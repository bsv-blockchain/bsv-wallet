/**
 * The decoy-output finding, on every rail (plan-review finding; design §9 B7).
 *
 * Anyone can add a 1-sat 1Color output to a payment. When the broadcast hold
 * parked every transaction with ANY 1Color output, a payer could make the
 * payee's wallet hold a BSV credit instead of broadcasting it, and stay free
 * to double-spend its inputs. The hold now applies only where THIS wallet's
 * token custody is involved: a `color_transfers` row, a Mandala host-ledger
 * record (written before the lib internalizes a receipt), or an input spent
 * from one of its `p color` baskets.
 *
 * Each rail is driven through its OWN receive code over a REAL toolbox
 * `Wallet` on `StorageExpoSQLite` (node:sqlite), so the payment reaches the
 * real `internalizeAction` → `shareReqsWithWorld` → hold:
 *  · handle (MessageBox PeerPay inbox): `internalizeIncoming`;
 *  · direct (WebRTC): `receiveDirectPayment` with the real `@bsv/webrtpay`;
 *  · nearby (localpay): `verifyFramePayment` + `processPending`;
 *  · address (legacy sweep): the rail's own `wallet payment` internalize args.
 * A decoy-carrying BSV payment is broadcast and never queued; the same
 * transaction with this wallet's custody in it is held.
 */
const mockGetOnline = jest.fn(async () => true)
jest.mock('../../core/net/online', () => ({ getOnline: () => mockGetOnline() }))
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
  type ChainTracker,
  type WalletProtocol
} from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { Wallet, WalletSigner, WalletStorageManager } from '@bsv/wallet-toolbox-mobile'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { findOfflineActions } from '../../core/storage/methods/offlineActions'
import { internalizeIncoming } from '../../core/pay/rails/handle'
import { receiveDirectPayment } from '../../core/directpay/receive'
import { loadWebRTPay, setWebRTPayForTests } from '../../core/directpay/webrtpay'
import { PEERPAY_PROTOCOL_ID, processPending, savePending, type KVStorage } from '../../core/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import { verifyFramePayment } from '../../core/localpay/verify'
import { LEGACY_DERIVATION_SUFFIX, derivationPrefixFor } from '../../core/pay/rails/address'
import { HOST_LEDGER_RECORD_PREFIX } from '../../core/mandala/colorGuard'
import { createTransferJournal, type JournalDb } from '../../core/mandala/transferJournal'

const ADMIN = 'admin.example'
const HEIGHT = 0
const PREFIX = 'ZGVjb3lwcmVmaXg='
const SUFFIX = 'ZGVjb3lzdWZmaXg='
const PAY_SATS = 5_000
const DECOY_ASSET = `${'cd'.repeat(32)}_0`

function asMined(tx: Transaction): void {
  tx.merklePath = MerklePath.fromCoinbaseTxidAndHeight(tx.id('hex'), HEIGHT)
}

const tracker: ChainTracker = {
  isValidRootForHeight: async (_root: string, height: number) => height === HEIGHT,
  currentHeight: async () => HEIGHT + 100
}

function servicesWith(postBeef: jest.Mock) {
  return {
    getChainTracker: async () => tracker,
    getHeaderForHeight: async (height: number) => (height === HEIGHT ? new Uint8Array(80) : undefined),
    nLockTimeIsFinal: async () => true,
    getHeight: async () => HEIGHT + 100,
    postBeef
  }
}

function memoryKv(): KVStorage {
  const map = new Map<string, string>()
  return {
    getKeyValue: async k => map.get(k),
    setKeyValue: async (k, v) => {
      map.set(k, v)
    }
  }
}

let seed = 400

async function makeWallet() {
  seed++
  const keyDeriver = new KeyDeriver(new PrivateKey(seed))
  const identityKey = keyDeriver.identityKey
  const storage = new StorageExpoSQLite({
    chain: 'test',
    identityKey,
    databaseName: `decoy-${seed}`,
    commissionSatoshis: 0,
    feeModel: { model: 'sat/kb', value: 100 }
  } as never)
  await storage.migrate(`decoy-${seed}`, identityKey)
  const postBeef = jest.fn(async (_beef: unknown, txids: string[]) => [
    { txidResults: txids.map(txid => ({ txid, status: 'success' })) }
  ])
  const services = servicesWith(postBeef)
  storage.setServices(services as never)
  const storageManager = new WalletStorageManager(identityKey, storage as never)
  const signer = new WalletSigner('test' as never, keyDeriver as never, storageManager)
  const wallet = new Wallet(signer as never, services as never)
  Object.defineProperty(wallet, '__bsvVaultAdminOriginator', { value: ADMIN, enumerable: false })
  return { wallet, storage, keyDeriver, postBeef }
}

/**
 * An UNMINED payment of PAY_SATS to this wallet's BRC-29 key for (prefix,
 * suffix, sender), from a mined parent the sender owns, with a decoy 1-sat
 * 1Color output beside it.
 */
