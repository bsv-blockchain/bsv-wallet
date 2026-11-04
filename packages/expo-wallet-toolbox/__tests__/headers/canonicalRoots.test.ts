import { Utils } from '@bsv/sdk'
import { OfflineFirstChaintracks } from '../../core/headers/OfflineFirstChaintracks'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import { parseHeader } from '../../core/headers/headerConsensus'
import { genesis, anchor, branch, combine } from './fixtures/regtest'

const headers = branch(8, 'c')
const all = [genesis, ...headers]
const root = (height: number) => parseHeader(all[height]).merkleRoot
function source(items = all) {
  return {
    getPresentHeight: jest.fn(async () => items.length - 1),
    getHeaders: jest.fn(async (height: number, count: number) =>
      Utils.toHex(Array.from(combine(items.slice(height, height + count))))
    ),
    findHeaderForHeight: jest.fn(async () => ({ ...parseHeader(headers[0]), height: 5 })),
    isValidRootForHeight: jest.fn(async () => true),
    currentHeight: async () => items.length - 1
  } as any
}

it('rejects an isolated easy-PoW remote header at an arbitrary requested height', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  const remote = source([])
  remote.getPresentHeight.mockResolvedValue(5)
  remote.getHeaders.mockResolvedValue('')
  remote.findHeaderForHeight.mockResolvedValue({
    version: 536870912,
    previousHash: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d',
    merkleRoot: '2e650ee9705b54c8d94ea92fd03469afb77dbab072529b7f3496f8f9d1a724f8',
    time: 1755630093,
    bits: 486604799,
    nonce: 4197783250,
    height: 5
  })
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  expect(
    await tracker.isValidRootForHeight('2e650ee9705b54c8d94ea92fd03469afb77dbab072529b7f3496f8f9d1a724f8', 5)
  ).toBe(false)
  expect(remote.findHeaderForHeight).not.toHaveBeenCalled()
  expect(store.rootForHeight(5)).toBeUndefined()
})

it('synchronizes a valid anchored chain online and retains verification offline', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  const remote = source()
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight(root(5), 5)).toBe(true)
  expect(remote.findHeaderForHeight).not.toHaveBeenCalled()
  const offline = new OfflineFirstChaintracks(source(), async () => false, 'regtest')
  offline.setStore(await HeaderStore.open(fs, 'regtest', anchor))
  expect(await offline.isValidRootForHeight(root(5), 5)).toBe(true)
})

it('never authenticates legacy raw extra roots or locally prewarmed unanchored roots', async () => {
  const fs = memoryHeaderFs()
  await fs.writeText('regtest-extra.json', JSON.stringify({ '50': 'a'.repeat(64) }))
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  expect(store.rootForHeight(50)).toBeUndefined()
  await store.putExtraRoot(51, 'b'.repeat(64))
  expect(store.rootForHeight(51)).toBeUndefined()
})

it('authenticates historical headers by a bounded backward proof ending at the pinned checkpoint', async () => {
  const fs = memoryHeaderFs()
  const historicalAnchor = { height: 8, hash: parseHeader(headers[7]).hash }
  const store = await HeaderStore.open(fs, 'regtest', historicalAnchor)
  const remote = source()
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight(root(2), 2)).toBe(true)
  const offline = new OfflineFirstChaintracks(source(), async () => false, 'regtest')
  offline.setStore(await HeaderStore.open(fs, 'regtest', historicalAnchor))
  expect(await offline.isValidRootForHeight(root(2), 2)).toBe(true)
})

it('rejects a reordered/height-relabeled historical proof and never persists its roots', async () => {
  const fs = memoryHeaderFs()
  const historicalAnchor = { height: 8, hash: parseHeader(headers[7]).hash }
  const store = await HeaderStore.open(fs, 'regtest', historicalAnchor)
  const altered = [...all]
  ;[altered[2], altered[3]] = [altered[3], altered[2]]
  const tracker = new OfflineFirstChaintracks(source(altered), async () => true, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight(root(2), 2)).toBe(false)
  expect(store.rootForHeight(2)).toBeUndefined()
})

