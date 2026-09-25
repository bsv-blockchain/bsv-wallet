/**
 * ui/importDatabases.ts, exercised against a fake expo-sqlite backed by
 * node:sqlite — the real engine, so `backupDatabaseAsync`'s "copy everything,
 * schema objects included" behaviour is genuinely reproduced rather than
 * assumed. Only `expo-sqlite`, `expo-file-system` and `expo-document-picker`
 * are faked; `parseDbFilename` / `selectLatestDb` / `registerDb` and the
 * import logic itself are the real modules under test.
 *
 * See the ledger rows this file locks: XR-079, XR-080, XR-081, XR-082,
 * XR-083, XR-084 (docs/security/external-review-ledger.md).
 *
 * Everything the jest.mock factories below reference is named with a `mock`
 * prefix — jest's hoisting guard only allows out-of-scope references to
 * variables named that way.
 */
import { DatabaseSync } from 'node:sqlite'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

// The repo's jest mock for this package (jest/async-storage-mock.js) is a
// plain CJS `module.exports = asMock`, with no `.default`. A compiled `import
// X from '...'` gets Babel's interop for that automatically, but
// walletDbRegistry.ts's lazy `require(...).default` (needed to keep a native
// module out of the barrel's eager import graph) does not — so it sees
// `undefined` unless `.default` is added here, test-locally.
jest.mock('@react-native-async-storage/async-storage', () => {
  const actual = jest.requireActual('@react-native-async-storage/async-storage')
  return { ...actual, default: actual }
})

// ── expo-sqlite, faked over node:sqlite ─────────────────────────────────────

/** expo-sqlite's async surface over node:sqlite's sync one — only the
 * handful of methods importDatabases.ts / StorageExpoSQLite actually call. */
function mockAdapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
    closeAsync: async () => {
      db.close()
    },
    __raw: db
  }
}
export type FakeDb = ReturnType<typeof mockAdapt>

/** Copy every schema object and every row from `src` into `dest` — the same
 * "whole file, as-is" behaviour `SQLite.backupDatabaseAsync` has in reality
 * (a page-level copy, not a filtered logical one). */
function mockCopyDb(src: DatabaseSync, dest: DatabaseSync): void {
  dest.exec('PRAGMA foreign_keys = OFF')
  const objects = src
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`)
    .all() as { type: string; name: string; sql: string }[]
  for (const kind of ['table', 'index', 'view', 'trigger']) {
    for (const obj of objects.filter(o => o.type === kind)) {
      dest.exec(obj.sql)
    }
  }
  for (const obj of objects.filter(o => o.type === 'table')) {
    const rows = src.prepare(`SELECT * FROM "${obj.name}"`).all() as Record<string, unknown>[]
    if (rows.length === 0) continue
    const cols = Object.keys(rows[0])
    const stmt = dest.prepare(
      `INSERT INTO "${obj.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    )
    for (const row of rows) {
      stmt.run(...(cols.map(c => row[c]) as never[]))
    }
  }
}

/** filename -> handle. Simulates "a file already exists / is already open at
 * this name" for expo-sqlite's file-backed openDatabaseAsync. */
const mockOpenDbs = new Map<string, FakeDb>()
/** id -> raw in-memory db. What `deserializeDatabaseAsync` "deserializes"
 * into, keyed by an id smuggled through the fake picked-file bytes. */
const mockSourceDbs = new Map<string, DatabaseSync>()

function mockRegisterSource(id: string, raw: DatabaseSync): Uint8Array {
  mockSourceDbs.set(id, raw)
  return new TextEncoder().encode(JSON.stringify({ __sourceId: id }))
}

/** `DatabaseSync` itself is a top-level import, which the jest.mock factory
 * below cannot reference directly (out-of-scope), so it is re-required here
 * behind a `mock`-prefixed function instead. */
function mockNewMemoryDb(): DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync: DB } = require('node:sqlite')
  return new DB(':memory:')
}

