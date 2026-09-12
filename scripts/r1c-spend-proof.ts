/**
 * R1C spend proof — spec §0 step 1, software-key half. Proves the EXACT shipped template
 * (packages/expo-wallet-toolbox/core/services/vault/r1comb.ts) is accepted by a real network before the vault
 * feature flag is turned on. Two software P-256 keys stand in for the YubiKeys: what is under test is the
 * script's acceptance by the network, not the hardware. Replaces scripts/k1-spend-proof.ts.
 *
 * Usage:
 *   npx tsx scripts/r1c-spend-proof.ts --local
 *   FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts --live <chain> <fundingWIF> <arcUrl> [arcApiKey]
 *
 * FUNDING_UTXO is a P2PKH output the WIF controls, discovered out of band (block explorer), the same convention
 * the deleted r1k1-spend-proof.ts used. Everything else comes from argv. Run once without FUNDING_UTXO to print
 * the address to fund.
 *
 * Funds: 100,000 sat per deposit; every spend returns to the funding address, so the balance only shrinks by
 * fees. Peak lock = 3 deposits alive at once (300,000 sat) plus fees at 100 sat/kB over 7 deposits
 * (~45 KB each, the lock is in the OUTPUT) and 5 spends (2.7–8 KB) → fund >= 400,000 sat.
 *
 * Sequence (every txid printed; summary at the end for the spec changelog):
 *   D1 deposit (N = 2: keys A, B)  → S1 spend by A (1-in / 1-out, version 1)
 *   D2 deposit                     → S2 spend by B
 *   D3, D4, D5 deposits            → S3 3-input spend by A
 *   D6 deposit                     → S4 mixed spend: D6 + a wallet P2PKH input, signer B (output > vault input)
 *   D7 deposit                     → S5 spend by A after the zero-scalar OP_PUSH_TX screen.
 * Every other spend must pass verifyVaultInput locally; the script aborts on the first local or ARC rejection.
 * Spends chain on unconfirmed parents — fine for ARC (mempool chains).
 */
import { ARC, Hash, P2PKH, PrivateKey, ProtoWallet, SatoshisPerKilobyte, Transaction, Utils } from '@bsv/sdk'
import type { LockingScript } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  R1C_LOCK_LEN,
  R1C_UNLOCK_LEN,
  buildLock,
  bakedCommitments,
  bakedSalt,
  commitment,
  compressPubkey,
  sighashPreimage,
  signerDigest,
  pushTxDerCheck,
  buildUnlock,
  decodeVaultInstructions,
  pushTxSignatureS,
  SECP_N,
  type VaultSaltChain,
  vaultSaltHmacData,
  verifyVaultInput,
  encodeVaultInstructions
} from '../packages/expo-wallet-toolbox/core/services/vault/r1comb'

const [, , mode, chainArg, wif, arcUrl, arcApiKey] = process.argv
if (mode !== '--local' && mode !== '--live') {
  console.error('usage: npx tsx scripts/r1c-spend-proof.ts --local')
  console.error('   or: FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts --live <main|test|teratest> <fundingWIF> <arcUrl> [arcApiKey]')
  process.exit(1)
}
const liveChain: VaultSaltChain | undefined =
  chainArg === 'main' || chainArg === 'test' || chainArg === 'teratest' ? chainArg : undefined
if (mode === '--live' && (!liveChain || !wif || !arcUrl)) {
  console.error('usage: FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts --live <main|test|teratest> <fundingWIF> <arcUrl> [arcApiKey]')
  process.exit(1)
}
const proofChain: VaultSaltChain = mode === '--live' ? liveChain! : 'test'

const VAULT_SATS = 100_000
/** Spec §2.6: fee model unchanged (100 sat/kB). */
const FEE_SAT_PER_KB = 100
/** Measured P2PKH unlock: push(<=72-byte DER) + push(33-byte pubkey). */
const P2PKH_UNLOCK_LEN = 107
interface Coin {
  tx: Transaction
  vout: number
  satoshis: number
  /** Real chain txid when `tx` is only a stand-in (the initial FUNDING_UTXO). */
  txid?: string
}
interface VaultCoin extends Coin {
  lock: LockingScript
  salt: string
}
interface SoftKey {
  name: string
  serial: string
  priv: Uint8Array
  pub: string
}