it('accepts a reorg-tail replacement only after the complete competing branch has greater work', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  await store.append(combine(headers.slice(0, 5)), 1)
  const replacement = [genesis, ...branch(9, 'd')]
  const tracker = new OfflineFirstChaintracks(source(replacement), async () => true, 'regtest')
  tracker.setStore(store)
  const replacementRoot = parseHeader(replacement[5]).merkleRoot
  expect(await tracker.isValidRootForHeight(replacementRoot, 5)).toBe(true)
  expect(store.tipHeight).toBe(9)
  expect(store.rootForHeight(5)).toBe(replacementRoot)
})

it('rejects an equal-work tail replacement and preserves the previously authenticated root', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  await store.append(combine(headers), 1)
  const replacement = [genesis, ...branch(8, 'd')]
  const tracker = new OfflineFirstChaintracks(source(replacement), async () => true, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight(parseHeader(replacement[7]).merkleRoot, 7)).toBe(false)
  expect(store.rootForHeight(7)).toBe(root(7))
})

it('binds the attached store to the explicitly selected network', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  const tracker = new OfflineFirstChaintracks(source(), async () => true, 'test')
  expect(() => tracker.setStore(store)).toThrow(/different network/)
})

it('links historical pages across boundaries and discards corrupted persisted pages on reopen', async () => {
  const items = [genesis, ...branch(2100, 'e')]
  const historicalAnchor = { height: 2100, hash: parseHeader(items[2100]).hash }
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', historicalAnchor)
  const remote = source(items)
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  const wanted = parseHeader(items[50]).merkleRoot
  expect(await tracker.isValidRootForHeight(wanted, 50)).toBe(true)
  expect(remote.getHeaders.mock.calls).toEqual([
    [101, 2000],
    [0, 101]
  ])
  const page = (await fs.readBytes('regtest-history-0-100.bin'))!.slice()
  page[36] ^= 1
  await fs.writeBytes('regtest-history-0-100.bin', page)
  const reopened = await HeaderStore.open(fs, 'regtest', historicalAnchor)
  expect(reopened.rootForHeight(50)).toBeUndefined()
  expect(reopened.rootForHeight(200)).toBe(parseHeader(items[200]).merkleRoot)
})

it('verifies the shipped network genesis without downloading historical ancestry', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', { height: 8, hash: parseHeader(headers[7]).hash })
  const remote = source()
  const tracker = new OfflineFirstChaintracks(remote, async () => false, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight(root(0), 0)).toBe(true)
  expect(remote.getHeaders).not.toHaveBeenCalled()
})

it('reports the consensus-synchronized height consistently online and offline', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  const remote = source()
  const claimedHeight = jest.spyOn(remote, 'currentHeight').mockResolvedValue(999)
  let online = true
  const tracker = new OfflineFirstChaintracks(remote, async () => online, 'regtest')
  tracker.setStore(store)
  expect(await tracker.currentHeight()).toBe(headers.length)
  expect(store.tipHeight).toBe(headers.length)
  online = false
  expect(await tracker.currentHeight()).toBe(headers.length)
  expect(claimedHeight).not.toHaveBeenCalled()
})

it('retains the validated height when an online refresh has no headers or fails', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  await store.append(combine(headers.slice(0, 5)), 1)
  const remote = source()
  const claimedHeight = jest.spyOn(remote, 'currentHeight').mockResolvedValue(999)
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  remote.getHeaders.mockResolvedValue('')
  expect(await tracker.currentHeight()).toBe(5)
  remote.getHeaders.mockRejectedValue(new Error('refresh unavailable'))
  expect(await tracker.currentHeight()).toBe(5)
  expect(claimedHeight).not.toHaveBeenCalled()
})

