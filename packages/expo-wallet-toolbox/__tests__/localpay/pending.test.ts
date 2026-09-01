import {
  MAX_PENDING_ATTEMPTS,
  PENDING_KEY,
  PENDING_SUMMARY_KEY,
  PendingCorruptError,
  SPENT_KEY,
  getPending,
  getPendingCorruptNotice,
  getRetryable,
  getUnprocessed,
  isSessionSpent,
  markSessionSpent,
  processPending,
  readUnprocessedPending,
  savePending,
  updateStatus
} from '../../core/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import { Transaction, Beef, LockingScript } from '@bsv/sdk'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v),
  }
}

const frame = (): PaymentFrame => ({
  version: FRAME_VERSION,
  kind: 'bsv' as const,
  senderIdentityKey: '02'.padEnd(66, 'c'),
  outputIndex: 0,
  derivationPrefix: 'cHJlZml4',
  derivationSuffix: 'c3VmZml4',
  transaction: new Uint8Array([9, 9, 9]),
})

// A real AtomicBEEF, distinct from `frame()`'s placeholder bytes: attribution
// derives the txid by actually parsing the frame's transaction (internalizeAction's
// own resolved value carries no txid — see utils/localpay/pending.ts's processPending),
// so exercising that path needs bytes Beef.fromBinary can actually read.
function atomicBeefFixture(): { txid: string; transaction: Uint8Array } {
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1000,
    lockingScript: LockingScript.fromHex('76a914000000000000000000000000000000000000000088ac')
  })
  const txid = tx.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { txid, transaction: new Uint8Array(beef.toBinaryAtomic(txid)) }
}

