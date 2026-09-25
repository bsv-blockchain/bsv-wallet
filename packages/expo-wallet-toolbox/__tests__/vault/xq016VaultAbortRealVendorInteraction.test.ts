/**
 * XQ-016 (review follow-up) — the fixer report for the vendor `abortAction`
 * fail-open fix (see __tests__/storage/abortActionChainStatus.test.ts) claimed
 * "Vault's own abortAction calls only ever target strictly unsigned
 * (never-broadcast) actions ... unaffected (I1-I3 unchanged)". That claim was
 * FACTUALLY WRONG and is corrected here, not repeated:
 *
 *   `core/services/vault/transfers.ts`'s `ABORTABLE` set is
 *   `new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])` — it explicitly
 *   includes `'nosend'` — and `freeReservedInputs` (reachable from the live
 *   withdrawal-creation retry path in `createSignableVaultTx`, itself reached
 *   from `withdrawFromVault`/`relockVault`) calls the real vendor
 *   `abortAction` on any `ABORTABLE` orphan action found to be holding a vault
 *   outpoint this withdrawal wants. A `nosend` orphan is exactly the case
 *   XQ-016's fix changed the behavior of. Every existing Vault test
 *   (`__tests__/vault/transfers.test.ts` and friends) drives a FAKE
 *   `VaultWallet` whose `abortAction` is a bare `jest.fn()`, so none of them
 *   ever exercised the real vendor code this way.
 *
 * This test drives `freeReservedInputs` directly (exported from transfers.ts
 * for exactly this purpose) against a REAL `@bsv/wallet-toolbox-mobile`
 * `Wallet` + `WalletStorageManager` + `WalletSigner` + `StorageExpoSQLite`
 * (real SQLite via `node:sqlite`, same harness as
 * `abortActionChainStatus.test.ts`), with a real signed `nosend` orphan action
 * reserving the vault outpoint and a `getStatusForTxids` stub that throws —
 * the exact "chain status cannot be established" condition XQ-016 fixed.
 *
 * The `nosend` case below passes `storage.findSpendingReferences` as
 * `freeReservedInputs`' `findSpendingReferences` — the SAME real,
 * `StorageExpoSQLite`-backed indexed lookup `VaultScreen.tsx` /
 * `VaultTransferScreen.tsx` inject in the live app, not a test stub — so the
 * reservation-heal query itself is production code too, not just the
 * `abortAction` call at the end of it. (The OTHER path,
 * `abortReservingOutpoints`'s `w.listActions({ includeInputs: true })` scan
 * fallback, is exercised by the control test below instead: for a `nosend`
 * action specifically it also works at runtime, but under this Jest
 * environment's CJS transform it trips an unrelated, pre-existing limitation
 * — `core/storage/methods/listActionsSql.ts` does `await import('@bsv/sdk')`
 * to read a signed transaction's sequence number, which needs
 * `--experimental-vm-modules` to run under `ts-jest`/`babel-jest`'s current
 * config. That is a Jest-only gap, not a production bug: Metro/Node both
 * support dynamic `import()` natively. It only surfaces once an action's raw
 * tx is actually written, which is why the control test's still-`'unsigned'`
 * orphan — which has no raw tx yet — hits that same scan path cleanly.)
 *
 * VERDICT (verified by this test, not just traced by hand): the interaction
 * is benign. `freeReservedInputs`'s own `abortActions` loop marks a reference
 * "aborted" the instant it decides to call `abortAction` on it — BEFORE
 * awaiting the result — and swallows any rejection into a `console.log`. So
 * when the real, patched `abortAction` now fails closed and throws, this
 * Vault-side retry-heal path still reports the orphan as "freed" even though
 * its input was NOT actually released. That miscount is a real, PRE-EXISTING
 * quirk in `transfers.ts` (it would misfire identically for ANY `abortAction`
 * rejection reason, not just this one, and predates the XQ-016 vendor patch
 * entirely) — flagged separately as a follow-up, not fixed here, since it is
 * an unrelated root cause and does not threaten I1/I2/I3: the observable
 * effect is that `createSignableVaultTx`'s single retry then fails the SAME
 * way (the input is still reserved), and that failure propagates as an
 * ordinary thrown error to the withdrawal caller — a failed retry, never a
 * silent spend, and never a released reservation while chain status is
 * genuinely unknown. That is the load-bearing assertion below.
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
  const registry: Map<string, InstanceType<typeof TestDatabase>> = ((globalThis as Record<string, unknown>)
    .__xq016VaultTestDbs as never) ?? new Map()
  ;(globalThis as Record<string, unknown>).__xq016VaultTestDbs = registry
  return {
    openDatabaseAsync: async (name: string) => {
      const db = new TestDatabase()
      registry.set(name, db)
      return db
    }
  }
})
jest.mock('../../core/diskSpace', () => ({ diskPressure: () => 'ok' }))
// transfers.ts pulls in vaultStore/ceremonyHost/toolboxConfig/backup-preference
// at import time; none of those systems are exercised by this test (it calls
// `freeReservedInputs` directly, never a ceremony or config gate), but they
// require native modules this jest environment does not have — mocked exactly
// as __tests__/vault/transfers.test.ts does for the same reason.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v }),
      deleteItemAsync: jest.fn(async (k: string) => { delete store[k] }),
      __clear: () => { for (const k of Object.keys(store)) delete store[k] }
    }
  })()
}))
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  requestVaultSigner: jest.fn(),
  noteVaultProgress: jest.fn()
}))
jest.mock('../../core/toolboxConfig', () => ({
  getBackupUrl: jest.fn(() => 'https://backup.example'),
  isVaultEnabled: jest.fn(() => true),
  isVaultAvailable: jest.fn(() => true)
}))
jest.mock('../../core/backup/preference', () => ({
  isBackupPushEnabled: jest.fn(async () => true)
}))

import {
  Beef,
  KeyDeriver,
  MerklePath,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript,
  type ChainTracker
} from '@bsv/sdk'
import { Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { buildPaymentFrame } from '../../core/localpay/build'
import { mintSession } from '../../core/localpay/session'
import { PEERPAY_PROTOCOL_ID } from '../../core/localpay/pending'
import { freeReservedInputs, type VaultWallet } from '../../core/services/vault/transfers'

const ORIGINATOR = 'admin.example'
const FUNDING_SATOSHIS = 100_000
const PAY_AMOUNT = 4200
const FUNDING_HEIGHT = 0
const FUNDING_PREFIX = 'ZnVuZHByZWZpeA=='
const FUNDING_SUFFIX = 'ZnVuZHN1ZmZpeA=='

function asMined(tx: Transaction): void {
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), FUNDING_HEIGHT)
}

function trackerAccepting(tx: Transaction): ChainTracker {
  const root = (tx.merklePath as MerklePath).computeRoot(tx.id('hex'))
  return {
    isValidRootForHeight: async (r: string, h: number) => r === root && h === FUNDING_HEIGHT,
    currentHeight: async () => FUNDING_HEIGHT + 100
  }
}

/**
 * A real payer `Wallet` over a real `StorageExpoSQLite`, funded with a real
 * "mined" UTXO internalized through `Wallet.internalizeAction` — identical
 * setup to `abortActionChainStatus.test.ts`'s `setupFundedWallet`, plus the
 * funding outpoint string this test needs to stand in for a "wedged vault
 * outpoint" (transfers.ts has no concept of what locks the coin; the reserve/
 * abort machinery under test works purely off outpoints and action rows).
 */