jest.mock('expo-sqlite', () => ({
  deserializeDatabaseAsync: async (bytes: Uint8Array) => {
    const { __sourceId } = JSON.parse(new TextDecoder().decode(bytes))
    const raw = mockSourceDbs.get(__sourceId)
    if (!raw) throw new Error('test: unknown source id ' + __sourceId)
    return mockAdapt(raw)
  },
  openDatabaseAsync: async (filename: string) => {
    let handle = mockOpenDbs.get(filename)
    if (!handle) {
      handle = mockAdapt(mockNewMemoryDb())
      mockOpenDbs.set(filename, handle)
    }
    return handle
  },
  backupDatabaseAsync: async ({ sourceDatabase, destDatabase }: { sourceDatabase: FakeDb; destDatabase: FakeDb }) => {
    mockCopyDb(sourceDatabase.__raw, destDatabase.__raw)
  },
  openDatabaseSync: () => {
    throw new Error('not used by this test')
  },
  deleteDatabaseAsync: async () => {}
}))

// ── expo-file-system / expo-document-picker ─────────────────────────────────

const mockFileBytes = new Map<string, Uint8Array>()

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    async bytes(): Promise<Uint8Array> {
      const b = mockFileBytes.get(this.uri)
      if (!b) throw new Error('test: no bytes registered for ' + this.uri)
      return b
    }
  }
}))

let mockPickedAsset: { name: string; uri: string } | null = null
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => {
    if (!mockPickedAsset) return { canceled: true, assets: null }
    return { canceled: false, assets: [mockPickedAsset] }
  }
}))

// ── AlertCard / Toast ────────────────────────────────────────────────────────

let mockAlertChoice = 'import'
const mockShowAlert = jest.fn(async () => mockAlertChoice)
const mockShowToast = jest.fn()
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))

// The package barrel (`@bsv/expo-wallet-toolbox`, i.e. core/index.ts) pulls in
// a great deal that has nothing to do with importing a database — including
// expo-local-authentication, an untransformed native ESM module Jest cannot
// parse. importDatabases.ts only needs a handful of named exports from it, so
// this re-exports the real underlying modules directly and skips the rest.
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  i18n: jest.requireActual('../../core/i18n/translations').default,
  ...jest.requireActual('../../core/walletDbRegistry'),
  ...jest.requireActual('../../core/storage/dbImage')
}))

import { importWalletDatabase } from '../../ui/importDatabases'

// ── Test fixtures ────────────────────────────────────────────────────────────

const NOW = '2026-09-25T00:00:00.000Z'
const KEY_SUFFIX = 'deadbeef'
const CHAIN = 'test'
const CURRENT_IDENTITY_KEY = '02' + 'a'.repeat(62)
const FOREIGN_IDENTITY_KEY = '02' + 'b'.repeat(62)

/** A fresh, real-schema in-memory wallet db with a single settings row. */
async function buildWalletDb(identityKey: string, chain: string = CHAIN): Promise<DatabaseSync> {
  const raw = new DatabaseSync(':memory:')
  await createTables(mockAdapt(raw) as never)
  raw.exec(
    `INSERT INTO settings (storageIdentityKey, storageName, chain, dbtype, maxOutputScript, created_at, updated_at)
     VALUES ('${identityKey}', 'bsv-wallet', '${chain}', 'SQLite', 1024, '${NOW}', '${NOW}')`
  )
  return raw
}

let currentStorage: StorageExpoSQLite

async function buildCurrentStorage(dbName: string): Promise<StorageExpoSQLite> {
  const raw = await buildWalletDb(CURRENT_IDENTITY_KEY)
  const storage = new StorageExpoSQLite({ chain: CHAIN, identityKey: CURRENT_IDENTITY_KEY } as never)
  ;(storage as unknown as { db: unknown }).db = mockAdapt(raw)
  ;(storage as unknown as { dbName: string }).dbName = dbName
  ;(storage as unknown as { _settings: unknown })._settings = {
    storageIdentityKey: CURRENT_IDENTITY_KEY,
    storageName: 'bsv-wallet',
    chain: CHAIN,
    dbtype: 'SQLite',
    maxOutputScript: 1024,
    created_at: NOW,
    updated_at: NOW
  }
  return storage
}

