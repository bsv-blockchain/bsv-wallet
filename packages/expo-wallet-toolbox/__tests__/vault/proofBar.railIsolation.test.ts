/**
 * I3 proof bar — rail isolation, against the REAL wallet and REAL storage.
 *
 * Invariant I3 (owner's words): "Everyday BSV and stablecoin rails, paired
 * BRC-100 callers, backup hosts, and other wallets MUST NOT spend Vault funds
 * or learn the hot seed. Ordinary pay/get-paid paths MUST NOT select Vault
 * UTXOs." Proof bar: "MessageBox, localpay, P2PKH, stablecoin/token, and
 * offline-queue builders refuse Vault inputs. The external-wallet guard plus
 * the storage backstop both deny Vault discovery and mutation."
 *
 * SEEDING. Every Vault output here is inserted via `Wallet.internalizeAction`
 * with `protocol: 'basket insertion'` targeting the `admin vault` basket and
 * originator === the wallet's own `__bsvVaultAdminOriginator` — i.e. the same
 * "an already-mined output becomes ours" path a real Vault deposit or a
 * backup restore leaves in storage (see StorageExpoSQLite's
 * `outputOwnership.test.ts` for the storage-level equivalent, and
 * `transfers.ts`'s `newVaultOutput`/`VAULT_BASKET` for what a live deposit
 * writes). What is NOT reproduced here is the mainnet-only release gating
 * (`requireReleased`/`isVaultAvailable`) and hardware-signing ceremony a real
 * deposit goes through before it ever calls `createAction` — those gate
 * WHETHER a Vault output gets created, not whether ordinary rails can select
 * one once it exists, which is the isolation property under test. The
 * resulting stored row (basket `admin vault`, byte-exact R1C lock from
 * `buildLock`/`commitment`) is indistinguishable from a live deposit's.
 *
 * WHAT THIS FILE DOES NOT EXERCISE, AND WHY:
 *  - `buildTokenPaymentFrame` (core/localpay/build.ts) end to end: it calls
 *    `assembleBundle`/`mintTipLinkage`/`deps.lockToPayee`, which need a live
 *    Mandala overlay. What IS exercised for real, against the real wallet, is
 *    its actual coin-selection machinery: `listOutputs({basket, ...})`
 *    (basket-scoped discovery) composed with `MandalaToken.decode` (script-
 *    shape filtering) — see the "Mandala" describe block below. Both halves
 *    are proven to exclude the Vault independently, so bypassing either one
 *    alone would not be enough to select it.
 *  - A full BLE/native-radio nearby transport, or a live MessageBox/overlay
 *    server: `sendViaHandle` is driven for real up to and including its
 *    `createAction`/`signAction`/broadcast calls, with a stub `PeerPayClient`
 *    (`sendMessage` only, never consulted for fund selection) and a stub
 *    network broadcaster (`services.postBeef`, which only ever sees inputs
 *    the wallet itself already chose — it cannot influence what got picked).
 *  - The vault's own withdrawal/re-lock spends (they run through YubiKey
 *    ceremony host code, not through any of the "everyday" rails this
 *    invariant is about) — out of scope for I3, which is about EVERYDAY
 *    rails never reaching INTO the Vault, not about the Vault's own path out.
 *
 * METHODOLOGY. Every negative here has a positive control in the SAME test:
 * either the identical builder call, from the identical wallet holding the
 * identical Vault output, ALSO spends/lists/accepts an ordinary default-
 * basket (or ordinary-basket) item — proving the harness is live and the
 * builder actually does its job, not merely broken/inert.
 */
jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual('node:sqlite')
  class TestDatabase {
    db = new DatabaseSync(':memory:')
    async execAsync(sql: string) {
      this.db.exec(sql)
    }
    async runAsync(sql: string, params: unknown[] = []) {
      const result = this.db.prepare(sql).run(...(params as never[]))
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) }
    }
    async getFirstAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).get(...(params as never[])) ?? null
    }
    async getAllAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).all(...(params as never[]))
    }
    async withExclusiveTransactionAsync(fn: (transaction: TestDatabase) => Promise<void>) {
      this.db.exec('BEGIN')
      try {
        await fn(this)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    async closeAsync() {
      this.db.close()
    }
  }
  return { openDatabaseAsync: async () => new TestDatabase() }
})
jest.mock('../../core/diskSpace', () => ({ diskPressure: () => 'ok' }))