it.each([false, true])('fails closed without an attached validated store (online=%s)', async online => {
  const remote = source()
  const claimedHeight = jest.spyOn(remote, 'currentHeight')
  const tracker = new OfflineFirstChaintracks(remote, async () => online, 'regtest')
  await expect(tracker.currentHeight()).rejects.toThrow(/validated header store/i)
  expect(claimedHeight).not.toHaveBeenCalled()
  expect(remote.getPresentHeight).not.toHaveBeenCalled()
})

it.each([-1, 1.5, NaN])('refuses invalid root heights before consulting the source (%s)', async height => {
  const remote = source()
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  expect(await tracker.isValidRootForHeight(root(1), height)).toBe(false)
  expect(remote.getHeaders).not.toHaveBeenCalled()
})

it('records a missing height when no validated store is attached', async () => {
  const remote = source()
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  expect(await tracker.isValidRootForHeight(root(1), 1)).toBe(false)
  expect(tracker.peekLastMissHeight()).toBe(1)
  expect(remote.getHeaders).not.toHaveBeenCalled()
})

it.each(['', 'z'.repeat(9 * 160)])('rejects incomplete or nonhex historical pages', async bytes => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', { height: 8, hash: parseHeader(headers[7]).hash })
  const remote = source()
  remote.getHeaders.mockResolvedValue(bytes)
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight(root(2), 2)).toBe(false)
  expect(store.rootForHeight(2)).toBeUndefined()
  expect(tracker.peekLastMissHeight()).toBe(2)
})

it('preserves authenticated checkpoint roots when the requested root disagrees', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  const remote = source()
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight('f'.repeat(64), 0)).toBe(false)
  expect(remote.getHeaders).not.toHaveBeenCalled()
})

it('handles non-Error transport failures without accepting an unresolved root or height', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  const remote = source()
  remote.getPresentHeight.mockRejectedValue('unavailable')
  const tracker = new OfflineFirstChaintracks(remote, async () => true, 'regtest')
  tracker.setStore(store)
  expect(await tracker.isValidRootForHeight(root(1), 1)).toBe(false)
  expect(await tracker.currentHeight()).toBe(0)
})

it('rejects historical page dimensions and checkpoint mismatches before persistence', async () => {
  const fs = memoryHeaderFs()
  const historicalAnchor = { height: 8, hash: parseHeader(headers[7]).hash }
  const store = await HeaderStore.open(fs, 'regtest', historicalAnchor)
  await expect(store.addHistoricalPage(combine(all), 1)).rejects.toThrow(/wrong height or length/)
  await expect(store.addHistoricalPage(combine(all).subarray(80), 0)).rejects.toThrow(/wrong height or length/)
  const different = [genesis, ...branch(8, 'f')]
  await expect(store.addHistoricalPage(combine(different), 0)).rejects.toThrow(/not committed/)
  expect(await fs.readText('regtest-history.json')).toBeUndefined()
})

it.each([
  '{',
  JSON.stringify({ version: 1, chain: 'other', anchorHeight: 8, pages: 1 }),
  JSON.stringify({ version: 1, chain: 'regtest', anchorHeight: 8, anchorHash: parseHeader(headers[7]).hash, pages: 2 })
])('ignores malformed or mismatched historical index metadata', async index => {
  const fs = memoryHeaderFs()
  await fs.writeText('regtest-history.json', index)
  const store = await HeaderStore.open(fs, 'regtest', { height: 8, hash: parseHeader(headers[7]).hash })
  expect(store.rootForHeight(2)).toBeUndefined()
  expect(store.nextHistoricalHeight).toBe(8)
})

it('does not restore historical roots when the index refers to an absent page', async () => {
  const fs = memoryHeaderFs()
  const historicalAnchor = { height: 8, hash: parseHeader(headers[7]).hash }
  await fs.writeText(
    'regtest-history.json',
    JSON.stringify({
      version: 1,
      chain: 'regtest',
      anchorHeight: 8,
      anchorHash: historicalAnchor.hash,
      pages: 1
    })
  )
  const store = await HeaderStore.open(fs, 'regtest', historicalAnchor)
  expect(store.rootForHeight(2)).toBeUndefined()
  expect(store.nextHistoricalHeight).toBe(8)
})