describe('localpay pending queue', () => {
  it('persists under the localpay key', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    expect(s.map.has(PENDING_KEY)).toBe(true)
  })

  it('returns saved entries as pending', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const all = await getPending(s)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('pending')
    expect(all[0].frame.outputIndex).toBe(0)
  })

  it('quarantines corrupt JSON instead of treating the queue as empty', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, '{not json')
    await expect(getPending(s)).rejects.toThrow(/corrupt/i)
    const keys = [...s.map.keys()]
    expect(keys.some(k => k.startsWith('localpay_pending_corrupt_'))).toBe(true)
    expect(JSON.parse(s.map.get(PENDING_KEY)!)).toEqual([])
  })

  it('replaces PENDING_KEY with [] after quarantining corrupt JSON so a later save can proceed', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, '{not json')
    await expect(getPending(s)).rejects.toBeInstanceOf(PendingCorruptError)
    expect(JSON.parse(s.map.get(PENDING_KEY)!)).toEqual([])
    expect([...s.map.keys()].some(k => k.startsWith('localpay_pending_corrupt_'))).toBe(true)
    const saved = await savePending(s, frame())
    expect(saved.status).toBe('pending')
  })

  it('does not let a stale corrupt-repair wipe a later save', async () => {
    const corrupt = '{not json'
    const map = new Map<string, string>()
    map.set(PENDING_KEY, corrupt)

    let initialReaders = 0
    let releaseInitial!: () => void
    const initialBarrier = new Promise<void>(r => { releaseInitial = r })
    let bothStarted!: () => void
    const bothInitialReads = new Promise<void>(r => { bothStarted = r })

    let casPasses = 0
    let releaseStaleCas!: () => void
    const staleCasHold = new Promise<void>(r => { releaseStaleCas = r })
    let staleCasPending!: () => void
    const staleCasReached = new Promise<void>(r => { staleCasPending = r })

    const storage = {
      map,
      getKeyValue: async (k: string) => {
        if (k === PENDING_KEY) {
          const quarantines = [...map.keys()].filter(x => x.startsWith('localpay_pending_corrupt_')).length
          if (quarantines > 0) {
            casPasses++
            if (casPasses === 2) {
              staleCasPending()
              await staleCasHold
            }
            return map.get(k)
          }
          if (map.get(k) === corrupt) {
            initialReaders++
            if (initialReaders === 2) bothStarted()
            await initialBarrier
            return corrupt
          }
        }
        return map.get(k)
      },
      setKeyValue: async (k: string, v: string) => {
        map.set(k, v)
      },
    }

    const first = getPending(storage as never)
    const stale = getPending(storage as never)
    await bothInitialReads
    releaseInitial()

    await staleCasReached
    await expect(first).rejects.toBeInstanceOf(PendingCorruptError)
    const saved = await savePending(storage as never, frame())
    releaseStaleCas()
    await expect(stale).rejects.toBeInstanceOf(PendingCorruptError)

    const all = JSON.parse(map.get(PENDING_KEY)!) as { id: string }[]
    expect(all.map(e => e.id)).toEqual([saved.id])
  })

  it('still throws on save over corrupt JSON after repairing PENDING_KEY to []', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, '{not json')
    await expect(savePending(s, frame())).rejects.toThrow(/corrupt/i)
    expect(JSON.parse(s.map.get(PENDING_KEY)!)).toEqual([])
    expect([...s.map.keys()].some(k => k.startsWith('localpay_pending_corrupt_'))).toBe(true)
  })

  it('drops completed entries on write', async () => {
    const s = fakeStorage()
    const a = await savePending(s, frame())
    await updateStatus(s, a.id, 'completed')
    const b = await savePending(s, frame())
    const all = JSON.parse(s.map.get(PENDING_KEY)!) as { id: string; status: string }[]
    expect(all.map(e => e.id)).toEqual([b.id])
  })

  it('propagates PendingCorruptError from getUnprocessed', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, '{not json')
    await expect(getUnprocessed(s)).rejects.toThrow(PendingCorruptError)
  })

  it('readUnprocessedPending reports corrupt instead of an empty queue', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, '{not json')
    expect(await readUnprocessedPending(s)).toEqual({ count: 0, stuck: 0, corrupt: true })
  })

  it('readUnprocessedPending counts unprocessed entries', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    expect(await readUnprocessedPending(s)).toEqual({ count: 1, stuck: 0, corrupt: false })
  })

  it('surfaces a corrupt-pending notice until a successful parse', async () => {
    const s = fakeStorage()
    s.map.set(PENDING_KEY, '{not json')
    await expect(getPending(s)).rejects.toThrow(PendingCorruptError)
    expect(getPendingCorruptNotice()).toBe(true)
    const clean = fakeStorage()
    await savePending(clean, frame())
    expect(getPendingCorruptNotice()).toBe(false)
  })

  it('excludes completed entries from unprocessed', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'completed')
    expect(await getUnprocessed(s)).toHaveLength(0)
  })

  it('re-offers a processing entry after a crash', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'processing')
    expect(await getUnprocessed(s)).toHaveLength(1)
  })

  it('records a failure reason', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'failed', 'no network')
    expect((await getPending(s))[0].failureReason).toBe('no network')
  })

  it('marks completed when internalizeAction succeeds', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(results).toEqual([expect.objectContaining({ success: true })])
    // completed entries are pruned on write
    expect(await getPending(s)).toEqual([])
  })

  it('marks failed and keeps the entry when internalizeAction throws', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    const wallet = { internalizeAction: jest.fn().mockRejectedValue(new Error('offline')) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(results).toEqual([expect.objectContaining({ success: false, error: 'offline' })])
    const all = await getPending(s)
    expect(all[0].status).toBe('failed')
    expect(all).toHaveLength(1)
  })

  it('storage failures propagate from getPending', async () => {
    const s = {
      getKeyValue: jest.fn().mockRejectedValue(new Error('SQLite locked')),
      setKeyValue: jest.fn(),
    }
    await expect(getPending(s as never)).rejects.toThrow('SQLite locked')
  })

  it('storage failures propagate from savePending and do not call setKeyValue', async () => {
    const setKeyValue = jest.fn()
    const s = {
      getKeyValue: jest.fn().mockRejectedValue(new Error('SQLite locked')),
      setKeyValue,
    }
    await expect(savePending(s as never, frame())).rejects.toThrow('SQLite locked')
    expect(setKeyValue).not.toHaveBeenCalled()
  })

  it('processPending re-invokes internalizeAction for processing entry and completes it', async () => {
    const s = fakeStorage()
    const p = await savePending(s, frame())
    await updateStatus(s, p.id, 'processing')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const results = await processPending(wallet as never, s, 'admin.com')
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect(await getPending(s)).toEqual([])
  })

  it('records the transport a payment arrived over, when the caller knows it', async () => {
    const s = fakeStorage()
    await savePending(s, frame(), 'awdl')
    expect((await getPending(s))[0].receivedVia).toBe('awdl')
  })

  it('leaves the transport unset when the caller does not pass one', async () => {
    const s = fakeStorage()
    await savePending(s, frame())
    expect((await getPending(s))[0].receivedVia).toBeUndefined()
  })

  it('attributes the queue row with the sender identity and transport after a successful internalize', async () => {
    const s = fakeStorage()
    const { txid, transaction } = atomicBeefFixture()
    await savePending(s, { ...frame(), transaction }, 'awdl')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn().mockResolvedValue(undefined)
    await processPending(wallet as never, s, 'admin.com', attribute)
    expect(attribute).toHaveBeenCalledWith(txid, {
      senderIdentityKey: '02'.padEnd(66, 'c'),
      receivedVia: 'awdl'
    })
  })

  it('does not fail the payment or stop the queue when attribution throws', async () => {
    const s = fakeStorage()
    const { transaction } = atomicBeefFixture()
    await savePending(s, { ...frame(), transaction }, 'awdl')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn().mockRejectedValue(new Error('database is locked'))
    const results = await processPending(wallet as never, s, 'admin.com', attribute)
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect(await getPending(s)).toEqual([])
  })

  it("does not stop the loop when one entry's attribution throws and another follows", async () => {
    const s = fakeStorage()
    const { transaction } = atomicBeefFixture()
    await savePending(s, { ...frame(), transaction }, 'awdl')
    await savePending(s, { ...frame(), transaction }, 'qr')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn().mockRejectedValueOnce(new Error('database is locked')).mockResolvedValueOnce(undefined)
    const results = await processPending(wallet as never, s, 'admin.com', attribute)
    expect(results).toEqual([expect.objectContaining({ success: true }), expect.objectContaining({ success: true })])
    expect(attribute).toHaveBeenCalledTimes(2)
  })

  it('skips attribution rather than throwing when the frame is not a readable BEEF', async () => {
    // frame()'s placeholder transaction bytes ([9, 9, 9]) are not a real BEEF —
    // Beef.fromBinary rejects them. A legacy or malformed frame must not crash
    // an otherwise-successful internalize.
    const s = fakeStorage()
    await savePending(s, frame(), 'awdl')
    const wallet = { internalizeAction: jest.fn().mockResolvedValue({ accepted: true }) }
    const attribute = jest.fn()
    const results = await processPending(wallet as never, s, 'admin.com', attribute)
    expect(results).toEqual([expect.objectContaining({ success: true })])
    expect(attribute).not.toHaveBeenCalled()
  })

  it('concurrent saves both persist via serialization', async () => {
    const s = {
      map: new Map<string, string>(),
      getKeyValue: async (k: string) => {
        await new Promise(r => setImmediate(r))
        return s.map.get(k)
      },
      setKeyValue: async (k: string, v: string) => {
        await new Promise(r => setImmediate(r))
        s.map.set(k, v)
      },
    }
    const [p1, p2] = await Promise.all([
      savePending(s as never, frame()),
      savePending(s as never, frame()),
    ])
    const all = await getPending(s as never)
    expect(all).toHaveLength(2)
    expect(all.map(x => x.id)).toContain(p1.id)
    expect(all.map(x => x.id)).toContain(p2.id)
    // Verify the stored list itself has 2 entries
    const stored = JSON.parse(s.map.get(PENDING_KEY)!)
    expect(stored).toHaveLength(2)
  })
})

