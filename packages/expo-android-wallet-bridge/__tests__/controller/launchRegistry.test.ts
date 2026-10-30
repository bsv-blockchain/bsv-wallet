import { createFakeNative } from '../../src/testing/fakeNative'
import { createLaunchRegistry } from '../../src/controller/launchRegistry'
import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import { CHALLENGE, SCHEME, epochOf, helloFor, kOf, uriOf } from './support'

function setup() {
  const native = createFakeNative()
  const registry = createLaunchRegistry({ native, scheme: SCHEME })
  return { native, registry }
}

describe('launch registry', () => {
  it('duplicate epoch in one take yields one record', () => {
    const { native, registry } = setup()
    native.pushLaunch(uriOf(1), 0)
    native.pushLaunch(uriOf(1), 0)
    registry.ingest()
    expect(registry.take(epochOf(1))).toBeDefined()
    expect(registry.take(epochOf(1))).toBeUndefined()
    expect(registry.hasLive()).toBe(false)
  })

  it('burnt epoch is not re-created by a later take', () => {
    const { native, registry } = setup()
    native.pushLaunch(uriOf(1), 0)
    registry.ingest()
    expect(registry.take(epochOf(1))).toBeDefined()
    native.pushLaunch(uriOf(1), 0)
    registry.ingest()
    expect(registry.take(epochOf(1))).toBeUndefined()
    expect(registry.hasLive()).toBe(false)
    // After 10 minutes the tombstone is gone, but only the Kotlin-aged record could come back, and it has expired.
    native.advance(600_001)
    native.pushLaunch(uriOf(1), 130_000)
    registry.ingest()
    expect(registry.take(epochOf(1))).toBeUndefined()
  })

  it('expiry uses the Kotlin age: a launch aged 119 s has 1 s left', () => {
    const { native, registry } = setup()
    native.pushLaunch(uriOf(1), 119_000)
    registry.ingest()
    expect(registry.hasLive()).toBe(true)
    expect(registry.lastExpiresAt()).toBe(native.elapsedRealtime() + 1_000)
    native.advance(999)
    expect(registry.hasLive()).toBe(true)
    native.advance(2)
    expect(registry.hasLive()).toBe(false)
    expect(registry.take(epochOf(1))).toBeUndefined()
  })

  it('hello matches the right one of 32 and consumes nothing', () => {
    const { native, registry } = setup()
    for (let i = 0; i < 32; i++) native.pushLaunch(uriOf(i), 0)
    registry.ingest()
    const q = { origin: 'https://example.com', challenge: CHALLENGE, host: '127.0.0.1:3321' }
    for (let rep = 0; rep < 2; rep++) {
      const m = registry.matchHello({ ...q, hello: helloFor(17) })
      expect(m?.epoch).toBe(epochOf(17))
      expect(Array.from(m!.k)).toEqual(Array.from(kOf(17)))
    }
    expect(registry.matchHello({ ...q, hello: helloFor(17, 'https://other.example') })).toBeUndefined()
    expect(registry.matchHello({ ...q, hello: helloFor(17, 'https://example.com', '127.0.0.1:3322') })).toBeUndefined()
    expect(registry.take(epochOf(17))).toBeDefined()
    expect(registry.matchHello({ ...q, hello: helloFor(17) })).toBeUndefined()
  })

  it('eviction displaces the oldest unused, never a parked one; full of parked drops the new URI', () => {
    const { native, registry } = setup()
    for (let i = 0; i < 32; i++) native.pushLaunch(uriOf(i), 0)
    registry.ingest()
    // Burn and park the oldest.
    expect(registry.take(epochOf(0))).toBeDefined()
    registry.markParked(epochOf(0), true)
    native.pushLaunch(uriOf(100), 0)
    registry.ingest()
    // Record 1 (oldest unused, unparked) was displaced; 0 (parked) kept; 100 present.
    expect(registry.take(epochOf(1))).toBeUndefined()
    expect(registry.take(epochOf(2))).toBeDefined()
    expect(registry.take(epochOf(100))).toBeDefined()
    // Fill the store with parked records only.
    const full = setup()
    for (let i = 0; i < 32; i++) full.native.pushLaunch(uriOf(i), 0)
    full.registry.ingest()
    for (let i = 0; i < 32; i++) {
      full.registry.take(epochOf(i))
      full.registry.markParked(epochOf(i), true)
    }
    full.native.pushLaunch(uriOf(200), 0)
    full.registry.ingest()
    expect(full.registry.take(epochOf(200))).toBeUndefined()
    expect(full.registry.hasLive()).toBe(false)
  })

  it('take marks used before anything else can fail', () => {
    const { native, registry } = setup()
    native.pushLaunch(uriOf(1), 0)
    registry.ingest()
    const first = registry.take(epochOf(1))
    expect(first?.epoch).toBe(epochOf(1))
    expect(registry.hasLive()).toBe(false)
    expect(registry.take(epochOf(1))).toBeUndefined()
    expect(registry.take(epochOf(999))).toBeUndefined()
    // The copy handed out is independent of the wiped stored secret.
    expect(Array.from(first!.k)).toEqual(Array.from(kOf(1)))
  })

  it('invalid URIs are dropped silently', () => {
    const { native, registry } = setup()
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    for (const bad of [
      'garbage',
      `${SCHEME}://launch?v=2&e=${epochOf(1)}&k=${b64uEncode(kOf(1))}&n=AAAAAAAAAAAAAAAAAAAAAA`,
      `${SCHEME}://other?v=1`,
      uriOf(1) + '&x=1',
      'x'.repeat(600)
    ])
      native.pushLaunch(bad, 0)
    expect(() => registry.ingest()).not.toThrow()
    expect(registry.hasLive()).toBe(false)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    jest.restoreAllMocks()
  })

  it('k and e never appear in logs', () => {
    const { native, registry } = setup()
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
      jest.spyOn(console, m).mockImplementation(() => {})
    )
    native.pushLaunch(uriOf(3), 0)
    native.pushLaunch(uriOf(3), 0)
    native.pushLaunch('junk', 0)
    registry.ingest()
    registry.matchHello({ hello: 'x', origin: 'https://a.example', challenge: CHALLENGE, host: 'h' })
    registry.take(epochOf(3))
    registry.markParked(epochOf(3), true)
    registry.markParked(epochOf(3), false)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    jest.restoreAllMocks()
  })
})