import {
  Beef,
  KeyDeriver,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  Random,
  Transaction,
  Utils,
  type ChainTracker
} from '@bsv/sdk'
import { Wallet, WalletPermissionsManager, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-mobile'
import { MandalaToken } from '@bsv/templates'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { buildPaymentFrame } from '../../core/localpay/build'
import { mintSession } from '../../core/localpay/session'
import { PEERPAY_PROTOCOL_ID, processPending, savePending, type KVStorage } from '../../core/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import { sendViaHandle } from '../../core/pay/rails/handle'
import { sendToAddress } from '../../core/pay/rails/address'
import { getOutboxEntries } from '../../core/peerpay/outbox'
import { guardVaultAccess, VaultAccessDenied } from '../../core/services/vault/guard'
import { buildLock, commitment, R1C_UNLOCK_LEN } from '../../core/services/vault/r1comb'
import { MANDALA_BASKET } from '../../core/mandala/bundle'

// Not imported from core/services/vault/transfers.ts: that module transitively
// pulls in ceremonyHost.ts -> vaultStore.ts -> `expo-secure-store`, a native
// module Jest cannot transform. guard.ts's own tests hardcode this constant
// for the same reason. Kept identical to transfers.ts's `export const
// VAULT_BASKET = 'admin vault'` and to guard.ts's internal `VAULT_BASKET`.
const VAULT_BASKET = 'admin vault'

const ADMIN = 'admin.example'
const FUNDING_HEIGHT = 0
const VAULT_SATS = 1_000_000
const DEFAULT_SATS = 500_000
const PAY_AMOUNT = 50_000

const FUNDING_PREFIX = 'ZnVuZHByZWZpeA=='
const FUNDING_SUFFIX = 'ZnVuZHN1ZmZpeA=='
const PAYEE = new KeyDeriver(new PrivateKey(999))

/** A "mined" transaction: a single-leaf merkle path whose root the shared
 * chain tracker below always accepts at height 0. This file is about Vault
 * ISOLATION, not merkle-proof correctness (that is covered elsewhere, e.g.
 * `verifyFrameEndToEnd.test.ts`'s P0-1 suite), so every fixture is "mined" the
 * same permissive way. */
function asMined(tx: Transaction): void {
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), FUNDING_HEIGHT)
}

const services = {
  getChainTracker: async (): Promise<ChainTracker> => ({
    isValidRootForHeight: async (_root: string, height: number) => height === FUNDING_HEIGHT,
    currentHeight: async () => FUNDING_HEIGHT + 100
  }),
  getHeaderForHeight: async (height: number) => (height === FUNDING_HEIGHT ? new Uint8Array(80) : undefined),
  nLockTimeIsFinal: async () => true,
  getHeight: async () => FUNDING_HEIGHT + 100,
  // A generic "every provider accepted it" broadcast stub. It only ever sees
  // whatever inputs the wallet itself already selected — it has no influence
  // over selection, so it is safe to make it always succeed.
  postBeef: async (_beef: unknown, txids: string[]) => [
    { txidResults: txids.map(txid => ({ txid, status: 'success' })) }
  ]
}

function saltHex(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32)
}

// A real, on-curve P-256 point (the standard base point G, compressed) — the
// R1C commitment math (core/services/vault/r1comb.ts) needs a genuine NIST
// P-256 public key, which an ordinary @bsv/sdk `PrivateKey` (secp256k1) is
// not. Reused verbatim from __tests__/storage/outputOwnership.test.ts's own
// Vault fixture. Isolation here does not depend on this key being unique per
// output — only the salt (see `saltHex`) needs to vary.
const P256_PUBKEY = '036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'

function memoryKvStorage(): KVStorage {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => {
      map.set(k, v)
    }
  }
}

