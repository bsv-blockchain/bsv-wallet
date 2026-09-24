/**
 * P0-1 end to end: an HONESTLY BUILT payment frame, produced by the REAL
 * payer-side toolbox (`@bsv/wallet-toolbox-mobile`'s `Wallet` +
 * `WalletStorageManager` + `WalletSigner` + this package's own
 * `StorageExpoSQLite`, against real SQLite), must pass `verifyFramePayment`'s
 * `tx.verify(chainTracker)` gate — not just a frame hand-assembled with SDK
 * primitives, as `verify.test.ts`'s P0-1 suite already covers.
 *
 * The reviewer's open question was whether `Wallet.createAction` /
 * `Wallet.signAction`'s `trustSelf: 'known'` default (which lets the STORAGE
 * layer merge a wallet-funded input as txid-only, since it trusts its own
 * records) can leak a txid-only ancestor into the AtomicBEEF this package's
 * `build.ts` hands to a payee — which `verifyFramePayment` now refuses
 * (P0-1, fail-closed). This test builds the payer's whole chain — a real
 * "mined" funding UTXO, internalized through the real `Wallet.internalizeAction`,
 * then spent through the real `buildPaymentFrame` (`createAction` with
 * `signAndProcess:false` → `signAction`) — and asserts the resulting frame's
 * AtomicBEEF carries the funding ancestor's raw bytes, not just its txid, by
 * running it through the SAME `verifyFramePayment` the payee actually calls.
 *
 * The second test below is the proof the first one is not vacuous: it takes
 * the SAME real frame and shows `verifyFramePayment` actually depends on the
 * payee's chain tracker recognising the ancestor — swap in a tracker that
 * does not, and the identical honest frame is refused.
 *
 * `expo-sqlite` is mocked onto `node:sqlite` exactly as
 * `__tests__/storage/repairSettledToken.test.ts` does, so `StorageExpoSQLite`
 * runs unmodified — real `migrate()`, real CRUD, real fund selection.
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
import { verifyFramePayment, type DerivingWallet } from '../../core/localpay/verify'
import { mintSession } from '../../core/localpay/session'
import { PEERPAY_PROTOCOL_ID } from '../../core/localpay/pending'
import type { PaymentFrame } from '../../core/localpay/codec'

const ORIGINATOR = 'admin.example'
const FUNDING_SATOSHIS = 100_000
const PAY_AMOUNT = 4200
const FUNDING_HEIGHT = 0

/** The funding output's own derivation nonces — distinct from the session's. */
const FUNDING_PREFIX = 'ZnVuZHByZWZpeA=='
const FUNDING_SUFFIX = 'ZnVuZHN1ZmZpeA=='

/**
 * A "mined" transaction: a single-leaf merkle path whose root is the tx's own
 * txid, current enough to clear `MerklePath.verify`'s 100-block rule. Same
 * construction as `verify.test.ts`'s `minedAncestor` / `trackerAccepting`.
 */
function asMined(tx: Transaction): void {
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), FUNDING_HEIGHT)
}

/** The chain tracker a payee who actually synced this funding tx's header would report. */
function trackerAccepting(tx: Transaction): ChainTracker {
  const root = (tx.merklePath as MerklePath).computeRoot(tx.id('hex'))
  return {
    isValidRootForHeight: async (r: string, h: number) => r === root && h === FUNDING_HEIGHT,
    currentHeight: async () => FUNDING_HEIGHT + 100
  }
}

/** A tracker that recognises no root at all — a payee whose header window never covers this ancestor. */
function trackerRejectingEverything(): ChainTracker {
  return {
    isValidRootForHeight: async () => false,
    currentHeight: async () => FUNDING_HEIGHT + 100
  }
}

/**
 * Builds one honest BSV payment frame end to end through the REAL toolbox:
 * a real `KeyDeriver`-backed payer `Wallet`, a real `StorageExpoSQLite`
 * (against real SQLite), a real "mined" funding UTXO internalized through
 * `Wallet.internalizeAction`, and this package's own `buildPaymentFrame`
 * (`createAction` noSend/signAndProcess:false → `signAction`).
 *
 * Returns the frame plus everything a payee needs to verify it for real:
 * the payee's own `KeyDeriver` (so `verifyFramePayment`'s BRC-42 derivation
 * is a genuine two-party agreement, not a fixed key the payer already knew)
 * and the funding transaction (so callers can build whichever chain tracker
 * they want to check `verifyFramePayment` against).
 */
