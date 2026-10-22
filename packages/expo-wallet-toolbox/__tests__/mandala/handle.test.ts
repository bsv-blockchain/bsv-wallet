/**
 * The handle rail's token half (plan 07 Task 13): hand-over send, MessageBox
 * redelivery and inbox receive over the `mandala-color` box.
 *
 *  · `sendToHandle` journals the row `handed_over` BEFORE delivering (W4): a
 *    lost MessageBox response may still have delivered, so the abort guard
 *    must already refuse. Only a delivered hand-over is named to `settleNow`
 *    (post-ACK intent, IC §2.3).
 *  · A per-asset latch refuses a second send while one is in flight (the
 *    double tap). A failed delivery is still `sent` (a second send would be a
 *    second payment), `notified: false`, and the tick redelivers it.
 *  · Redelivery rebuilds the §7.2 body from the row's custody fields, the
 *    module's `handoffEvidence` and the AtomicBEEF; never from the overlay.
 *  · Every inbox credit is journaled `held`; only the module inventory
 *    (`reconcileHeld`) settles it, so an unknown offline state never reads
 *    as admitted. An unreadable box is `incomplete`, never "nothing there".
 *  · A resend checks everything it needs BEFORE it hands a parked payment
 *    over: a failed or offline resend leaves the row as it found it.
 *
 * Every lib call is mocked; the journal is real SQLite.
 */
const order: string[] = []

jest.mock('@bsv/mandala', () => {
  const actual = jest.requireActual('@bsv/mandala')
  return {
    ...actual,
    sendHandover: jest.fn(),
    deliverHandover: jest.fn(),
    receiveHandovers: jest.fn()
  }
})

import type { DatabaseSync } from 'node:sqlite'
import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { ATTESTED_PROFILE_ID, deliverHandover, receiveHandovers, sendHandover, type HandoverResult } from '@bsv/mandala'
import {
  receiveFromInbox,
  redeliverPending,
  resendTransfer,
  sendToHandle,
  type HandleDeps,
  type MandalaMessageBox
} from '../../core/mandala/handle'
import type { InventoryRecord } from '../../core/mandala/assets'
import { reconcileHeldTransfers } from '../../core/mandala/settle'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import type { ColorTransferRow } from '../../core/mandala/types'
import { openTestDb } from '../__helpers__/nodeSqlite'

const sendHandoverMock = sendHandover as jest.MockedFunction<typeof sendHandover>
const deliverHandoverMock = deliverHandover as jest.MockedFunction<typeof deliverHandover>
const receiveHandoversMock = receiveHandovers as jest.MockedFunction<typeof receiveHandovers>

const ME = new PrivateKey(7).toPublicKey().toString()
const B = new PrivateKey(11).toPublicKey().toString()
const A = `${'ab'.repeat(32)}_0`
const A2 = `${'cd'.repeat(32)}_0`
const T = 'a1'.repeat(32)
const U = 'b2'.repeat(32)
const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const MAX_U64 = 18446744073709551615n
const DEPLOY_HEX = '0100000000000000000000'
const PROFILE_DATA = { [ATTESTED_PROFILE_ID]: { [A]: { declarationTx: DEPLOY_HEX, submissions: [] } } }
const BEEF = [1, 1, 1, 1, 0xab]

let raw: DatabaseSync
let journal: TransferJournal
/** The module's `p color assets` view, as `reconcileHeld` reads it. */
let inventory: jest.Mock<Promise<InventoryRecord[]>, []>

const record = (txid: string, tags: string[]): InventoryRecord => ({
  outpoint: `${txid}.0`,
  assetId: A,
  role: 'value',
  units: MAX_U64,
  tags
})

function handover(over: Partial<HandoverResult> = {}): HandoverResult {
  return {
    txid: T,
    tx: BEEF,
    reference: 'ref-T',
    outputIndex: 0,
    offChainValues: [9, 9],
    receipt: {
      version: 1,
      assetId: A,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      senderIdentityKey: 'blinded-A-prime',
      profileData: PROFILE_DATA
    },
    ...over
  }
}