async function makeWallet(seed: number): Promise<{ wallet: Wallet; storage: StorageExpoSQLite; keyDeriver: KeyDeriver }> {
  const keyDeriver = new KeyDeriver(new PrivateKey(seed))
  const identityKey = keyDeriver.identityKey
  const storage = new StorageExpoSQLite({
    chain: 'test',
    identityKey,
    databaseName: `proofbar-${seed}`,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 }
  } as never)
  await storage.migrate(`proofbar-${seed}`, identityKey)
  const storageManager = new WalletStorageManager(identityKey, storage as never)
  const signer = new WalletSigner('test' as never, keyDeriver as never, storageManager)
  const wallet = new Wallet(signer as never, services as never)
  // Mirrors WalletContext.tsx exactly: a non-enumerable property compared by
  // the toolbox's own patched createAction/internalizeAction against the
  // calling originator — this is what the storage backstop's
  // `__bsvVaultAdminAuthorized` flag is derived from.
  Object.defineProperty(wallet, '__bsvVaultAdminOriginator', {
    value: ADMIN,
    enumerable: false,
    configurable: false,
    writable: false
  })
  return { wallet, storage, keyDeriver }
}

/** Seeds an ordinary default-basket P2PKH coin via a real, mined, internalized
 * "wallet payment" — the same shape `verifyFrameEndToEnd.test.ts` funds a
 * payer with. Returns the outpoint the automatic funding CAN select. */
async function fundDefault(
  wallet: Wallet,
  keyDeriver: KeyDeriver,
  satoshis: number
): Promise<{ outpoint: string; txid: string }> {
  const sender = PrivateKey.fromRandom()
  const privKey = keyDeriver.derivePrivateKey(
    PEERPAY_PROTOCOL_ID as [2, string],
    `${FUNDING_PREFIX} ${FUNDING_SUFFIX}`,
    sender.toPublicKey().toString()
  )
  const tx = new Transaction()
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(privKey.toAddress()) })
  asMined(tx)
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  const result = await wallet.internalizeAction(
    {
      tx: new Uint8Array(beef.toBinaryAtomic(txid)),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: FUNDING_PREFIX,
            derivationSuffix: FUNDING_SUFFIX,
            senderIdentityKey: sender.toPublicKey().toString()
          }
        }
      ],
      description: 'I3 proof fixture: ordinary default-basket funding'
    } as never,
    ADMIN
  )
  if ((result as { accepted?: boolean }).accepted !== true) throw new Error('default funding did not internalize')
  return { outpoint: `${txid}.0`, txid }
}

/** Seeds a Vault output: exact R1C lock (real `buildLock`/`commitment`),
 * `admin vault` basket, via a real, mined, internalized basket insertion under
 * the admin originator. See the top-of-file comment for why this mirrors a
 * live deposit's storage effect without the mainnet/hardware gating. */
async function fundVault(
  wallet: Wallet,
  satoshis: number,
  nonce: number
): Promise<{ outpoint: string; txid: string; lockHex: string }> {
  const salt = saltHex(nonce)
  const lock = buildLock({ commitments: [commitment(P256_PUBKEY, salt)], saltHex64: salt })
  const tx = new Transaction()
  tx.addOutput({ satoshis, lockingScript: lock })
  asMined(tx)
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  const result = await wallet.internalizeAction(
    {
      tx: new Uint8Array(beef.toBinaryAtomic(txid)),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: VAULT_BASKET,
            customInstructions: JSON.stringify({ note: 'I3 proof fixture' })
          }
        }
      ],
      description: 'I3 proof fixture: Vault deposit (basket-insertion internalize under the admin originator)'
    } as never,
    ADMIN
  )
  if ((result as { accepted?: boolean }).accepted !== true) throw new Error('vault funding did not internalize')
  return { outpoint: `${txid}.0`, txid, lockHex: lock.toHex() }
}

/** Seeds an ordinary, non-admin, non-default, non-`p `-prefixed basket output
 * — the positive control basket for the BRC-100 "admin-reserved basket" rule
 * (WalletPermissionsManager.isAdminBasket), distinct from both `default` and
 * `admin vault` (both of which that rule treats as admin-only). */