interface SaltContext {
  wallet: ProtoWallet
  vaultId: string
  createdAt: number
  nextKeyIndex: number
  salts: Set<string>
  keyIds: Set<string>
  scriptHashes: Set<string>
}

interface AllocatedLock {
  lock: LockingScript
  salt: string
  customInstructions: string
}

const funding = mode === '--live' ? PrivateKey.fromWif(wif!) : PrivateKey.fromRandom()
const fundingLock = new P2PKH().lock(funding.toAddress())
const broadcaster = mode === '--live'
  ? (arcApiKey ? new ARC(arcUrl!, { apiKey: arcApiKey }) : new ARC(arcUrl!))
  : undefined

function softKey(name: string): SoftKey {
  const priv = p256.utils.randomSecretKey()
  // 65-byte SEC1 in → compressed out: the same path the card's public key takes in the app
  return { name, serial: `SOFTWARE-PROOF-${name}`, priv, pub: compressPubkey(Utils.toHex(Array.from(p256.getPublicKey(priv, false)))) }
}
const keyA = softKey('A')
const keyB = softKey('B')

function makeSaltContext(): SaltContext {
  return {
    wallet: new ProtoWallet(PrivateKey.fromRandom()),
    vaultId: Utils.toHex(PrivateKey.fromRandom().toArray('be', 32)),
    createdAt: Date.now(),
    nextKeyIndex: 1,
    salts: new Set(),
    keyIds: new Set(),
    scriptHashes: new Set()
  }
}

const liveSaltContext = makeSaltContext()

const keyRecord = (context: SaltContext, key: SoftKey, index: number) => ({
  serial: key.serial,
  slot: 0x82,
  pubkey: key.pub,
  nickname: `Software proof key ${key.name}`,
  enrolledAt: context.createdAt + index
})

/** Allocate the exact v6 salt/metadata shape used by transfers.ts. */
async function allocateLock(context: SaltContext, keys: SoftKey[]): Promise<AllocatedLock> {
  const keyIndex = context.nextKeyIndex++
  const saltKeyId = String(keyIndex)
  const serials = keys.map(key => key.serial)
  const { hmac } = await context.wallet.createHmac({
    protocolID: [2, 'vault salt'],
    keyID: saltKeyId,
    counterparty: 'self',
    data: vaultSaltHmacData(serials),
    seekPermission: false
  })
  if (
    !Array.isArray(hmac) || hmac.length !== 32 ||
    hmac.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 0xff)
  ) {
    throw new Error('wallet returned a non-canonical Vault salt HMAC')
  }
  const salt = Utils.toHex(hmac)
  const commitments = keys.map(key => commitment(key.pub, salt))
  const lock = buildLock({ commitments, saltHex64: salt })
  const scriptHash = Utils.toHex(Hash.sha256(lock.toBinary()))
  if (context.salts.has(salt) || context.keyIds.has(saltKeyId) || context.scriptHashes.has(scriptHash)) {
    throw new Error('wallet-derived Vault salt, derivation ID, or script hash repeated')
  }
  context.salts.add(salt)
  context.keyIds.add(saltKeyId)
  context.scriptHashes.add(scriptHash)
  if (lock.toBinary().length !== R1C_LOCK_LEN(keys.length)) throw new Error('R1C lock length drift')
  if (bakedSalt(lock) !== salt || bakedCommitments(lock).join(',') !== commitments.join(',')) {
    throw new Error('R1C lock did not round-trip its salt and commitments')
  }
  const customInstructions = encodeVaultInstructions({
    v: 6,
    type: 'R1C',
    salt,
    saltKeyId,
    chain: proofChain,
    vaultId: context.vaultId,
    revision: 1,
    createdAt: context.createdAt,
    keys: keys.map((key, index) => keyRecord(context, key, index))
  })
  if (decodeVaultInstructions(customInstructions) === null) throw new Error('v6 recovery metadata did not round-trip')
  return { lock, salt, customInstructions }
}

/** P2PKH outputs the funding key controls: change outputs and returned spends. */
const wallet: Coin[] = []
const txids: string[] = []

