/**
 * XR-011 / XR-055 — known, tracked gap: appData written in a window with no OTHER entity
 * activity never reaches the backup log.
 *
 * cc349df8 (XR-011) and 7f34d10d (XR-055) fixed the general case — appData now rides any
 * chunk that pushOnce is ALREADY sending because of a real toolbox-entity change. But
 * `pushOnce` deliberately never sends a chunk for appData alone (see push.ts/codec.ts's own
 * docs on why: the toolbox's inherited `processSyncChunk` treats an all-empty-entity chunk
 * as its completion sentinel, so an appended appData-only entry could make a downstream
 * reader stop consuming the log early — see `push.test.ts`'s "never appends purely to carry
 * appData" case, which pins that decision at the unit level).
 *
 * The consequence, unverified end-to-end until this test: a receiver-side localpay_pending
 * frame, a peerpay_outbox delivery checkpoint, or a receiveIssuedDates entry written in a
 * window where NOTHING else in the wallet's entity tables changed is never appended to the
 * backup log at all — not merely delayed. If the device is lost before some UNRELATED entity
 * change happens to close a later window, that row is unrecoverable even though a perfectly
 * healthy, verified backup exists.
 *
 * This is deliberately NOT a regression test with a fix behind it: closing it for real needs
 * either a dedicated appData-only log-entry shape (safe only once every reader in the device
 * fleet is known to understand it) or a new backup-server-side channel outside the chunk log
 * — both wire-level changes shared with other devices/the server, out of scope for a
 * same-device code fix. It exists so the exact gap the ledger's own regression_test_plan
 * targets stays pinned and visible in the suite instead of silently re-discovered.
 */
import { Hash, PrivateKey, Utils } from '@bsv/sdk'

jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import { emptyChunk, isEmptyChunk } from '../../core/backup/codec'
import { pushOnce, type PushDeps } from '../../core/backup/push'
import { restoreOnImport } from '../../core/backup/restoreOnImport'
import { getPending, savePending, type KVStorage as PendingKVStorage } from '../../core/localpay/pending'
import { FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import { getOutboxEntries } from '../../core/peerpay/outbox'
import { getIssuedDates, recordIssuedDate } from '../../core/pay/receiveHistory'
import type { SyncChunk } from '../../core/toolboxTypes'

const PRIMARY = new PrivateKey(41).toArray('be', 32)
const IDENTITY = '02' + 'cd'.repeat(32)
const DEVICE_A = 'd'.repeat(32)

function sha256Hex (bytes: number[]): string {
  return Utils.toHex(Hash.sha256(bytes))
}

function chunkWithTx (txid: string): SyncChunk {
  const c = emptyChunk('a', 'b', IDENTITY) as unknown as Record<string, unknown[]>
  c.provenTxs = [{ provenTxId: 1, txid, rawTx: [1, 2, 3], updated_at: '2026-08-01T00:00:00.000Z' }]
  return c as unknown as SyncChunk
}

/**
 * An in-memory stand-in for the whole backup SERVER — append/manifest/index/blob/limits —
 * shared by both the pushing device and the restoring device in these tests, exactly as the
 * real server is shared by every device on a wallet.
 */
function fakeBackupServer (): any {
  const logs = new Map<string, number[][]>()
  const key = (d: string, g: number): string => `${d}/${g}`
  return {
    append: jest.fn(async (deviceId: string, generation: number, seq: number, _prevSha: string | undefined, ciphertext: number[]) => {
      const k = key(deviceId, generation)
      const arr = logs.get(k) ?? []
      arr[seq - 1] = ciphertext
      logs.set(k, arr)
      return { sha256: sha256Hex(ciphertext) }
    }),
    manifest: jest.fn(async () => {
      const out: any[] = []
      for (const [k, arr] of logs.entries()) {
        if (arr.length === 0) continue
        const [deviceId, genStr] = k.split('/')
        out.push({
          deviceId,
          generation: Number(genStr),
          headSeq: arr.length,
          headSha256: sha256Hex(arr[arr.length - 1]),
          totalBytes: arr.reduce((s, b) => s + b.length, 0),
          updatedAt: '2026-08-15T00:00:00Z'
        })
      }
      return out
    }),
    index: jest.fn(async (deviceId: string, generation: number) => {
      const arr = logs.get(key(deviceId, generation)) ?? []
      return arr.map((b, i) => ({
        seq: i + 1,
        sha256: sha256Hex(b),
        prevSha256: i === 0 ? undefined : sha256Hex(arr[i - 1]),
        size: b.length,
        createdAt: '2026-08-15T00:00:00Z'
      }))
    }),
    blob: jest.fn(async (deviceId: string, generation: number, seq: number) => (logs.get(key(deviceId, generation)) ?? [])[seq - 1]),
    limits: jest.fn().mockResolvedValue({ maxBlobBytes: 1 << 20, maxBodyBytes: 1 << 21, serverIdentityKey: '02'.padEnd(66, 'a') }),
    pruneGeneration: jest.fn()
  }
}

/** The pushing ("old", about-to-be-lost) device's storage: real KV semantics, plus a
 * getSyncChunk the test drives explicitly to control exactly when entity activity exists. */
function pushingDeviceStorage (chunks: SyncChunk[]): PendingKVStorage & { getSyncChunk: jest.Mock } {
  const kv = new Map<string, string>()
  const queue = [...chunks]
  return {
    getSyncChunk: jest.fn(async () => queue.shift() ?? emptyChunk('a', 'b', IDENTITY)),
    getKeyValue: async (k: string) => kv.get(k),
    setKeyValue: async (k: string, v: string) => void kv.set(k, v)
  }
}

/** The restoring ("new") device's storage — mirrors restoreOnImport.test.ts's own fake. */
function freshDeviceStorage (): any {
  const kv = new Map<string, string>()
  const s: any = {
    kv,
    getKeyValue: async (k: string) => kv.get(k),
    setKeyValue: async (k: string, v: string) => void kv.set(k, v),
    findProvenTxReqs: jest.fn().mockResolvedValue([]),
    makeAvailable: jest.fn().mockResolvedValue({ storageIdentityKey: 'fresh-local' }),
    findOrInsertUser: jest.fn(async () => ({ user: { userId: 7 }, isNew: true })),
    findOrInsertSyncStateAuth: jest.fn(async () => ({ syncState: {}, isNew: true })),
    processSyncChunk: jest.fn(async (_args: unknown, chunk: SyncChunk) => {
      if (s.findOrInsertUser.mock.calls.length === 0 || s.findOrInsertSyncStateAuth.mock.calls.length === 0) {
        throw new Error('A truthy value is required.')
      }
      return isEmptyChunk(chunk)
        ? { done: true, maxUpdated_at: undefined, updates: 0, inserts: 0 }
        : { done: false, maxUpdated_at: undefined, updates: 0, inserts: 0 }
    })
  }
  return s
}

function frame (): PaymentFrame {
  return {
    version: FRAME_VERSION,
    kind: 'bsv',
    senderIdentityKey: '02'.padEnd(66, 'a'),
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction: new Uint8Array([1, 2, 3])
  }
}

beforeEach(async () => { await AsyncStorage.clear() })

/**
 * Runs the shared scaffold: a baseline push that lands a real backup (so restore itself
 * succeeds), then `writeAppOwnedRow` writes exactly one KV row with no accompanying entity
 * change, then a second push observes an empty entity chunk (the ledger's own scenario: "no
 * other wallet entity activity in that window"), then a fresh device restores.
 */
async function runIsolatedActivityScenario (
  writeAppOwnedRow: (storage: PendingKVStorage) => Promise<void>
): Promise<{ pushed2: number, windowClosed2: boolean, restoredStorage: any, chunksReplayed: number }> {
  const server = fakeBackupServer()
  const pushingStorage = pushingDeviceStorage([chunkWithTx('base')])
  const deps: PushDeps = {
    storage: pushingStorage as any,
    primaryKey: PRIMARY,
    chain: 'main',
    identityKey: IDENTITY,
    client: server,
    deviceId: DEVICE_A
  }

  // 1. Baseline push: a real entity change, nothing app-owned queued yet. Lands one entry.
  const first = await pushOnce(deps)
  expect(first.pushed).toBe(1)

  // 2. The row itself: exactly what the ledger's scenario describes — a receiver
  // acknowledgment / outbox delivery / issued-address record, with NOTHING else touching an
  // entity table in this same window.
  await writeAppOwnedRow(pushingStorage)

  // 3. Second push observes an empty entity chunk — the reviewer's exact scenario.
  const second = await pushOnce(deps)

  // 4. Device lost. Restore onto a fresh device from the same server.
  const restoredStorage = freshDeviceStorage()
  const result = await restoreOnImport({
    storage: restoredStorage,
    primaryKey: PRIMARY,
    chain: 'main',
    identityKey: IDENTITY,
    client: server
  } as any)
  expect(result.restored).toBe(true)

  return { pushed2: second.pushed, windowClosed2: second.windowClosed, restoredStorage, chunksReplayed: result.chunks }
}

describe('XR-011/XR-055: appData written in an activity-free window is not backed up (known gap)', () => {
  it('XR-011: a receiver-side acknowledged localpay pending frame is stranded, not merely delayed', async () => {
    let saved: Awaited<ReturnType<typeof savePending>> | undefined
    const { pushed2, windowClosed2, restoredStorage, chunksReplayed } = await runIsolatedActivityScenario(async (storage) => {
      saved = await savePending(storage, frame(), 'qr')
    })

    // The second push genuinely sent nothing — confirms this run reproduces the reviewer's
    // premise (an empty entity chunk), not merely a stale assertion.
    expect(pushed2).toBe(0)
    expect(windowClosed2).toBe(true)
    expect(saved).toBeDefined()

    // The baseline backup replayed fine (one chunk, from step 1) …
    expect(chunksReplayed).toBe(1)
    // … but the frame acknowledged in the activity-free window never reached the log, so a
    // restore onto a brand-new device — with a perfectly healthy, verified backup — does not
    // recover it. This is the row's own headline scenario, still open; see appData.ts and
    // push.ts for the design delta this requires (a dedicated appData-only wire shape,
    // fleet-version-gated, or a separate server channel).
    expect(await getPending(restoredStorage)).toEqual([])
  })

  it('secondary instance of the same gap: peerpay_outbox delivery checkpoint is stranded', async () => {
    const { pushed2, restoredStorage } = await runIsolatedActivityScenario(async (storage) => {
      await storage.setKeyValue('peerpay_outbox', JSON.stringify([{ id: 'o1', status: 'unsent', delivering: true }]))
    })

    expect(pushed2).toBe(0)
    expect(await getOutboxEntries(restoredStorage)).toEqual([])
  })

  it('XR-055: an issued conventional-receive date is stranded the same way', async () => {
    const { pushed2, restoredStorage } = await runIsolatedActivityScenario(async (storage) => {
      await recordIssuedDate(storage, '2026-09-01')
    })

    expect(pushed2).toBe(0)
    // Lower severity than the localpay/peerpay case (WalletCheckScreen's repair loop and the
    // address itself remain seed-derivable regardless of backup — see the ledger row's own
    // notes) but the SAME mechanism: a restored device does not inherit this date.
    expect(await getIssuedDates(restoredStorage)).toEqual([])
  })
})
