import fs from 'fs'
import path from 'path'
import {
  HeaderConsensus,
  bitsToTarget,
  targetToBits,
  headerWork,
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
