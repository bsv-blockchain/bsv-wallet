import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { decodeEntry, emptyChunk, encodeChunk } from '../../core/backup/codec'
import { deriveBackupWallet } from '../../core/backup/derive'
import { restoreFromBackup } from '../../core/backup/restore'
import { RemoteSyncReader } from '../../core/backup/RemoteSyncReader'
import { BACKUP_PROTOCOL, backupKeyId } from '../../core/backup/constants'

const wallet = deriveBackupWallet(new PrivateKey(21).toArray('be', 32), 'main')
const DEVICE = 'd'.repeat(32)
const digest = (bytes: number[]) => Utils.toHex(Hash.sha256(bytes))
const settings = { storageIdentityKey: 'local' } as any
const args = {} as any

function chunk(txid: string) {
  const value = emptyChunk('a', 'b', 'user')
  value.provenTxs = [{ txid, rawTx: [1] }] as any
  return value
}

function backend(blobs: number[][]) {
  const index = blobs.map((bytes, i) => ({
    seq: i + 1,
    sha256: digest(bytes),
    prevSha256: i ? digest(blobs[i - 1]) : undefined,
    size: bytes.length,
    createdAt: '2026-01-01'
  }))
  return {
    index: async () => index,
    blob: async (_device: string, _generation: number, seq: number) => new Uint8Array(blobs[seq - 1])
  }
}

function reader(blobs: number[][], device = DEVICE, generation = 1) {
  return new RemoteSyncReader(backend(blobs) as any, wallet, 'main', device, generation, settings)
}

async function boundLog() {
  const blobs: number[][] = []
  for (let i = 0; i < 3; i++) {
    blobs.push(
      await encodeChunk(
        wallet,
        chunk(String(i)),
        'main',
        i
          ? {
              generation: 1,
              initialChunkCount: 1,
              initialHeadSha256: digest(blobs[0])
            }
          : undefined,
        i ? { localpayPending: JSON.stringify([i]) } : undefined,
        { deviceId: DEVICE, generation: 1, seq: i + 1, prevSha256: i ? digest(blobs[i - 1]) : undefined }
      )
    )
  }
  return blobs
}

it('rejects duplicated authentic ciphertext even after the server rebuilds every index digest/link', async () => {
  const blobs = await boundLog()
  const attack = reader([blobs[1], blobs[1]])
  expect(await attack.verifiedComplete()).toBe(false)
  await expect(attack.getSyncChunk(args)).rejects.toThrow(/position|sequence|authenticated/)
})

it('preflights later snapshot reordering before returning the first recovery chunk', async () => {
  const blobs = await boundLog()
  const attack = reader([blobs[0], blobs[2], blobs[1]])
  await expect(attack.getSyncChunk(args)).rejects.toThrow(/position|sequence|authenticated/)
  expect(attack.appData).toBeUndefined()
})

it.each([
  ['another-device', 1],
  [DEVICE, 2]
])('rejects cross-device or generation moves (%s, %i)', async (device, generation) => {
  const attack = reader(await boundLog(), String(device), Number(generation))
  await expect(attack.getSyncChunk(args)).rejects.toThrow(/position|generation|authenticated/)
})

it('verifies an unchanged ordered log and preserves its latest snapshot on repeat restores', async () => {
  const blobs = await boundLog()
  for (let attempt = 0; attempt < 2; attempt++) {
    const valid = reader(blobs)
    expect(await valid.verifiedComplete()).toBe(true)
    for (let i = 0; i < 3; i++) expect((await valid.getSyncChunk(args)).provenTxs?.[0].txid).toBe(String(i))
    expect(valid.appData?.localpayPending).toBe('[2]')
  }
  expect((await decodeEntry(wallet, blobs[1], 'main')).position).toMatchObject({ deviceId: DEVICE, seq: 2 })
})

it('does not mark legacy count-only seals verified or apply their reorderable snapshots', async () => {
  const blob = await encodeChunk(
    wallet,
    chunk('legacy'),
    'main',
    { generation: 1, initialChunkCount: 1 },
    { localpayPending: '["old"]', receiveIssuedDates: ['2020-01-01'] }
  )
  const legacy = reader([blob])
  expect(await legacy.verifiedComplete()).toBe(false)
  expect((await legacy.getSyncChunk(args)).provenTxs?.[0].txid).toBe('legacy')
  expect(legacy.appData).toBeUndefined()
})