async function setupFundedWallet(seed: number) {
  const payerKeyDeriver = new KeyDeriver(new PrivateKey(seed))
  const payerIdentityKey = payerKeyDeriver.identityKey

  const dbName = `xq-016-vault-test-${seed}`
  const storage = new StorageExpoSQLite({
    chain: 'test',
    identityKey: payerIdentityKey,
    databaseName: dbName,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 }
  } as never)
  await storage.migrate(dbName, payerIdentityKey)

  // Same pre-existing, separately-flagged schema-drift workaround as
  // abortActionChainStatus.test.ts — this package's `transactions` table has
  // never added the vendor's BRC-177 columns, which blocks any 'failed'
  // transition (including a rejected abortAction's own invalidation attempt)
  // on the real app schema. Added to this test's own throwaway database only.
  const registry = (globalThis as Record<string, unknown>).__xq016VaultTestDbs as
    | Map<string, { execAsync(sql: string): Promise<void> }>
    | undefined
  const rawDb = registry?.get(dbName)
  if (!rawDb) throw new Error('test setup: could not reach the underlying in-memory database')
  await rawDb.execAsync('ALTER TABLE transactions ADD COLUMN noSendExpiryState TEXT')
  await rawDb.execAsync('ALTER TABLE transactions ADD COLUMN noSendExpiryReclaimTxid TEXT')

  const storageManager = new WalletStorageManager(payerIdentityKey, storage as never)
  const signer = new WalletSigner('test' as never, payerKeyDeriver as never, storageManager)

  let fundingTx!: Transaction
  const getStatusForTxids = jest.fn()
  const services = {
    getChainTracker: async (): Promise<ChainTracker> => trackerAccepting(fundingTx),
    getHeaderForHeight: async (height: number) => (height === FUNDING_HEIGHT ? new Uint8Array(80) : undefined),
    nLockTimeIsFinal: async () => true,
    getHeight: async () => FUNDING_HEIGHT + 100,
    getStatusForTxids
  }

  const wallet = new Wallet(signer as never, services as never)

  const fundingSender = PrivateKey.fromRandom()
  const fundingKeyID = `${FUNDING_PREFIX} ${FUNDING_SUFFIX}`
  const fundingPrivKey = payerKeyDeriver.derivePrivateKey(
    PEERPAY_PROTOCOL_ID as [2, string],
    fundingKeyID,
    fundingSender.toPublicKey().toString()
  )
  fundingTx = new Transaction()
  fundingTx.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: UnlockingScript.fromHex('')
  })
  fundingTx.addOutput({ satoshis: FUNDING_SATOSHIS, lockingScript: new P2PKH().lock(fundingPrivKey.toAddress()) })
  asMined(fundingTx)

  const fundingBeef = new Beef()
  fundingBeef.mergeTransaction(fundingTx)

  const internalized = await wallet.internalizeAction(
    {
      tx: new Uint8Array(fundingBeef.toBinaryAtomic(fundingTx.id('hex'))),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: FUNDING_PREFIX,
            derivationSuffix: FUNDING_SUFFIX,
            senderIdentityKey: fundingSender.toPublicKey().toString()
          }
        }
      ],
      description: 'fund the payer wallet for the XQ-016 vault-interaction test'
    } as never,
    ORIGINATOR
  )
  if ((internalized as { accepted?: boolean }).accepted !== true) {
    throw new Error('internalizeAction did not accept the funding transaction')
  }

  return { wallet, storage, getStatusForTxids, fundingOutpoint: `${fundingTx.id('hex')}.0` }
}