async function fundGeneralBasket(
  wallet: Wallet,
  basket: string,
  satoshis: number
): Promise<{ outpoint: string; inputBEEF: number[] }> {
  const tx = new Transaction()
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
  asMined(tx)
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  const result = await wallet.internalizeAction(
    {
      tx: new Uint8Array(beef.toBinaryAtomic(txid)),
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket } }],
      description: 'I3 proof fixture: ordinary basket'
    } as never,
    ADMIN
  )
  if ((result as { accepted?: boolean }).accepted !== true) throw new Error('general-basket funding did not internalize')
  return { outpoint: `${txid}.0`, inputBEEF: beef.toBinary() }
}

async function fundMandalaToken(wallet: Wallet, assetId: string, amount: number): Promise<string> {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, amount, new Array(20).fill(7)) })
  asMined(tx)
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  const result = await wallet.internalizeAction(
    {
      tx: new Uint8Array(beef.toBinaryAtomic(txid)),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: MANDALA_BASKET,
            customInstructions: JSON.stringify({
              protocolID: [2, 'mandala token'],
              keyID: 'k',
              counterparty: 'self',
              direction: 'received'
            }),
            tags: ['mandala', 'received', assetId]
          }
        }
      ],
      description: 'I3 proof fixture: Mandala token'
    } as never,
    ADMIN
  )
  if ((result as { accepted?: boolean }).accepted !== true) throw new Error('mandala funding did not internalize')
  return `${txid}.0`
}

/**
 * Whether `outpoint` is still a spendable output in `basket`, per the real
 * wallet's own bookkeeping. Deliberately NOT `wallet.listActions` with
 * `includeInputs: true`: this repo's own `listActionsSql.ts` resolves each
 * input's sequence number via a dynamic `await import('@bsv/sdk')`
 * (core/storage/methods/listActionsSql.ts), which this plain-CJS Jest run
 * cannot execute ("A dynamic import callback was invoked without
 * --experimental-vm-modules") once an action actually has spent inputs.
 * `listOutputs` never goes through that code path, and is just as direct a
 * check for the property this file cares about: did spending happen to THIS
 * coin or not.
 */
async function isSpendable(wallet: Wallet, basket: string, outpoint: string): Promise<boolean> {
  const { outputs } = (await wallet.listOutputs(
    { basket, limit: 100, offset: 0 } as never,
    ADMIN
  )) as { outputs: { outpoint: string; spendable?: boolean }[] }
  const found = outputs.find(o => o.outpoint === outpoint)
  return !!found?.spendable
}

function newSession(prefix: string, suffix: string) {
  return mintSession({
    identityKey: PAYEE.identityKey,
    amount: PAY_AMOUNT,
    derivationPrefix: prefix,
    derivationSuffix: suffix,
    supportsAwdl: true
  })
}

describe('I3: localpay buildPaymentFrame never selects Vault funds', () => {
  it('I3: refuses to build when only a Vault output is available (insufficient funds)', async () => {
    const { wallet } = await makeWallet(101)
    await fundVault(wallet, VAULT_SATS, 1)

    const session = newSession(Utils.toBase64(Random(8)), Utils.toBase64(Random(8)))
    await expect(buildPaymentFrame(wallet as never, session, ADMIN, PAY_AMOUNT)).rejects.toThrow()
  })

  it('I3: spends the ordinary default-basket coin and never the Vault outpoint when both are available', async () => {
    const { wallet, keyDeriver } = await makeWallet(102)
    const vault = await fundVault(wallet, VAULT_SATS, 2)
    const funding = await fundDefault(wallet, keyDeriver, DEFAULT_SATS)

    const session = newSession(Utils.toBase64(Random(8)), Utils.toBase64(Random(8)))
    const built = await buildPaymentFrame(wallet as never, session, ADMIN, PAY_AMOUNT)

    const tx = Transaction.fromAtomicBEEF(Array.from(built.frame.transaction))
    const usedOutpoints = tx.inputs.map(i => `${i.sourceTXID}.${i.sourceOutputIndex}`)
    expect(usedOutpoints).toContain(funding.outpoint) // positive control: it CAN and DID spend the ordinary coin
    expect(usedOutpoints).not.toContain(vault.outpoint) // negative: the Vault coin, though available and ample, was not touched
  })
})