beforeEach(async () => {
  mockOpenDbs.clear()
  mockSourceDbs.clear()
  mockFileBytes.clear()
  mockPickedAsset = null
  mockAlertChoice = 'import'
  mockShowAlert.mockClear()
  mockShowToast.mockClear()
  await AsyncStorage.clear()
  currentStorage = await buildCurrentStorage(`wallet-${KEY_SUFFIX}-${CHAIN}net-1000.db`)
})

function pickFile(name: string, raw: DatabaseSync): void {
  const uri = `file://test/${name}`
  mockFileBytes.set(uri, mockRegisterSource(name, raw))
  mockPickedAsset = { name, uri }
}

describe('importWalletDatabase', () => {
  it('XR-079: rejects an image whose settings row belongs to a different wallet identity', async () => {
    const foreignName = `wallet-${KEY_SUFFIX}-${CHAIN}net-2000.db`
    pickFile(foreignName, await buildWalletDb(FOREIGN_IDENTITY_KEY))

    const result = await importWalletDatabase(currentStorage)

    expect(result.imported).toBe(false)
    // Rejected before ever reaching the registry or the live filename.
    expect(mockOpenDbs.has(currentStorage.dbName)).toBe(false)
    expect(await AsyncStorage.getItem(`walletDbs-${KEY_SUFFIX}-${CHAIN}net`)).toBeNull()
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/backup/i) }))
  })

  it('XR-079: rejects an image with zero or multiple settings rows', async () => {
    const raw = await buildWalletDb(CURRENT_IDENTITY_KEY)
    raw.exec(
      `INSERT INTO settings (storageIdentityKey, storageName, chain, dbtype, maxOutputScript, created_at, updated_at)
       VALUES ('${FOREIGN_IDENTITY_KEY}', 'bsv-wallet', '${CHAIN}', 'SQLite', 1024, '${NOW}', '${NOW}')`
    )
    const name = `wallet-${KEY_SUFFIX}-${CHAIN}net-2000.db`
    pickFile(name, raw)

    const result = await importWalletDatabase(currentStorage)

    expect(result.imported).toBe(false)
  })

  it('XR-079/XR-084: never opens or overwrites the live active filename, even on an exact filename collision', async () => {
    // Same filename as the currently active database, matching identity —
    // this is exactly the "restore an old backup with the same export name"
    // scenario the finding describes.
    pickFile(currentStorage.dbName, await buildWalletDb(CURRENT_IDENTITY_KEY))

    const result = await importWalletDatabase(currentStorage)

    expect(result.imported).toBe(true)
    // The destination is never the live filename.
    expect(result.filename).not.toBe(currentStorage.dbName)
    expect(mockOpenDbs.has(currentStorage.dbName)).toBe(false)
  })

  it('XR-079: an accepted import is routed through registerDb under a fresh filename', async () => {
    const name = `wallet-${KEY_SUFFIX}-${CHAIN}net-2000.db`
    pickFile(name, await buildWalletDb(CURRENT_IDENTITY_KEY))

    const result = await importWalletDatabase(currentStorage)

    expect(result.imported).toBe(true)
    expect(result.filename).toBeTruthy()
    const registered = JSON.parse((await AsyncStorage.getItem(`walletDbs-${KEY_SUFFIX}-${CHAIN}net`)) as string)
    expect(registered).toContain(result.filename)
  })

  it('XR-079: rejects a filename timestamp forged into the future', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 10_000
    const name = `wallet-${KEY_SUFFIX}-${CHAIN}net-${farFuture}.db`
    pickFile(name, await buildWalletDb(CURRENT_IDENTITY_KEY))

    const result = await importWalletDatabase(currentStorage)

    expect(result.imported).toBe(false)
    // Rejected before ever touching the registry.
    expect(await AsyncStorage.getItem(`walletDbs-${KEY_SUFFIX}-${CHAIN}net`)).toBeNull()
  })
})