function fundingInput(c: Coin) {
  return {
    sourceTXID: c.txid,
    sourceTransaction: c.tx,
    sourceOutputIndex: c.vout,
    sequence: 0xffffffff,
    unlockingScriptTemplate: new P2PKH().unlock(funding, 'all', false, c.satoshis, fundingLock)
  }
}

function takeLargestWalletCoin(): Coin {
  if (wallet.length === 0) throw new Error('no wallet coins left')
  wallet.sort((a, b) => b.satoshis - a.satoshis)
  return wallet.splice(0, 1)[0]
}

async function broadcast(label: string, tx: Transaction): Promise<void> {
  if (!broadcaster) throw new Error(`${label}: live broadcaster is not configured`)
  const res = await tx.broadcast(broadcaster)
  if (res.status !== 'success') throw new Error(`${label}: ARC rejected the transaction: ${JSON.stringify(res)}`)
  const id = tx.id('hex')
  txids.push(`${label}: ${id}`)
  console.log(`${label}: broadcast OK txid ${id} (${tx.toBinary().length} B)`)
}

/** Consolidate every wallet coin into one N = 2 vault output (version 1, spec §2.6) + change. */
async function deposit(label: string): Promise<VaultCoin> {
  const { salt, lock, customInstructions } = await allocateLock(liveSaltContext, [keyA, keyB])
  const commitments = [keyA, keyB].map(k => commitment(k.pub, salt))
  const lockLen = lock.toBinary().length
  if (lockLen !== R1C_LOCK_LEN(2)) throw new Error(`template drift: lock is ${lockLen} B, expected ${R1C_LOCK_LEN(2)} — aborting before any funds move`)
  const baked = bakedCommitments(lock)
  if (baked.join(',') !== commitments.join(',')) throw new Error('bakedCommitments does not round-trip the commitments')
  if (bakedSalt(lock) !== salt) throw new Error('bakedSalt does not round-trip the output salt')
  console.log(`\n${label}: lock ${lockLen} B; customInstructions ${customInstructions}`)

  const coins = wallet.splice(0)
  if (coins.length === 0) throw new Error(`${label}: no wallet coins to fund the deposit`)
  const tx = new Transaction(1, [], [], 0)
  for (const c of coins) tx.addInput(fundingInput(c))
  tx.addOutput({ satoshis: VAULT_SATS, lockingScript: lock })
  tx.addOutput({ lockingScript: fundingLock, change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_SAT_PER_KB))
  await tx.sign()
  const change = tx.outputs[1].satoshis
  if (change === undefined) throw new Error(`${label}: fee() left the change amount unset`)
  await broadcast(label, tx)
  wallet.push({ tx, vout: 1, satoshis: change })
  return { tx, vout: 0, satoshis: VAULT_SATS, lock, salt }
}

interface SpendOptions {
  signer: SoftKey
  /** Add one wallet P2PKH input; the single output then exceeds the vault inputs (spec §0: "withdraw slightly more"). */
  extraP2PKH?: boolean
}

