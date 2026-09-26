/**
 * Physical-device report 2026-09-25: a Nearby payment failed with
 * "generateChangeSdk error: required fee error 23 !== 33".
 *
 * Cause (vendored @bsv/wallet-toolbox-mobile 2.14.0, generateChangeSdkCore):
 * surplus shaping split a single change output into outputs of exactly
 * changeInitialSatoshis (the basket's minimumDesiredUTXOValue, 32) — below
 * the dust floor (40 at 100 sat/kB). removeDustOutputs then stripped them,
 * shrinking the transaction without returning the fee paid for their bytes,
 * and validateGenerateChangeSdkResult rejected the overpaid plan. Fixed by a
 * patch-package hunk flooring every split output at the dust floor.
 *
 * The case: the payer holds ONE coin worth the payment plus a small surplus
 * (about 180 sats), in a wallet whose default change basket still carries
 * the legacy minimumDesiredUTXOValue of 32 — every wallet created before the
 * 2.14 bump (the toolbox only upgrades it to 5000 in its own migrations,
 * which StorageExpoSQLite does not run). Built through the real Wallet +
 * StorageExpoSQLite on real SQLite, exactly as verifyFrameEndToEnd.test.ts
 * does.
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

import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript, type ChainTracker } from '@bsv/sdk'
import { Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { buildPaymentFrame } from '../../core/localpay/build'
import { mintSession } from '../../core/localpay/session'
import { PEERPAY_PROTOCOL_ID } from '../../core/localpay/pending'

const ORIGINATOR = 'admin.example'
const PAY_AMOUNT = 100_000
const FUNDING_HEIGHT = 0
const FUNDING_PREFIX = 'ZnVuZHByZWZpeA=='
const FUNDING_SUFFIX = 'ZnVuZHN1ZmZpeA=='

async function payFromOneCoin(fundingSatoshis: number, dbName: string) {
  const payerKeyDeriver = new KeyDeriver(new PrivateKey(11))
  const payerIdentityKey = payerKeyDeriver.identityKey
  const storage = new StorageExpoSQLite({
    chain: 'test',
    identityKey: payerIdentityKey,
    databaseName: dbName,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 }
  } as never)
  await storage.migrate(dbName, payerIdentityKey)
  const storageManager = new WalletStorageManager(payerIdentityKey, storage as never)
  const signer = new WalletSigner('test' as never, payerKeyDeriver as never, storageManager)

  let fundingTx!: Transaction
  const tracker = (): ChainTracker => {
    const root = (fundingTx.merklePath as MerklePath).computeRoot(fundingTx.id('hex'))
    return {
      isValidRootForHeight: async (r: string, h: number) => r === root && h === FUNDING_HEIGHT,
      currentHeight: async () => FUNDING_HEIGHT + 100
    }
  }
  const services = {
    getChainTracker: async (): Promise<ChainTracker> => tracker(),
    getHeaderForHeight: async (height: number) => (height === FUNDING_HEIGHT ? new Uint8Array(80) : undefined),
    nLockTimeIsFinal: async () => true,
    getHeight: async () => FUNDING_HEIGHT + 100
  }
  const wallet = new Wallet(signer as never, services as never)

  const fundingSender = PrivateKey.fromRandom()
  const fundingPrivKey = payerKeyDeriver.derivePrivateKey(
    PEERPAY_PROTOCOL_ID as [2, string],
    `${FUNDING_PREFIX} ${FUNDING_SUFFIX}`,
    fundingSender.toPublicKey().toString()
  )
  fundingTx = new Transaction()
  fundingTx.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  fundingTx.addOutput({ satoshis: fundingSatoshis, lockingScript: new P2PKH().lock(fundingPrivKey.toAddress()) })
  fundingTx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(fundingTx.id('hex'), FUNDING_HEIGHT)
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
      description: 'fund the payer from one coin'
    } as never,
    ORIGINATOR
  )
  if ((internalized as { accepted?: boolean }).accepted !== true) throw new Error('funding not internalized')
  // The legacy basket default an existing wallet still has.
  await (storage as unknown as { db: { runAsync(sql: string): Promise<unknown> } }).db.runAsync(
    "UPDATE output_baskets SET minimumDesiredUTXOValue = 32 WHERE name = 'default'"
  )

  const payee = new KeyDeriver(new PrivateKey(22))
  const session = mintSession({
    identityKey: payee.identityKey,
    amount: PAY_AMOUNT,
    derivationPrefix: 'cGF5ZGVyaXZwcmVmaXg=',
    derivationSuffix: 'cGF5ZGVyaXZzdWZmaXg=',
    supportsAwdl: true
  })
  return await buildPaymentFrame(wallet as never, session, ORIGINATOR, PAY_AMOUNT)
}

describe('Nearby payment funded from one coin with a small surplus', () => {
  it.each([100_165, 100_180, 100_195, 100_260])('builds when the only coin holds %i sats', async funding => {
    const built = await payFromOneCoin(funding, `nearby-fee-${funding}`)
    expect(built.frame.kind).toBe('bsv')
    const tx = Transaction.fromAtomicBEEF(Array.from(built.frame.transaction))
    const paid = tx.outputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0)
    const fee = funding - paid
    // The fee is exactly what the size requires at 100 sat/kB: nothing lost to
    // stripped dust outputs, and every change output clears the dust floor.
    expect(fee).toBe(Math.ceil((tx.toBinary().length / 1000) * 100))
    for (const o of tx.outputs.filter(o => o.satoshis !== PAY_AMOUNT)) expect(o.satoshis).toBeGreaterThanOrEqual(40)
  }, 60_000)
})