/** The journal with every write recorded into `order`. */
function recordingJournal(j: TransferJournal): TransferJournal {
  return {
    ...j,
    insert: async row => {
      order.push(`journal.insert:${row.state}`)
      return await j.insert(row)
    },
    setDelivered: async (txid, delivered) => {
      order.push(`setDelivered:${delivered}`)
      await j.setDelivered(txid, delivered)
    }
  }
}

function messageBox(over: Partial<MandalaMessageBox> = {}): MandalaMessageBox {
  return {
    sendMessage: jest.fn(async () => ({})),
    listMessages: jest.fn(async () => []),
    acknowledgeMessage: jest.fn(async () => ({})),
    ...over
  }
}

function deps(over: Partial<HandleDeps> = {}): HandleDeps & { abortAction: jest.Mock } {
  const abortAction = jest.fn(async () => ({ aborted: true }))
  const mb = messageBox()
  return {
    wallet: { abortAction } as unknown as WalletInterface,
    identityKey: async () => ME,
    journal: recordingJournal(journal),
    color: {
      handoffEvidence: jest.fn(async (txid: string) => ({ version: 1 as const, txid, profileData: PROFILE_DATA }))
    },
    messageBox: async () => mb,
    settleNow: jest.fn(async () => {
      order.push('settleNow')
      return 'settled' as const
    }),
    isOnline: async () => true,
    rememberDeploy: jest.fn(async () => {}),
    refetch: jest.fn(async () => BEEF),
    processed: new Set<string>(),
    now: () => new Date(NOW),
    recipientRefusal: (r: string) => (/^(02|03)[0-9a-f]{64}$/i.test(r) ? null : 'not an identity key'),
    // The runtime's own reconcile, over the real journal and the mocked view.
    reconcileHeld: jest.fn(async (txids: readonly string[]) => {
      await reconcileHeldTransfers({ journal, inventory: async () => await inventory() }, txids)
    }),
    abortAction,
    ...over
  }
}

function row(over: Partial<Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>> = {}) {
  return {
    txid: T,
    role: 'sent' as const,
    assetId: A,
    units: 1500n,
    outputIndex: 0,
    counterpartyKey: B,
    reference: 'ref-T',
    rail: 'handle' as const,
    state: 'handed_over' as const,
    delivered: false,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    senderIdentityKey: 'blinded-A-prime',
    ...over
  }
}

beforeEach(async () => {
  order.length = 0
  jest.clearAllMocks()
  let db
  ;({ raw, db } = await openTestDb())
  journal = createTransferJournal(db as JournalDb, () => new Date(NOW))
  inventory = jest.fn(async () => [])
  sendHandoverMock.mockImplementation(async () => {
    order.push('sendHandover')
    return handover()
  })
  deliverHandoverMock.mockImplementation(async () => {
    order.push('deliverHandover')
  })
  receiveHandoversMock.mockResolvedValue({ accepted: [], failed: [] })
})

afterEach(() => raw.close())