/** Version-1 spend of `vaults` to the funding address; local strict verification, then broadcast. */
async function spend(label: string, vaults: VaultCoin[], o: SpendOptions): Promise<void> {
  const tx = new Transaction(1, [], [], 0)
  for (const v of vaults) tx.addInput({ sourceTransaction: v.tx, sourceOutputIndex: v.vout, sequence: 0xffffffff })
  let p2pkhSats = 0
  if (o.extraP2PKH === true) {
    const c = takeLargestWalletCoin()
    tx.addInput(fundingInput(c))
    p2pkhSats = c.satoshis
  }
  const vaultTotal = vaults.reduce((s, v) => s + v.satoshis, 0)
  const size = 10 + vaults.length * (41 + 3 + R1C_UNLOCK_LEN) + (o.extraP2PKH === true ? 41 + 1 + P2PKH_UNLOCK_LEN : 0) + (8 + 1 + 25)
  const fee = Math.ceil((size * FEE_SAT_PER_KB) / 1000)
  const outSats = vaultTotal + p2pkhSats - fee
  if (o.extraP2PKH === true && outSats <= vaultTotal) throw new Error(`${label}: mixed spend must withdraw more than the vault inputs cover`)
  tx.addOutput({ satoshis: outSats, lockingScript: fundingLock })

  // Every vault preimage must pass pushTxDerCheck before requesting a signature.
  // Each bump changes hashSequence, so all preimages are recomputed.
  const vaultIdx = vaults.map((_, i) => i)
  let preimages: number[][] = []
  for (let attempt = 0; ; attempt++) {
    preimages = vaultIdx.map(i => sighashPreimage(tx, i, vaults[i].satoshis))
    const bad = preimages.findIndex(p => !pushTxDerCheck(p).ok)
    if (bad < 0) break
    if (attempt >= 16) throw new Error(`${label}: pushTxDerCheck failed 16 times in a row`)
    console.log(`${label}: input ${bad} produced the invalid zero OP_PUSH_TX scalar; bumping its sequence`)
    tx.inputs[bad].sequence = ((tx.inputs[bad].sequence ?? 0xffffffff) - 1) >>> 0
  }

  // Sign each vault input with the software key — the card would receive exactly signerDigest(preimage).
  for (const i of vaultIdx) {
    const digest = signerDigest(preimages[i])
    const compact = p256.sign(Uint8Array.from(Utils.toArray(digest, 'hex') as number[]), o.signer.priv, { prehash: false, lowS: false })
    const der = Array.from(p256.Signature.fromBytes(compact).toBytes('der'))
    const unlock = buildUnlock({ preimage: preimages[i], derSig: der, pubkeyHex33: o.signer.pub })
    const len = unlock.toBinary().length
    if (len > R1C_UNLOCK_LEN) throw new Error(`${label}: unlock is ${len} B > R1C_UNLOCK_LEN`)
    tx.inputs[i].unlockingScript = unlock
    console.log(`${label}: input ${i} signed by key ${o.signer.name}; unlock ${len} B`)
  }
  if (o.extraP2PKH === true) await tx.sign() // signs the templated P2PKH input only; vault inputs are left as set

  // Strict local verification (the same flags the app uses before signAction).
  for (const i of vaultIdx) {
    let ok = false
    let err = ''
    try {
      ok = verifyVaultInput({ tx, inputIndex: i, sourceSatoshis: vaults[i].satoshis, lockingScript: vaults[i].lock, unlockingScript: tx.inputs[i].unlockingScript! })
    } catch (e) {
      err = (e as Error).message.split('\n')[0]
    }
    if (!ok) {
      throw new Error(`${label}: input ${i} failed local strict verification: ${err}`)
    }
  }
  console.log(`${label}: tx ${tx.toBinary().length} B, ${tx.inputs.length} inputs, output ${outSats} sat${o.extraP2PKH === true ? ` (> ${vaultTotal} vault sat)` : ''}`)
  await broadcast(label, tx)
  wallet.push({ tx, vout: 0, satoshis: outSats })
}

function localVaultCoin(allocated: AllocatedLock, satoshis = VAULT_SATS): VaultCoin {
  const tx = new Transaction(1, [], [], 0)
  tx.addOutput({ satoshis, lockingScript: allocated.lock })
  return { tx, vout: 0, satoshis, lock: allocated.lock, salt: allocated.salt }
}

function localSpendTransaction(coin: VaultCoin, outputs?: { satoshis: number; lockingScript: LockingScript }[]): Transaction {
  const tx = new Transaction(1, [], [], 0)
  tx.addInput({ sourceTransaction: coin.tx, sourceOutputIndex: coin.vout, sequence: 0xffffffff })
  for (const output of outputs ?? [{ satoshis: coin.satoshis - 1_000, lockingScript: fundingLock }]) tx.addOutput(output)
  return tx
}

function signatureFor(preimage: number[], key: SoftKey): number[] {
  const digest = signerDigest(preimage)
  const compact = p256.sign(
    Uint8Array.from(Utils.toArray(digest, 'hex') as number[]),
    key.priv,
    { prehash: false, lowS: false }
  )
  return Array.from(p256.Signature.fromBytes(compact).toBytes('der'))
}

function unlockWith(
  tx: Transaction,
  coin: VaultCoin,
  signatureKey: SoftKey,
  tablePubkey = signatureKey.pub
): void {
  const preimage = sighashPreimage(tx, 0, coin.satoshis)
  if (!pushTxDerCheck(preimage).ok) throw new Error('OP_PUSH_TX totality check unexpectedly failed')
  tx.inputs[0].unlockingScript = buildUnlock({
    preimage,
    derSig: signatureFor(preimage, signatureKey),
    pubkeyHex33: tablePubkey
  })
}