async function decoyPayment(keyDeriver: KeyDeriver, sender: PrivateKey, prefix = PREFIX, suffix = SUFFIX) {
  const payee = keyDeriver.derivePrivateKey(
    PEERPAY_PROTOCOL_ID as WalletProtocol,
    `${prefix} ${suffix}`,
    sender.toPublicKey().toString()
  )
  const parent = new Transaction()
  parent.addOutput({ satoshis: PAY_SATS + 500, lockingScript: new P2PKH().lock(sender.toAddress()) })
  asMined(parent)
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(sender) })
  tx.addOutput({ satoshis: PAY_SATS, lockingScript: new P2PKH().lock(payee.toAddress()) })
  tx.addOutput({
    satoshis: 1,
    lockingScript: new OneColor().lock(DECOY_ASSET, 1n, PrivateKey.fromRandom().toPublicKey().toHash() as number[])
  })
  await tx.sign()
  const beef = new Beef()
  beef.mergeTransaction(tx)
  const txid = tx.id('hex')
  return { tx, txid, atomic: beef.toBinaryAtomic(txid) }
}

async function queued(storage: StorageExpoSQLite): Promise<string[]> {
  return (await findOfflineActions(storage.sqliteDb as never, {})).map(r => r.txid)
}

const broadcastTxids = (postBeef: jest.Mock): string[] => postBeef.mock.calls.flatMap(c => c[1] as string[])

beforeEach(() => {
  mockGetOnline.mockResolvedValue(true)
})

afterEach(() => setWebRTPayForTests(undefined))

describe('a decoy 1Color output never makes the payee hold a BSV credit', () => {
  it('handle rail (MessageBox PeerPay inbox): internalizeIncoming broadcasts it', async () => {
    const { wallet, storage, keyDeriver, postBeef } = await makeWallet()
    const sender = PrivateKey.fromRandom()
    const p = await decoyPayment(keyDeriver, sender)
    const client = { acknowledgeMessage: jest.fn(async () => true) }
    const outcome = await internalizeIncoming(wallet as never, client as never, ADMIN, {
      messageId: 'm1',
      sender: sender.toPublicKey().toString(),
      token: {
        customInstructions: { derivationPrefix: PREFIX, derivationSuffix: SUFFIX },
        transaction: p.atomic,
        amount: PAY_SATS,
        outputIndex: 0
      }
    } as never)
    expect(outcome).toBe('credited')
    expect(broadcastTxids(postBeef)).toContain(p.txid)
    expect(await queued(storage)).toEqual([])
  })

  it('direct rail (WebRTC): receiveDirectPayment with the real @bsv/webrtpay broadcasts it', async () => {
    const { wallet, storage, keyDeriver, postBeef } = await makeWallet()
    const sender = PrivateKey.fromRandom()
    const p = await decoyPayment(keyDeriver, sender)
    const webrtpay = loadWebRTPay()
    expect(webrtpay).not.toBeNull()
    const receipt = await receiveDirectPayment({
      webrtpay: webrtpay!,
      wallet: wallet as never,
      originator: ADMIN,
      store: { storage: memoryKv(), identity: keyDeriver.identityKey, chain: 'test' },
      payment: {
        messageId: 'd1',
        sender: sender.toPublicKey().toString(),
        token: {
          customInstructions: { derivationPrefix: PREFIX, derivationSuffix: SUFFIX },
          transaction: p.atomic,
          amount: PAY_SATS,
          outputIndex: 0
        }
      } as never,
      classify: () => 'other' as never
    })
    expect(receipt).toMatchObject({ status: 'accepted', added: true })
    expect(broadcastTxids(postBeef)).toContain(p.txid)
    expect(await queued(storage)).toEqual([])
  })

  it('nearby rail (localpay): the frame verifies and processPending broadcasts it', async () => {
    const { wallet, storage, keyDeriver, postBeef } = await makeWallet()
    const sender = PrivateKey.fromRandom()
    const p = await decoyPayment(keyDeriver, sender)
    const frame: PaymentFrame = {
      version: FRAME_VERSION,
      kind: 'bsv',
      senderIdentityKey: sender.toPublicKey().toString(),
      outputIndex: 0,
      derivationPrefix: PREFIX,
      derivationSuffix: SUFFIX,
      transaction: Uint8Array.from(p.atomic)
    }
    await expect(verifyFramePayment({ wallet: wallet as never, chainTracker: tracker }, frame, ADMIN)).resolves.toEqual(
      {
        kind: 'bsv',
        satoshis: PAY_SATS
      }
    )
    const kv = memoryKv()
    await savePending(kv, frame, 'ble')
    expect(await processPending(wallet as never, kv, ADMIN)).toEqual([{ id: expect.any(String), success: true }])
    expect(broadcastTxids(postBeef)).toContain(p.txid)
    expect(await queued(storage)).toEqual([])
  })

  it('address rail (legacy sweep): its wallet-payment internalize broadcasts it', async () => {
    const { wallet, storage, keyDeriver, postBeef } = await makeWallet()
    // The address rail's own remittance: dated prefix, legacy suffix, the "anyone" sender.
    const anyone = new PrivateKey(1)
    const prefix = derivationPrefixFor('2026-10-24')
    const p = await decoyPayment(keyDeriver, anyone, prefix, LEGACY_DERIVATION_SUFFIX)
    const r = await wallet.internalizeAction(
      {
        tx: p.atomic,
        description: 'Payment to your address',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              senderIdentityKey: anyone.toPublicKey().toString(),
              derivationPrefix: prefix,
              derivationSuffix: LEGACY_DERIVATION_SUFFIX
            }
          }
        ],
        labels: ['legacy', 'inbound', 'bsvbrowser']
      },
      ADMIN
    )
    expect(r.accepted).toBe(true)
    expect(broadcastTxids(postBeef)).toContain(p.txid)
    expect(await queued(storage)).toEqual([])
  })
})

