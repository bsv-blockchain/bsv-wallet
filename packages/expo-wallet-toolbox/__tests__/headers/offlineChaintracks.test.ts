import { OfflineFirstChaintracks } from '../../core/headers/OfflineFirstChaintracks'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import { parseHeader } from '../../core/headers/headerConsensus'
import { anchor as REGTEST_ANCHOR, branch, combine } from './fixtures/regtest'

const ANCHOR = { height: 0, hash: '00'.repeat(32) }

// Two real, consecutive ttn headers (same fixture as headerStore.test.ts's
// TTN_1_AND_2, deserialized) — genuinely proof-of-work-valid, so a mock built
// from them passes the XR-068 PoW check the same way a real chaintracks
// response would.
const VALID_HEADER_1 = {
  version: 536870912,
  previousHash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d',
  merkleRoot: '2e650ee9705b54c8d94ea92fd03469afb77dbab072529b7f3496f8f9d1a724f8',
  time: 1755630093,
  bits: 486604799,
  nonce: 4197783250
}
// Real header 2 — a second, independently-valid header with a different
// merkleRoot, used wherever a test needs a distinct "healed" root.
const VALID_HEADER_2 = {
  version: 536870912,
  previousHash: '00000000b0d8e3f1cc18460d4ea585b013134e305c56dab9987e503c7809d14b',
  merkleRoot: '6817de212e62baeeafc40dc91bddc468188ece17628dea8a96eb83c2c11c8ffc',
  time: 1755630103,
  bits: 486604799,
  nonce: 3008811781
}
const ROOT = VALID_HEADER_1.merkleRoot
const HEALED_ROOT = VALID_HEADER_2.merkleRoot

async function storeWithExtraRoot(height: number, root: string) {
  const s = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
  await s.putExtraRoot(height, root)
  return s
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    findHeaderForHeight: jest.fn().mockResolvedValue({ ...VALID_HEADER_1, height: 5 }),
    currentHeight: jest.fn().mockResolvedValue(999),
    isValidRootForHeight: jest.fn().mockResolvedValue(true),
    getChain: jest.fn().mockResolvedValue('ttn'),
    getHeaders: jest.fn().mockResolvedValue(''),
    getPresentHeight: jest.fn().mockResolvedValue(999),
    ...overrides
  } as never
}