describe('I3: the handle/MessageBox rail (sendViaHandle) never selects Vault funds', () => {
  it('I3: refuses to build when only a Vault output is available', async () => {
    const { wallet } = await makeWallet(103)
    await fundVault(wallet, VAULT_SATS, 3)

    await expect(
      sendViaHandle({
        wallet: wallet as never,
        adminOriginator: ADMIN,
        client: { sendMessage: async () => undefined } as never,
        storage: memoryKvStorage(),
        recipient: PrivateKey.fromRandom().toPublicKey().toString(),
        satoshis: PAY_AMOUNT,
        messageBoxUrl: 'https://messagebox.invalid'
      })
    ).rejects.toThrow()
  })

  it('I3: spends the ordinary default-basket coin and never the Vault outpoint when both are available', async () => {
    const { wallet, keyDeriver } = await makeWallet(104)
    const vault = await fundVault(wallet, VAULT_SATS, 4)
    const funding = await fundDefault(wallet, keyDeriver, DEFAULT_SATS)

    const kv = memoryKvStorage()
    await sendViaHandle({
      wallet: wallet as never,
      adminOriginator: ADMIN,
      client: { sendMessage: async () => undefined } as never,
      storage: kv,
      recipient: PrivateKey.fromRandom().toPublicKey().toString(),
      satoshis: PAY_AMOUNT,
      messageBoxUrl: 'https://messagebox.invalid'
    })

    // The outbox row holds the exact AtomicBEEF `createAction` produced
    // (`token.transaction`) — reading it back avoids `wallet.listActions`
    // entirely (see `isSpendable`'s comment for why).
    const [entry] = await getOutboxEntries(kv)
    const tx = Transaction.fromAtomicBEEF(entry.token.transaction)
    const usedOutpoints = tx.inputs.map(i => `${i.sourceTXID}.${i.sourceOutputIndex}`)
    expect(usedOutpoints).toContain(funding.outpoint) // positive control
    expect(usedOutpoints).not.toContain(vault.outpoint) // negative
  })
})

describe('I3: the address rail (sendToAddress) never selects Vault funds', () => {
  it('I3: refuses to build when only a Vault output is available', async () => {
    const { wallet } = await makeWallet(105)
    await fundVault(wallet, VAULT_SATS, 5)

    await expect(
      sendToAddress({
        wallet: wallet as never,
        adminOriginator: ADMIN,
        address: PrivateKey.fromRandom().toAddress(),
        satoshis: PAY_AMOUNT
      })
    ).rejects.toThrow()
  })

  it('I3: spends the ordinary default-basket coin and never the Vault outpoint when both are available', async () => {
    const { wallet, keyDeriver } = await makeWallet(106)
    const vault = await fundVault(wallet, VAULT_SATS, 6)
    const funding = await fundDefault(wallet, keyDeriver, DEFAULT_SATS)

    await sendToAddress({
      wallet: wallet as never,
      adminOriginator: ADMIN,
      address: PrivateKey.fromRandom().toAddress(),
      satoshis: PAY_AMOUNT
    })

    // `sendToAddress` exposes neither the built transaction nor its inputs, so
    // isolation is checked by consequence: did spending happen to this coin?
    // (see `isSpendable`'s comment for why this replaces `listActions`.)
    expect(await isSpendable(wallet, 'default', funding.outpoint)).toBe(false) // positive control: it WAS spent
    expect(await isSpendable(wallet, VAULT_BASKET, vault.outpoint)).toBe(true) // negative: the Vault coin is untouched
  })
})

