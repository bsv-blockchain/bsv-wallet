import { PrivateKey, Utils } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { LogEntry } from '../../core/backup/client'
import { encodeChunk, emptyChunk, isEmptyChunk } from '../../core/backup/codec'
import { deriveBackupWallet } from '../../core/backup/derive'
import { BackupChainError, RemoteSyncReader } from '../../core/backup/RemoteSyncReader'

const PRIMARY = new PrivateKey(21).toArray('be', 32)
const DEVICE = 'd'.repeat(32)
const SETTINGS = { storageIdentityKey: 'local-storage-key' } as any

const args = {
  identityKey: 'ik', fromStorageIdentityKey: 'a', toStorageIdentityKey: 'b',
  maxRoughSize: 0, maxItems: 0, offsets: []
} as any

function chunkWithTx (txid: string): SyncChunk {
  const c = emptyChunk('a', 'b', 'user') as unknown as Record<string, unknown[]>
  c.provenTxs = [{ provenTxId: 1, txid, rawTx: [1, 2, 3] }]
  return c as unknown as SyncChunk
}

/** A client backed by an in-memory log, standing in for the server. */
function fakeClient (blobs: number[][], entries?: LogEntry[]): any {
  const index: LogEntry[] = entries ?? blobs.map((b, i) => ({
    seq: i + 1,
    sha256: `sha${i + 1}`,
    prevSha256: i === 0 ? undefined : `sha${i}`,
    size: b.length,
    createdAt: '2026-08-15T00:00:00Z'
  }))
  return {
    index: jest.fn().mockResolvedValue(index),
    blob: jest.fn(async (_d: string, _g: number, seq: number) => blobs[seq - 1]),
    manifest: jest.fn().mockResolvedValue([]),
    append: jest.fn(),
    pruneGeneration: jest.fn()
  }
}

describe('RemoteSyncReader', () => {
  it('returns chunks in sequence order', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa'), 'main'),
      await encodeChunk(w, chunkWithTx('bbb'), 'main')
    ]
    const reader = new RemoteSyncReader(fakeClient(blobs), w, 'main', DEVICE, 1, SETTINGS)

    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('aaa')
    expect((await reader.getSyncChunk(args)).provenTxs?.[0].txid).toBe('bbb')
  })

  it('signals completion with an all-empty chunk', async () => {
    // The toolbox treats an empty chunk as the completion sentinel, and needs every one of
    // the twelve arrays present rather than undefined.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const reader = new RemoteSyncReader(fakeClient([await encodeChunk(w, chunkWithTx('aaa'), 'main')]), w, 'main', DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    const done = await reader.getSyncChunk(args)

    expect(isEmptyChunk(done)).toBe(true)
    expect(Array.isArray(done.outputs)).toBe(true)
    expect(Array.isArray(done.certificateFields)).toBe(true)
  })

  it('rejects a log with a missing sequence', async () => {
    // A gap means the restore would be silently incomplete — the wallet would look healthy
    // while missing outputs it needs to spend. Failing loudly is the safer outcome.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [await encodeChunk(w, chunkWithTx('aaa'), 'main')]
    const broken: LogEntry[] = [
      { seq: 2, sha256: 'sha2', prevSha256: 'sha1', size: 1, createdAt: 'z' }
    ]

    const reader = new RemoteSyncReader(fakeClient(blobs, broken), w, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toBeInstanceOf(BackupChainError)
  })

  it('rejects a forked chain', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa'), 'main'),
      await encodeChunk(w, chunkWithTx('bbb'), 'main')
    ]
    const forked: LogEntry[] = [
      { seq: 1, sha256: 'sha1', prevSha256: undefined, size: 1, createdAt: 'z' },
      { seq: 2, sha256: 'sha2', prevSha256: 'NOT-sha1', size: 1, createdAt: 'z' }
    ]

    const reader = new RemoteSyncReader(fakeClient(blobs, forked), w, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/forked/)
  })

  it('cannot decrypt a log written by a different wallet', async () => {
    const mine = deriveBackupWallet(PRIMARY, 'main')
    const theirs = deriveBackupWallet(new PrivateKey(22).toArray('be', 32), 'main')
    const blobs = [await encodeChunk(theirs, chunkWithTx('aaa'), 'main')]

    const reader = new RemoteSyncReader(fakeClient(blobs), mine, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow()
  })

  it('cannot decrypt a log written by the same wallet on another network', async () => {
    // The cross-network restore scenario this feature exists to prevent: same seed,
    // blobs written on mainnet, reader operating on testnet. Must fail outright.
    const main = deriveBackupWallet(PRIMARY, 'main')
    const test = deriveBackupWallet(PRIMARY, 'test')
    const blobs = [await encodeChunk(main, chunkWithTx('aaa'), 'main')]

    const reader = new RemoteSyncReader(fakeClient(blobs), test, 'test', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow()
  })

  it('reads the index once, not per chunk', async () => {
    const w = deriveBackupWallet(PRIMARY, 'main')
    const blobs = [
      await encodeChunk(w, chunkWithTx('aaa'), 'main'),
      await encodeChunk(w, chunkWithTx('bbb'), 'main')
    ]
    const client = fakeClient(blobs)
    const reader = new RemoteSyncReader(client, w, 'main', DEVICE, 1, SETTINGS)

    await reader.getSyncChunk(args)
    await reader.getSyncChunk(args)
    await reader.getSyncChunk(args)

    expect(client.index).toHaveBeenCalledTimes(1)
  })

  it('round-trips a chunk through encode and restore byte-exactly', async () => {
    // The property the whole feature depends on: what a restore replays is exactly what
    // the push captured, including the binary fields that make outputs spendable.
    const w = deriveBackupWallet(PRIMARY, 'main')
    const original = emptyChunk('a', 'b', 'user') as unknown as Record<string, unknown[]>
    original.outputs = [{
      outputId: 1,
      senderIdentityKey: '02' + 'cd'.repeat(32),
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      lockingScript: Array.from({ length: 64 }, (_, i) => i)
    }]

    const blobs = [await encodeChunk(w, original as unknown as SyncChunk, 'main')]
    const reader = new RemoteSyncReader(fakeClient(blobs), w, 'main', DEVICE, 1, SETTINGS)
    const restored = await reader.getSyncChunk(args) as any

    // This metadata exists only in the database and is exactly why the seed alone cannot
    // recover a wallet.
    expect(restored.outputs[0].senderIdentityKey).toBe('02' + 'cd'.repeat(32))
    expect(restored.outputs[0].derivationPrefix).toBe('cHJlZml4')
    expect(restored.outputs[0].derivationSuffix).toBe('c3VmZml4')
    expect(restored.outputs[0].lockingScript).toEqual(Array.from({ length: 64 }, (_, i) => i))
  })
})