it('refuses replacing live consensus context and operations without authenticated bootstrap', async () => {
  const live = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  await live.append(combine(headers.slice(0, 1)), 1)
  await expect(live.initializeContext(genesis)).rejects.toThrow(/Cannot replace live/)
  const pending = await HeaderStore.open(memoryHeaderFs(), 'regtest', { height: 8, hash: parseHeader(headers[7]).hash })
  expect(pending.chainWork).toBe(0n)
  expect(pending.hashForHeight(9)).toBeUndefined()
  await expect(pending.append(headers[0], 9)).rejects.toThrow(/bootstrap/)
  await expect(pending.replaceBranch(9, headers[0])).rejects.toThrow(/context unavailable/)
})

it('validates replacement framing before touching a known good window', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  for (const bytes of [new Uint8Array(), new Uint8Array(81)]) {
    await expect(store.replaceBranch(1, bytes)).rejects.toThrow(/Invalid replacement header bytes/)
  }
  expect(store.tipHeight).toBe(0)
})

it('drops a persisted window whose non-genesis bootstrap context has disappeared', async () => {
  const fs = memoryHeaderFs()
  const checkpoint = { height: 1, hash: parseHeader(headers[0]).hash }
  const store = await HeaderStore.open(fs, 'regtest', checkpoint)
  await store.initializeContext(combine(all.slice(0, 2)))
  await store.append(headers[1], 2)
  await fs.deleteFile('regtest-context.bin')
  const reopened = await HeaderStore.open(fs, 'regtest', checkpoint)
  expect(reopened.needsContext).toBe(true)
  expect(reopened.count).toBe(0)
  expect(reopened.rootForHeight(2)).toBeUndefined()
})

it('drops a persisted window whose committed binary prefix is missing', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(headers[0], 1)
  await fs.deleteFile('regtest.bin')
  const reopened = await HeaderStore.open(fs, 'regtest', anchor)
  expect(reopened.count).toBe(0)
})

it('ignores malformed window metadata rather than retaining stale roots', async () => {
  const fs = memoryHeaderFs()
  await fs.writeText('regtest.json', '{')
  expect((await HeaderStore.open(fs, 'regtest', anchor)).count).toBe(0)
})

it('cannot serve an assumed genesis on an unsupported network', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'unknown', anchor)
  expect(store.rootForHeight(0)).toBeUndefined()
  expect(store.needsContext).toBe(true)
})

it('refuses a winning replacement when its retained on-disk prefix is unavailable', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  const extension = branch(9, 'c')
  await store.append(combine(extension.slice(0, 8)), 1)
  await fs.deleteFile('regtest.bin')
  await expect(store.replaceBranch(7, combine(extension.slice(6)))).rejects.toThrow(/Stored header prefix unavailable/)
  expect(store.tipHeight).toBe(8)
})

it('indexes roots directly from authenticated bootstrap context and rejects invalid lookup heights', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', { height: 8, hash: parseHeader(headers[7]).hash })
  await store.initializeContext(combine(all))
  expect(store.rootForHeight(2)).toBe(root(2))
  for (const height of [-1, 0.5, NaN]) expect(store.rootForHeight(height)).toBeUndefined()
  expect(await store.append(new Uint8Array(), 9)).toBe(0)
})

it('yields while reopening and replacing longer authenticated windows', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  const items = branch(101, 'c')
  await store.append(combine(items), 1)
  const reopened = await HeaderStore.open(fs, 'regtest', anchor)
  expect(reopened.count).toBe(101)
  reopened.yieldEvery = 1
  const replacement = branch(102, 'd')
  await reopened.replaceBranch(1, combine(replacement))
  expect(reopened.rootForHeight(102)).toBe(parseHeader(replacement[101]).merkleRoot)
})