describe('sendToHandle', () => {
  it('journals handed_over before delivering, then settles', async () => {
    const d = deps()
    const r = await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 1500n, note: 'lunch' })
    expect(order).toEqual([
      'sendHandover',
      'journal.insert:handed_over',
      'deliverHandover',
      'setDelivered:true',
      'settleNow'
    ])
    expect(r).toEqual({ kind: 'sent', txid: T, settled: true, notified: true })
    expect(sendHandoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ identityKey: ME, assetId: A, amount: 1500n, recipientKey: B, note: 'lunch' })
    )
    expect(deliverHandoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipientKey: B, handover: expect.objectContaining({ txid: T }), note: 'lunch' })
    )
    expect(await journal.get(T)).toMatchObject({
      role: 'sent',
      state: 'handed_over',
      delivered: true,
      reference: 'ref-T',
      rail: 'handle',
      units: 1500n,
      counterpartyKey: B,
      outputIndex: 0,
      assetId: A,
      note: 'lunch',
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      senderIdentityKey: 'blinded-A-prime'
    })
    expect(d.settleNow).toHaveBeenCalledWith(T)
  })

  it('a second sendToHandle while one is in flight for the same asset is refused', async () => {
    const d = deps()
    const a = { assetId: A, recipientIdentityKey: B, units: 5n }
    const first = sendToHandle(d, a)
    const second = await sendToHandle(d, a)
    expect(second).toMatchObject({ kind: 'refused', code: 'ERR_SEND_IN_FLIGHT' })
    expect(await first).toMatchObject({ kind: 'sent', txid: T })
    expect(sendHandoverMock).toHaveBeenCalledTimes(1)
    // The latch is released once the first send is done.
    sendHandoverMock.mockImplementationOnce(async () => handover({ txid: U, reference: 'ref-U' }))
    expect(await sendToHandle(d, a)).toMatchObject({ kind: 'sent', txid: U })
  })

  it('a send of another asset is not held up by the latch', async () => {
    const d = deps()
    sendHandoverMock
      .mockImplementationOnce(async () => handover())
      .mockImplementationOnce(async () => handover({ txid: U, reference: 'ref-U' }))
    const [x, y] = await Promise.all([
      sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 5n }),
      sendToHandle(d, { assetId: A2, recipientIdentityKey: B, units: 5n })
    ])
    expect(x.kind).toBe('sent')
    expect(y.kind).toBe('sent')
  })

  it('a delivery failure still reports sent, notified false, and stays handed_over', async () => {
    const d = deps()
    deliverHandoverMock.mockImplementationOnce(async () => {
      throw new Error('Network request failed')
    })
    const r = await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 1500n })
    expect(r).toEqual({ kind: 'sent', txid: T, settled: false, notified: false })
    expect(await journal.get(T)).toMatchObject({ state: 'handed_over', delivered: false })
    // No ACK, no post-ACK intent: the hand-over is not named to the module.
    expect(d.settleNow).not.toHaveBeenCalled()
    expect(d.abortAction).not.toHaveBeenCalled()
  })

  it('a MessageBox that cannot be opened is a failed delivery, not a failed send', async () => {
    const d = deps({
      messageBox: async () => {
        throw new Error('no network')
      }
    })
    const r = await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 1500n })
    expect(r).toEqual({ kind: 'sent', txid: T, settled: false, notified: false })
    expect(await journal.get(T)).toMatchObject({ state: 'handed_over', delivered: false })
  })

  it('does not settle while offline, and a settle that will not answer in time reads unsettled', async () => {
    const offline = deps({ isOnline: async () => false })
    expect(await sendToHandle(offline, { assetId: A, recipientIdentityKey: B, units: 1n })).toEqual({
      kind: 'sent',
      txid: T,
      settled: false,
      notified: true
    })
    expect(offline.settleNow).not.toHaveBeenCalled()

    sendHandoverMock.mockImplementationOnce(async () => handover({ txid: U, reference: 'ref-U' }))
    const hung = deps({
      settleNow: jest.fn(() => new Promise<never>(() => {})),
      settleTimeoutMs: 5
    })
    expect(await sendToHandle(hung, { assetId: A, recipientIdentityKey: B, units: 1n })).toEqual({
      kind: 'sent',
      txid: U,
      settled: false,
      notified: true
    })

    const throwing = deps({
      isOnline: async () => {
        throw new Error('NetInfo')
      }
    })
    sendHandoverMock.mockImplementationOnce(async () => handover({ txid: 'c3'.repeat(32), reference: 'ref-c' }))
    expect(await sendToHandle(throwing, { assetId: A, recipientIdentityKey: B, units: 1n })).toMatchObject({
      kind: 'sent',
      settled: false
    })
    expect(throwing.settleNow).not.toHaveBeenCalled()
  })

  it('maps module refusals by error name', async () => {
    const named = (name: string, extra: Record<string, unknown> = {}) =>
      Object.assign(new Error(`${name} happened`), { name }, extra)
    for (const name of [
      'UnsupportedProfileError',
      'ProfileParamsError',
      'ProfileDataError',
      'AttestationEvidenceError'
    ]) {
      sendHandoverMock.mockRejectedValueOnce(named(name))
      expect(await sendToHandle(deps(), { assetId: A, recipientIdentityKey: B, units: 1n })).toMatchObject({
        kind: 'refused',
        code: name
      })
    }
    sendHandoverMock.mockRejectedValueOnce(named('ColorProviderError', { code: 'ERR_FROZEN', transport: false }))
    expect(await sendToHandle(deps(), { assetId: A, recipientIdentityKey: B, units: 1n })).toMatchObject({
      kind: 'refused',
      code: 'ERR_FROZEN'
    })
    sendHandoverMock.mockRejectedValueOnce(named('ColorProviderError', { code: 'ERR_UNAVAILABLE', transport: true }))
    expect(await sendToHandle(deps(), { assetId: A, recipientIdentityKey: B, units: 1n })).toMatchObject({
      kind: 'unavailable'
    })
    sendHandoverMock.mockRejectedValueOnce(new Error('socket hang up'))
    expect(await sendToHandle(deps(), { assetId: A, recipientIdentityKey: B, units: 1n })).toMatchObject({
      kind: 'unavailable'
    })
    // The user's own "no" at the spend prompt: nothing was sent.
    sendHandoverMock.mockRejectedValueOnce(named('ColorConsentDeclinedError'))
    expect(await sendToHandle(deps(), { assetId: A, recipientIdentityKey: B, units: 1n })).toMatchObject({
      kind: 'refused',
      code: 'ColorConsentDeclinedError'
    })
    expect(await journal.list()).toEqual([])
    expect(deliverHandoverMock).not.toHaveBeenCalled()
  })

  it('never sends units above 2^64-1, nor zero', async () => {
    const d = deps()
    expect(await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 18446744073709551616n })).toMatchObject({
      kind: 'refused'
    })
    expect(await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 0n })).toMatchObject({
      kind: 'refused'
    })
    expect(sendHandoverMock).not.toHaveBeenCalled()
    expect(await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: MAX_U64 })).toMatchObject({
      kind: 'sent'
    })
    expect(sendHandoverMock).toHaveBeenCalledWith(expect.objectContaining({ amount: MAX_U64 }))
    expect((await journal.get(T))!.units).toBe(MAX_U64)
  })

  it('refuses a recipient that is not an identity key before building anything', async () => {
    const d = deps()
    expect(await sendToHandle(d, { assetId: A, recipientIdentityKey: '1BvBMSEYstWetq', units: 1n })).toMatchObject({
      kind: 'refused',
      code: 'ERR_RECIPIENT'
    })
    expect(sendHandoverMock).not.toHaveBeenCalled()
  })

  it('a journal fault after signing never delivers, and releases the unseen action', async () => {
    const d = deps()
    d.journal = {
      ...d.journal,
      insert: async () => {
        throw new Error('database is locked')
      }
    }
    const r = await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 1n })
    expect(r).toMatchObject({ kind: 'unavailable' })
    expect(deliverHandoverMock).not.toHaveBeenCalled()
    expect(d.settleNow).not.toHaveBeenCalled()
    expect(d.abortAction).toHaveBeenCalledWith({ reference: 'ref-T' })
  })

  it('a txid journaled for another transfer is never delivered, and the unseen action is released', async () => {
    const d = deps()
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined }))
    const r = await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 1n })
    expect(r).toMatchObject({ kind: 'unavailable' })
    expect(deliverHandoverMock).not.toHaveBeenCalled()
    expect(d.abortAction).toHaveBeenCalledWith({ reference: 'ref-T' })
    expect(await journal.get(T)).toMatchObject({ role: 'received', state: 'held' })
  })

  it('a send to self owes no delivery: journaled delivered, settled', async () => {
    const d = deps()
    sendHandoverMock.mockImplementationOnce(async () => {
      order.push('sendHandover')
      return handover({ receipt: { ...handover().receipt, senderIdentityKey: ME } })
    })
    const r = await sendToHandle(d, { assetId: A, recipientIdentityKey: ME, units: 3n })
    expect(r).toEqual({ kind: 'sent', txid: T, settled: true, notified: true })
    expect(deliverHandoverMock).not.toHaveBeenCalled()
    expect(order).toEqual(['sendHandover', 'journal.insert:handed_over', 'settleNow'])
    expect(await journal.get(T)).toMatchObject({ state: 'handed_over', delivered: true, counterpartyKey: ME })
  })
})