/** Same load-bearing check as abortActionChainStatus.test.ts: the funding
 * output's own `spendable` state. */
async function fundingOutputSpendable(storage: StorageExpoSQLite): Promise<boolean> {
  const rows = (await (storage as unknown as { findOutputs: (a: unknown) => Promise<{ spendable: boolean }[]> })
    .findOutputs({ partial: { transactionId: 1 } })) as { spendable: boolean }[]
  if (rows.length !== 1) throw new Error(`expected exactly one funding output, found ${rows.length}`)
  return rows[0].spendable
}

describe('XQ-016 review follow-up: freeReservedInputs against the REAL (non-mocked) vendor abortAction', () => {
  it('does not free a vault outpoint reserved by a real signed nosend orphan when chain status cannot be established', async () => {
    const { wallet, storage, getStatusForTxids, fundingOutpoint } = await setupFundedWallet(701)

    // A real signed `nosend` action reserving the vault outpoint — standing
    // in for an orphaned withdrawal attempt left behind by a prior failed
    // vault transfer. Built exactly like a live payment (buildPaymentFrame),
    // matching how a genuine 'nosend' reservation is produced in this app.
    const session = mintSession({
      identityKey: new KeyDeriver(new PrivateKey(802)).identityKey,
      amount: PAY_AMOUNT,
      derivationPrefix: 'cGF5ZGVyaXZwcmVmaXg=',
      derivationSuffix: 'cGF5ZGVyaXZzdWZmaXg=',
      supportsAwdl: true
    })
    const built = await buildPaymentFrame(wallet as never, session, ORIGINATOR, PAY_AMOUNT)
    expect(built.reference).toBeTruthy()
    expect(await fundingOutputSpendable(storage)).toBe(false)

    // The chain-status service is down for the retry-heal's abort attempt —
    // exactly the condition XQ-016 fixed the vendor's abortAction for.
    getStatusForTxids.mockImplementation(async () => {
      throw new Error('status service unreachable')
    })

    // Simulate the shape of error createAction throws when it refuses to
    // spend an outpoint another (in this case, the nosend orphan's) action
    // still reserves — the real trigger for transfers.ts's retry-heal path.
    const wedgedError = new Error(`must be spendable output ${fundingOutpoint}`)

    // The real, production-wired lookup (see header) rather than the
    // listActions-scan fallback — see this file's header for why.
    const findSpendingReferences = storage.findSpendingReferences.bind(storage)

    const freed = await freeReservedInputs(
      wallet as unknown as VaultWallet,
      ORIGINATOR,
      wedgedError,
      [fundingOutpoint],
      findSpendingReferences
    )

    // The REAL, load-bearing assertion, previously unverified by any test:
    // the reservation must still be in place. The vendor's real abortAction
    // (reached through Vault's own retry-heal path, not mocked) fails closed
    // and does NOT invalidate the nosend orphan while its chain status is
    // unknown — so the outpoint stays reserved rather than being silently
    // freed for a re-spend that could race a broadcast already in flight.
    expect(await fundingOutputSpendable(storage)).toBe(false)

    // Documents the exact, separately-flagged miscount described in this
    // file's header: `freeReservedInputs` still reports 1 "freed" reference
    // here, because `abortActions` marks it aborted before awaiting
    // `abortAction`'s outcome. This is why the caller in
    // `createSignableVaultTx` would retry `createOnce()` once more — and,
    // because the input is genuinely still reserved, that retry fails the
    // same way, propagating as an ordinary error rather than ever completing
    // a spend. Asserted here so a future change to that counting behavior
    // must consciously update this documented interaction.
    expect(freed).toBe(1)

    // Confirms the real, non-mocked chain-status gate was actually consulted
    // through Vault's path (retried once, per abortAction's existing
    // retry-chain-check plumbing), not bypassed.
    expect(getStatusForTxids).toHaveBeenCalledTimes(2)
  })

  it('control: frees the outpoint when the orphan is genuinely unsigned (never reaches the chain-status gate)', async () => {
    const { wallet, storage, getStatusForTxids, fundingOutpoint } = await setupFundedWallet(703)

    getStatusForTxids.mockImplementation(async () => {
      throw new Error('status service unreachable')
    })

    // An action reserving the SAME funding outpoint (auto-selected — the
    // wallet holds exactly one UTXO), deliberately left unsigned
    // (signAndProcess: false, no follow-up signAction). It stays 'unsigned',
    // which is ABORTABLE without ever consulting chain status — the same
    // never-broadcast case the existing control in
    // abortActionChainStatus.test.ts covers, now proven through Vault's own
    // retry-heal path rather than a direct abortAction call.
    const created = (await wallet.createAction(
      {
        description: 'XQ-016 vault-interaction control: never signed',
        outputs: [
          { lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(), satoshis: 1000, outputDescription: 'control output' }
        ],
        options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
      },
      ORIGINATOR
    )) as { signableTransaction?: { reference: string } }
    expect(created.signableTransaction?.reference).toBeTruthy()
    expect(await fundingOutputSpendable(storage)).toBe(false)

    const wedgedError = new Error(`must be spendable output ${fundingOutpoint}`)
    const freed = await freeReservedInputs(wallet as unknown as VaultWallet, ORIGINATOR, wedgedError, [fundingOutpoint])

    expect(freed).toBe(1)
    expect(await fundingOutputSpendable(storage)).toBe(true)
    expect(getStatusForTxids).not.toHaveBeenCalled()
  })
})
