import { HeaderStore } from '../../core/headers/headerStore'
import { HeaderConsensus, parseHeader } from '../../core/headers/headerConsensus'
import { memoryHeaderFs, type HeaderFs } from '../../core/headers/fs'
import { anchor, branch, combine, genesis } from './fixtures/regtest'

const current = branch(5, 'a')
const longer = branch(6, 'b')
const shorter = branch(4, 'c')
const journal = 'regtest-replace.json'
const backup = 'regtest-replace.bin'

function expectWindow(store: HeaderStore, headers: Uint8Array[]) {
  expect(store.count).toBe(headers.length)
  expect(store.tipHash).toBe(parseHeader(headers[headers.length - 1]).hash)
  headers.forEach((header, i) => expect(store.rootForHeight(i + 1)).toBe(parseHeader(header).merkleRoot))
}

// Regtest has fixed difficulty. Only the shorter persistence cases override
// the comparison result; header linkage, PoW, indexing and reopen stay real.
async function replace(store: HeaderStore, headers: Uint8Array[]) {
  const work = Object.getOwnPropertyDescriptor(HeaderConsensus.prototype, 'chainWork')!.get!
  const tip = parseHeader(headers[headers.length - 1]).hash
  const spy =
    headers === shorter
      ? jest.spyOn(HeaderConsensus.prototype, 'chainWork', 'get').mockImplementation(function (this: HeaderConsensus) {
          return work.call(this) + (this.tipHash === tip ? 1000n : 0n)
        })
      : undefined
  try {
    return await store.replaceBranch(1, combine(headers))
  } finally {
    spy?.mockRestore()
  }
}

type Boundary = { method: 'writeBytes' | 'writeText' | 'deleteFile'; path: string }
const boundaries: Boundary[] = [
  { method: 'writeBytes', path: backup },
  { method: 'writeText', path: journal },
  { method: 'writeBytes', path: 'regtest.bin' },
  { method: 'writeText', path: 'regtest.json' },
  { method: 'deleteFile', path: journal }
]

// Once the selected operation tears/stops, all further mutations fail until
// restart. This prevents a catch handler from masking a simulated process exit.
function interruptedFs(base: HeaderFs, boundary: Boundary, when: 'before' | 'after' | 'torn') {
  let stopped = false
  async function mutate(
    method: Boundary['method'],
    path: string,
    write: () => Promise<void>,
    tear?: () => Promise<void>
  ) {
    if (stopped) throw new Error('process stopped')
    if (method === boundary.method && path === boundary.path) {
      stopped = true
      if (when === 'after') await write()
      if (when === 'torn') await tear!()
      throw new Error('process stopped')
    }
    await write()
  }
  return {
    ...base,
    writeBytes: (path: string, value: Uint8Array) =>
      mutate(
        'writeBytes',
        path,
        () => base.writeBytes(path, value),
        () => base.writeBytes(path, value.slice(0, Math.floor(value.length / 2)))
      ),
    writeText: (path: string, value: string) =>
      mutate(
        'writeText',
        path,
        () => base.writeText(path, value),
        () => base.writeText(path, value.slice(0, Math.floor(value.length / 2)))
      ),
    deleteFile: (path: string) => mutate('deleteFile', path, () => base.deleteFile(path))
  }
}

describe.each([
  ['longer', longer],
  ['shorter (comparison seam)', shorter]
] as const)('%s replacement recovery', (_, headers) => {
  it.each(
    boundaries.flatMap(boundary =>
      (boundary.method === 'deleteFile' ? (['before', 'after'] as const) : (['before', 'after', 'torn'] as const)).map(
        when => ({ ...boundary, when })
      )
    )
  )('reopens a complete committed window at $method $path $when', async ({ method, path, when }) => {
    const base = memoryHeaderFs()
    const seeded = await HeaderStore.open(base, 'regtest', anchor)
    await seeded.append(combine(current), 1)
    const fs = { ...base }
    const store = await HeaderStore.open(fs, 'regtest', anchor)
    Object.assign(fs, interruptedFs(base, { method, path }, when))
    let result: number | undefined
    try {
      result = await replace(store, headers)
    } catch {
      // Reopen below is the assertion; failures are expected before commit.
    }
    const committed = method === 'deleteFile' && when === 'after'
    if (committed) expect(result).toBe(headers.length)
    const expected = committed ? headers : current
    expectWindow(store, expected)
    expectWindow(await HeaderStore.open(base, 'regtest', anchor), expected)
    expect(await base.readBytes('regtest.bin')).toEqual(combine(expected))
    expect(await base.readText(journal)).toBeUndefined()
    expectWindow(await HeaderStore.open(base, 'regtest', anchor), expected)
  })
})

