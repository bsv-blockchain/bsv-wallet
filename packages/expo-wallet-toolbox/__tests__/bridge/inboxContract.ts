/**
 * The `InboxStore` contract suite (spec 6.8). Any adapter, the in-memory one here and project 2's
 * App Group one later, passes it by supplying a factory.
 */
import { Utils } from '@bsv/sdk'
import { inboxDigest, type InboxStore } from '../../core/bridge/inbox'

export interface StoreHarness {
  store: InboxStore
  /** The same persisted state opened by a new process (new boot id). */
  restart(): InboxStore
}

export interface Clock {
  now(): number
  advance(ms: number): void
}

export const MARKER = 'PLAINTEXT-MARKER-7f3a'

const bytes = (s: string) => Uint8Array.from(Utils.toArray(s, 'utf8'))
const text = (b: Uint8Array) => Utils.toUTF8(Array.from(b))
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function containsMarker(raw: Uint8Array): boolean {
  const needle = Utils.toArray(MARKER, 'utf8')
  outer: for (let i = 0; i + needle.length <= raw.length; i++) {
    for (let j = 0; j < needle.length; j++) if (raw[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

export function runInboxStoreContract(name: string, makeStore: (clock: Clock) => StoreHarness): void {
  describe(`InboxStore contract: ${name}`, () => {
    let t = 1_000_000
    const clock: Clock = {
      now: () => t,
      advance: ms => {
        t += ms
      }
    }
    let h: StoreHarness
    let store: InboxStore
    beforeEach(() => {
      t = 1_000_000
      h = makeStore(clock)
      store = h.store
    })

    it('stages, stats and reads a record without changing its state', async () => {
      expect(await store.create(ID(1), bytes('hello'))).toBe(true)
      expect(await store.stat(ID(1))).toMatchObject({ size: 5, state: 'pending' })
      expect(text((await store.read(ID(1))) as Uint8Array)).toBe('hello')
      expect(await store.stat(ID(1))).toMatchObject({ state: 'pending' })
      expect(await store.stat(ID(2))).toBeUndefined()
      expect(await store.list('pending')).toEqual([ID(1)])
    })

    it('re-stage is refused in every state, tombstones included', async () => {
      await store.create(ID(1), bytes('a'))
      expect(await store.create(ID(1), bytes('b'))).toBe(false)
      await store.accept(ID(1))
      expect(await store.create(ID(1), bytes('b'))).toBe(false)
      await store.claim(ID(1), inboxDigest(bytes('a')))
      expect(await store.create(ID(1), bytes('b'))).toBe(false)
      await store.writeResult(ID(1), bytes('r'))
      expect(await store.create(ID(1), bytes('b'))).toBe(false)
      await store.ack(ID(1))
      expect(await store.create(ID(1), bytes('b'))).toBe(false)
      expect(await store.stat(ID(1))).toMatchObject({ state: 'done' })
    })

    it('size is available from stat without reading the payload', async () => {
      await store.create(ID(1), new Uint8Array(1234))
      expect((await store.stat(ID(1)))?.size).toBe(1234)
    })

    it('accept moves pending to accepted once', async () => {
      await store.create(ID(1), bytes('a'))
      expect(await store.accept(ID(1))).toBe(true)
      expect(await store.accept(ID(1))).toBe(false)
      expect(await store.accept(ID(9))).toBe(false)
    })

    it('claim needs an accepted record', async () => {
      await store.create(ID(1), bytes('a'))
      expect(await store.claim(ID(1), inboxDigest(bytes('a')))).toBe('not-accepted')
    })

    it('concurrent claim succeeds exactly once', async () => {
      await store.create(ID(1), bytes('a'))
      await store.accept(ID(1))
      const d = inboxDigest(bytes('a'))
      const results = await Promise.all([store.claim(ID(1), d), store.claim(ID(1), d), store.claim(ID(1), d)])
      expect(results.filter(r => r === 'claimed')).toHaveLength(1)
      expect(results.filter(r => r === 'not-accepted')).toHaveLength(2)
    })

    it('claim fails when the digest does not match, and the record stays accepted', async () => {
      await store.create(ID(1), bytes('a'))
      await store.accept(ID(1))
      expect(await store.claim(ID(1), inboxDigest(bytes('changed')))).toBe('digest-mismatch')
      expect(await store.stat(ID(1))).toMatchObject({ state: 'accepted' })
      expect(await store.claim(ID(1), inboxDigest(bytes('a')))).toBe('claimed')
    })

    it('claim stamps the boot id and deletes the arguments', async () => {
      await store.create(ID(1), bytes('a'))
      await store.accept(ID(1))
      await store.claim(ID(1), inboxDigest(bytes('a')))
      expect(await store.stat(ID(1))).toMatchObject({ state: 'claimed', claimBootId: store.bootId(), size: 1 })
      expect(await store.read(ID(1))).toBeUndefined()
    })

    it('a result is written once, read, and acknowledged without losing the tombstone', async () => {
      await store.create(ID(1), bytes('a'))
      expect(await store.readResult(ID(1))).toEqual({ kind: 'none' })
      expect(await store.writeResult(ID(1), bytes('r1'))).toBe(true)
      expect(await store.writeResult(ID(1), bytes('r2'))).toBe(false)
      const r = await store.readResult(ID(1))
      expect(r.kind === 'result' && text(r.bytes)).toBe('r1')
      expect(await store.read(ID(1))).toBeUndefined()
      await store.ack(ID(1))
      expect(await store.readResult(ID(1))).toEqual({ kind: 'purged' })
      expect(await store.stat(ID(1))).toBeDefined()
    })

    it('an unacknowledged result is purged after 15 minutes', async () => {
      await store.create(ID(1), bytes('a'))
      await store.writeResult(ID(1), bytes('r'))
      clock.advance(14 * 60_000)
      expect((await store.readResult(ID(1))).kind).toBe('result')
      clock.advance(2 * 60_000)
      expect(await store.readResult(ID(1))).toEqual({ kind: 'purged' })
      expect(await store.create(ID(1), bytes('b'))).toBe(false)
    })

    it('close events are written and read after a sequence number, in order', async () => {
      await store.writeEvent({ v: 1, closeSeq: 2, instanceId: 'i', epoch: 'e2', reason: 'lost' })
      await store.writeEvent({ v: 1, closeSeq: 1, instanceId: 'i', epoch: 'e1', reason: 'revoked' })
      expect((await store.readEventsAfter(0)).map(e => e.closeSeq)).toEqual([1, 2])
      expect((await store.readEventsAfter(1)).map(e => e.epoch)).toEqual(['e2'])
      expect(await store.readEventsAfter(2)).toEqual([])
    })

    it('state survives a restart under a new boot id', async () => {
      await store.create(ID(1), bytes('a'))
      await store.accept(ID(1))
      await store.claim(ID(1), inboxDigest(bytes('a')))
      await store.create(ID(2), bytes('b'))
      await store.accept(ID(2))
      const next = h.restart()
      expect(next.bootId()).not.toBe(store.bootId())
      expect(await next.stat(ID(1))).toMatchObject({ state: 'claimed', claimBootId: store.bootId() })
      expect(await next.list('accepted')).toEqual([ID(2)])
      expect(await next.release(ID(2))).toBe(true)
      expect(await next.list('pending')).toEqual([ID(2)])
      expect(await next.release(ID(2))).toBe(false)
    })

    it('raw stored bytes contain no plaintext marker', async () => {
      await store.create(ID(1), bytes(JSON.stringify({ args: MARKER })))
      await store.create(ID(2), bytes(JSON.stringify({ args: MARKER })))
      await store.accept(ID(2))
      await store.writeResult(ID(3 - 1), bytes(JSON.stringify({ result: MARKER })))
      await store.writeEvent({ v: 1, closeSeq: 1, instanceId: MARKER, epoch: MARKER, reason: 'lost' })
      const raw = store.rawBytes()
      expect(raw.length).toBeGreaterThan(0)
      expect(raw.some(containsMarker)).toBe(false)
      // The check can fail: it does see a marker when one is present.
      expect(containsMarker(bytes(MARKER))).toBe(true)
    })
  })
}