describe("I3: the Mandala/token spend path's input-selection never touches the Vault", () => {
  it('I3: listOutputs scoped to the Mandala basket returns the real coin and never the Vault outpoint', async () => {
    const { wallet } = await makeWallet(107)
    const vault = await fundVault(wallet, VAULT_SATS, 7)
    const assetId = `${'ab'.repeat(32)}.0`
    const tokenOutpoint = await fundMandalaToken(wallet, assetId, 250)

    // Exactly the query `listTokenBasket` (core/localpay/build.ts, used by
    // buildTokenPaymentFrame's coin selection) issues, scoped to the real
    // Mandala basket.
    const listed = (await wallet.listOutputs(
      { basket: MANDALA_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 10, offset: 0 } as never,
      ADMIN
    )) as { outputs: { outpoint: string }[] }
    const outpoints = listed.outputs.map(o => o.outpoint)
    expect(outpoints).toContain(tokenOutpoint) // positive control: the real coin is discoverable this way
    expect(outpoints).not.toContain(vault.outpoint) // negative: basket-scoping excludes the Vault coin
  })

  it('I3: MandalaToken.decode rejects the exact Vault R1C lock even if basket scoping were bypassed (defense in depth)', async () => {
    const { wallet } = await makeWallet(108)
    const vault = await fundVault(wallet, VAULT_SATS, 8)

    // Positive control: decode succeeds for a real Mandala token script —
    // proves the assertion below is a real rejection, not a broken decoder.
    const realTokenScript = new MandalaToken().lock(`${'cd'.repeat(32)}.0`, 99, new Array(20).fill(3))
    expect(() => MandalaToken.decode(realTokenScript)).not.toThrow()

    // Negative: the coin-selection loop in `buildTokenPaymentFrame`
    // (core/localpay/build.ts) wraps this exact call in try/catch and skips
    // any output that throws — so even a `listOutputs` result that somehow
    // included the Vault's exact lock could never become a selected coin.
    expect(() => MandalaToken.decode(LockingScript.fromHex(vault.lockHex))).toThrow()
  })
})

describe('I3: the offline pending-payment queue never credits into the Vault basket', () => {
  it('I3: a queued token frame is credited only into the Mandala basket, never the Vault basket, regardless of frame content', async () => {
    const { wallet } = await makeWallet(109)
    const vault = await fundVault(wallet, VAULT_SATS, 9)

    const assetId = `${'ef'.repeat(32)}.0`
    const tx = new Transaction()
    tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(assetId, 500, new Array(20).fill(5)) })
    asMined(tx)
    const beef = new Beef()
    beef.mergeTransaction(tx)

    // `internalizeOutput` (core/localpay/pending.ts) hardcodes
    // `basket: MANDALA_BASKET` into the insertionRemittance it builds — no
    // field of PaymentFrame maps to a basket name. These values are as
    // adversarial as the type allows, to demonstrate that none of them can
    // reach the basket decision.
    const frame: PaymentFrame = {
      version: FRAME_VERSION,
      kind: 'token',
      senderIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
      outputIndex: 0,
      derivationPrefix: Utils.toBase64(Utils.toArray(VAULT_BASKET, 'utf8')),
      derivationSuffix: Utils.toBase64(Utils.toArray('admin', 'utf8')),
      token: {
        assetId,
        overlayUrl: 'https://overlay.invalid',
        overlayIdentityKey: PrivateKey.fromRandom().toPublicKey().toString(),
        certificates: [],
        linkage: [],
        admissions: []
      },
      transaction: new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
    }

    const kv = memoryKvStorage()
    await savePending(kv, frame)
    const results = await processPending(wallet as never, kv, ADMIN)
    expect(results).toEqual([{ id: expect.any(String), success: true }])

    const mandala = (await wallet.listOutputs(
      { basket: MANDALA_BASKET, limit: 10, offset: 0 } as never,
      ADMIN
    )) as { outputs: { outpoint: string }[] }
    expect(mandala.outputs.length).toBeGreaterThan(0) // positive control: the queue mechanism does credit real coins

    const vaultAfter = (await wallet.listOutputs(
      { basket: VAULT_BASKET, limit: 10, offset: 0 } as never,
      ADMIN
    )) as { outputs: { outpoint: string }[] }
    expect(vaultAfter.outputs.map(o => o.outpoint)).toEqual([vault.outpoint]) // negative: still just the pre-seeded coin, nothing new
  })
})

