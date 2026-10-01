import { HD, Mnemonic } from '@bsv/sdk'
import { discoverProfiles, type ProfileProbe } from '../../core/profiles/discovery'
import type { BackupChain } from '../../core/backup/constants'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const hd = HD.fromSeed(Mnemonic.fromString(MNEMONIC).toSeed(''))
const keyHex = (n: number) => Buffer.from(hd.derive(`m/0'/${n}'`).privKey.toArray()).toString('hex')

/** A backup server holding `backups[n] = chains` for profile n. */
function fakeProbe(backups: Record<number, BackupChain[]>, failAt?: number): { probe: ProfileProbe; asked: number[] } {
  const byKey = new Map<string, number>()
  for (let n = 0; n < 60; n++) byKey.set(keyHex(n), n)
  const asked: number[] = []
  const probe: ProfileProbe = async (primaryKey, chain) => {
    const n = byKey.get(Buffer.from(primaryKey).toString('hex'))!
    if (!asked.includes(n)) asked.push(n)
    if (n === failAt) throw new Error('offline')
    return (backups[n] ?? []).includes(chain)
  }
  return { probe, asked }
}

async function run(backups: Record<number, BackupChain[]>, opts: { failAt?: number; maxProfiles?: number } = {}) {
  const { probe, asked } = fakeProbe(backups, opts.failAt)
  const registered: Array<[number, string]> = []
  const count = await discoverProfiles({
    mnemonic: MNEMONIC,
    probe,
    register: async (i, net) => {
      registered.push([i, net])
    },
    maxProfiles: opts.maxProfiles
  })
  return { count, registered, asked }
}

test('registers consecutive backed-up profiles and stops at the first miss', async () => {
  const r = await run({ 1: ['main'], 2: ['test'], 4: ['main'] })
  expect(r.registered).toEqual([
    [1, 'main'],
    [2, 'test']
  ])
  expect(r.count).toBe(2)
  expect(r.asked).toEqual([1, 2, 3])
})

test('prefers mainnet when a profile has backups on several networks', async () => {
  expect((await run({ 1: ['teratest', 'main'] })).registered).toEqual([[1, 'main']])
  expect((await run({ 1: ['teratest', 'test'] })).registered).toEqual([[1, 'test']])
})

test('nothing backed up → nothing registered', async () => {
  expect((await run({})).count).toBe(0)
})

test('a probe error stops discovery and keeps what was found', async () => {
  const r = await run({ 1: ['main'], 2: ['main'], 3: ['main'] }, { failAt: 2 })
  expect(r.registered).toEqual([[1, 'main']])
})

test('maxProfiles bounds the search', async () => {
  const all: Record<number, BackupChain[]> = {}
  for (let n = 1; n < 60; n++) all[n] = ['main']
  const r = await run(all, { maxProfiles: 3 })
  expect(r.registered.map(([i]) => i)).toEqual([1, 2, 3])
})
