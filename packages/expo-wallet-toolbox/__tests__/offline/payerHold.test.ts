import { holdSentPaymentOffline, parkSentPaymentOffline, releaseParkedPayment } from '../../core/offline/payerHold'
import {
  findOfflineActionByTxid,
  insertOfflineAction,
  updateOfflineAction
} from '../../core/storage/methods/offlineActions'
import { TaskSendOffline } from '../../core/monitor/TaskSendOffline'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import type { EvidenceFrame } from '../../core/mandala/types'

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

  // XR-036: `processOfflineActions.ts`'s `readSettlement` tells "ordinary BSV"
  // from "token, needs overlay admission first" by whether ANY
  // `token_settlements` row exists for the txid at all. `holdSentPaymentOffline`
  // used to insert the queue row straight at 'queued' and wake the drain BEFORE
  // `journalHandover` had written that row — so a process kill or a transient
  // write fault right there left a drainable row with no settlement to match
  // it, and the drain read that absence as "plain BSV" and posted it straight
  // past overlay admission.
  describe('XR-036: a token-bearing hold is not drainable before its settlement journals', () => {
    const TOKEN_FRAME: EvidenceFrame = {
      token: {
        assetId: 'ab'.repeat(32) + '.0',
        overlayUrl: 'https://overlay.example',
        overlayIdentityKey: '02' + 'cd'.repeat(32),
        linkage: []
      },
      transaction: new Uint8Array([1])
    }

    it('inserts at parked, never queued, when the settlement journal write fails', async () => {
      const onTokenHandedOver = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        frame: TOKEN_FRAME,
        onTokenHandedOver,
        reference: 'the-reference'
      })

      expect(onTokenHandedOver).toHaveBeenCalledWith(TOKEN_FRAME, TXID, 'handed_over', 'the-reference')
      expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' }, 'parked')
      // The one assertion that matters: never promoted to 'queued', so
      // `processOfflineActions` never finds a drainable row for this txid.
      expect(mockedUpdate).not.toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(false)
    })

    it('promotes to queued and wakes the drain once the journal write lands', async () => {
      const onTokenHandedOver = jest.fn().mockResolvedValue(undefined)
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        frame: TOKEN_FRAME,
        onTokenHandedOver
      })

      expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' }, 'parked')
      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(true)
      expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
    })

    it('a plain BSV hold (no frame/hook) keeps the old immediate queue/wake order', async () => {
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
      const onTokenHandedOver = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await holdSentPaymentOffline({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        frame: TOKEN_FRAME,
        onTokenHandedOver
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
    const TOKEN_FRAME: EvidenceFrame = {
      token: {
        assetId: 'ab'.repeat(32) + '.0',
        overlayUrl: 'https://overlay.example',
        overlayIdentityKey: '02' + 'cd'.repeat(32),
        linkage: []
      },
      transaction: new Uint8Array([1])
    }

    it('resolves true for a plain BSV park (nothing to journal)', async () => {
      const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })
      await expect(
        parkSentPaymentOffline({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })
      ).resolves.toBe(true)
    })

    it('resolves false when a token hold journal write fails', async () => {
      const onTokenHandedOver = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
      const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })

      await expect(
        parkSentPaymentOffline({
          storage: storage as unknown as StorageExpoSQLite,
          txid: TXID,
          frame: TOKEN_FRAME,
          onTokenHandedOver
        })
      ).resolves.toBe(false)
      // Still durable at 'parked' regardless of the journal outcome.
      expect(mockedInsert).toHaveBeenCalledWith(storage.sqliteDb, { userId: 5, txid: TXID, role: 'sent' }, 'parked')
    })

    it('resolves true when a token hold journal write lands', async () => {
      const onTokenHandedOver = jest.fn().mockResolvedValue(undefined)
      const storage = storageStub({ tx: { transactionId: 99, userId: 5 } })

      await expect(
        parkSentPaymentOffline({
          storage: storage as unknown as StorageExpoSQLite,
          txid: TXID,
          frame: TOKEN_FRAME,
          onTokenHandedOver
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

  // XR-036 review follow-up: `parkSentPaymentOffline` discards
  // `journalHandover`'s outcome, and this function (called from
  // WalletHomeScreen.tsx's resend flow) had no check of its own — so a
  // token-bearing payment whose park-time settlement write silently failed
  // (a transient fault, same class as XR-036's own scenario) could still be
  // promoted straight to 'queued' here, waking the drain with no
  // `token_settlements` row for `processOfflineActions`'s `readSettlement` to
  // find. That absence reads as "plain BSV" and posts the token transfer
  // straight past overlay admission: the exact XR-036 defect, reached through
  // this second entry point instead of `holdSentPaymentOffline`.
  describe('XR-036 review follow-up: a token hold is not released without its settlement row', () => {
    function tokenDbStub(settlementRow: unknown) {
      return {
        getFirstAsync: jest.fn().mockResolvedValue(settlementRow),
        getAllAsync: jest.fn().mockResolvedValue([]),
        runAsync: jest.fn().mockResolvedValue({ changes: 1 })
      }
    }

    it('does not promote when isTokenHold is set and no settlement row exists', async () => {
      const storage = storageStub({
        sqliteDb: tokenDbStub(null),
        tx: { transactionId: 99, userId: 5, status: 'nosend' }
      })

      await releaseParkedPayment({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        isTokenHold: true
      })

      expect(mockedUpdate).not.toHaveBeenCalled()
      expect(TaskSendOffline.hasPending).toBe(false)
      expect(storage.updateTransactionStatus).not.toHaveBeenCalled()
    })

    it('promotes once a settlement row exists for the token hold', async () => {
      const storage = storageStub({
        sqliteDb: tokenDbStub({ txid: TXID, state: 'parked' }),
        tx: { transactionId: 99, userId: 5, status: 'nosend' }
      })

      await releaseParkedPayment({
        storage: storage as unknown as StorageExpoSQLite,
        txid: TXID,
        isTokenHold: true
      })

      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(true)
      expect(storage.updateTransactionStatus).toHaveBeenCalledWith('unproven', 99)
    })

    it('still releases a plain BSV park (isTokenHold unset) with no settlement row', async () => {
      const storage = storageStub({ tx: { transactionId: 99, userId: 5, status: 'nosend' } })

      await releaseParkedPayment({ storage: storage as unknown as StorageExpoSQLite, txid: TXID })

      expect(mockedUpdate).toHaveBeenCalledWith(storage.sqliteDb, TXID, { status: 'queued' })
      expect(TaskSendOffline.hasPending).toBe(true)
    })
  })
})