it('rolls back a transient metadata failure before the same instance appends or retries', async () => {
  const base = memoryHeaderFs()
  let fail = false
  const fs = {
    ...base,
    async writeText(path: string, text: string) {
      if (fail && path === 'regtest.json') {
        fail = false
        throw new Error('metadata failed')
      }
      await base.writeText(path, text)
    }
  }
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(combine(current), 1)
  const work = store.chainWork
  fail = true
  await expect(replace(store, longer)).rejects.toThrow('metadata failed')
  expectWindow(store, current)
  expect(store.chainWork).toBe(work)
  expect(await base.readBytes('regtest.bin')).toEqual(combine(current))
  expect(await base.readText(journal)).toBeUndefined()
  await store.append(branch(6, 'a')[5], 6)
  const next = branch(7, 'd')
  await replace(store, next)
  expectWindow(await HeaderStore.open(base, 'regtest', anchor), next)
})

it.each([false, true])('requires reopen when marker deletion has an unreadable outcome (deleted=%s)', async deleted => {
  const base = memoryHeaderFs()
  let failRead = false
  let failDelete = false
  const fs = {
    ...base,
    async deleteFile(path: string) {
      if (failDelete && path === journal) {
        if (deleted) await base.deleteFile(path)
        failRead = true
        throw new Error('delete outcome unknown')
      }
      await base.deleteFile(path)
    },
    async readText(path: string) {
      if (failRead && path === journal) {
        failRead = false
        throw new Error('marker read failed')
      }
      return base.readText(path)
    }
  }
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(combine(current), 1)
  failDelete = true
  await expect(replace(store, longer)).rejects.toThrow(/reopen/)
  expect(store.rootForHeight(1)).toBeUndefined()
  expect(store.hashForHeight(1)).toBeUndefined()
  await expect(store.append(branch(6, 'a')[5], 6)).rejects.toThrow(/reopen/)
  expectWindow(await HeaderStore.open(base, 'regtest', anchor), deleted ? longer : current)
})

it.each(['append', 'truncate', 'reset', 'replace', 'initialize'] as const)(
  'blocks %s while rollback is failing, then retries rollback before mutation',
  async operation => {
    const base = memoryHeaderFs()
    let failMeta = false
    let failRollback = false
    const fs = {
      ...base,
      async writeBytes(path: string, bytes: Uint8Array) {
        if (failRollback && path === 'regtest.bin') throw new Error('rollback failed')
        await base.writeBytes(path, bytes)
      },
      async writeText(path: string, text: string) {
        if (failMeta && path === 'regtest.json') {
          failMeta = false
          failRollback = true
          throw new Error('metadata failed')
        }
        await base.writeText(path, text)
      }
    }
    const store = await HeaderStore.open(fs, 'regtest', anchor)
    await store.append(combine(current), 1)
    failMeta = true
    await expect(replace(store, longer)).rejects.toThrow('rollback failed')
    const mutate = () => {
      switch (operation) {
        case 'append':
          return store.append(branch(6, 'a')[5], 6)
        case 'truncate':
          return store.truncateToCount(4)
        case 'reset':
          return store.reset()
        case 'replace':
          return replace(store, longer)
        case 'initialize':
          return store.initializeContext(genesis)
      }
    }
    await expect(mutate()).rejects.toThrow('rollback failed')
    expectWindow(store, current)
    expect(await base.readText(journal)).toBeDefined()
    failRollback = false
    if (operation === 'initialize') await expect(mutate()).rejects.toThrow('Cannot replace live')
    else await mutate()
    const reopened = await HeaderStore.open(base, 'regtest', anchor)
    expect(reopened.count).toBe(store.count)
    expect(reopened.tipHash).toBe(store.tipHash)
    expect(reopened.chainWork).toBe(store.chainWork)
  }
)