describe('OfflineFirstChaintracks', () => {
  it('answers from a consensus-validated store without touching the network', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true, 'regtest')
    const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', REGTEST_ANCHOR)
    const headers = branch(6, 'c')
    await store.append(combine(headers), 1)
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(parseHeader(headers[4]).merkleRoot, 5)).toBe(true)
    expect((r as any).findHeaderForHeight).not.toHaveBeenCalled()
    expect((r as any).getHeaders).not.toHaveBeenCalled()
  })

  it('consults the network when the local root disagrees, still rejecting a genuinely wrong root', async () => {
    // A network-only root is a hint until its chain proof validates.
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    // A local DISAGREEMENT is not trusted blindly (it may be a poisoned/stale
    // cache), so we ask the network — which also rejects 'cd…'.
    expect(await ct.isValidRootForHeight('cd'.repeat(32), 5)).toBe(false)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('does not heal a poisoned hint from a standalone provider header', async () => {
    // Regression for the chain-tracker bug: the store cached a WRONG root for a
    // height (e.g. from a bad String(bytes) conversion), which made valid proofs
    // for that height fail forever. Now the disagreement is re-checked online.
    const r = remote() // network returns the correct ROOT for height 5
    const ct = new OfflineFirstChaintracks(r, async () => true)
    const store = await storeWithExtraRoot(5, 'ff'.repeat(32)) // poisoned entry
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
    expect(store.rootForHeight(5)).toBeUndefined()
  })

  it('offline: a local disagreement stays rejected (cannot consult the network)', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => false)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.isValidRootForHeight('cd'.repeat(32), 5)).toBe(false)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('does not cache a standalone provider header on an online miss', async () => {
    const r = remote()
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
    expect(store.rootForHeight(5)).toBeUndefined()
  })

  it('refuses on a miss while offline and records the missed height', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => false)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
    expect(ct.lastMissHeight).toBe(5)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('takeLastMissHeight returns a recorded miss and then clears it', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
    expect(ct.takeLastMissHeight()).toBe(5)
    expect(ct.takeLastMissHeight()).toBeUndefined()
    expect(ct.lastMissHeight).toBeUndefined()
  })

  it('peekLastMissHeight returns the miss without clearing it', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
    // after a recorded miss:
    expect(ct.peekLastMissHeight()).toBe(5)
    expect(ct.peekLastMissHeight()).toBe(5)
    expect(ct.lastMissHeight).toBe(5)
  })

  it('refuses on a miss with no store at all', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
  })

  it('returns false rather than throwing when the network lookup fails', async () => {
    const r = remote({ findHeaderForHeight: jest.fn().mockRejectedValue(new Error('down')) })
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(false)
  })

  it('reports the store tip as the current height while offline', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => false)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.currentHeight()).toBe(0)
  })

  it('reports the remote height while online', async () => {
    const ct = new OfflineFirstChaintracks(remote(), async () => true)
    expect(await ct.currentHeight()).toBe(999)
  })

  it('delegates getChain to the remote client when no chain was given', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    expect(await ct.getChain()).toBe('ttn')
    expect((r as never as { getChain: jest.Mock }).getChain).toHaveBeenCalled()
  })

  // The toolbox Monitor awaits getChain and both subscriptions inside every
  // runOnce (via `ready`), so none of them may depend on the network or throw.
  it('answers getChain from the configured chain without touching the network', async () => {
    const r = remote({ getChain: jest.fn().mockRejectedValue(new Error('offline')) })
    const ct = new OfflineFirstChaintracks(r, async () => false, 'ttn')
    expect(await ct.getChain()).toBe('ttn')
    expect((r as never as { getChain: jest.Mock }).getChain).not.toHaveBeenCalled()
  })

  it('resolves an inert subscription when the remote cannot subscribe', async () => {
    const unsubscribe = jest.fn().mockResolvedValue(true)
    const r = remote({
      subscribeHeaders: jest.fn().mockRejectedValue(new Error('Method not implemented.')),
      subscribeReorgs: jest.fn().mockRejectedValue(new Error('Method not implemented.')),
      unsubscribe
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ct = new OfflineFirstChaintracks(r, async () => true, 'ttn')
      const headers = await ct.subscribeHeaders(() => {})
      const reorgs = await ct.subscribeReorgs(() => {})
      expect(typeof headers).toBe('string')
      expect(typeof reorgs).toBe('string')
      await expect(ct.unsubscribe(headers)).resolves.toBe(true)
      expect(unsubscribe).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // `false` means the remote's subscribe methods are stubs callers must not
  // touch (the HTTP ChaintracksServiceClient); the wrapper must say the same.
  it.each([false, true, undefined])('forwards the remote supportsReorgEvents (%s)', flag => {
    const ct = new OfflineFirstChaintracks(remote({ supportsReorgEvents: flag }), async () => true, 'ttn')
    expect(ct.supportsReorgEvents).toBe(flag)
  })

  // misc-p2-02 hardening: a mismatch at a height the window has already
  // PoW-validated (the body, i.e. not the last 6 heights) must be refused
  // outright — no remote lookup, no putExtraRoot — because that lookup-and-
  // cache is exactly how an unauthenticated network answer (or a MITM, given
  // the confirmed absence of TLS pinning) could overwrite a root this device
  // already validated itself.
  describe('window-covered mismatches (misc-p2-02)', () => {
    const HEADERS = branch(20, 'a')
    const rootFor = (height: number) => parseHeader(HEADERS[height - 1]).merkleRoot
    async function seedWindow(count: number) {
      const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', REGTEST_ANCHOR)
      await store.append(combine(HEADERS.slice(0, count)), 1)
      return store
    }

    it('refuses a body-height mismatch outright, even when a lying remote agrees with the forged root (MITM case)', async () => {
      const store = await seedWindow(20) // baseHeight=1, tipHeight=20, body=[1,14]
      const findHeaderForHeight = jest.fn().mockResolvedValue({ merkleRoot: 'cd'.repeat(32) })
      const r = remote({ findHeaderForHeight })
      const ct = new OfflineFirstChaintracks(r, async () => true)
      ct.setStore(store)
      expect(await ct.isValidRootForHeight('cd'.repeat(32), 10)).toBe(false)
      expect(findHeaderForHeight).not.toHaveBeenCalled()
      // The window's own PoW-linked root for height 10 is untouched.
      expect(store.rootForHeight(10)).toBe(rootFor(10))
    })

    it('requires an anchored proof outside the window even if an isolated header has valid PoW', async () => {
      const store = await seedWindow(10) // tipHeight=10
      const findHeaderForHeight = jest.fn().mockResolvedValue({ ...VALID_HEADER_2, height: 50 })
      const r = remote({ findHeaderForHeight })
      const ct = new OfflineFirstChaintracks(r, async () => true)
      ct.setStore(store)
      expect(await ct.isValidRootForHeight(HEALED_ROOT, 50)).toBe(false)
      expect(findHeaderForHeight).not.toHaveBeenCalled()
      expect(store.rootForHeight(50)).toBeUndefined()
    })

    // XR-068: the miss/tail fallback used to trust a bare, unauthenticated
    // `{ merkleRoot }` from a single findHeaderForHeight response with zero
    // proof-of-work check — exactly the shape a compromised/MITM'd
    // chaintracks operator would return to make a forged BEEF root verify.
    it('XR-068: refuses a forged miss/tail header that carries no valid proof-of-work, and does not cache it', async () => {
      const store = await seedWindow(10) // tipHeight=10, height 50 is a genuine miss
      const forgedRoot = 'ee'.repeat(32)
      // A bare header claim, same shape the original bug accepted outright.
      const findHeaderForHeight = jest.fn().mockResolvedValue({ merkleRoot: forgedRoot })
      const r = remote({ findHeaderForHeight })
      const ct = new OfflineFirstChaintracks(r, async () => true)
      ct.setStore(store)
      expect(await ct.isValidRootForHeight(forgedRoot, 50)).toBe(false)
      expect(findHeaderForHeight).not.toHaveBeenCalled()
      expect(store.rootForHeight(50)).toBeUndefined()
      expect(ct.lastMissHeight).toBe(50)
    })

    // Same shape of forgery, but for a disagreement inside the last-6 reorg
    // tail rather than a complete miss — the other fallback path that still
    // reaches the network.
    it('XR-068: also refuses a forged header for a reorg-tail disagreement', async () => {
      const store = await seedWindow(10) // tipHeight=10, tail=[5,10]
      const forgedRoot = 'ee'.repeat(32)
      const findHeaderForHeight = jest.fn().mockResolvedValue({ merkleRoot: forgedRoot })
      const r = remote({ findHeaderForHeight })
      const ct = new OfflineFirstChaintracks(r, async () => true)
      ct.setStore(store)
      expect(await ct.isValidRootForHeight(forgedRoot, 8)).toBe(false)
      expect(store.rootForHeight(8)).toBe(rootFor(8)) // unchanged, not overwritten with the forgery
    })

    it('does not replace a reorg-tail root from an isolated header with valid PoW', async () => {
      const store = await seedWindow(10) // tipHeight=10, tail=[5,10]
      const findHeaderForHeight = jest.fn().mockResolvedValue({ ...VALID_HEADER_2, height: 8 })
      const r = remote({ findHeaderForHeight })
      const ct = new OfflineFirstChaintracks(r, async () => true)
      ct.setStore(store)
      // Valid own-target PoW alone cannot replace the authenticated tail.
      expect(await ct.isValidRootForHeight(HEALED_ROOT, 8)).toBe(false)
      expect(findHeaderForHeight).not.toHaveBeenCalled()
    })
  })

  it('passes through a subscription the remote does support', async () => {
    const unsubscribe = jest.fn().mockResolvedValue(true)
    const r = remote({ subscribeReorgs: jest.fn().mockResolvedValue('remote-sub'), unsubscribe })
    const ct = new OfflineFirstChaintracks(r, async () => true, 'ttn')
    expect(await ct.subscribeReorgs(() => {})).toBe('remote-sub')
    await ct.unsubscribe('remote-sub')
    expect(unsubscribe).toHaveBeenCalledWith('remote-sub')
  })
})