function verifyLocal(tx: Transaction, coin: VaultCoin): true {
  return verifyVaultInput({
    tx,
    inputIndex: 0,
    sourceSatoshis: coin.satoshis,
    lockingScript: coin.lock,
    unlockingScript: tx.inputs[0].unlockingScript!
  })
}

function requireLocalRejection(label: string, work: () => unknown): void {
  try {
    work()
  } catch {
    return
  }
  throw new Error(`${label}: invalid Vault spend was accepted`)
}

const sameBytes = (a: number[] | Uint8Array, b: number[] | Uint8Array): boolean =>
  a.length === b.length && Array.from(a).every((value, index) => value === b[index])

function bigEndian32(value: bigint): number[] {
  const hex = value.toString(16).padStart(64, '0')
  return Utils.toArray(hex, 'hex') as number[]
}

/** Exercise the exact template without a network or funded key. This matrix is
 * deterministic in shape and intentionally runs before the opt-in live proof. */
async function runLocalProof(): Promise<void> {
  const context = makeSaltContext()
  const keys = ['A', 'B', 'C', 'D', 'E'].map(softKey)
  const outsider = softKey('OUTSIDER')
  let accepted = 0
  let rejected = 0

  for (let n = 2; n <= 5; n++) {
    const authorized = keys.slice(0, n)
    const coin = localVaultCoin(await allocateLock(context, authorized))
    for (const signer of authorized) {
      const tx = localSpendTransaction(coin)
      unlockWith(tx, coin, signer)
      verifyLocal(tx, coin)
      accepted++
    }

    const outsiderTable = localSpendTransaction(coin)
    unlockWith(outsiderTable, coin, outsider)
    requireLocalRejection(`N=${n} outsider table`, () => verifyLocal(outsiderTable, coin))
    rejected++

    const wrongSignature = localSpendTransaction(coin)
    unlockWith(wrongSignature, coin, outsider, authorized[0].pub)
    requireLocalRejection(`N=${n} outsider signature`, () => verifyLocal(wrongSignature, coin))
    rejected++
  }

  // Re-lock: an old N=3 key authorizes the replacement, then a newly added key
  // can open the fresh N=5 output.
  const oldCoin = localVaultCoin(await allocateLock(context, keys.slice(0, 3)), 180_000)
  const relock = await allocateLock(context, keys)
  const relockTx = localSpendTransaction(oldCoin, [{ satoshis: 170_000, lockingScript: relock.lock }])
  unlockWith(relockTx, oldCoin, keys[1])
  verifyLocal(relockTx, oldCoin)
  const relockedCoin: VaultCoin = { tx: relockTx, vout: 0, satoshis: 170_000, lock: relock.lock, salt: relock.salt }
  const afterRelock = localSpendTransaction(relockedCoin)
  unlockWith(afterRelock, relockedCoin, keys[4])
  verifyLocal(afterRelock, relockedCoin)
  accepted += 2

  // Withdrawal with a re-vaulted remainder: both outputs are covered by the
  // covenant preimage, and the remainder remains spendable by the same key set.
  const source = localVaultCoin(await allocateLock(context, keys.slice(0, 4)), 200_000)
  const remainder = await allocateLock(context, keys.slice(0, 4))
  const remainderTx = localSpendTransaction(source, [
    { satoshis: 90_000, lockingScript: fundingLock },
    { satoshis: 100_000, lockingScript: remainder.lock }
  ])
  unlockWith(remainderTx, source, keys[2])
  verifyLocal(remainderTx, source)
  const originalValue = remainderTx.outputs[0].satoshis!
  remainderTx.outputs[0].satoshis = originalValue + 1
  requireLocalRejection('post-sign output mutation', () => verifyLocal(remainderTx, source))
  remainderTx.outputs[0].satoshis = originalValue
  verifyLocal(remainderTx, source)
  const remainderCoin: VaultCoin = { tx: remainderTx, vout: 1, satoshis: 100_000, lock: remainder.lock, salt: remainder.salt }
  const spendRemainder = localSpendTransaction(remainderCoin)
  unlockWith(spendRemainder, remainderCoin, keys[0])
  verifyLocal(spendRemainder, remainderCoin)
  accepted += 2
  rejected++

  // Force the one digest for which the primary OP_PUSH_TX scalar is zero. The
  // second covenant key/constant must select s=1 and still bind the transaction.
  const fallbackCoin = localVaultCoin(await allocateLock(context, keys.slice(0, 2)))
  const fallbackTx = localSpendTransaction(fallbackCoin)
  const fallbackPreimage = sighashPreimage(fallbackTx, 0, fallbackCoin.satoshis)
  const originalHash256 = Hash.hash256
  const forcedDigest = bigEndian32(SECP_N - (1n << 248n))
  const mutableHash = Hash as unknown as { hash256: (message: number[] | Uint8Array) => number[] }
  try {
    mutableHash.hash256 = message => sameBytes(message, fallbackPreimage)
      ? [...forcedDigest]
      : originalHash256(Array.from(message))
    if (pushTxSignatureS(fallbackPreimage) !== 1n) throw new Error('OP_PUSH_TX fallback branch did not select s=1')
    unlockWith(fallbackTx, fallbackCoin, keys[0])
    verifyLocal(fallbackTx, fallbackCoin)
    accepted++
  } finally {
    mutableHash.hash256 = originalHash256
  }

  console.log(`local matrix PASS: ${accepted} authorized spends accepted; ${rejected} outsider/tamper spends rejected; N=2..5, relock, remainder and OP_PUSH_TX fallback covered`)
}