async function stagedRecovery() {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(combine(current), 1)
  await fs.writeBytes(backup, combine(current))
  await fs.writeText(journal, (await fs.readText('regtest.json'))!)
  await fs.writeBytes('regtest.bin', combine(longer))
  await fs.writeText(
    'regtest.json',
    JSON.stringify({
      chain: 'regtest',
      anchorHeight: 0,
      anchorHash: anchor.hash,
      count: longer.length,
      tipHash: parseHeader(longer[longer.length - 1]).hash
    })
  )
  return fs
}

it.each(
  boundaries
    .slice(2)
    .flatMap(boundary =>
      (boundary.method === 'deleteFile' ? (['before', 'after'] as const) : (['before', 'after', 'torn'] as const)).map(
        when => ({ ...boundary, when })
      )
    )
)('retries interrupted rollback at $method $path $when', async ({ method, path, when }) => {
  const fs = await stagedRecovery()
  await expect(HeaderStore.open(interruptedFs(fs, { method, path }, when), 'regtest', anchor)).rejects.toThrow(
    'process stopped'
  )
  expectWindow(await HeaderStore.open(fs, 'regtest', anchor), current)
})

it('discards an empty unpublished marker while retaining the previous window', async () => {
  const fs = await stagedRecovery()
  await fs.writeBytes('regtest.bin', combine(current))
  await fs.writeText('regtest.json', (await fs.readText(journal))!)
  await fs.writeText(journal, '')
  expectWindow(await HeaderStore.open(fs, 'regtest', anchor), current)
  expect(await fs.readText(journal)).toBeUndefined()
})

it.each(['missing', 'truncated'])('refuses recovery when the undo snapshot is %s', async state => {
  const fs = await stagedRecovery()
  if (state === 'missing') await fs.deleteFile(backup)
  else await fs.writeBytes(backup, current[0])
  await expect(HeaderStore.open(fs, 'regtest', anchor)).rejects.toThrow(/snapshot unavailable/)
  expect(await fs.readText(journal)).toBeDefined()
})

it('revalidates recovered headers rather than trusting the undo metadata', async () => {
  const fs = await stagedRecovery()
  await fs.writeBytes(backup, new Uint8Array(current.length * 80))
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  expect(store.count).toBe(0)
  expect(store.rootForHeight(1)).toBeUndefined()
})

it.each(['checkpoint', 'context'] as const)('applies %s invalidation after rollback', async change => {
  const fs = await stagedRecovery()
  const checkpoint = { height: 1, hash: parseHeader(current[0]).hash }
  if (change === 'context') {
    const meta = JSON.parse((await fs.readText(journal))!)
    await fs.writeText(journal, JSON.stringify({ ...meta, anchorHeight: 1, anchorHash: checkpoint.hash }))
  }
  const store = await HeaderStore.open(fs, 'regtest', checkpoint)
  expect(store.count).toBe(0)
  expect(store.needsContext).toBe(true)
  expect(store.rootForHeight(2)).toBeUndefined()
  expect(await fs.readText(journal)).toBeUndefined()
})

it('can replace an empty window and later replace while keeping an authenticated prefix', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await replace(store, current)
  const next = branch(7, 'a')
  await store.replaceBranch(4, combine(next.slice(3)))
  expectWindow(await HeaderStore.open(fs, 'regtest', anchor), next)
})

it('does not start a replacement without a complete snapshot of the current window', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'regtest', anchor)
  await store.append(combine(current), 1)
  await fs.writeBytes('regtest.bin', current[0])
  await expect(replace(store, longer)).rejects.toThrow(/Stored header prefix unavailable/)
  expectWindow(store, current)
  expect(await fs.readText(journal)).toBeUndefined()
})
