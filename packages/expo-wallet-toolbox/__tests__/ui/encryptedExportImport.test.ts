/**
 * Encrypted "Export Wallet Data" → "Import Wallet Data", end to end on a real
 * file system and the real SQLite engine (node:sqlite): `VACUUM INTO` takes
 * the snapshot, the file is streamed through AES to a `.db.enc`, and import
 * streams it back to a temp `.db` that SQLite opens from disk. Only the Expo
 * modules are faked, each as a thin shim over node's fs / sqlite.
 *
 * Locks: the export never shares plaintext, an import by another wallet or of
 * a damaged file is refused, and neither direction leaves a decrypted copy
 * behind in the cache.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'

jest.mock('@react-native-async-storage/async-storage', () => {
  const actual = jest.requireActual('@react-native-async-storage/async-storage')
  return { ...actual, default: actual }
})

const mockRoot = { dir: '' }

function mockAdapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
    closeAsync: async () => db.close(),
    __raw: db
  }
}
type FakeDb = ReturnType<typeof mockAdapt>

jest.mock('expo-sqlite', () => {
  const { DatabaseSync: DB } = require('node:sqlite')
  const p = require('node:path')
  const f = require('node:fs')
  return {
    openDatabaseAsync: async (name: string, _opts?: unknown, directory?: string) => {
      const dir = directory ?? p.join(mockRoot.dir, 'SQLite')
      f.mkdirSync(dir, { recursive: true })
      return mockAdapt(name === ':memory:' ? new DB(':memory:') : new DB(p.join(dir, name)))
    },
    // Logical copy is enough here: dest is always a fresh, empty database.
    backupDatabaseAsync: async ({ sourceDatabase, destDatabase }: { sourceDatabase: FakeDb; destDatabase: FakeDb }) => {
      const src = sourceDatabase.__raw
      const dest = destDatabase.__raw
      const objects = src
        .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`)
        .all() as { type: string; name: string; sql: string }[]
      for (const kind of ['table', 'index']) for (const o of objects.filter(x => x.type === kind)) dest.exec(o.sql)
      for (const o of objects.filter(x => x.type === 'table')) {
        const rows = src.prepare(`SELECT * FROM "${o.name}"`).all() as Record<string, unknown>[]
        for (const row of rows) {
          const cols = Object.keys(row)
          dest
            .prepare(`INSERT INTO "${o.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?')})`)
            .run(...(cols.map(c => row[c]) as never[]))
        }
      }
    },
    deserializeDatabaseAsync: async () => {
      throw new Error('test: the encrypted path must not deserialize in memory')
    }
  }
})

jest.mock('expo-file-system', () => {
  const f = require('node:fs')
  const p = require('node:path')
  const toPath = (parts: unknown[]) =>
    p.join(...parts.map(x => (typeof x === 'string' ? x.replace(/^file:\/\//, '') : (x as { path: string }).path)))
  class Directory {
    path: string
    constructor(...parts: unknown[]) {
      this.path = toPath(parts)
    }
    get uri() {
      return 'file://' + this.path + '/'
    }
    get exists() {
      return f.existsSync(this.path)
    }
    create() {
      f.mkdirSync(this.path, { recursive: true })
    }
    delete() {
      f.rmSync(this.path, { recursive: true, force: true })
    }
  }
  class File {
    path: string
    constructor(...parts: unknown[]) {
      this.path = toPath(parts)
    }
    get uri() {
      return 'file://' + this.path
    }
    get exists() {
      return f.existsSync(this.path)
    }
    get size() {
      return f.statSync(this.path).size
    }
    create() {
      f.writeFileSync(this.path, new Uint8Array(0))
    }
    delete() {
      f.rmSync(this.path, { force: true })
    }
    open(mode: string) {
      const fd = f.openSync(this.path, mode === 'r' ? 'r' : 'w')
      return {
        size: f.fstatSync(fd).size,
        readBytes: (n: number) => {
          const buf = new Uint8Array(n)
          return buf.slice(0, f.readSync(fd, buf, 0, n, null))
        },
        writeBytes: (b: Uint8Array) => void f.writeSync(fd, b),
        close: () => f.closeSync(fd)
      }
    }
  }
  return {
    File,
    Directory,
    FileMode: { ReadOnly: 'r', WriteOnly: 'w' },
    Paths: {
      get cache() {
        return new Directory(mockRoot.dir, 'cache')
      }
    }
  }
})

const mockShared: { name: string; bytes: Uint8Array }[] = []
jest.mock('expo-sharing', () => ({
  shareAsync: async (uri: string) => {
    const p = uri.replace(/^file:\/\//, '')
    mockShared.push({
      name: require('node:path').basename(p),
      bytes: new Uint8Array(require('node:fs').readFileSync(p))
    })
  }
}))

let mockPickedAsset: { name: string; uri: string; size: number } | null = null
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => ({ canceled: false, assets: [mockPickedAsset] })
}))

const mockShowAlert = jest.fn(async (..._args: unknown[]) => 'import')
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  i18n: jest.requireActual('../../core/i18n/translations').default,
  ...jest.requireActual('../../core/walletDbRegistry'),
  ...jest.requireActual('../../core/storage/dbImage'),
  ...jest.requireActual('../../core/storage/encryptedDbImage'),
  PENDING_KEY: jest.requireActual('../../core/localpay/pending').PENDING_KEY,
  PENDING_SUMMARY_KEY: jest.requireActual('../../core/localpay/pending').PENDING_SUMMARY_KEY,
  createTables: jest.requireActual('../../core/storage/schema/createTables').createTables
}))

import { exportAllWalletDatabases } from '../../ui/exportDatabases'
import { importWalletDatabase } from '../../ui/importDatabases'

const NOW = '2026-09-25T00:00:00.000Z'
const IDENTITY = '02' + 'a'.repeat(62)
const DB_NAME = 'wallet-deadbeef-testnet-1000.db'
const walletKey = PrivateKey.fromRandom()

async function buildStorage(): Promise<StorageExpoSQLite> {
  const dir = path.join(mockRoot.dir, 'SQLite')
  fs.mkdirSync(dir, { recursive: true })
  const raw = new DatabaseSync(path.join(dir, DB_NAME))
  raw.exec('PRAGMA journal_mode = WAL')
  await createTables(mockAdapt(raw) as never)
  raw.exec(
    `INSERT INTO settings (storageIdentityKey, storageName, chain, dbtype, maxOutputScript, created_at, updated_at)
     VALUES ('${IDENTITY}', 'bsv-wallet', 'test', 'SQLite', 1024, '${NOW}', '${NOW}')`
  )
  // Enough rows that the image spans several 1 MiB chunks.
  const ins = raw.prepare(`INSERT INTO key_value_store (key, value, updated_at) VALUES (?, ?, '${NOW}')`)
  for (let i = 0; i < 300; i++) ins.run(`k${i}`, 'v'.repeat(10_000))
  const storage = new StorageExpoSQLite({ chain: 'test', identityKey: IDENTITY } as never)
  Object.assign(storage, {
    db: mockAdapt(raw),
    dbName: DB_NAME,
    _settings: { storageIdentityKey: IDENTITY, chain: 'test' }
  })
  return storage
}

function pick(bytes: Uint8Array, name: string): string {
  const dir = path.join(mockRoot.dir, 'picked')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, bytes)
  mockPickedAsset = { name, uri: 'file://' + p, size: bytes.length }
  return p
}

let storage: StorageExpoSQLite

beforeEach(async () => {
  mockRoot.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-export-'))
  mockShared.length = 0
  mockShowAlert.mockClear()
  await AsyncStorage.clear()
  storage = await buildStorage()
})

afterEach(() => {
  fs.rmSync(mockRoot.dir, { recursive: true, force: true })
})

async function exportEncrypted(): Promise<{ name: string; bytes: Uint8Array }> {
  const n = await exportAllWalletDatabases(storage, {
    encrypt: true,
    wallet: new ProtoWallet(walletKey),
    originator: 'admin.test'
  })
  expect(n).toBe(1)
  expect(mockShared).toHaveLength(1)
  return mockShared[0]
}

describe('encrypted wallet database export/import', () => {
  it('exports a .db.enc with no plaintext in it and nothing left in the cache', async () => {
    const { name, bytes } = await exportEncrypted()
    expect(name).toMatch(/^wallet-deadbeef-testnet-\d+\.db\.enc$/)
    expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024)
    expect(Buffer.from(bytes).includes(Buffer.from('SQLite format 3'))).toBe(false)
    expect(Buffer.from(bytes).includes(Buffer.from(IDENTITY))).toBe(false)
    expect(fs.existsSync(path.join(mockRoot.dir, 'cache', 'bsv-wallet-export'))).toBe(false)
  })

  it('imports its own encrypted export, streaming through a temp file it then removes', async () => {
    const { name, bytes } = await exportEncrypted()
    const pickedPath = pick(bytes, name)

    const result = await importWalletDatabase(storage, { wallet: new ProtoWallet(walletKey), originator: 'admin.test' })

    expect(result).toMatchObject({ imported: true, keySuffix: 'deadbeef', chain: 'test' })
    const imported = new DatabaseSync(path.join(mockRoot.dir, 'SQLite', result.filename!))
    expect(imported.prepare('SELECT storageIdentityKey FROM settings').get()).toEqual({ storageIdentityKey: IDENTITY })
    // The 300 rows this test wrote, not the storage's own markers (e.g. the
    // 1Color migration key).
    expect(imported.prepare("SELECT COUNT(*) AS n FROM key_value_store WHERE key GLOB 'k[0-9]*'").get()).toEqual({
      n: 300
    })
    imported.close()
    expect(fs.existsSync(path.join(mockRoot.dir, 'cache', 'bsv-wallet-import'))).toBe(false)
    expect(fs.existsSync(pickedPath)).toBe(false)
  })

  it("refuses another wallet's export and leaves no decrypted copy", async () => {
    const { name, bytes } = await exportEncrypted()
    pick(bytes, name)

    const result = await importWalletDatabase(storage, { wallet: new ProtoWallet(PrivateKey.fromRandom()) })

    expect(result.imported).toBe(false)
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cannot Import This Backup' }))
    expect(fs.existsSync(path.join(mockRoot.dir, 'cache', 'bsv-wallet-import'))).toBe(false)
  })

  it('refuses a damaged export', async () => {
    const { name, bytes } = await exportEncrypted()
    bytes[bytes.length - 100] ^= 1
    pick(bytes, name)

    const result = await importWalletDatabase(storage, { wallet: new ProtoWallet(walletKey) })

    expect(result.imported).toBe(false)
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cannot Import This Backup' }))
    expect(fs.existsSync(path.join(mockRoot.dir, 'cache', 'bsv-wallet-import'))).toBe(false)
  })
})
