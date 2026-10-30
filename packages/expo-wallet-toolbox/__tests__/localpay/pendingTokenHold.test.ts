/**
 * A pending nearby token payment on the PAYER is held from broadcast until the
 * journal reads `settled` (plan 07 Task 15, W1).
 *
 * The payer hands over a signed `noSend` tx and then parks it, holds it, or
 * releases a park, in any order a screen and a crash allow. Every one of those
 * moves goes through the runtime's `nearby.onHandedOver` into the one durable
 * host record, `color_transfers`, and the broadcast hold (`colorHeldTxids`)
 * reads that same record. These tests use REAL SQLite (`createTables`), the
 * real journal, the real runtime hooks (`createNearbyPayer`) and the real
 * `payerHold` functions over the real `offline_actions` table: only the lib's
 * `sendHandover` is mocked, because it needs a module-hosting wallet.
 *
 * What is pinned:
 *  · `handover` journals `built` with the receipt custody, after checking the
 *    hand-over is bound to the session's remittance and pays output 0;
 *  · a journal fault, a foreign duplicate row or an unbound hand-over releases
 *    the signed action (nobody has its bytes yet) and throws;
 *  · `onHandedOver` is forward-only and idempotent: built → parked →
 *    handed_over, a repeat or a later state is a success, a cancelled or
 *    missing row is a failure (so the queue row is never promoted for it);
 *  · at built, parked and handed_over the tx is held; only settled releases it.
 */
jest.mock('@bsv/mandala', () => {
  const actual = jest.requireActual('@bsv/mandala')
  return { ...actual, sendHandover: jest.fn() }
})

import type { DatabaseSync } from 'node:sqlite'
import { P2PKH, PrivateKey, Transaction, type WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import {
  createHostLedger,
  handoverBody,
  receiptOfBody,
  sendHandover,
  type HandoverResult,
  type HostLedger
} from '@bsv/mandala'
import { createNearbyPayer } from '../../core/mandala/nearby'
import { createHandoverBodies } from '../../core/mandala/handle'
import { colorHeldTxids } from '../../core/mandala/colorGuard'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import { holdSentPaymentOffline, parkSentPaymentOffline, releaseParkedPayment } from '../../core/offline/payerHold'
import { findOfflineActionByTxid } from '../../core/storage/methods/offlineActions'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { TaskSendOffline } from '../../core/monitor/TaskSendOffline'
import { openTestDb, type ExpoLikeDb } from '../__helpers__/nodeSqlite'

const sendHandoverMock = sendHandover as jest.MockedFunction<typeof sendHandover>

const ME = new PrivateKey(7).toPublicKey().toString()
const PAYEE = new PrivateKey(11).toPublicKey().toString()
const A_PRIME = new PrivateKey(13).toPublicKey().toString()
const ASSET = 'ab'.repeat(32) + '_0'
const PREFIX = 'cHJlZml4cHJlZml4cHJlZml4cHJlZml4cHJlZml4cHI='
const SUFFIX = 'c3VmZml4c3VmZml4c3VmZml4c3VmZml4c3VmZml4c3U='
const PKH = new Array(20).fill(9)
const MAX_U64 = 18446744073709551615n

function signedHandover(units: bigint, over: Partial<HandoverResult> = {}): { h: HandoverResult; rawTx: number[] } {
  const source = new Transaction()
  source.addOutput({ lockingScript: new P2PKH().lock(PKH), satoshis: 1000 })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(PKH) })
  tx.addOutput({ lockingScript: new OneColor().lock(ASSET, units, PKH), satoshis: 1 })
  tx.addOutput({ lockingScript: new P2PKH().lock(PKH), satoshis: 900 })
  const body = handoverBody({
    assetId: ASSET,
    amount: units,
    outputIndex: 0,
    tx: tx.toAtomicBEEF(),
    derivationPrefix: PREFIX,
    derivationSuffix: SUFFIX,
    senderIdentityKey: A_PRIME,
    senderMode: 'blinded',
    linkage: [{ txid: tx.id('hex'), offChainValues: [1] }]
  })
  const h: HandoverResult = {
    txid: tx.id('hex'),
    tx: tx.toAtomicBEEF(),
    reference: 'ref-nearby',
    outputIndex: 0,
    offChainValues: [1],
    receipt: receiptOfBody(body),
    body,
    ...over
  }
  return { h, rawTx: tx.toBinary() }
}