describe('redeliverPending', () => {
  it('tick redelivers an undelivered hand-over from handoffEvidence', async () => {
    const d = deps()
    await journal.insert(row())
    expect(await redeliverPending(d)).toBe(1)
    expect(d.color.handoffEvidence).toHaveBeenCalledWith(T)
    expect(d.refetch).toHaveBeenCalledWith(T)
    expect(deliverHandoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientKey: B,
        handover: {
          txid: T,
          tx: BEEF,
          outputIndex: 0,
          reference: 'ref-T',
          offChainValues: [],
          receipt: {
            version: 1,
            assetId: A,
            derivationPrefix: 'cHJlZml4',
            derivationSuffix: 'c3VmZml4',
            senderIdentityKey: 'blinded-A-prime',
            profileData: PROFILE_DATA
          }
        }
      })
    )
    expect((await d.journal.get(T))!.delivered).toBe(true)
    // Delivered is the ACK: the hand-over is now named to the module.
    expect(d.settleNow).toHaveBeenCalledWith(T)
  })

  it('leaves delivered, received, settled and not-yet-handed-over rows alone', async () => {
    const d = deps()
    await journal.insert(row({ txid: 'c1'.repeat(32), delivered: true }))
    await journal.insert(row({ txid: 'c2'.repeat(32), rail: 'nearby', delivered: true }))
    await journal.insert(row({ txid: 'c3'.repeat(32), role: 'received', state: 'held', reference: undefined }))
    await journal.insert(row({ txid: 'c4'.repeat(32), state: 'settled' }))
    await journal.insert(row({ txid: 'c5'.repeat(32), rail: 'nearby', state: 'parked' }))
    expect(await redeliverPending(d)).toBe(0)
    expect(deliverHandoverMock).not.toHaveBeenCalled()
  })

  it('redelivers an undelivered hand-over whatever rail it first took', async () => {
    // A parked nearby payment a resend handed over, whose delivery then failed.
    const d = deps()
    await journal.insert(row({ rail: 'nearby' }))
    expect(await redeliverPending(d)).toBe(1)
    expect(deliverHandoverMock).toHaveBeenCalledWith(expect.objectContaining({ recipientKey: B }))
    expect((await journal.get(T))!.delivered).toBe(true)
  })

  it('a row whose bytes cannot be had stays undelivered for the next tick', async () => {
    const d = deps({ refetch: jest.fn(async () => undefined) })
    await journal.insert(row())
    expect(await redeliverPending(d)).toBe(0)
    expect(deliverHandoverMock).not.toHaveBeenCalled()
    expect((await journal.get(T))!.delivered).toBe(false)
  })

  it('a failed redelivery stays undelivered and never throws', async () => {
    const d = deps()
    await journal.insert(row())
    deliverHandoverMock.mockRejectedValueOnce(new Error('502'))
    expect(await redeliverPending(d)).toBe(0)
    expect((await journal.get(T))!.delivered).toBe(false)
  })

  it('does not redeliver a hand-over its own send is still delivering', async () => {
    const d = deps()
    let release!: () => void
    deliverHandoverMock.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const sending = sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 1n })
    for (let i = 0; i < 20 && deliverHandoverMock.mock.calls.length === 0; i++) await new Promise(r => setImmediate(r))
    expect(deliverHandoverMock).toHaveBeenCalledTimes(1)
    expect(await redeliverPending(d)).toBe(0)
    release()
    expect(await sending).toMatchObject({ kind: 'sent', notified: true })
    expect(deliverHandoverMock).toHaveBeenCalledTimes(1)
  })
})