describe('spent session guard', () => {
  const sid = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])

  it('reports an unseen session as unspent', async () => {
    await expect(isSessionSpent(fakeStorage(), sid())).resolves.toBe(false)
  })

  it('reports a marked session as spent', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    await expect(isSessionSpent(s, sid())).resolves.toBe(true)
  })

  it('distinguishes different sessions', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    const other = new Uint8Array(16).fill(9)
    await expect(isSessionSpent(s, other)).resolves.toBe(false)
  })

  it('is idempotent', async () => {
    const s = fakeStorage()
    await markSessionSpent(s, sid())
    await markSessionSpent(s, sid())
    expect(JSON.parse(s.map.get(SPENT_KEY)!)).toHaveLength(1)
  })

  it('treats corrupt storage as no sessions spent', async () => {
    const s = fakeStorage()
    s.map.set(SPENT_KEY, 'not json')
    await expect(isSessionSpent(s, sid())).resolves.toBe(false)
  })
})

// A queue that retries a hopeless frame forever re-validates a full BEEF on
// every wallet build and every nearby settle, and keeps calling it "waiting".
describe('pending queue attempt ceiling', () => {
  const frame = (id = 'a') =>
    ({
      version: 1,
      kind: 'bsv' as const,
      senderIdentityKey: '02' + id.repeat(64).slice(0, 64),
      outputIndex: 0,
      derivationPrefix: 'p',
      derivationSuffix: 's',
      transaction: new Uint8Array([1, 2, 3])
    })

  function store() {
    const kv = new Map<string, string>()
    return {
      kv,
      getKeyValue: async (k: string) => kv.get(k),
      setKeyValue: async (k: string, v: string) => void kv.set(k, v)
    }
  }

  it('stops retrying a frame after MAX_PENDING_ATTEMPTS failures', async () => {
    const s = store()
    const entry = await savePending(s, frame())
    for (let i = 0; i < MAX_PENDING_ATTEMPTS; i++) {
      await updateStatus(s, entry.id, 'failed', 'nope')
    }
    expect(await getRetryable(s)).toHaveLength(0)
    // Still held: it is money this device could not credit, not rubbish.
    expect(await getUnprocessed(s)).toHaveLength(1)
  })

  it('keeps retrying while attempts remain', async () => {
    const s = store()
    const entry = await savePending(s, frame())
    await updateStatus(s, entry.id, 'failed', 'nope')
    expect(await getRetryable(s)).toHaveLength(1)
  })

  it('does not count a given-up payment as waiting', async () => {
    const s = store()
    const entry = await savePending(s, frame())
    for (let i = 0; i < MAX_PENDING_ATTEMPTS; i++) {
      await updateStatus(s, entry.id, 'failed', 'nope')
    }
    expect(await readUnprocessedPending(s)).toEqual({ count: 0, stuck: 1, corrupt: false })
  })

  it('does not burn an attempt merely for starting one', async () => {
    const s = store()
    const entry = await savePending(s, frame())
    await updateStatus(s, entry.id, 'processing')
    await updateStatus(s, entry.id, 'processing')
    expect(await getRetryable(s)).toHaveLength(1)
  })
})