let raw: DatabaseSync
let db: ExpoLikeDb
let journal: TransferJournal
let abortAction: jest.Mock
let onChange: jest.Mock
let kvMap: Map<string, string>
let ledger: HostLedger
const HOST = { revealSpecificKeyLinkage: jest.fn() } as unknown as WalletInterface

function memoryKv() {
  return {
    getKeyValue: async (k: string) => kvMap.get(k),
    setKeyValue: async (k: string, v: string) => {
      kvMap.set(k, v)
    }
  }
}

function payer(j: TransferJournal = journal) {
  return createNearbyPayer({
    wallet: { abortAction } as unknown as WalletInterface,
    identityKey: async () => ME,
    journal: j,
    hostWallet: HOST,
    ledger,
    bodies: createHandoverBodies(memoryKv()),
    recipientRefusal: k => (k === 'bad' ? 'not an identity key' : null),
    onChange
  })
}

const ask = (units: bigint, note?: string) => ({
  assetId: ASSET,
  units,
  recipientKey: PAYEE,
  derivationPrefix: PREFIX,
  derivationSuffix: SUFFIX,
  ...(note === undefined ? {} : { note })
})

/** The storage slice `payerHold` reads, over the real database. */
function storageOver(txid: string, status = 'nosend') {
  return {
    sqliteDb: db,
    findTransactions: jest.fn(async (a: { partial: { txid: string } }) =>
      a.partial.txid === txid ? [{ transactionId: 1, userId: 1, status }] : []
    ),
    updateTransactionStatus: jest.fn(async () => undefined)
  } as unknown as StorageExpoSQLite
}

beforeEach(async () => {
  ;({ raw, db } = await openTestDb())
  // `offline_actions.userId` references `users`.
  raw.prepare(`INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (1,'n','n','k')`).run()
  journal = createTransferJournal(db as unknown as JournalDb, () => new Date('2026-10-22T12:00:00.000Z'))
  abortAction = jest.fn(async () => ({ aborted: true }))
  onChange = jest.fn()
  kvMap = new Map()
  ledger = createHostLedger({
    getItem: async k => kvMap.get(k) ?? null,
    setItem: async (k, v) => {
      kvMap.set(k, v)
    },
    removeItem: async k => {
      kvMap.delete(k)
    },
    keys: async prefix => [...kvMap.keys()].filter(k => k.startsWith(prefix))
  })
  sendHandoverMock.mockReset()
  TaskSendOffline.resetForTests()
})

afterEach(() => {
  raw.close()
})