describe('resendTransfer', () => {
  it('is not-found with no row, and with no evidence', async () => {
    const d = deps()
    expect(await resendTransfer(d, T)).toBe('not-found')
    await journal.insert(row())
    ;(d.color.handoffEvidence as jest.Mock).mockResolvedValueOnce(undefined)
    expect(await resendTransfer(d, T)).toBe('not-found')
    expect(deliverHandoverMock).not.toHaveBeenCalled()
  })

  it('resends a delivered hand-over again, and is unavailable without bytes or a box', async () => {
    const d = deps()
    await journal.insert(row({ delivered: true }))
    expect(await resendTransfer(d, T)).toBe('resent')
    expect(deliverHandoverMock).toHaveBeenCalledTimes(1)
    ;(d.refetch as jest.Mock).mockResolvedValueOnce(undefined)
    expect(await resendTransfer(d, T)).toBe('unavailable')
    deliverHandoverMock.mockRejectedValueOnce(new Error('offline'))
    expect(await resendTransfer(d, T)).toBe('unavailable')
  })

  it('is not-found for a received row or a final refusal', async () => {
    const d = deps()
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined }))
    expect(await resendTransfer(d, T)).toBe('not-found')
    await journal.insert(row({ txid: U, state: 'refused', reference: 'ref-U' }))
    expect(await resendTransfer(d, U)).toBe('not-found')
    expect(deliverHandoverMock).not.toHaveBeenCalled()
  })

  it('a parked payment is journaled handed_over before it is resent', async () => {
    const d = deps()
    await journal.insert(row({ rail: 'nearby', state: 'parked' }))
    deliverHandoverMock.mockImplementationOnce(async () => {
      order.push(`deliverHandover@${(await journal.get(T))!.state}`)
    })
    expect(await resendTransfer(d, T)).toBe('resent')
    expect(order).toContain('deliverHandover@handed_over')
    expect(await journal.get(T)).toMatchObject({ state: 'handed_over', delivered: true })
  })

  describe('a resend that cannot deliver leaves a parked payment parked', () => {
    it('with no evidence', async () => {
      const d = deps()
      await journal.insert(row({ rail: 'nearby', state: 'parked' }))
      ;(d.color.handoffEvidence as jest.Mock).mockResolvedValueOnce(undefined)
      expect(await resendTransfer(d, T)).toBe('not-found')
      expect((await journal.get(T))!.state).toBe('parked')
    })

    it('with evidence for another txid', async () => {
      const d = deps()
      await journal.insert(row({ rail: 'nearby', state: 'parked' }))
      ;(d.color.handoffEvidence as jest.Mock).mockResolvedValueOnce({ version: 1, txid: U, profileData: PROFILE_DATA })
      expect(await resendTransfer(d, T)).toBe('not-found')
      expect((await journal.get(T))!.state).toBe('parked')
    })

    it('with no custody fields', async () => {
      const d = deps()
      await journal.insert(row({ rail: 'nearby', state: 'parked', derivationPrefix: undefined }))
      expect(await resendTransfer(d, T)).toBe('not-found')
      expect((await journal.get(T))!.state).toBe('parked')
    })

    it('with no bytes', async () => {
      const d = deps({ refetch: jest.fn(async () => undefined) })
      await journal.insert(row({ rail: 'nearby', state: 'parked' }))
      expect(await resendTransfer(d, T)).toBe('unavailable')
      expect((await journal.get(T))!.state).toBe('parked')
    })

    it('when the evidence read throws', async () => {
      const d = deps()
      await journal.insert(row({ rail: 'nearby', state: 'parked' }))
      ;(d.color.handoffEvidence as jest.Mock).mockRejectedValueOnce(new Error('locked'))
      expect(await resendTransfer(d, T)).toBe('unavailable')
      expect((await journal.get(T))!.state).toBe('parked')
    })

    it('with a MessageBox that cannot be opened', async () => {
      const d = deps({
        messageBox: async () => {
          throw new Error('no network')
        }
      })
      await journal.insert(row({ rail: 'nearby', state: 'parked' }))
      expect(await resendTransfer(d, T)).toBe('unavailable')
      expect((await journal.get(T))!.state).toBe('parked')
      expect(deliverHandoverMock).not.toHaveBeenCalled()
    })
  })

  it('a delivery that fails after the hand-over stays handed_over for the tick, never parked again', async () => {
    // The bytes may have landed (a lost response): the abort guard must keep refusing.
    const d = deps()
    await journal.insert(row({ rail: 'nearby', state: 'parked' }))
    deliverHandoverMock.mockRejectedValueOnce(new Error('502'))
    expect(await resendTransfer(d, T)).toBe('unavailable')
    expect(await journal.get(T)).toMatchObject({ state: 'handed_over', delivered: false })
    expect(await redeliverPending(d)).toBe(1)
    expect((await journal.get(T))!.delivered).toBe(true)
  })

  it('a payment cancelled while the resend prepared is not delivered', async () => {
    const d = deps()
    await journal.insert(row({ rail: 'nearby', state: 'parked' }))
    ;(d.color.handoffEvidence as jest.Mock).mockImplementationOnce(async (txid: string) => {
      await journal.advance(txid, ['parked'], 'cancelled')
      return { version: 1, txid, profileData: PROFILE_DATA }
    })
    expect(await resendTransfer(d, T)).toBe('not-found')
    expect(deliverHandoverMock).not.toHaveBeenCalled()
    expect((await journal.get(T))!.state).toBe('cancelled')
  })
})