async function buildHonestFrame(): Promise<{
  frame: PaymentFrame
  payeeKeyDeriver: KeyDeriver
  fundingTx: Transaction
}> {
  const payerKeyDeriver = new KeyDeriver(new PrivateKey(11))
  const payerIdentityKey = payerKeyDeriver.identityKey

  const storage = new StorageExpoSQLite({
    chain: 'test',
    identityKey: payerIdentityKey,
    databaseName: 'verify-e2e-test',
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 }
  } as never)
  await storage.migrate('verify-e2e-test', payerIdentityKey)

  const storageManager = new WalletStorageManager(payerIdentityKey, storage as never)
  const signer = new WalletSigner('test' as never, payerKeyDeriver as never, storageManager)

  // The one chain tracker the payer's own internalize is checked against — a
  // payee who actually synced this funding transaction's header would report
  // exactly the same thing (see `trackerAccepting` above).
  let fundingTx!: Transaction
  const services = {
    getChainTracker: async (): Promise<ChainTracker> => trackerAccepting(fundingTx),
    getHeaderForHeight: async (height: number) => (height === FUNDING_HEIGHT ? new Uint8Array(80) : undefined),
    nLockTimeIsFinal: async () => true,
    getHeight: async () => FUNDING_HEIGHT + 100
  }

  const wallet = new Wallet(signer as never, services as never)

  // Fund the payer: a real "mined" UTXO, paid to a BRC-29 script this
  // wallet's own KeyDeriver can unlock, internalized through the real
  // `Wallet.internalizeAction` exactly as an incoming payment would be.
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
      description: 'fund the payer wallet for the P0-1 e2e test'
    } as never,
    ORIGINATOR
  )
  if ((internalized as { accepted?: boolean }).accepted !== true) {
    throw new Error('internalizeAction did not accept the funding transaction')
  }

  // The payee's session: a real, independent identity, so the payment output
  // is a real BRC-42 agreement, not a fixed key the payer already knew.
  const payeeKeyDeriver = new KeyDeriver(new PrivateKey(22))
  const session = mintSession({
    identityKey: payeeKeyDeriver.identityKey,
    amount: PAY_AMOUNT,
    derivationPrefix: 'cGF5ZGVyaXZwcmVmaXg=',
    derivationSuffix: 'cGF5ZGVyaXZzdWZmaXg=',
    supportsAwdl: true
  })

  // The real build: `Wallet.createAction` (noSend, signAndProcess:false)
  // funded from the internalized UTXO above, then `Wallet.signAction`.
  const built = await buildPaymentFrame(wallet as never, session, ORIGINATOR, PAY_AMOUNT)

  return { frame: built.frame, payeeKeyDeriver, fundingTx }
}

/** A payee wallet doing the SAME real BRC-42 derivation `verifyFramePayment` requires, against `tracker`. */
function payeeWallet(payeeKeyDeriver: KeyDeriver, tracker: ChainTracker): DerivingWallet {
  return {
    getPublicKey: async (args: unknown) => {
      const a = args as { protocolID: [0 | 1 | 2, string]; keyID: string; counterparty: string; forSelf?: boolean }
      return {
        publicKey: payeeKeyDeriver.derivePublicKey(a.protocolID, a.keyID, a.counterparty, a.forSelf).toString()
      }
    },
    getServices: () => ({ getChainTracker: async () => tracker })
  }
}

describe('verifyFramePayment: end to end against the real payer-side toolbox (P0-1)', () => {
  it('accepts a frame the real Wallet/StorageExpoSQLite round trip actually produced', async () => {
    const { frame, payeeKeyDeriver, fundingTx } = await buildHonestFrame()
    expect(frame.kind).toBe('bsv')

    // The exact fact P0-1 depends on: the frame's AtomicBEEF carries the
    // funding ancestor's RAW bytes, not merely its txid.
    const framedBeef = Beef.fromBinaryStrict(Array.from(frame.transaction))
    const ancestorEntry = framedBeef.findTxid(fundingTx.id('hex'))
    expect(ancestorEntry).toBeTruthy()
    expect(ancestorEntry?.isTxidOnly).toBe(false)

    await expect(
      verifyFramePayment(payeeWallet(payeeKeyDeriver, trackerAccepting(fundingTx)), frame, ORIGINATOR)
    ).resolves.toEqual({
      kind: 'bsv',
      satoshis: PAY_AMOUNT
    })
  })

  // Proves the pass above is not vacuous: the identical real frame, checked
  // against a payee chain tracker that does not recognise the funding
  // ancestor's root, is refused — so acceptance in the first test is really
  // coming from `tx.verify(chainTracker)`, not from some earlier check alone.
  it('refuses the identical real frame when the payee’s tracker does not recognise the ancestor', async () => {
    const { frame, payeeKeyDeriver } = await buildHonestFrame()

    await expect(
      verifyFramePayment(payeeWallet(payeeKeyDeriver, trackerRejectingEverything()), frame, ORIGINATOR)
    ).rejects.toMatchObject({ name: 'FrameVerifyError', kind: 'unparseable' })
  })
})
