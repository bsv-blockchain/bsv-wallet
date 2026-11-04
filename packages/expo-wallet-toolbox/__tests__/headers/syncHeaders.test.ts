import { Utils } from '@bsv/sdk'
import { syncHeaders } from '../../core/headers/syncHeaders'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import fs from 'fs'
import path from 'path'

// Same two verified ttn headers as __tests__/headerStore.test.ts, one per line.
const ANCHOR = { height: 0, hash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d' }
// prettier-ignore
const H1 = '000000206d77b7767981eac2b2044a1a1c19b9741c2347375b8fa8a0bbea990400000000f824a7d1f9f896347f9b5272b0ba7db7af6934d02fa94ed9c8545b70e90e652e0dcaa468ffff001dd21635fa'
// prettier-ignore
const H2 = '000000204bd109783c507e98b9da565c304e1313b085a54e0d4618ccf1e3d8b000000000fc8f1cc1c283eb968aea8d6217ce8e1868c4dd1bc90dc4afeeba622e21de176817caa468ffff001d05d356b3'

const store = () => HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)

describe('syncHeaders', () => {
  it.each([0, -1, 1.5, 100001, NaN])('rejects invalid chunk size %s before consulting the source', async chunkSize => {
    const getPresentHeight = jest.fn(async () => 0)
    await expect(
      syncHeaders({ store: await store(), client: { getPresentHeight, getHeaders: async () => '' }, chunkSize })
    ).rejects.toThrow(/Invalid header chunk size/)
    expect(getPresentHeight).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, NaN, 0x80000000])('rejects invalid present height %s without reading headers', async height => {
    const getHeaders = jest.fn(async () => '')
    await expect(
      syncHeaders({ store: await store(), client: { getPresentHeight: async () => height, getHeaders } })
    ).rejects.toThrow(/invalid present height/)
    expect(getHeaders).not.toHaveBeenCalled()
  })

  it('initializes an authenticated mainnet bootstrap before using the store', async () => {
    const anchor = { height: 886147, hash: '0000000000000000069794608511a422848e3d42efba5edd7bee4028ca8656f7' }
    const context = fs.readFileSync(path.join(__dirname, 'fixtures/main-886001-886160.bin')).subarray(0, 147 * 80)
    const s = await HeaderStore.open(memoryHeaderFs(), 'main', anchor)
    const getHeaders = jest.fn(async () => context.toString('hex'))
    expect(s.needsContext).toBe(true)
    await expect(
      syncHeaders({ store: s, client: { getPresentHeight: async () => anchor.height, getHeaders } })
    ).resolves.toMatchObject({ added: 0, tipHeight: anchor.height })
    expect(getHeaders).toHaveBeenCalledWith(886001, 147)
    expect(s.needsContext).toBe(false)
  })

  it.each(['', 'z'.repeat(147 * 160)])('rejects absent or nonhex bootstrap data', async context => {
    const anchor = { height: 886147, hash: '0000000000000000069794608511a422848e3d42efba5edd7bee4028ca8656f7' }
    const s = await HeaderStore.open(memoryHeaderFs(), 'main', anchor)
    await expect(
      syncHeaders({
        store: s,
        client: { getPresentHeight: async () => anchor.height, getHeaders: async () => context }
      })
    ).rejects.toThrow(/bootstrap context unavailable or malformed/)
    expect(s.needsContext).toBe(true)
  })

  it('requires the current tip bytes when the advertised chain height is unchanged', async () => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    await expect(
      syncHeaders({ store: s, client: { getPresentHeight: async () => 1, getHeaders: async () => '' } })
    ).rejects.toThrow(/Chain tip header unavailable/)
    await expect(
      syncHeaders({ store: s, client: { getPresentHeight: async () => 1, getHeaders: async () => H1 } })
    ).resolves.toMatchObject({ added: 0, tipHeight: 1 })
  })
  it('pulls chunks until it reaches the present height', async () => {
    const calls: [number, number][] = []
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number, count: number) => {
        calls.push([height, count])
        return height === 1 ? H1 : H2
      }
    }
    const s = await store()
    const r = await syncHeaders({ store: s, client, chunkSize: 1 })
    expect(r.added).toBe(2)
    expect(r.tipHeight).toBe(2)
    expect(calls).toEqual([
      [1, 1],
      [2, 1]
    ])
  })

  it('does nothing when already at the tip', async () => {
    const client = { getPresentHeight: async () => 0, getHeaders: async () => '' }
    const s = await store()
    const r = await syncHeaders({ store: s, client })
    expect(r.added).toBe(0)
  })

  it('rejects an inconsistent same-height source without replacing the validated tip', async () => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    let reads = 0
    const client = {
      getPresentHeight: async () => 1,
      getHeaders: async () => (++reads === 1 ? H2 : H1)
    }
    await expect(syncHeaders({ store: s, client })).rejects.toThrow(
      'Replacement header branch does not have greater accumulated work'
    )
    expect(s.tipHeight).toBe(1)
    expect(s.hashForHeight(1)).toBeDefined()
    expect(reads).toBe(2)
  })

  it('stops without error when the service returns no headers', async () => {
    const client = { getPresentHeight: async () => 500, getHeaders: async () => '' }
    const s = await store()
    const r = await syncHeaders({ store: s, client })
    expect(r.added).toBe(0)
    expect(r.tipHeight).toBe(0)
  })

  it('honours shouldStop between chunks', async () => {
    let served = 0
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => {
        served++
        return height === 1 ? H1 : H2
      }
    }
    const s = await store()
    const r = await syncHeaders({ store: s, client, chunkSize: 1, shouldStop: () => served >= 1 })
    expect(r.added).toBe(1)
    expect(served).toBe(1)
  })

  it('reports progress per chunk', async () => {
    const progress: number[] = []
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => (height === 1 ? H1 : H2)
    }
    const s = await store()
    await syncHeaders({ store: s, client, chunkSize: 1, onProgress: tip => progress.push(tip) })
    expect(progress).toEqual([1, 2])
  })

  it('propagates a validation failure rather than silently truncating', async () => {
    const client = { getPresentHeight: async () => 2, getHeaders: async (height: number) => (height === 2 ? H1 : H2) }
    const s = await store()
    await expect(syncHeaders({ store: s, client, chunkSize: 1 })).rejects.toThrow(/previous hash/i)
  })

  it('XR-060: never persists more headers from one chunk than were requested', async () => {
    // Each header here is individually genuine (real PoW, correctly chained),
    // so a compromised/misbehaving chaintracks handing back MORE of them than
    // `want` cannot be caught by per-header validation alone — only a cap
    // tied to what was actually requested can bound how much a single
    // response is allowed to persist.
    const client = {
      getPresentHeight: async () => 2,
      // Asked for exactly 1 header at height 1, but answers with 2.
      getHeaders: async (height: number) => (height === 1 ? H1 + H2 : '')
    }
    const s = await store()
    const r = await syncHeaders({ store: s, client, chunkSize: 1 })
    expect(r.added).toBe(1)
    expect(r.tipHeight).toBe(1)
    expect(s.tipHeight).toBe(1)
  })

  it('rewinds an orphaned tip and retries from the new height', async () => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    let first = true
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => {
        if (height === 2 && first) {
          first = false
          return H1
        }
        return height === 1 ? H1 : H2
      }
    }
    const r = await syncHeaders({ store: s, client, chunkSize: 1 })
    expect(r.tipHeight).toBe(2)
    expect(s.count).toBe(2)
  })

  it.each(['', 'z'.repeat(160)])('rejects malformed ancestor responses during reconciliation', async ancestor => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => (height === 2 ? H1 : ancestor)
    }
    await expect(syncHeaders({ store: s, client })).rejects.toThrow(/Reorg ancestor header unavailable/)
    expect(s.tipHeight).toBe(1)
  })

  it('rejects a reconciliation with no authenticated common ancestor', async () => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    const client = { getPresentHeight: async () => 2, getHeaders: async (height: number) => (height === 2 ? H1 : H2) }
    await expect(syncHeaders({ store: s, client })).rejects.toThrow(/No authenticated reorg ancestor/)
    expect(s.tipHeight).toBe(1)
  })

  it.each(['', 'zz', '00'])('rejects missing or malformed replacement bytes (%s)', async replacement => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    let first = true
    const client = {
      getPresentHeight: async () => 2,
      getHeaders: async (height: number) => {
        if (height === 1) return H1
        if (first) {
          first = false
          return H1
        }
        return replacement
      }
    }
    await expect(syncHeaders({ store: s, client })).rejects.toThrow(
      /Replacement header branch unavailable|Malformed replacement/
    )
    expect(s.tipHeight).toBe(1)
  })

  it('propagates a replacement validation error without discarding the current window', async () => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    const client = { getPresentHeight: async () => 2, getHeaders: async () => H1 }
    await expect(syncHeaders({ store: s, client })).rejects.toThrow(/previous hash/)
    expect(s.tipHeight).toBe(1)
  })

  it.each([2, 3])('stops reconciliation before its phase %i touches state', async stopCall => {
    const s = await store()
    await s.append(new Uint8Array(Utils.toArray(H1, 'hex')), 1)
    let calls = 0
    const client = { getPresentHeight: async () => 2, getHeaders: async () => H1 }
    const result = await syncHeaders({ store: s, client, shouldStop: () => ++calls >= stopCall })
    expect(result.tipHeight).toBe(1)
    expect(s.tipHeight).toBe(1)
  })
})
