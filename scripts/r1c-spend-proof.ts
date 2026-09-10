/**
 * R1C spend proof — spec §0 step 1, software-key half. Proves the EXACT shipped template
 * (packages/expo-wallet-toolbox/core/services/vault/r1comb.ts) is accepted by a real network before the vault
 * feature flag is turned on. Two software P-256 keys stand in for the YubiKeys: what is under test is the
 * script's acceptance by the network, not the hardware. Replaces scripts/k1-spend-proof.ts.
 *
 * Usage:
 *   FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]
 *
 * FUNDING_UTXO is a P2PKH output the WIF controls, discovered out of band (block explorer), the same convention
 * the deleted r1k1-spend-proof.ts used. Everything else comes from argv. Run once without FUNDING_UTXO to print
 * the address to fund.
 *
 * Funds: 100,000 sat per deposit; every spend returns to the funding address, so the balance only shrinks by
 * fees. Peak lock = 3 deposits alive at once (300,000 sat) + ~25,000 sat of fees at 100 sat/kB over 7 deposits
 * (~28 KB each, the 28 KB lock is in the OUTPUT) and 5 spends (2.7–8 KB) → fund >= 400,000 sat.
 *
 * Sequence (every txid printed; summary at the end for the spec changelog):
 *   D1 deposit (N = 2: keys A, B)  → S1 spend by A (1-in / 1-out, version 2)
 *   D2 deposit                     → S2 spend by B
 *   D3, D4, D5 deposits            → S3 3-input spend by A
 *   D6 deposit                     → S4 mixed spend: D6 + a wallet P2PKH input, signer B (output > vault input)
 *   D7 deposit                     → S5 spend by A whose vault input's sequence was GROUND until
 *                                    pushTxDerCheck(preimage).ok === false. The strict local interpreter MUST
 *                                    reject it (MINIMALDATA) and the network MUST accept it — that is the
 *                                    version-2 relaxation the design relies on (spec §1 D4).
 * Every other spend must pass verifyVaultInput locally; the script aborts on the first local or ARC rejection.
 * Spends chain on unconfirmed parents — fine for ARC (mempool chains).
 */
import { ARC, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, Utils } from '@bsv/sdk'
import type { LockingScript } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  R1C_LOCK_LEN,
  R1C_UNLOCK_LEN,
  buildLock,
  bakedCommitments,
  commitment,
  compressPubkey,
  sighashPreimage,
  signerDigest,
  pushTxDerCheck,
  buildUnlock,
  verifyVaultInput,
  encodeVaultInstructions
} from '../packages/expo-wallet-toolbox/core/services/vault/r1comb'

const [, , wif, arcUrl, arcApiKey] = process.argv
if (!wif || !arcUrl) {
  console.error('usage: FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]')
  process.exit(1)
}

const VAULT_SATS = 100_000
/** Spec §2.6: fee model unchanged (100 sat/kB). */
const FEE_SAT_PER_KB = 100
/** Measured P2PKH unlock: push(<=72-byte DER) + push(33-byte pubkey). */
const P2PKH_UNLOCK_LEN = 107
/** Expected ≈ 65,536 tries at 2^-16 each; 2^21 leaves a 2^-46 chance of missing. */
const GRIND_MAX = 1 << 21

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
  name: 'A' | 'B'
  priv: Uint8Array
  pub: string
}

const funding = PrivateKey.fromWif(wif)
const fundingLock = new P2PKH().lock(funding.toAddress())
const broadcaster = arcApiKey ? new ARC(arcUrl, { apiKey: arcApiKey }) : new ARC(arcUrl)

function softKey(name: 'A' | 'B'): SoftKey {
  const priv = p256.utils.randomSecretKey()
  // 65-byte SEC1 in → compressed out: the same path the card's public key takes in the app
  return { name, priv, pub: compressPubkey(Utils.toHex(Array.from(p256.getPublicKey(priv, false)))) }
}
const keyA = softKey('A')
const keyB = softKey('B')

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
  const res = await tx.broadcast(broadcaster)
  if (res.status !== 'success') throw new Error(`${label}: ARC rejected the transaction: ${JSON.stringify(res)}`)
  const id = tx.id('hex')
  txids.push(`${label}: ${id}`)
  console.log(`${label}: broadcast OK txid ${id} (${tx.toBinary().length} B)`)
}