describe('receiveFromInbox', () => {
  const accepted = (txid: string, offline: boolean, messageId = `m-${txid.slice(0, 4)}`) => ({
    messageId,
    txid,
    assetId: A,
    amount: MAX_U64,
    outputIndex: 0,
    offline
  })

  it('journals every inbox credit held; only the module inventory settles it', async () => {
    const d = deps()
    inventory.mockResolvedValue([record(T, ['color_offline']), record(U, ['color_state_available'])])
    receiveHandoversMock.mockResolvedValueOnce({
      accepted: [accepted(T, true), accepted(U, false)],
      failed: [{ messageId: 'bad', error: new Error('x'), code: 'ERR_SHAPE' }]
    })
    expect(await receiveFromInbox(d)).toEqual({ credited: 2, failed: 1 })
    expect(d.reconcileHeld).toHaveBeenCalledWith([T, U])
    expect(receiveHandoversMock).toHaveBeenCalledWith(expect.objectContaining({ processed: d.processed }))
    expect(await journal.get(T)).toMatchObject({
      role: 'received',
      state: 'held',
      rail: 'handle',
      units: MAX_U64,
      outputIndex: 0,
      assetId: A
    })
    expect(await journal.get(U)).toMatchObject({ role: 'received', state: 'settled', rail: 'handle' })
  })

  it('records the sender and caches the attested deploy from the listed body', async () => {
    const body = {
      v: 3,
      kind: 'handover',
      assetId: A,
      outputIndex: 0,
      tx: 'beef',
      receipt: { version: 1, assetId: A, profileData: PROFILE_DATA }
    }
    const mb = messageBox({
      listMessages: jest.fn(async () => [{ messageId: 'm1', sender: B, body: JSON.stringify(body) }])
    })
    const d = deps({ messageBox: async () => mb })
    receiveHandoversMock.mockImplementationOnce(async p => {
      await p.messageBoxClient.listMessages({ messageBox: 'mandala-color', acceptPayments: false })
      return { accepted: [accepted(T, false, 'm1')], failed: [] }
    })
    expect(await receiveFromInbox(d)).toEqual({ credited: 1, failed: 0 })
    expect((await journal.get(T))!.counterpartyKey).toBe(B)
    expect(d.rememberDeploy).toHaveBeenCalledWith(DEPLOY_HEX)
  })

  it('a credit the lib reports online stays held when the inventory cannot be read', async () => {
    // The lib reports `offline: false` when its own view read fails: not proof of admission.
    const d = deps()
    inventory.mockRejectedValue(new Error('p color assets: view unavailable'))
    receiveHandoversMock.mockResolvedValueOnce({ accepted: [accepted(T, false)], failed: [] })
    expect(await receiveFromInbox(d)).toEqual({ credited: 1, failed: 0 })
    expect((await journal.get(T))!.state).toBe('held')
  })

  it('a credit the inventory does not list yet stays held', async () => {
    const d = deps()
    receiveHandoversMock.mockResolvedValueOnce({ accepted: [accepted(T, false)], failed: [] })
    expect(await receiveFromInbox(d)).toEqual({ credited: 1, failed: 0 })
    expect((await journal.get(T))!.state).toBe('held')
  })

  it('an offline credit stays held even when the lib and the view agree it is offline', async () => {
    const d = deps()
    inventory.mockResolvedValue([record(T, ['color_offline'])])
    receiveHandoversMock.mockResolvedValueOnce({ accepted: [accepted(T, true)], failed: [] })
    await receiveFromInbox(d)
    expect((await journal.get(T))!.state).toBe('held')
  })

  it('a replayed credit that was journaled held moves to settled once the inventory admits it', async () => {
    const d = deps()
    await journal.insert(row({ role: 'received', state: 'held', reference: undefined, rail: 'external' }))
    receiveHandoversMock.mockResolvedValue({ accepted: [accepted(T, false)], failed: [] })
    inventory.mockRejectedValueOnce(new Error('view unavailable'))
    expect(await receiveFromInbox(d)).toEqual({ credited: 1, failed: 0 })
    expect((await journal.get(T))!.state).toBe('held')
    inventory.mockResolvedValueOnce([record(T, ['color_state_available'])])
    expect(await receiveFromInbox(d)).toEqual({ credited: 1, failed: 0 })
    expect((await journal.get(T))!.state).toBe('settled')
  })

  it('a reconcile that throws is logged, never thrown, and leaves the credit held', async () => {
    const d = deps({
      reconcileHeld: jest.fn(async () => {
        throw new Error('database is locked')
      })
    })
    receiveHandoversMock.mockResolvedValueOnce({ accepted: [accepted(T, false)], failed: [] })
    expect(await receiveFromInbox(d)).toEqual({ credited: 1, failed: 0 })
    expect((await journal.get(T))!.state).toBe('held')
  })

  it('an unreadable box is incomplete, never an empty one', async () => {
    receiveHandoversMock.mockRejectedValueOnce(new Error('401'))
    expect(await receiveFromInbox(deps())).toEqual({ credited: 0, failed: 0, incomplete: true })
    const noBox = deps({
      messageBox: async () => {
        throw new Error('no network')
      }
    })
    expect(await receiveFromInbox(noBox)).toEqual({ credited: 0, failed: 0, incomplete: true })
  })

  it('a journal fault after a credit is logged, not thrown: reconcileHeld journals it later', async () => {
    const d = deps()
    d.journal = {
      ...d.journal,
      insert: async () => {
        throw new Error('database is locked')
      }
    }
    receiveHandoversMock.mockResolvedValueOnce({ accepted: [accepted(T, true)], failed: [] })
    expect(await receiveFromInbox(d)).toEqual({ credited: 1, failed: 0 })
  })
})
