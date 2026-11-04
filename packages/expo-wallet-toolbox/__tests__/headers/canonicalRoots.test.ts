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
