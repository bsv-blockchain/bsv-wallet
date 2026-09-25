/**
 * XQ-016 — `@bsv/wallet-toolbox-mobile`'s `StorageProvider.abortAction`
 * (`out/index.mobile.cjs`, `observeAbortChainProtection` / `abortAction`)
 * fails OPEN when it cannot learn a `nosend` transaction's real chain status:
 * `observeAbortChainProtection` swallows any thrown/timed-out/non-success
 * `services.getStatusForTxids` call into `serviceUnreachable = true` with
 * `chainStatus` left `undefined`, and `abortAction` then treats anything
 * other than exactly `'mined'`/`'known'` as safe to invalidate — including
 * "the status service is down" — invalidating the action and unconditionally
 * flipping its reserved inputs back to `spendable: true`.
 *
 * A `nosend` action is, by construction, one this wallet chose not to
 * broadcast itself but may have handed to someone else (PeerPay/handle,
 * LocalPay/nearby) who broadcasts it independently. If that independent
 * broadcast has already landed, or simply hasn't propagated to whichever
 * provider `getStatusForTxids` asks, at the exact moment the status service
 * is unreachable, this fail-open lets the payer's own wallet free and
 * re-spend inputs that already back a payment someone else may complete —
 * a double-spend race, not merely a stuck balance.
 *
 * This test drives the REAL patched vendor code path — a real
 * `StorageExpoSQLite` (real SQLite via `node:sqlite`), a real `Wallet` +
 * `WalletStorageManager` + `WalletSigner`, a real funded, signed `nosend`
 * action built the same way `core/localpay/build.ts`'s `buildPaymentFrame`
 * builds one for a live nearby payment — with a services stub whose
 * `getStatusForTxids` throws, exactly as the brief's evidence describes.
 *
 * `expo-sqlite` is mocked onto `node:sqlite` exactly as
 * `__tests__/storage/repairSettledToken.test.ts` and
 * `__tests__/localpay/verifyFrameEndToEnd.test.ts` do, so `StorageExpoSQLite`
 * runs unmodified — real `migrate()`, real CRUD, real fund selection, real
 * `abortAction`.
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
  // Keyed by dbName so the test can reach back into the exact underlying
  // in-memory database `StorageExpoSQLite.migrate()` just created.
  const registry: Map<string, InstanceType<typeof TestDatabase>> = ((globalThis as Record<string, unknown>)
    .__xq016TestDbs as never) ?? new Map()
  ;(globalThis as Record<string, unknown>).__xq016TestDbs = registry
  return {
    openDatabaseAsync: async (name: string) => {
      const db = new TestDatabase()
      registry.set(name, db)
      return db
    }
  }
})
jest.mock('../../core/diskSpace', () => ({ diskPressure: () => 'ok' }))

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
 * "mined" UTXO internalized through `Wallet.internalizeAction` — everything
 * `buildPaymentFrame` needs to build and sign a genuine `nosend` action, the
 * same way a live nearby payment does. `getStatusForTxids` is a bare
 * `jest.fn()` the caller configures per test, so the funding/build phase
 * (which never calls it) is unaffected by whatever behavior a test later
 * gives it for the abort phase.
 */
async function setupFundedWallet(seed: number) {
  const payerKeyDeriver = new KeyDeriver(new PrivateKey(seed))
  const payerIdentityKey = payerKeyDeriver.identityKey

  const dbName = `xq-016-test-${seed}`
  const storage = new StorageExpoSQLite({
    chain: 'test',
    identityKey: payerIdentityKey,
    databaseName: dbName,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 }
  } as never)
  await storage.migrate(dbName, payerIdentityKey)

  // This package's `transactions` table (core/storage/schema/createTables.ts)
  // predates @bsv/wallet-toolbox-mobile's BRC-177 columns and has never added
  // them, because this app does not use BRC-177 early-reclaim actions. But
  // `StorageProvider.updateTransactionStatus`'s generic 'failed' path
  // (shared by every abort/failure, not just BRC-177 ones) unconditionally
  // queries `noSendExpiryReclaimTxid` via `protectNoSendExpiryReclaimInputOnFailure`
  // — so on the real app schema that query throws "no such column" instead of
  // returning "no match", and NO 'failed' transition (this ledger row's fix
  // included) can complete. That is a real, separate schema-drift bug this
  // ledger row does not fix (flagged separately) — added here, in the test's
  // own database only, purely so this test can exercise XQ-016's actual
  // target (`observeAbortChainProtection` / `abortAction`) rather than being
  // blocked by that unrelated gap.
  const registry = (globalThis as Record<string, unknown>).__xq016TestDbs as
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
      description: 'fund the payer wallet for the XQ-016 test'
    } as never,
    ORIGINATOR
  )
  if ((internalized as { accepted?: boolean }).accepted !== true) {
    throw new Error('internalizeAction did not accept the funding transaction')
  }

  return { wallet, storage, getStatusForTxids }
}