async function runLiveProof(): Promise<void> {
  console.log('funding address:', funding.toAddress())
  const FUNDING_UTXO = process.env.FUNDING_UTXO
  if (!FUNDING_UTXO) {
    console.error('\nFund the address above (>= 400,000 sat), then set FUNDING_UTXO=<txid>:<vout>:<satoshis> and re-run.')
    process.exit(1)
  }
  const [fTxid, fVout, fSats] = FUNDING_UTXO.split(':')
  if (!/^[0-9a-f]{64}$/i.test(fTxid ?? '') || !/^\d+$/.test(fVout ?? '') || !/^\d+$/.test(fSats ?? '')) {
    throw new Error('FUNDING_UTXO must be <64-hex txid>:<vout>:<satoshis>')
  }
  // fee()/sign()/EF serialisation read sourceTransaction.outputs[vout]; build a stand-in holding the one real output.
  const stub = new Transaction(1, [], [], 0)
  for (let i = 0; i < Number(fVout); i++) stub.addOutput({ satoshis: 0, lockingScript: fundingLock })
  stub.addOutput({ satoshis: Number(fSats), lockingScript: fundingLock })
  wallet.push({ tx: stub, vout: Number(fVout), satoshis: Number(fSats), txid: fTxid.toLowerCase() })
  console.log(`funding UTXO ${fTxid}:${fVout} ${fSats} sat`)
  console.log(`key A ${keyA.pub}\nkey B ${keyB.pub}`)

  const d1 = await deposit('D1')
  await spend('S1 (A, 1-in/1-out)', [d1], { signer: keyA })
  const d2 = await deposit('D2')
  await spend('S2 (B, 1-in/1-out)', [d2], { signer: keyB })
  const d3 = await deposit('D3')
  const d4 = await deposit('D4')
  const d5 = await deposit('D5')
  await spend('S3 (A, 3 vault inputs)', [d3, d4, d5], { signer: keyA })
  const d6 = await deposit('D6')
  await spend('S4 (B, vault + P2PKH input)', [d6], { signer: keyB, extraP2PKH: true })
  const d7 = await deposit('D7')
  await spend('S5 (A, zero-scalar-screened version-1 spend)', [d7], { signer: keyA })

  console.log('\n--- summary (record in docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md changelog) ---')
  for (const t of txids) console.log(t)
  console.log('\nPASS: all seven deposits and five version-1 spends accepted after strict local verification.')
}

async function main(): Promise<void> {
  await runLocalProof()
  if (mode === '--local') return
  await runLiveProof()
}

main().catch(e => {
  console.error('\nspend proof FAILED:', e instanceof Error ? e.message : e)
  if (txids.length > 0) {
    console.error('txids broadcast before the failure:')
    for (const t of txids) console.error('  ' + t)
  }
  process.exit(1)
})