describe('nearby.handover journals the payer row', () => {
  it('asks the lib with the session remittance and journals built with the custody fields', async () => {
    const { h } = signedHandover(MAX_U64)
    sendHandoverMock.mockResolvedValue(h)

    await expect(payer().handover(ask(MAX_U64, ' lunch '))).resolves.toBe(h)

    expect(sendHandoverMock).toHaveBeenCalledWith({
      wallet: expect.anything(),
      identityKey: ME,
      assetId: ASSET,
      amount: MAX_U64,
      recipientKey: PAYEE,
      derivationPrefix: PREFIX,
      derivationSuffix: SUFFIX,
      note: 'lunch',
      hostWallet: HOST,
      ledger,
      // The wallet owns durability: no lib txJournal entry per send.
      journal: false
    })
    // The v4 body is kept for a later resend.
    expect(JSON.parse(kvMap.get(`bsvwallet.color.handover.${h.txid}`)!)).toEqual(h.body)
    expect(await journal.get(h.txid)).toMatchObject({
      role: 'sent',
      state: 'built',
      rail: 'nearby',
      delivered: false,
      reference: 'ref-nearby',
      units: MAX_U64,
      outputIndex: 0,
      assetId: ASSET,
      counterpartyKey: PAYEE,
      note: 'lunch',
      derivationPrefix: PREFIX,
      derivationSuffix: SUFFIX,
      senderIdentityKey: A_PRIME
    })
    expect(onChange).toHaveBeenCalled()
    expect(abortAction).not.toHaveBeenCalled()
  })

  it.each([
    ['a foreign derivationPrefix', { receipt: { ...signedHandover(1n).h.receipt, derivationPrefix: 'b3RoZXI=' } }],
    ['the payee output at index 1', { outputIndex: 1 }],
    ['another asset', { receipt: { ...signedHandover(1n).h.receipt, assetId: 'cd'.repeat(32) + '_0' } }]
  ])('releases and throws, journaling nothing, for a hand-over with %s', async (_l, over) => {
    const { h } = signedHandover(5n, over as Partial<HandoverResult>)
    sendHandoverMock.mockResolvedValue(h)

    await expect(payer().handover(ask(5n))).rejects.toThrow(/session|output 0|asset/)
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-nearby' })
    expect(await journal.get(h.txid)).toBeUndefined()
    // Released: the host ledger stops vouching for its change.
    expect(await ledger.get(h.txid)).toMatchObject({ state: 'refused', code: 'ERR_RELEASED' })
  })

  it('releases the signed action and throws when the journal cannot record it', async () => {
    const { h } = signedHandover(5n)
    sendHandoverMock.mockResolvedValue(h)
    const broken: TransferJournal = {
      ...journal,
      insert: async () => {
        throw new Error('SQLITE_BUSY')
      }
    }

    await expect(payer(broken).handover(ask(5n))).rejects.toThrow('SQLITE_BUSY')
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-nearby' })
  })

  it('releases and throws when the txid already belongs to another transfer', async () => {
    const { h } = signedHandover(5n)
    await journal.insert({
      txid: h.txid,
      role: 'received',
      state: 'held',
      assetId: ASSET,
      units: 5n,
      outputIndex: 0,
      rail: 'external',
      delivered: false
    })
    sendHandoverMock.mockResolvedValue(h)

    await expect(payer().handover(ask(5n))).rejects.toThrow(/another transfer/)
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-nearby' })
    expect((await journal.get(h.txid))?.role).toBe('received')
  })

  it('refuses an amount or recipient the request alone rules out, before any wallet call', async () => {
    await expect(payer().handover(ask(0n))).rejects.toThrow(/base units/)
    await expect(payer().handover(ask(MAX_U64 + 1n))).rejects.toThrow(/base units/)
    await expect(payer().handover({ ...ask(1n), recipientKey: 'bad' })).rejects.toThrow('not an identity key')
    expect(sendHandoverMock).not.toHaveBeenCalled()
  })

  it('passes a lib refusal through untouched, with nothing to release', async () => {
    sendHandoverMock.mockRejectedValue(Object.assign(new Error('frozen'), { name: 'ColorProviderError' }))
    await expect(payer().handover(ask(5n))).rejects.toMatchObject({ name: 'ColorProviderError' })
    expect(abortAction).not.toHaveBeenCalled()
  })
})

