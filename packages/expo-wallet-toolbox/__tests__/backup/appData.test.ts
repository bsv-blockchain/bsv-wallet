import {
  applyAppData,
  captureAppDataSnapshot,
  isEmptyAppData,
  mergeAppData
} from '../../core/backup/appData'
import { PENDING_KEY } from '../../core/localpay/pending'
import { OUTBOX_KEY } from '../../core/peerpay/outbox'
import { RECEIVE_HISTORY_KEY } from '../../core/pay/receiveHistory'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

describe('XR-011: isEmptyAppData', () => {
  it('is true for undefined', () => {
    expect(isEmptyAppData(undefined)).toBe(true)
  })

  it('is true for an object with nothing set', () => {
    expect(isEmptyAppData({})).toBe(true)
  })

  it('is true for an empty receiveIssuedDates array', () => {
    expect(isEmptyAppData({ receiveIssuedDates: [] })).toBe(true)
  })

  it('is false when localpayPending is set', () => {
    expect(isEmptyAppData({ localpayPending: '[]' })).toBe(false)
  })

  it('is false when peerpayOutbox is set', () => {
    expect(isEmptyAppData({ peerpayOutbox: '[]' })).toBe(false)
  })

  it('is false when receiveIssuedDates has entries', () => {
    expect(isEmptyAppData({ receiveIssuedDates: ['2026-08-01'] })).toBe(false)
  })
})

describe('XR-011: captureAppDataSnapshot', () => {
  it('is empty for a fresh install with nothing queued', async () => {
    const storage = fakeStorage()
    await expect(captureAppDataSnapshot(storage)).resolves.toEqual({})
  })

  it('captures the current localpay_pending and peerpay_outbox rows verbatim', async () => {
    const pending = '[{"id":"p1","status":"pending"}]'
    const outbox = '[{"id":"o1","status":"unsent"}]'
    const storage = fakeStorage({ [PENDING_KEY]: pending, [OUTBOX_KEY]: outbox })

    await expect(captureAppDataSnapshot(storage)).resolves.toEqual({
      localpayPending: pending,
      peerpayOutbox: outbox
    })
  })

  it('captures the issued-date history (XR-055)', async () => {
    const storage = fakeStorage({ [RECEIVE_HISTORY_KEY]: JSON.stringify(['2026-08-01', '2026-07-01']) })

    await expect(captureAppDataSnapshot(storage)).resolves.toEqual({
      receiveIssuedDates: ['2026-07-01', '2026-08-01']
    })
  })
})

describe('XR-011: applyAppData', () => {
  it('writes localpayPending and peerpayOutbox verbatim into a fresh storage', async () => {
    const storage = fakeStorage()
    const pending = '[{"id":"p1","status":"pending"}]'
    const outbox = '[{"id":"o1","status":"unsent"}]'

    await applyAppData(storage, { localpayPending: pending, peerpayOutbox: outbox })

    expect(storage.map.get(PENDING_KEY)).toBe(pending)
    expect(storage.map.get(OUTBOX_KEY)).toBe(outbox)
  })

  it('writes the issued-date history', async () => {
    const storage = fakeStorage()
    await applyAppData(storage, { receiveIssuedDates: ['2026-08-01', '2026-08-01', '2026-07-01'] })

    expect(JSON.parse(storage.map.get(RECEIVE_HISTORY_KEY)!)).toEqual(['2026-07-01', '2026-08-01'])
  })

  it('never touches a row the snapshot did not carry', async () => {
    const storage = fakeStorage({ [PENDING_KEY]: 'untouched' })
    await applyAppData(storage, { peerpayOutbox: '[]' })

    expect(storage.map.get(PENDING_KEY)).toBe('untouched')
  })

  it('does nothing at all for an empty snapshot', async () => {
    const storage = fakeStorage()
    await applyAppData(storage, {})
    expect(storage.map.size).toBe(0)
  })

  // The concrete safety property the ledger asks for: a replayed row can never cause an
  // automatic broadcast or input release without the existing guards. applyAppData's own
  // signature only ever touches a KV-shaped storage (getKeyValue/setKeyValue) — there is no
  // internalizeAction, broadcast, or abort call anywhere in its reach, so a storage stub that
  // implements ONLY those two methods is a complete, faithful double: if a future edit ever
  // reached for anything else, this stub throws "x is not a function" and the test fails.
  it('touches storage through nothing but getKeyValue/setKeyValue', async () => {
    const calls: string[] = []
    const narrow = {
      getKeyValue: async (k: string) => {
        calls.push(`get:${k}`)
        return undefined
      },
      setKeyValue: async (k: string, _v: string) => {
        calls.push(`set:${k}`)
      }
    }
    await applyAppData(narrow, {
      localpayPending: '[]',
      peerpayOutbox: '[]',
      receiveIssuedDates: ['2026-08-01']
    })
    expect(calls).toEqual([`set:${PENDING_KEY}`, `set:${OUTBOX_KEY}`, `set:${RECEIVE_HISTORY_KEY}`])
  })
})

describe('XR-011/XR-015: mergeAppData', () => {
  it('unions distinct localpay_pending entries from two devices rather than dropping one', () => {
    const a = { localpayPending: '[{"id":"p1"}]' }
    const b = { localpayPending: '[{"id":"p2"}]' }

    const merged = mergeAppData(a, b)

    expect(JSON.parse(merged.localpayPending!)).toEqual([{ id: 'p1' }, { id: 'p2' }])
  })

  it('unions distinct peerpay_outbox entries from two devices', () => {
    const a = { peerpayOutbox: '[{"id":"o1"}]' }
    const b = { peerpayOutbox: '[{"id":"o2"}]' }

    const merged = mergeAppData(a, b)

    expect(JSON.parse(merged.peerpayOutbox!)).toEqual([{ id: 'o1' }, { id: 'o2' }])
  })

  it('deduplicates by id rather than keeping both copies of the same entry', () => {
    const a = { localpayPending: '[{"id":"p1","status":"pending"}]' }
    const b = { localpayPending: '[{"id":"p1","status":"pending"}]' }

    const merged = mergeAppData(a, b)

    expect(JSON.parse(merged.localpayPending!)).toHaveLength(1)
  })

  it('unions issued-date histories', () => {
    const merged = mergeAppData({ receiveIssuedDates: ['2026-08-01'] }, { receiveIssuedDates: ['2026-07-01'] })
    expect(merged.receiveIssuedDates).toEqual(['2026-07-01', '2026-08-01'])
  })

  it('is undefined-safe on either side', () => {
    expect(mergeAppData(undefined, { localpayPending: '[]' })).toEqual({ localpayPending: '[]' })
    expect(mergeAppData({ peerpayOutbox: '[]' }, undefined)).toEqual({ peerpayOutbox: '[]' })
    expect(mergeAppData(undefined, undefined)).toEqual({})
  })
})
