import { holdSentPaymentOffline, parkSentPaymentOffline, releaseParkedPayment } from '../../core/offline/payerHold'
import {
  findOfflineActionByTxid,
  insertOfflineAction,
  updateOfflineAction
} from '../../core/storage/methods/offlineActions'
import { TaskSendOffline } from '../../core/monitor/TaskSendOffline'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

// The DB mapper is its own tested unit (`core/storage/methods/offlineActions.ts`);
// here it's mocked so these tests pin exactly what `holdSentPaymentOffline`
// hands it, without duplicating its own SQL coverage.
jest.mock('../../core/storage/methods/offlineActions', () => ({
  findOfflineActionByTxid: jest.fn().mockResolvedValue(undefined),
  insertOfflineAction: jest.fn().mockResolvedValue(undefined),
  updateOfflineAction: jest.fn().mockResolvedValue(undefined)
}))

const mockedFind = findOfflineActionByTxid as jest.Mock
const mockedInsert = insertOfflineAction as jest.Mock
const mockedUpdate = updateOfflineAction as jest.Mock

const TXID = 'aa'.repeat(32)

function storageStub(
  opts: {
    sqliteDb?: unknown
    tx?: { transactionId: number; userId: number; status?: string } | null
    updateTransactionStatus?: jest.Mock
  } = {}
) {
  const tx = opts.tx === undefined ? { transactionId: 42, userId: 7 } : opts.tx
  return {
    sqliteDb: 'sqliteDb' in opts ? opts.sqliteDb : {},
    findTransactions: jest.fn().mockResolvedValue(tx ? [tx] : []),
    updateTransactionStatus: opts.updateTransactionStatus ?? jest.fn().mockResolvedValue(undefined)
  }
}