describe('onHandedOver is forward-only and idempotent', () => {
  async function built(): Promise<HandoverResult> {
    const { h } = signedHandover(5n)
    sendHandoverMock.mockResolvedValue(h)
    return await payer().handover(ask(5n))
  }

  it('built → parked → handed_over, delivered on hand-over', async () => {
    const h = await built()
    const p = payer()
    await p.onHandedOver(h.txid, 'parked')
    expect(await journal.get(h.txid)).toMatchObject({ state: 'parked', delivered: false })
    await p.onHandedOver(h.txid, 'handed_over')
    expect(await journal.get(h.txid)).toMatchObject({ state: 'handed_over', delivered: true })
  })

  it('a repeat, or a park after the hand-over, never moves the row back', async () => {
    const h = await built()
    const p = payer()
    await p.onHandedOver(h.txid, 'handed_over')
    await p.onHandedOver(h.txid, 'handed_over')
    await p.onHandedOver(h.txid, 'parked')
    expect((await journal.get(h.txid))?.state).toBe('handed_over')
    await journal.advance(h.txid, ['handed_over'], 'settled')
    await p.onHandedOver(h.txid, 'handed_over')
    expect((await journal.get(h.txid))?.state).toBe('settled')
  })

  it('fails for a cancelled row and for a txid with no row', async () => {
    const h = await built()
    await journal.advance(h.txid, ['built'], 'cancelled')
    await expect(payer().onHandedOver(h.txid, 'handed_over')).rejects.toThrow(/cancelled/)
    await expect(payer().onHandedOver('ff'.repeat(32), 'parked')).rejects.toThrow(/no sent row/)
  })
})

describe('the payer’s token tx is held until the journal reads settled', () => {
  it('parks then releases through the journal, held at every step short of settled', async () => {
    const { h, rawTx } = signedHandover(1500n)
    sendHandoverMock.mockResolvedValue(h)
    const p = payer()
    const held = async () =>
      (
        await colorHeldTxids([{ txid: h.txid, rawTx }], {
          statesOf: t => journal.statesOf(t),
          custodyOf: async () => new Set()
        })
      ).has(h.txid)

    await p.handover(ask(1500n))
    expect((await journal.get(h.txid))?.state).toBe('built')
    expect(await held()).toBe(true)

    const storage = storageOver(h.txid)
    await expect(
      parkSentPaymentOffline({ storage, txid: h.txid, framePayload: 'bsvpayf1:x', onHandedOver: p.onHandedOver })
    ).resolves.toBe(true)
    expect((await journal.get(h.txid))?.state).toBe('parked')
    expect((await findOfflineActionByTxid(db as never, h.txid))?.status).toBe('parked')
    expect(await held()).toBe(true)

    await releaseParkedPayment({ storage, txid: h.txid, isTokenHold: true, onHandedOver: p.onHandedOver })
    expect((await journal.get(h.txid))?.state).toBe('handed_over')
    expect((await findOfflineActionByTxid(db as never, h.txid))?.status).toBe('queued')
    expect(await held()).toBe(true)

    await journal.advance(h.txid, ['handed_over'], 'settled')
    expect(await held()).toBe(false)
  })

  it('a positive-ack hold journals handed_over before the queue row wakes the drain', async () => {
    const { h, rawTx } = signedHandover(1500n)
    sendHandoverMock.mockResolvedValue(h)
    const p = payer()
    await p.handover(ask(1500n))

    await holdSentPaymentOffline({ storage: storageOver(h.txid), txid: h.txid, onHandedOver: p.onHandedOver })

    expect(await journal.get(h.txid)).toMatchObject({ state: 'handed_over', delivered: true })
    expect((await findOfflineActionByTxid(db as never, h.txid))?.status).toBe('queued')
    expect(TaskSendOffline.hasPending).toBe(true)
    expect(
      (
        await colorHeldTxids([{ txid: h.txid, rawTx }], {
          statesOf: t => journal.statesOf(t),
          custodyOf: async () => new Set()
        })
      ).has(h.txid)
    ).toBe(true)
  })

  it('a hold whose journal hook fails is left parked, never drainable', async () => {
    const { h } = signedHandover(1500n)
    // No hand-over row at all: the hook has nothing to advance.
    await holdSentPaymentOffline({ storage: storageOver(h.txid), txid: h.txid, onHandedOver: payer().onHandedOver })

    expect((await findOfflineActionByTxid(db as never, h.txid))?.status).toBe('parked')
    expect(TaskSendOffline.hasPending).toBe(false)
  })
})