describe('the hold still applies where this wallet’s token custody is involved', () => {
  it('holds the same transaction when the host ledger recorded it (a receipt being credited)', async () => {
    const { wallet, storage, keyDeriver, postBeef } = await makeWallet()
    const sender = PrivateKey.fromRandom()
    const p = await decoyPayment(keyDeriver, sender)
    // What the lib's acceptHandover writes before it internalizes a receipt.
    await storage.setKeyValue(
      HOST_LEDGER_RECORD_PREFIX + p.txid,
      JSON.stringify({ v: 1, txid: p.txid, assetId: DECOY_ASSET, state: 'pending', outputs: [1], at: 1 })
    )
    const client = { acknowledgeMessage: jest.fn(async () => true) }
    await internalizeIncoming(wallet as never, client as never, ADMIN, {
      messageId: 'm2',
      sender: sender.toPublicKey().toString(),
      token: {
        customInstructions: { derivationPrefix: PREFIX, derivationSuffix: SUFFIX },
        transaction: p.atomic,
        amount: PAY_SATS,
        outputIndex: 0
      }
    } as never)
    expect(broadcastTxids(postBeef)).not.toContain(p.txid)
    expect(await queued(storage)).toEqual([p.txid])
  })

  it('a present but unreadable ledger record still counts as custody (fail closed)', async () => {
    const { storage, keyDeriver } = await makeWallet()
    const p = await decoyPayment(keyDeriver, PrivateKey.fromRandom())
    await storage.setKeyValue(HOST_LEDGER_RECORD_PREFIX + p.txid, '{not json')
    expect(await storage.colorHeldTxids([{ txid: p.txid, rawTx: p.tx.toBinary() }])).toEqual(new Set([p.txid]))
  })

  it('holds a transaction with a journal row until the row reads settled', async () => {
    const { storage, keyDeriver } = await makeWallet()
    const p = await decoyPayment(keyDeriver, PrivateKey.fromRandom())
    const journal = createTransferJournal(storage.sqliteDb as unknown as JournalDb)
    await journal.insert({
      txid: p.txid,
      role: 'received',
      assetId: DECOY_ASSET,
      units: 1n,
      outputIndex: 1,
      rail: 'handle',
      state: 'held',
      delivered: false
    })
    const req = [{ txid: p.txid, rawTx: p.tx.toBinary() }]
    expect(await storage.colorHeldTxids(req)).toEqual(new Set([p.txid]))
    await journal.advance(p.txid, ['held'], 'settled')
    expect(await storage.colorHeldTxids(req)).toEqual(new Set())
  })

  it('holds a transaction that spends an output of this wallet’s p color baskets (any originator)', async () => {
    const { wallet, storage, keyDeriver } = await makeWallet()
    // A token output in a `p color` basket of this wallet.
    const coin = new Transaction()
    coin.addOutput({ satoshis: 1, lockingScript: new OneColor().lock(DECOY_ASSET, 7n, new Array(20).fill(7)) })
    asMined(coin)
    const coinBeef = new Beef()
    coinBeef.mergeTransaction(coin)
    await wallet.internalizeAction(
      {
        tx: coinBeef.toBinaryAtomic(coin.id('hex')),
        outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'p color cdcdv0' } }],
        description: 'decoy fixture: a p color coin'
      },
      ADMIN
    )
    // A transaction of this wallet that spends it (as createAction marks inputs before any broadcast).
    const p = await decoyPayment(keyDeriver, PrivateKey.fromRandom())
    const db = storage.sqliteDb as unknown as {
      runAsync(sql: string, params: unknown[]): Promise<{ lastInsertRowId: number }>
    }
    const ins = await db.runAsync(
      `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
       VALUES ('n', 'n', 1, 'nosend', 'ref-spend', 1, -1, ?)`,
      [p.txid]
    )
    await db.runAsync(`UPDATE outputs SET spentBy = ? WHERE txid = ? AND vout = 0`, [
      ins.lastInsertRowId,
      coin.id('hex')
    ])
    expect(await storage.colorHeldTxids([{ txid: p.txid, rawTx: p.tx.toBinary() }])).toEqual(new Set([p.txid]))
  })
})