/**
 * The FUNDING transaction's own output's current `spendable` state. The
 * funding transaction is always the first one written to a fresh database
 * (`transactionId: 1`), so this tracks the exact output XQ-016 is about,
 * rather than every `spendable: false` row — a failed transaction's OWN
 * (never-broadcast) outputs are correctly marked non-spendable too
 * (`markFailedTransactionOutputsNotSpendable`), which is unrelated to
 * whether the INPUT it tried to spend was released.
 */
async function fundingOutputSpendable(storage: StorageExpoSQLite): Promise<boolean> {
  const rows = (await (storage as unknown as { findOutputs: (a: unknown) => Promise<{ spendable: boolean }[]> })
    .findOutputs({ partial: { transactionId: 1 } })) as { spendable: boolean }[]
  if (rows.length !== 1) throw new Error(`expected exactly one funding output, found ${rows.length}`)
  return rows[0].spendable
}

describe('XQ-016: vendor abortAction fails closed when chain status cannot be established', () => {
  it('refuses the abort and keeps the inputs reserved when getStatusForTxids throws for a real signed nosend action', async () => {
    const { wallet, storage, getStatusForTxids } = await setupFundedWallet(101)

    // A real signed `nosend` action, funded from the internalized UTXO above —
    // byte-identical to what a live LocalPay/nearby build produces.
    const session = mintSession({
      identityKey: new KeyDeriver(new PrivateKey(202)).identityKey,
      amount: PAY_AMOUNT,
      derivationPrefix: 'cGF5ZGVyaXZwcmVmaXg=',
      derivationSuffix: 'cGF5ZGVyaXZzdWZmaXg=',
      supportsAwdl: true
    })
    const built = await buildPaymentFrame(wallet as never, session, ORIGINATOR, PAY_AMOUNT)
    expect(built.txid).toBeTruthy()
    expect(built.reference).toBeTruthy()

    // The funding input is reserved the moment the nosend action is built.
    expect(await fundingOutputSpendable(storage)).toBe(false)

    // The chain-status service is down for the abort attempt: every call
    // throws, exactly as a network outage or a timed-out provider would.
    getStatusForTxids.mockImplementation(async () => {
      throw new Error('status service unreachable')
    })

    // FAIL CLOSED: abortAction must refuse, not silently invalidate the
    // action and free the inputs.
    await expect(wallet.abortAction({ reference: built.reference! }, ORIGINATOR)).rejects.toThrow()

    // The load-bearing assertion: the reservation is untouched. On the
    // unfixed vendor code this input comes back `spendable: true` instead.
    expect(await fundingOutputSpendable(storage)).toBe(false)

    // Confirms the refusal actually came from the chain-status gate: it was
    // consulted, and retried once (abortAction's existing retry-chain-check
    // loop) before giving up — exactly the same shape as its pre-existing
    // identity-mismatch retry, not a new error path.
    expect(getStatusForTxids).toHaveBeenCalledTimes(2)
  })

  it('control: an action that was never signed/broadcast can still be aborted even while the chain-status service is down', async () => {
    const { wallet, storage, getStatusForTxids } = await setupFundedWallet(103)

    // The chain-status service is already down before the action even exists.
    getStatusForTxids.mockImplementation(async () => {
      throw new Error('status service unreachable')
    })

    // Built but deliberately never signed — `signAndProcess: false` and no
    // follow-up `signAction`, so the stored transaction stays `'unsigned'`,
    // never reaches `'nosend'`, and therefore never needed a chain-status
    // opinion at all. This is the "genuinely never-broadcast/unsigned
    // action" the fix must leave alone.
    const created = (await wallet.createAction(
      {
        description: 'XQ-016 control: never signed',
        outputs: [
          {
            lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
            satoshis: 1000,
            outputDescription: 'control output'
          }
        ],
        options: { randomizeOutputs: false, noSend: true, signAndProcess: false }
      },
      ORIGINATOR
    )) as { signableTransaction?: { reference: string } }
    const reference = created.signableTransaction?.reference
    expect(reference).toBeTruthy()

    expect(await fundingOutputSpendable(storage)).toBe(false)

    await expect(wallet.abortAction({ reference: reference! }, ORIGINATOR)).resolves.toEqual({ aborted: true })

    expect(await fundingOutputSpendable(storage)).toBe(true)

    // The chain-status gate is specific to `'nosend'` transactions with a
    // txid; an unsigned action never reaches it.
    expect(getStatusForTxids).not.toHaveBeenCalled()
  })
})
