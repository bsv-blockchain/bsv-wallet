import fs from 'fs'
import path from 'path'
import {
  HeaderConsensus,
  bitsToTarget,
  targetToBits,
  headerWork,
  parseHeader,
  nextWorkRequired,
  type WorkHeader
} from '../../core/headers/headerConsensus'

// Public mainnet headers from Teranode's canonical difficulty regression fixture:
// services/blockchain/886001_888000_headers.bin. Anchor886147 is pinned below.
const fixture = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/main-886001-886160.bin')))
const anchor = { height: 886147, hash: '0000000000000000069794608511a422848e3d42efba5edd7bee4028ca8656f7' }

it('validates exact mainnet DAA targets and locally accumulates work from an authenticated context', () => {
  const chain = HeaderConsensus.fromContext('main', anchor, fixture.slice(0, 147 * 80))
  const before = chain.chainWork
  for (let i = 147; i < 160; i++) chain.append(fixture.slice(i * 80, (i + 1) * 80), 886001 + i)
  expect(chain.tipHeight).toBe(886160)
  expect(chain.chainWork).toBeGreaterThan(before)
})

it('rejects insufficient or substituted bootstrap history', () => {
  expect(() => HeaderConsensus.fromContext('main', anchor, fixture.slice(80, 147 * 80))).toThrow(/context/)
  const altered = fixture.slice(0, 147 * 80)
  altered[4] ^= 1
  expect(() => HeaderConsensus.fromContext('main', anchor, altered)).toThrow(/context|link|proof/)
})

it('rejects a self-selected easier bits value even though it is within the network PoW limit', () => {
  const chain = HeaderConsensus.fromContext('main', anchor, fixture.slice(0, 147 * 80))
  const next = fixture.slice(147 * 80, 148 * 80)
  new DataView(next.buffer).setUint32(72, 0x1d00ffff, true)
  expect(() => chain.append(next, 886148)).toThrow(/difficulty/)
  expect(chain.tipHeight).toBe(886147)
})

it('rejects negative, zero and overflowing compact targets', () => {
  for (const bits of [0, 0x1d80ffff, 0x23000001, 0x22000100, 0x21010000]) {
    expect(() => bitsToTarget(bits)).toThrow(/target/)
  }
  expect(targetToBits(bitsToTarget(0x1d00ffff))).toBe(0x1d00ffff)
})

it('matches the BSV Node pow_tests.cpp CW-144 slow/fast block vectors exactly', () => {
  const history: WorkHeader[] = []
  let time = 1269211443
  const initial = targetToBits(((1n << 224n) - 1n) >> 4n)
  let work = 0n
  function add(delta: number, bits: number) {
    time += delta
    work += headerWork(bits)
    history.push({ height: 504031 + history.length, time, bits, work })
  }
  for (let i = 0; i < 2050; i++) add(i ? 600 : 0, initial)
  const required = () => nextWorkRequired('main', history, time + 600)
  let bits = required()
  for (let i = 0; i < 10; i++) {
    add(600, bits)
    expect(required()).toBe(bits)
  }
  add(6000, bits)
  expect(required()).toBe(bits)
  add(1200 - 6000, bits)
  expect(required()).toBe(bits)
  for (let i = 0; i < 20; i++) {
    add(600, bits)
    expect(required()).toBe(bits)
  }
  add(550, bits)
  expect(required()).toBe(bits)
  for (let i = 0; i < 10; i++) {
    add(550, bits)
    bits = required()
  }
  expect(bits).toBe(0x1c0fe7b1)
  for (let i = 0; i < 20; i++) {
    add(10, bits)
    bits = required()
  }
  expect(bits).toBe(0x1c0db19f)
  add(6000, bits)
  bits = required()
  expect(bits).toBe(0x1c0d9222)
})

it('uses the strict testnet/TTN twenty-minute threshold and keeps regtest difficulty fixed', () => {
  const history: WorkHeader[] = []
  let work = 0n
  for (let i = 0; i < 150; i++) {
    work += headerWork(0x1c0fffff)
    history.push({ height: 1697253 + i, time: 100000 + i * 600, bits: 0x1c0fffff, work })
  }
  const time = history[149].time
  expect(nextWorkRequired('test', history, time + 1201)).toBe(0x1d00ffff)
  expect(nextWorkRequired('test', history, time + 1200)).not.toBe(0x1d00ffff)
  expect(nextWorkRequired('regtest', [{ height: 0, time, bits: 0x207fffff, work: 2n }], time + 1)).toBe(0x207fffff)
  expect(nextWorkRequired('ttn', [{ height: 147, time, bits: 0x1c0fffff, work: 2n }], time + 1)).toBe(0x1d00ffff)
})