it('rejects an authenticated seal whose ordered snapshot head differs from the actual prefix', async () => {
  const first = await encodeChunk(wallet, chunk('0'), 'main', undefined, undefined, {
    deviceId: DEVICE,
    generation: 1,
    seq: 1
  })
  const last = await encodeChunk(
    wallet,
    chunk('1'),
    'main',
    {
      generation: 1,
      initialChunkCount: 1,
      initialHeadSha256: '0'.repeat(64)
    },
    undefined,
    { deviceId: DEVICE, generation: 1, seq: 2, prevSha256: digest(first) }
  )
  const attack = reader([first, last])
  expect(await attack.verifiedComplete()).toBe(false)
  await expect(attack.getSyncChunk(args)).rejects.toThrow(/snapshot head/)
})

it('does not apply any recovery chunk when a later authenticated position is moved', async () => {
  const blobs = await boundLog()
  const client = {
    ...backend([blobs[0], blobs[2], blobs[1]]),
    manifest: async () => [
      {
        deviceId: DEVICE,
        generation: 1,
        headSeq: 3,
        updatedAt: '2026-01-01'
      }
    ]
  }
  const storage = {
    makeAvailable: async () => settings,
    findOrInsertUser: async () => ({ user: { userId: 1 } }),
    findOrInsertSyncStateAuth: async () => ({}),
    processSyncChunk: jest.fn()
  }
  await expect(
    restoreFromBackup({
      storage: storage as any,
      client: client as any,
      primaryKey: new PrivateKey(21).toArray('be', 32),
      chain: 'main',
      identityKey: 'user'
    })
  ).rejects.toThrow(/authenticated backup position/)
  expect(storage.processSyncChunk).not.toHaveBeenCalled()
})

it.each([
  { deviceId: '', generation: 1, seq: 1 },
  { deviceId: DEVICE, generation: 0, seq: 1 },
  { deviceId: DEVICE, generation: 1.5, seq: 1 },
  { deviceId: DEVICE, generation: 1, seq: 0 },
  { deviceId: DEVICE, generation: 1, seq: 1.5 },
  { deviceId: DEVICE, generation: 1, seq: 1, prevSha256: '0'.repeat(64) },
  { deviceId: DEVICE, generation: 1, seq: 2 },
  { deviceId: DEVICE, generation: 1, seq: 2, prevSha256: 'invalid' }
])('rejects malformed authenticated position %j', async position => {
  const bytes = await encodeChunk(wallet, chunk('invalid'), 'main', undefined, undefined, position)
  await expect(decodeEntry(wallet, bytes, 'main')).rejects.toThrow(/position is malformed/)
})

it('rejects a missing position in a versioned envelope', async () => {
  const bytes = await encodeChunk(wallet, chunk('invalid'), 'main', undefined, undefined, {} as any)
  await expect(decodeEntry(wallet, bytes, 'main')).rejects.toThrow(/position is malformed/)
})

it('rejects a generation that changes from authenticated entries to legacy entries', async () => {
  const first = (await boundLog())[0]
  const legacy = await encodeChunk(wallet, chunk('legacy'), 'main')
  const mixed = reader([first, legacy])
  expect(await mixed.verifiedComplete()).toBe(false)
  await expect(mixed.getSyncChunk(args)).rejects.toThrow(/mixes legacy and authenticated positions/)
})

it('does not claim a complete initial snapshot until an authenticated seal exists', async () => {
  const first = (await boundLog())[0]
  const incomplete = reader([first])
  expect(await incomplete.verifiedComplete()).toBe(false)
  expect((await incomplete.getSyncChunk(args)).provenTxs?.[0].txid).toBe('0')
})

it.each([{ version: 3 }, { version: 2, position: null }])(
  'rejects unsupported or incomplete versioned envelopes (%j)',
  async fields => {
    const { ciphertext } = await wallet.encrypt({
      plaintext: Utils.toArray(
        JSON.stringify({ chain: 'main', chunk: emptyChunk('a', 'b', 'user'), ...fields }),
        'utf8'
      ),
      protocolID: BACKUP_PROTOCOL,
      keyID: backupKeyId('main'),
      counterparty: 'self'
    })
    await expect(decodeEntry(wallet, ciphertext, 'main')).rejects.toThrow(/version|position is malformed/)
  }
)

it('handles an empty generation as unverified recovery without fetching blobs', async () => {
  const client = backend([])
  const blob = jest.spyOn(client, 'blob')
  const empty = new RemoteSyncReader(client as any, wallet, 'main', DEVICE, 1, settings)
  expect(empty.length).toBe(0)
  expect(await empty.verifiedComplete()).toBe(false)
  expect((await empty.getSyncChunk(args)).provenTxs).toEqual([])
  expect(blob).not.toHaveBeenCalled()
})