describe('holdSentPaymentOffline', () => {
  beforeEach(() => {
    mockedInsert.mockClear()
    mockedInsert.mockResolvedValue(undefined)
    mockedUpdate.mockClear()
    mockedUpdate.mockResolvedValue(undefined)
    mockedFind.mockClear()
    mockedFind.mockResolvedValue(undefined)
    TaskSendOffline.resetForTests()
  })

  it('resolves transactionId and userId from the transaction row, not a guess', async () => {
    const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })
    await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

    expect(storage.findTransactions).toHaveBeenCalledWith({ partial: { txid: TXID }, noRawTx: true })
    expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
    expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' })
  })

  it('persists the frame payload on the queue row when given one', async () => {
    const storage = storageStub()

    await holdSentPaymentOffline({
      storage: storage as unknown as StorageExpoSQLite,
      txid: TXID,
      framePayload: 'bsvpayf1:abc'
    })

    expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, {
      userId: 7,
      txid: TXID,
      role: 'sent',
      framePayload: 'bsvpayf1:abc'
    })
    expect(TaskSendOffline.hasPending).toBe(true)
  })

  // ORDER MATTERS: the queue-row insert is durable and the status promotion is
  // not (nothing re-drives a hold that fails partway), so a failure between
  // the two must leave the drain still able to find and post this txid.
  it('inserts the queue row before promoting the transaction status', async () => {
    const calls: string[] = []
    mockedInsert.mockImplementation(async () => {
      calls.push('insert')
    })
    const updateTransactionStatus = jest.fn().mockImplementation(async () => {
      calls.push('promote')
    })
    const storage = storageStub({ updateTransactionStatus })

    await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

    expect(calls).toEqual(['insert', 'promote'])
  })

  it('throws when the database is not open, before touching storage', async () => {
    const storage = storageStub({ sqliteDb: undefined })

    await expect(
      holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow(/database is not open/)
    expect(storage.findTransactions).not.toHaveBeenCalled()
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    expect(mockedInsert).not.toHaveBeenCalled()
  })

  it('throws when no transaction row matches the txid, rather than guessing a userId', async () => {
    const storage = storageStub({ tx: null })

    await expect(
      holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow(/no transaction record/)
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    expect(mockedInsert).not.toHaveBeenCalled()
  })

  it('lets a thrown promotion propagate, having already queued the txid', async () => {
    const updateTransactionStatus = jest.fn().mockRejectedValue(new Error('db locked'))
    const storage = storageStub({ updateTransactionStatus })

    await expect(
      holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow('db locked')
    // The queue row insert already ran (and, per the ordering test above,
    // ran first), so the drain can still find and post this txid even though
    // this call reports failure to its caller.
    expect(mockedInsert).toHaveBeenCalledTimes(1)
  })

  // FIX F, part 1. `insertOfflineAction` is INSERT OR IGNORE on a UNIQUE txid,
  // so with a parked row already present the insert was silently ignored, the
  // row stayed 'parked' forever, and the promotion below still moved the
  // transaction past 'nosend' — leaving the payment neither drainable (the
  // drain reads 'queued'/'posting') nor cancellable (cancel refuses anything
  // past 'nosend'). Park → hold must leave the row queued and drainable.
  describe('a second confirm of a parked payment', () => {
    const parked = (status = 'parked') => ({
      offlineActionId: 1,
      created_at: 'n',
      updated_at: 'n',
      userId: 5,
      txid: TXID,
      seq: 1,
      role: 'sent' as const,
      senderIdentityKey: null,
      receivedVia: null,
      status,
      rejectedReason: null,
      poisonedByTxid: null,
      framePayload: 'bsvpayf1:abc'
    })

    it('advances the parked row to queued instead of re-inserting it', async () => {
      mockedFind.mockResolvedValue(parked())
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

      expect(mockedInsert).not.toHaveBeenCalled()
      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      // Drainable: the row is queued AND the drain has been woken.
      expect(TaskSendOffline.hasPending).toBe(true)
      expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
    })

    it('keeps the durable row write ahead of the promotion', async () => {
      mockedFind.mockResolvedValue(parked())
      const calls: string[] = []
      mockedUpdate.mockImplementation(async () => {
        calls.push('update')
      })
      const updateTransactionStatus = jest.fn().mockImplementation(async () => {
        calls.push('promote')
      })
      const storage = storageStub({
        tx: { transactionId: 99, userId: 5, status: 'nosend' },
        updateTransactionStatus
      })

      await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
      expect(calls).toEqual(['update', 'promote'])
    })

    it('leaves an already-promoted transaction alone while still queueing the row', async () => {
      mockedFind.mockResolvedValue(parked())
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'unproven' } })

      await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    })

    it('re-confirming an already-queued payment is a harmless no-op', async () => {
      mockedFind.mockResolvedValue(parked('queued'))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'unproven' } })

      await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

      expect(mockedInsert).not.toHaveBeenCalled()
      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
    })

    // Dragging a decided payment back to 'queued' would re-broadcast something
    // the wallet has already failed or the user already cancelled.
    it.each(['sent', 'rejected', 'acknowledged'])('refuses to rewind a %s row', async status => {
      mockedFind.mockResolvedValue(parked(status))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

      expect(mockedInsert).not.toHaveBeenCalled()
      expect(mockedUpdate).not.toHaveBeenCalled()
      expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    })
  })

  // XR-036: `holdSentPaymentOffline` used to insert the queue row straight at
  // 'queued' and wake the drain BEFORE the hand-over had been journaled — so a
  // process kill or a transient write fault right there left a drainable row
  // with no journal entry to match it. The drain's broadcast hold now keys on
  // the `color_transfers` journal (`colorHeldTxids`, a missing row holds), but
  // a token-bearing row is still parked until its journal write lands, so the
  // drain never sees it early.
  describe('XR-036: a token-bearing hold is not drainable before its settlement journals', () => {
    it('inserts at parked, never queued, when the settlement journal write fails', async () => {
      const onHandedOver = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        onHandedOver
      })

      expect(onHandedOver).toHaveBeenCalledWith(TXID, 'handed_over')
      expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' }, 'parked')
      // The one assertion that matters: never promoted to 'queued', so
      // `processOfflineActions` never finds a drainable row for this txid.
      expect(mockedUpdate).not.toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(false)
    })

    it('promotes to queued and wakes the drain once the journal write lands', async () => {
      const onHandedOver = jest.fn().mockResolvedValue(undefined)
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        onHandedOver
      })

      expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' }, 'parked')
      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(true)
      expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
    })

    it('a plain BSV hold (no journal hook) keeps the old immediate queue/wake order', async () => {
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

      expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' })
      expect(TaskSendOffline.hasPending).toBe(true)
    })

    it('an already-parked row is not promoted to queued when a re-journal attempt fails', async () => {
      mockedFind.mockResolvedValue({
        offlineActionId: 1,
        created_at: 'n',
        updated_at: 'n',
        userId: 5,
        txid: TXID,
        seq: 1,
        role: 'sent' as const,
        senderIdentityKey: null,
        receivedVia: null,
        status: 'parked',
        rejectedReason: null,
        poisonedByTxid: null,
        framePayload: 'bsvpayf1:abc'
      })
      const onHandedOver = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        onHandedOver
      })

      expect(mockedUpdate).not.toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(false)
    })
  })
})

