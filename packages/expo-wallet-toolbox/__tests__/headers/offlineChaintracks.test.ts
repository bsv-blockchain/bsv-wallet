import { OfflineFirstChaintracks } from '../../core/headers/OfflineFirstChaintracks'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import { Utils } from '@bsv/sdk'

const ANCHOR = { height: 0, hash: '00'.repeat(32) }
const ROOT = 'ab'.repeat(32)

async function storeWithExtraRoot(height: number, root: string) {
  const s = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
  await s.putExtraRoot(height, root)
  return s
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    findHeaderForHeight: jest.fn().mockResolvedValue({ merkleRoot: ROOT, height: 5 }),
    currentHeight: jest.fn().mockResolvedValue(999),
    isValidRootForHeight: jest.fn().mockResolvedValue(true),
    getChain: jest.fn().mockResolvedValue('ttn'),
    getHeaders: jest.fn().mockResolvedValue(''),
    getPresentHeight: jest.fn().mockResolvedValue(999),
    ...overrides
  } as never
}

describe('OfflineFirstChaintracks', () => {
  it('answers from the store without touching the network', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('consults the network when the local root disagrees, still rejecting a genuinely wrong root', async () => {
    // Network is authoritative and returns ROOT for height 5.
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    // A local DISAGREEMENT is not trusted blindly (it may be a poisoned/stale
    // cache), so we ask the network — which also rejects 'cd…'.
    expect(await ct.isValidRootForHeight('cd'.repeat(32), 5)).toBe(false)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).toHaveBeenCalled()
  })

  it('heals a poisoned local root: confirms a valid root via the network and refreshes the cache', async () => {
    // Regression for the chain-tracker bug: the store cached a WRONG root for a
    // height (e.g. from a bad String(bytes) conversion), which made valid proofs
    // for that height fail forever. Now the disagreement is re-checked online.
    const r = remote() // network returns the correct ROOT for height 5
    const ct = new OfflineFirstChaintracks(r, async () => true)
    const store = await storeWithExtraRoot(5, 'ff'.repeat(32)) // poisoned entry
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect(store.rootForHeight(5)).toBe(ROOT) // cache healed to the authoritative value
  })

  it('offline: a local disagreement stays rejected (cannot consult the network)', async () => {
    const r = remote()
    const ct = new OfflineFirstChaintracks(r, async () => false)
    ct.setStore(await storeWithExtraRoot(5, ROOT))
    expect(await ct.isValidRootForHeight('cd'.repeat(32), 5)).toBe(false)
    expect((r as never as { findHeaderForHeight: jest.Mock }).findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('falls back to the network on a miss while online and caches the root', async () => {
    const r = remote()
    const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
    const ct = new OfflineFirstChaintracks(r, async () => true)
    ct.setStore(store)
    expect(await ct.isValidRootForHeight(ROOT, 5)).toBe(true)
    expect(store.rootForHeight(5)).toBe(ROOT)
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
    const rootFor = (height: number) => height.toString(16).padStart(2, '0').repeat(32)
    const HEADER_BYTES = 80

    /** Seeds a HeaderStore's persisted files directly (bypassing append's
     * proof-of-work check) with `count` headers starting at height 1, so a
     * window big enough to have a body outside the last-6 tail can be built
     * without mining real headers. */
    async function seedWindow(count: number) {
      const fs = memoryHeaderFs()
      const bin = new Uint8Array(count * HEADER_BYTES)
      for (let i = 0; i < count; i++) {
        const wire = new Uint8Array(Utils.toArray(rootFor(i + 1), 'hex')).slice().reverse()
        bin.set(wire, i * HEADER_BYTES + 36)
      }
      await fs.writeBytes('ttn.bin', bin)
      await fs.writeText(
        'ttn.json',
        JSON.stringify({ chain: 'ttn', anchorHeight: 0, anchorHash: ANCHOR.hash, count, tipHash: 'ff'.repeat(32) })
      )
      return HeaderStore.open(fs, 'ttn', ANCHOR)
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

    it('still consults the remote and self-heals for a height outside the window entirely', async () => {
      const store = await seedWindow(10) // tipHeight=10
      const healedRoot = 'ee'.repeat(32)
      const findHeaderForHeight = jest.fn().mockResolvedValue({ merkleRoot: healedRoot })
      const r = remote({ findHeaderForHeight })
      const ct = new OfflineFirstChaintracks(r, async () => true)
      ct.setStore(store)
      expect(await ct.isValidRootForHeight(healedRoot, 50)).toBe(true)
      expect(findHeaderForHeight).toHaveBeenCalled()
      expect(store.rootForHeight(50)).toBe(healedRoot)
    })

    it("keeps today's behaviour for the last-6 reorg tail: a mismatch there still consults the remote", async () => {
      const store = await seedWindow(10) // tipHeight=10, tail=[5,10]
      const healedRoot = 'ee'.repeat(32)
      const findHeaderForHeight = jest.fn().mockResolvedValue({ merkleRoot: healedRoot })
      const r = remote({ findHeaderForHeight })
      const ct = new OfflineFirstChaintracks(r, async () => true)
      ct.setStore(store)
      // The window's own root for height 8 disagrees with healedRoot, but 8 is
      // in the tail, so the old self-heal path still runs and agrees.
      expect(await ct.isValidRootForHeight(healedRoot, 8)).toBe(true)
      expect(findHeaderForHeight).toHaveBeenCalled()
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
