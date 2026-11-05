import { Utils } from '@bsv/sdk'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import { parseHeader } from '../../core/headers/headerConsensus'
import { syncHeaders } from '../../core/headers/syncHeaders'

import { genesis, anchor, branch, combine } from './fixtures/regtest'

it('reports no work until a non-genesis checkpoint has authenticated bootstrap context', async () => {
  const headers = branch(2, 'c')
  const pending = await HeaderStore.open(memoryHeaderFs(), 'regtest', { height: 1, hash: parseHeader(headers[0]).hash })
  expect(pending.chainWork).toBe(0n)
})

it('rejects empty and partial replacement headers before touching the current window', async () => {
  const store = await HeaderStore.open(memoryHeaderFs(), 'regtest', anchor)
  for (const bytes of [new Uint8Array(), new Uint8Array(81)]) {
    await expect(store.replaceBranch(1, bytes)).rejects.toThrow(/Invalid replacement header bytes/)
  }
  expect(store.tipHeight).toBe(0)
})

it('reopens and replaces authenticated windows longer than the validation yield interval', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(combine(branch(101, 'c')), 1)
  const reopened = await HeaderStore.open(fs, 'regtest', anchor)
  expect(reopened.count).toBe(101)
  reopened.yieldEvery = 1
  const replacement = branch(102, 'd')
  await reopened.replaceBranch(1, combine(replacement))
  expect(reopened.rootForHeight(102)).toBe(parseHeader(replacement[101]).merkleRoot)
})

it('refuses a replacement that needs a retained disk prefix which has disappeared', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  const headers = branch(9, 'c')
  await store.append(combine(headers.slice(0, 8)), 1)
  await fs.deleteFile('regtest.bin')
  await expect(store.replaceBranch(7, combine(headers.slice(6)))).rejects.toThrow(/Stored header prefix unavailable/)
  expect(store.tipHeight).toBe(8)
})

it('discards corrupt persisted headers even when no separate bootstrap file exists', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(combine(branch(1, 'c')), 1)
  await fs.writeBytes('regtest.bin', new Uint8Array(80))
  const reopened = await HeaderStore.open(fs, 'regtest', anchor)
  expect(reopened.count).toBe(0)
  expect(reopened.rootForHeight(1)).toBeUndefined()
})

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