describe('parkSentPaymentOffline', () => {
  beforeEach(() => {
    mockedInsert.mockClear()
    mockedInsert.mockResolvedValue(undefined)
    TaskSendOffline.resetForTests()
  })

  it('records the payment without promoting it or waking the send task', async () => {
    const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })

    await parkSentPaymentOffline({
      storage: storage as unknown as StorageExpoSQLite,
      txid: TXID,
      framePayload: 'bsvpayf1:abc'
    })

    // The whole point of parking: nothing is released for broadcast.
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    expect(mockedInsert).toHaveBeenCalledWith(
      storage.sqliteDb,
      { userId: 5, txid: TXID, framePayload: 'bsvpayf1:abc', role: 'sent' },
      'parked'
    )
  })

  it('refuses when there is no transaction to park', async () => {
    const storage = storageStub({ tx: null })
    await expect(
      parkSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow(/no transaction record/)
    expect(mockedInsert).not.toHaveBeenCalled()
  })

  it('refuses when the database is closed', async () => {
    const storage = storageStub({ sqliteDb: undefined })
    await expect(
      parkSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
    ).rejects.toThrow(/database is not open/)
  })

  // XR-036 review follow-up: the journal outcome used to be discarded
  // entirely, so nothing downstream of a park could tell a silently-failed
  // token journal from one that landed. Propagated so a caller (and
  // `releaseParkedPayment`'s own settlement check) has something to act on.
  describe('XR-036 review follow-up: reports whether the settlement journal landed', () => {
    it('resolves true for a plain BSV park (nothing to journal)', async () => {
      const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })
      await expect(
        parkSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
      ).resolves.toBe(true)
    })

    it('resolves false when a token hold journal write fails', async () => {
      const onHandedOver = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })

      await expect(
        parkSentPaymentOffline({
          storage: storage as unknown as StorageExpoSQLite,
          txid: TXID,
          onHandedOver
        })
      ).resolves.toBe(false)
      // Still durable at 'parked' regardless of the journal outcome.
      expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' }, 'parked')
    })

    it('resolves true when a token hold journal write lands', async () => {
      const onHandedOver = jest.fn().mockResolvedValue(undefined)
      const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })

      await expect(
        parkSentPaymentOffline({
          storage: storage as unknown as StorageExpoSQLite,
          txid: TXID,
          onHandedOver
        })
      ).resolves.toBe(true)
    })
  })
})

describe('releaseParkedPayment', () => {
  beforeEach(() => {
    mockedUpdate.mockClear()
    mockedUpdate.mockResolvedValue(undefined)
    TaskSendOffline.resetForTests()
  })

  it('flips the parked row to queued and promotes the withheld transaction', async () => {
    const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

    await releaseParkedPayment({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

    expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
    expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
  })

  it('leaves an already-promoted transaction alone', async () => {
    const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'unproven' } })

    await releaseParkedPayment({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

    expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
  })

  // A token park whose journal write failed has no `parked` row behind it;
  // releasing it must first move the journal to `handed_over` through the
  // runtime hook. No hook, or a failed one, leaves the queue row parked: the
  // broadcast hold would still hold the tx (W1), but a queued row with a
  // journal that never says `handed_over` is a payment nothing will settle.
  describe('a token hold is released only through the journal', () => {
    it('does not promote when isTokenHold is set and no journal hook is given', async () => {
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await releaseParkedPayment({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        isTokenHold: true
      })

      expect(mockedUpdate).not.toHaveBeenCalled()
      expect(TaskSendOffline.hasPending).toBe(false)
      expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    })

    it('does not promote when the journal hook fails', async () => {
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })
      const onHandedOver = jest.fn().mockRejectedValue(new Error('color_transfers: no row'))

      await releaseParkedPayment({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        isTokenHold: true,
        onHandedOver
      })

      expect(onHandedOver).toHaveBeenCalledWith(TXID, 'handed_over')
      expect(mockedUpdate).not.toHaveBeenCalled()
      expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    })

    it('journals handed_over first, then promotes the token hold', async () => {
      const order: string[] = []
      mockedUpdate.mockImplementation(async () => {
        order.push('queued')
      })
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })
      const onHandedOver = jest.fn(async () => {
        order.push('journal')
      })

      await releaseParkedPayment({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        isTokenHold: true,
        onHandedOver
      })

      expect(order).toEqual(['journal', 'queued'])
      expect(TaskSendOffline.hasPending).toBe(true)
      expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
    })

    it('still releases a plain BSV park (isTokenHold unset) with no journal hook', async () => {
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await releaseParkedPayment({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(true)
    })
  })
})

describe('the payer journal across park and release', () => {
  beforeEach(() => {
    mockedInsert.mockClear()
    mockedInsert.mockResolvedValue(undefined)
    mockedUpdate.mockClear()
    mockedUpdate.mockResolvedValue(undefined)
    mockedFind.mockClear()
    mockedFind.mockResolvedValue(undefined)
    TaskSendOffline.resetForTests()
  })

  it('parks then releases through the journal', async () => {
    // A journal that only moves forward: built → parked → handed_over.
    const states: string[] = ['built']
    const onHandedOver = jest.fn(async (_txid: string, to: 'parked' | 'handed_over') => {
      const at = states[states.length - 1]
      if (to === 'parked' && at === 'built') states.push('parked')
      else if (to === 'handed_over' && (at === 'built' || at === 'parked')) states.push('handed_over')
    })
    const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

    await expect(
      parkSentPaymentOffline({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        framePayload: 'bsvpayf1:abc',
        onHandedOver
      })
    ).resolves.toBe(true)
    expect(states).toEqual(['built', 'parked'])
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    expect(TaskSendOffline.hasPending).toBe(false)

    await releaseParkedPayment({
      storage: storage as unknown as StorageExpoSQLite,
      txid: TXID,
      isTokenHold: true,
      onHandedOver
    })
    expect(states).toEqual(['built', 'parked', 'handed_over'])
    expect(onHandedOver.mock.calls).toEqual([
      [TXID, 'parked'],
      [TXID, 'handed_over']
    ])
    expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
    expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
  })
})