describe('pending summary key', () => {
  function store() {
    const kv = new Map<string, string>()
    const reads: string[] = []
    return {
      kv,
      reads,
      getKeyValue: async (k: string) => (reads.push(k), kv.get(k)),
      setKeyValue: async (k: string, v: string) => void kv.set(k, v)
    }
  }
  const frame = {
    version: 1,
    kind: 'bsv' as const,
    senderIdentityKey: '02'.padEnd(66, 'a'),
    outputIndex: 0,
    derivationPrefix: 'p',
    derivationSuffix: 's',
    transaction: new Uint8Array([1, 2, 3])
  }

  it('answers the badge without reading the queue itself', async () => {
    const s = store()
    await savePending(s, frame)
    s.reads.length = 0
    expect(await readUnprocessedPending(s)).toEqual({ count: 1, stuck: 0, corrupt: false })
    expect(s.reads).toEqual([PENDING_SUMMARY_KEY])
  })

  it('rebuilds and caches the summary for a store written before it existed', async () => {
    const s = store()
    await savePending(s, frame)
    s.kv.delete(PENDING_SUMMARY_KEY)
    expect(await readUnprocessedPending(s)).toEqual({ count: 1, stuck: 0, corrupt: false })
    expect(s.kv.get(PENDING_SUMMARY_KEY)).toBe(JSON.stringify({ waiting: 1, stuck: 0 }))
  })

  it('does not let a stale summary outlive a quarantined queue', async () => {
    const s = store()
    await savePending(s, frame)
    s.kv.set(PENDING_KEY, '{not json')
    await expect(getPending(s)).rejects.toBeInstanceOf(PendingCorruptError)
    expect(s.kv.get(PENDING_SUMMARY_KEY)).toBe(JSON.stringify({ waiting: 0, stuck: 0 }))
  })
})