it('enforces median time, future time and activated header versions before accepting roots', () => {
  const chain = HeaderConsensus.fromContext('main', anchor, fixture.slice(0, 147 * 80), () => 2000000000)
  const next = fixture.slice(147 * 80, 148 * 80)
  const tooOld = next.slice()
  new DataView(tooOld.buffer).setUint32(68, 1, true)
  expect(() => chain.append(tooOld, 886148)).toThrow(/median time/)
  const future = next.slice()
  new DataView(future.buffer).setUint32(68, 2000007201, true)
  expect(() => chain.append(future, 886148)).toThrow(/future/)
  const obsolete = next.slice()
  new DataView(obsolete.buffer).setUint32(0, 1, true)
  expect(() => chain.append(obsolete, 886148)).toThrow(/version/)
  expect(chain.tipHeight).toBe(anchor.height)
})

it('rejects unsupported networks and pre-DAA anchors before reading context', () => {
  expect(() => HeaderConsensus.fromContext('unknown' as never, anchor, new Uint8Array())).toThrow(/Unsupported/)
  for (const chain of ['main', 'test'] as const) {
    expect(() => HeaderConsensus.fromContext(chain, { ...anchor, height: 1 }, new Uint8Array())).toThrow(/post-DAA/)
  }
})

it('checks compact scalar boundaries and small-target sign carry without rounding', () => {
  for (const bits of [-1, 1.5, NaN, 0x100000000, 0x01000001]) {
    expect(() => bitsToTarget(bits)).toThrow(/target/)
  }
  expect(bitsToTarget(0x03012345)).toBe(0x12345n)
  expect(bitsToTarget(0x02008000)).toBe(0x80n)
  expect(targetToBits(0x80n)).toBe(0x02008000)
  expect(targetToBits(1n)).toBe(0x01010000)
  for (const target of [0n, -1n, 1n << 256n]) expect(() => targetToBits(target)).toThrow(/target/)
})

it('refuses missing, short, historical and non-increasing accumulated-work contexts', () => {
  expect(() => nextWorkRequired('main', [], 0)).toThrow(/context/)
  expect(() => nextWorkRequired('main', [{ height: 1, time: 1, bits: 0x1d00ffff, work: 1n }], 2)).toThrow(/Historical/)
  expect(() => nextWorkRequired('main', [{ height: 504031, time: 1, bits: 0x1d00ffff, work: 1n }], 2)).toThrow(
    /context/
  )
  const noWork = Array.from({ length: 147 }, (_, i) => ({
    height: 504031 + i,
    time: i * 600,
    bits: 0x1d00ffff,
    work: 1n
  }))
  expect(() => nextWorkRequired('main', noWork, 147 * 600)).toThrow(/work context/)
})

it('caps a very low-work DAA context at the network target limit', () => {
  const history = Array.from({ length: 147 }, (_, i) => ({
    height: 504031 + i,
    time: i * 600,
    bits: 0x1d00ffff,
    work: BigInt(i + 1)
  }))
  expect(nextWorkRequired('main', history, 147 * 600)).toBe(0x1d00ffff)
})

it('requires valid ancestor linkage and the exact terminal checkpoint commitment', () => {
  const context = fixture.slice(0, 147 * 80)
  const reordered = context.slice()
  reordered.set(context.slice(80, 160), 0)
  reordered.set(context.slice(0, 80), 80)
  expect(() => HeaderConsensus.fromContext('main', anchor, reordered)).toThrow(/linkage/)
  expect(() => HeaderConsensus.fromContext('main', { ...anchor, hash: '00'.repeat(32) }, context)).toThrow(/commit/)
})

it('bounds forks to authenticated integral heights and preserves independent descendants', () => {
  const chain = HeaderConsensus.fromContext('main', anchor, fixture.slice(0, 147 * 80))
  for (const height of [anchor.height - 1, anchor.height + 1, anchor.height + 0.5]) {
    expect(() => chain.forkAt(height)).toThrow(/outside authenticated history/)
  }
  const fork = chain.forkAt(anchor.height)
  fork.append(fixture.slice(147 * 80, 148 * 80), anchor.height + 1)
  expect(chain.tipHeight).toBe(anchor.height)
  expect(fork.tipHeight).toBe(anchor.height + 1)
  expect(fork.hashForHeight(anchor.height - 147)).toBeUndefined()
})

it('rejects non-sequential append heights before changing history', () => {
  const chain = HeaderConsensus.fromContext('main', anchor, fixture.slice(0, 147 * 80))
  expect(() => chain.append(fixture.slice(147 * 80, 148 * 80), anchor.height + 2)).toThrow(/Unexpected header height/)
  expect(chain.tipHeight).toBe(anchor.height)
})

it.each([0, 79, 81])('rejects a serialized header of %i bytes', length => {
  expect(() => parseHeader(new Uint8Array(length))).toThrow(/exactly 80 bytes/)
})