describe('RemoteSyncReader reliability and scheduling', () => {
  const wallet = () => ({ decrypt: jest.fn(async () => ({
    plaintext: Utils.toArray(JSON.stringify({ chain: 'main', chunk: chunkWithTx('restored') }), 'utf8')
  })) }) as any
  const entries = (n: number): LogEntry[] => Array.from({ length: n }, (_, i) => ({
    seq: i + 1, sha256: `sha${i + 1}`, prevSha256: i ? `sha${i}` : undefined,
    size: 10, createdAt: '2026-09-05T00:00:00Z'
  }))

  it('reads beyond the server 500-entry page limit and replays every chunk in order', async () => {
    const all = entries(501)
    const client = {
      index: jest.fn(async (_d, _g, from = 1) => all.slice(from - 1, from - 1 + 500)),
      blob: jest.fn(async () => new Uint8Array([1]))
    }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS, 501)
    for (let i = 0; i < 501; i++) expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(false)
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(true)
    expect(reader.length).toBe(501)
    expect(client.index.mock.calls).toEqual([[DEVICE, 1], [DEVICE, 1, 501]])
    expect(client.blob.mock.calls.map((call: any) => call[2])).toEqual(all.map(e => e.seq))
  })

  it('rejects an index that stops before the manifest head, before replaying any data', async () => {
    const client = {
      index: jest.fn().mockResolvedValueOnce(entries(1)).mockResolvedValueOnce([]),
      blob: jest.fn()
    }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS, 2)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/advertised head/)
    expect(client.blob).not.toHaveBeenCalled()
  })

  it('does not cache an invalid index across retries', async () => {
    const client = { index: jest.fn().mockResolvedValue([{ ...entries(1)[0], seq: 2 }]), blob: jest.fn() }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/gap/)
    await expect(reader.getSyncChunk(args)).rejects.toThrow(/gap/)
    expect(client.blob).not.toHaveBeenCalled()
  })

  it('retries the same sequence after a download or decryption failure', async () => {
    const w = wallet()
    w.decrypt.mockRejectedValueOnce(new Error('decode failed'))
    const client = {
      index: jest.fn().mockResolvedValue(entries(1)),
      blob: jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Uint8Array([1]))
    }
    const reader = new RemoteSyncReader(client as any, w, 'main', DEVICE, 1, SETTINGS)
    await expect(reader.getSyncChunk(args)).rejects.toThrow('offline')
    await expect(reader.getSyncChunk(args)).rejects.toThrow('decode failed')
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(false)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 1, 1])
  })

  it('downloads only one small chunk ahead while the caller replays, without reordering', async () => {
    const client = { index: jest.fn().mockResolvedValue(entries(3)), blob: jest.fn().mockResolvedValue(new Uint8Array([1])) }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await reader.getSyncChunk(args)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 2])
    await reader.getSyncChunk(args)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 2, 3])
    await reader.getSyncChunk(args)
    expect(client.blob).toHaveBeenCalledTimes(3)
  })

  it('keeps large chunks sequential to avoid doubling mobile memory pressure', async () => {
    const index = entries(2).map(e => ({ ...e, size: 2 * 1024 * 1024 }))
    const client = { index: jest.fn().mockResolvedValue(index), blob: jest.fn().mockResolvedValue(new Uint8Array([1])) }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await reader.getSyncChunk(args)
    expect(client.blob).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed prefetch when consumed and retries that sequence', async () => {
    const client = {
      index: jest.fn().mockResolvedValue(entries(2)),
      blob: jest.fn().mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(new Uint8Array([1]))
    }
    const reader = new RemoteSyncReader(client as any, wallet(), 'main', DEVICE, 1, SETTINGS)
    await reader.getSyncChunk(args)
    await new Promise(resolve => setImmediate(resolve))
    await expect(reader.getSyncChunk(args)).rejects.toThrow('offline')
    expect(isEmptyChunk(await reader.getSyncChunk(args))).toBe(false)
    expect(client.blob.mock.calls.map(call => call[2])).toEqual([1, 2, 2])
  })
})
