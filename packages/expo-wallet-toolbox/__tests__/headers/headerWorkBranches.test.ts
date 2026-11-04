import { Utils } from '@bsv/sdk'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import { parseHeader } from '../../core/headers/headerConsensus'
import { syncHeaders } from '../../core/headers/syncHeaders'

import { genesis, anchor, branch, combine } from './fixtures/regtest'

it('does not replace or persist a lower/equal-work branch, and adopts a greater-work branch', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  const current = branch(5, 'a')
  await store.append(combine(current), 1)
  const before = (await fs.readBytes('regtest.bin'))!.slice()
  const work = store.chainWork
  for (const count of [4, 5]) {
    await expect(store.replaceBranch(1, combine(branch(count, 'b')))).rejects.toThrow(/greater accumulated work/)
    expect(await fs.readBytes('regtest.bin')).toEqual(before)
    expect(store.chainWork).toBe(work)
  }
  const replacement = branch(6, 'c')
  await store.replaceBranch(1, combine(replacement))
  expect(store.tipHeight).toBe(6)
  expect(store.chainWork).toBeGreaterThan(work)
  const reopened = await HeaderStore.open(fs, 'regtest', anchor)
  expect(reopened.chainWork).toBe(store.chainWork)
  expect(reopened.rootForHeight(5)).toBe(parseHeader(replacement[4]).merkleRoot)
})

it('leaves a known valid tip intact when the online source offers a conflicting lower-work branch', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  const current = branch(5, 'a')
  await store.append(combine(current), 1)
  const tip = store.tipHash
  const alternative = [genesis, ...branch(4, 'b')]
  const source = {
    getPresentHeight: async () => 4,
    getHeaders: async (height: number, count: number) =>
      Utils.toHex(Array.from(combine(alternative.slice(height, height + count))))
  }
  await expect(syncHeaders({ store, client: source })).rejects.toThrow(/greater accumulated work/)
  expect(store.tipHash).toBe(tip)
  expect(store.count).toBe(5)
})

it('revalidates disk headers instead of trusting roots and work recorded by the previous build', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(combine(branch(2, 'a')), 1)
  const disk = (await fs.readBytes('regtest.bin'))!.slice()
  disk[36] ^= 1
  await fs.writeBytes('regtest.bin', disk)
  const reopened = await HeaderStore.open(fs, 'regtest', anchor)
  expect(reopened.rootForHeight(1)).toBeUndefined()
  expect(reopened.count).toBe(0)
})

it('continues staging bounded chunks until the competing branch has greater accumulated work', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  await store.append(combine(branch(5, 'a')), 1)
  const alternative = [genesis, ...branch(6, 'b')]
  const source = {
    getPresentHeight: async () => 6,
    getHeaders: async (height: number, count: number) =>
      Utils.toHex(Array.from(combine(alternative.slice(height, height + count))))
  }
  await expect(syncHeaders({ store, client: source, chunkSize: 2 })).resolves.toMatchObject({ tipHeight: 6 })
  expect(store.tipHash).toBe(parseHeader(alternative[6]).hash)
})