/** Consolidate every wallet coin into one N = 2 vault output (version 1, spec §2.6) + change. */
async function deposit(label: string): Promise<VaultCoin> {
  const salt = Utils.toHex(Array.from(p256.utils.randomSecretKey())) // fresh 32-byte salt per output (spec §2.2, §2.7)
  const commitments = [keyA, keyB].map(k => commitment(k.pub, salt))
  const lock = buildLock({ commitments })
  const lockLen = lock.toBinary().length
  if (lockLen !== R1C_LOCK_LEN(2)) throw new Error(`template drift: lock is ${lockLen} B, expected ${R1C_LOCK_LEN(2)} — aborting before any funds move`)
  const baked = bakedCommitments(lock)
  if (baked.join(',') !== commitments.join(',')) throw new Error('bakedCommitments does not round-trip the commitments')
  console.log(`\n${label}: lock ${lockLen} B; customInstructions ${encodeVaultInstructions({ v: 4, type: 'R1C', salt, keys: [keyA.pub, keyB.pub] })}`)

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
  /** Grind input 0's sequence until pushTxDerCheck FAILS, then broadcast anyway (single vault input only). */
  grindPeelFail?: boolean
}

/** Version-2 spend of `vaults` to the funding address; local strict verification, then broadcast. */
async function spend(label: string, vaults: VaultCoin[], o: SpendOptions): Promise<void> {
  if (o.grindPeelFail === true && vaults.length !== 1) throw new Error('grind mode is single-input')
  const tx = new Transaction(2, [], [], 0) // withdrawals are version 2 (spec §2.6)
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

  // D4b screen (spec §4.2): every vault preimage must pass pushTxDerCheck — bump the failing input's sequence
  // (each bump changes hashSequence, so all preimages are recomputed). Grind mode inverts the goal.
  const vaultIdx = vaults.map((_, i) => i)
  let preimages: number[][] = []
  if (o.grindPeelFail === true) {
    let found = false
    for (let k = 0; k < GRIND_MAX; k++) {
      tx.inputs[0].sequence = (0xfffffffe - k) >>> 0
      const p = sighashPreimage(tx, 0, vaults[0].satoshis)
      const chk = pushTxDerCheck(p)
      if (!chk.ok) {
        preimages = [p]
        found = true
        console.log(`${label}: sequence 0x${(tx.inputs[0].sequence ?? 0).toString(16)} makes the OP_PUSH_TX s peel-nonminimal after ${k + 1} tries (s = 0x${chk.s.toString(16)})`)
        break
      }
    }
    if (!found) throw new Error(`${label}: no failing sequence in ${GRIND_MAX} tries`)
  } else {
    for (let attempt = 0; ; attempt++) {
      preimages = vaultIdx.map(i => sighashPreimage(tx, i, vaults[i].satoshis))
      const bad = preimages.findIndex(p => !pushTxDerCheck(p).ok)
      if (bad < 0) break
      if (attempt >= 16) throw new Error(`${label}: pushTxDerCheck failed 16 times in a row`)
      console.log(`${label}: input ${bad} failed the OP_PUSH_TX screen (2^-16 event); bumping its sequence`)
      tx.inputs[bad].sequence = ((tx.inputs[bad].sequence ?? 0xffffffff) - 1) >>> 0
    }
  }

  // Sign each vault input with the software key — the card would receive exactly signerDigest(preimage).
  for (const i of vaultIdx) {
    const digest = signerDigest(preimages[i])
    const compact = p256.sign(Uint8Array.from(Utils.toArray(digest, 'hex') as number[]), o.signer.priv, { prehash: false, lowS: false })
    const der = Array.from(p256.Signature.fromBytes(compact).toBytes('der'))
    const unlock = buildUnlock({ preimage: preimages[i], derSig: der, pubkeyHex33: o.signer.pub, saltHex64: vaults[i].salt })
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
    if (o.grindPeelFail === true) {
      if (ok) throw new Error(`${label}: expected the strict interpreter to REJECT the constructed spend; it passed — nothing was proven`)
      console.log(`${label}: strict local Spend rejects as designed: ${err}`)
    } else if (!ok) {
      throw new Error(`${label}: input ${i} failed local strict verification: ${err}`)
    }
  }
  console.log(`${label}: tx ${tx.toBinary().length} B, ${tx.inputs.length} inputs, output ${outSats} sat${o.extraP2PKH === true ? ` (> ${vaultTotal} vault sat)` : ''}`)
  await broadcast(label, tx)
  wallet.push({ tx, vout: 0, satoshis: outSats })
}

async function main(): Promise<void> {
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
  await spend('S5 (A, constructed peel-nonminimal, version 2)', [d7], { signer: keyA, grindPeelFail: true })

  console.log('\n--- summary (record in docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md changelog) ---')
  for (const t of txids) console.log(t)
  console.log('\nPASS: all seven deposits and five version-2 spends accepted, including the peel-nonminimal one.')
}

main().catch(e => {
  console.error('\nspend proof FAILED:', e instanceof Error ? e.message : e)
  if (txids.length > 0) {
    console.error('txids broadcast before the failure:')
    for (const t of txids) console.error('  ' + t)
  }
  process.exit(1)
})