describe('I3: guardVaultAccess and the storage backstop deny external discovery and mutation of the Vault', () => {
  it('I3: listActions hides the Vault-labeled action from a non-admin originator (positive control: an ordinary action is still visible)', async () => {
    const { wallet, keyDeriver } = await makeWallet(110)
    const vault = await fundVault(wallet, VAULT_SATS, 10)
    const funding = await fundDefault(wallet, keyDeriver, DEFAULT_SATS)

    const guarded = guardVaultAccess(wallet as never, ADMIN)
    const ext = (await guarded.listActions(
      { labels: [], includeOutputs: true, includeInputs: true, includeInputSourceLockingScripts: true, limit: 50, offset: 0 } as never,
      'evil.com'
    )) as { actions: { txid?: string }[] }
    const txids = ext.actions.map(a => a.txid)
    expect(txids).not.toContain(vault.txid)
    expect(txids).toContain(funding.txid)
  })

  it('I3: createAction refuses a non-admin originator naming the Vault outpoint as an input (positive control: an ordinary outpoint is accepted)', async () => {
    const { wallet } = await makeWallet(111)
    const vault = await fundVault(wallet, VAULT_SATS, 11)
    // An ordinary CUSTOM (unmanaged) output, not the wallet-managed BRC-29
    // change `fundDefault` produces — the toolbox refuses to let managed
    // change be named as an explicit `inputs[]` entry at all ("must be an
    // unmanaged input"), for any originator, which would make it useless as
    // a positive control here.
    const ordinary = await fundGeneralBasket(wallet, 'general', DEFAULT_SATS)

    const guarded = guardVaultAccess(wallet as never, ADMIN)
    await expect(
      guarded.createAction(
        {
          description: 'attempt',
          inputs: [{ outpoint: vault.outpoint, inputDescription: 'vault input', unlockingScriptLength: R1C_UNLOCK_LEN }],
          outputs: [],
          options: { noSend: true, signAndProcess: false }
        } as never,
        'evil.com'
      )
    ).rejects.toThrow(VaultAccessDenied)

    const ok = await guarded.createAction(
      {
        description: 'ordinary',
        inputBEEF: ordinary.inputBEEF,
        inputs: [{ outpoint: ordinary.outpoint, inputDescription: 'ordinary input', unlockingScriptLength: 108 }],
        outputs: [],
        options: { noSend: true, signAndProcess: false }
      } as never,
      'evil.com'
    )
    expect(ok).toBeTruthy()
  })

  it('I3: internalizeAction refuses a non-admin originator carrying a fresh R1C output (positive control: an ordinary output is accepted)', async () => {
    const { wallet } = await makeWallet(112)
    const guarded = guardVaultAccess(wallet as never, ADMIN)

    // A FRESH R1C-locked transaction — deliberately not one already resident
    // in this wallet's history — since `carriesR1COutput` inspects the
    // incoming transaction's own outputs and does not depend on any prior
    // Vault inventory.
    const freshSalt = saltHex(50)
    const freshLock = buildLock({
      commitments: [commitment(P256_PUBKEY, freshSalt)],
      saltHex64: freshSalt
    })
    const freshTx = new Transaction()
    freshTx.addOutput({ satoshis: 1000, lockingScript: freshLock })
    asMined(freshTx)
    const freshBeef = new Beef()
    freshBeef.mergeTransaction(freshTx)

    await expect(
      guarded.internalizeAction(
        {
          tx: new Uint8Array(freshBeef.toBinaryAtomic(freshTx.id('hex'))),
          outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'general' } }],
          description: 'attempt'
        } as never,
        'evil.com'
      )
    ).rejects.toThrow(VaultAccessDenied)

    const ordinaryTx = new Transaction()
    ordinaryTx.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) })
    asMined(ordinaryTx)
    const ordinaryBeef = new Beef()
    ordinaryBeef.mergeTransaction(ordinaryTx)
    const ok = await guarded.internalizeAction(
      {
        tx: new Uint8Array(ordinaryBeef.toBinaryAtomic(ordinaryTx.id('hex'))),
        outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'general' } }],
        description: 'ordinary'
      } as never,
      'evil.com'
    )
    expect((ok as { accepted?: boolean }).accepted).toBe(true)
  })

  // `guardVaultAccess` (core/services/vault/guard.ts) never wraps `listOutputs`
  // at all — by design, per its own module comment: Vault ownership is never
  // inferred from a basket name. Basket-scoped discovery for an EXTERNAL
  // BRC-100 caller is denied one layer further out, by the toolbox's own
  // `WalletPermissionsManager` (a BRC-100-standard rule, not app-specific:
  // `isAdminBasket` refuses any basket named `admin*` — see
  // node_modules/@bsv/wallet-toolbox-mobile's `ensureBasketAccess`) — and
  // production wraps guardVaultAccess AROUND that permissions manager, never
  // around the bare wallet (see WalletContext.tsx's
  // `guardVaultAccess(newManagers.permissionsManager, adminOriginator)`).
  // This test reproduces that exact layering rather than the bare wallet.
  it('I3: listOutputs on the admin vault basket is refused for a non-admin originator through the production wallet layering (positive control: an ordinary basket is listable)', async () => {
    const { wallet } = await makeWallet(113)
    await fundVault(wallet, VAULT_SATS, 13)
    await fundGeneralBasket(wallet, 'wallet ui prefs', 1000)

    // `seekBasketListingPermissions: false` only skips the INTERACTIVE
    // consent flow for an ordinary basket (no bound `onBasketAccessRequested`
    // handler would otherwise hang this test waiting on a prompt that never
    // arrives). It has no effect on the admin-basket rule under test: per
    // `ensureBasketAccess`'s own order of checks, `isAdminBasket` is
    // evaluated and throws BEFORE `isBasketUsageRequired`/this config flag is
    // ever consulted.
    const permissionsManager = new WalletPermissionsManager(wallet as never, ADMIN, {
      seekBasketListingPermissions: false
    } as never)
    const guarded = guardVaultAccess(permissionsManager as never, ADMIN)

    await expect(
      guarded.listOutputs({ basket: VAULT_BASKET, limit: 10, offset: 0 } as never, 'evil.com')
    ).rejects.toThrow(/admin-only/i)

    const ordinary = (await guarded.listOutputs(
      { basket: 'wallet ui prefs', limit: 10, offset: 0 } as never,
      'evil.com'
    )) as { outputs: unknown[] }
    expect(ordinary.outputs.length).toBeGreaterThan(0)
  })

  it('I3: the storage backstop alone refuses a Vault input even with the guard bypassed entirely (positive control: an ordinary outpoint is accepted)', async () => {
    const { wallet } = await makeWallet(114)
    const vault = await fundVault(wallet, VAULT_SATS, 14)
    // An ordinary CUSTOM (unmanaged) output — see the comment in the
    // `createAction` guard test above for why wallet-managed change cannot be
    // used as this positive control.
    const ordinary = await fundGeneralBasket(wallet, 'general', DEFAULT_SATS)

    // The RAW wallet, called directly — no `guardVaultAccess` in the middle
    // at all — simulating the external guard being bypassed entirely. The
    // originator is still non-admin, so `vargs.__bsvVaultAdminAuthorized`
    // (set inside the toolbox's patched createAction) is false, and
    // StorageExpoSQLite.validateResolvedActionInput must refuse on its own.
    await expect(
      wallet.createAction(
        {
          description: 'attempt',
          inputs: [{ outpoint: vault.outpoint, inputDescription: 'vault input', unlockingScriptLength: R1C_UNLOCK_LEN }],
          outputs: [],
          options: { noSend: true, signAndProcess: false }
        } as never,
        'evil.com'
      )
    ).rejects.toThrow(/internal wallet authorization/i)

    const ok = await wallet.createAction(
      {
        description: 'ordinary',
        inputBEEF: ordinary.inputBEEF,
        inputs: [{ outpoint: ordinary.outpoint, inputDescription: 'ordinary input', unlockingScriptLength: 108 }],
        outputs: [],
        options: { noSend: true, signAndProcess: false }
      } as never,
      'evil.com'
    )
    expect(ok).toBeTruthy()
  })
})
