import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { importWalletDatabase } from '../../ui/importDatabases'

let mockSource: DatabaseSync
let mockDestination: DatabaseSync | undefined
const mockBackup = jest.fn()
const mockRegister = jest.fn()

function mockAdapt(raw: DatabaseSync) {
  return {
    __raw: raw,
    execAsync: async (sql: string) => {
      raw.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...(params as never[])),
    closeAsync: async () => {}
  }
}

jest.mock('expo-sqlite', () => ({
  deserializeDatabaseAsync: async () => mockAdapt(mockSource),
  openDatabaseAsync: async (name: string) => {
    const { DatabaseSync: DB } = require('node:sqlite')
    const raw = new DB(':memory:')
    if (name !== ':memory:') mockDestination = raw
    return mockAdapt(raw)
  },
  backupDatabaseAsync: async ({ sourceDatabase, destDatabase }: any) => {
    mockBackup()
    const src = sourceDatabase.__raw as DatabaseSync
    const dest = destDatabase.__raw as DatabaseSync
    const objects = src.prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as {
      type: string
      name: string
      sql: string
    }[]
    for (const type of ['table', 'index', 'view', 'trigger']) {
      for (const object of objects.filter(o => o.type === type && !o.name.startsWith('sqlite_'))) dest.exec(object.sql)
    }
    for (const object of objects.filter(o => o.type === 'table' && !o.name.startsWith('sqlite_'))) {
      const rows = src.prepare(`SELECT * FROM "${object.name}"`).all()
      for (const row of rows) {
        const columns = Object.keys(row)
        dest
          .prepare(
            `INSERT INTO "${object.name}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
          )
          .run(...(columns.map(c => row[c]) as never[]))
      }
    }
  }
}))
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => ({
    canceled: false,
    assets: [{ name: 'wallet-deadbeef-testnet-2000.db', uri: 'file://picked.db', size: 4096 }]
  })
}))
jest.mock('expo-file-system', () => ({
  File: class {
    async bytes() {
      return new Uint8Array([1])
    }
    delete() {}
  }
}))
jest.mock('../../core/index', () => ({
  i18n: { t: (key: string) => key },
  parseDbFilename: () => ({ keySuffix: 'deadbeef', chain: 'test', timestamp: 2000 }),
  getRegisteredDbs: async () => [],
  registerDb: (...args: unknown[]) => mockRegister(...args),
  prepareSqliteImageForDeserialize: (bytes: Uint8Array) => bytes,
  PENDING_KEY: 'localpay_pending',
  PENDING_SUMMARY_KEY: 'localpay_pending_summary',
  createTables: (...args: unknown[]) =>
    jest.requireActual('../../core/storage/schema/createTables').createTables(...args),
  ENCRYPTED_DB_EXTENSION: '.db.enc'
}))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: async () => 'import' }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))

const storage = {
  chain: 'test',
  dbName: 'wallet-deadbeef-testnet-1000.db',
  getSettings: () => ({ storageIdentityKey: '02' + 'a'.repeat(64) })
}

beforeEach(async () => {
  mockBackup.mockClear()
  mockRegister.mockClear()
  mockDestination = undefined
  mockSource = new DatabaseSync(':memory:')
  await createTables(mockAdapt(mockSource) as never)
  mockSource
    .prepare(
      'INSERT INTO settings (storageIdentityKey, storageName, chain, dbtype, maxOutputScript, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(storage.getSettings().storageIdentityKey, 'wallet', 'test', 'SQLite', 1024, '2026-11-04', '2026-11-04')
})

afterEach(() => {
  mockSource.close()
  mockDestination?.close()
})

describe('import schema inventory includes names matching sqlite_%', () => {
  it.each(['sqliteXbackdoor', 'sqliteEvil', 'SQLITEXattack'])(
    'rejects the legal trigger %s before copying or cleanup SQL',
    async name => {
      mockSource.exec(
        `CREATE TRIGGER ${name} AFTER DELETE ON proven_txs BEGIN SELECT RAISE(ABORT, 'hidden trigger ran'); END`
      )
      // SQLite LIKE treats '_' as one arbitrary character and ignores case.
      expect(
        mockSource.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'").all()
      ).toEqual([])
      expect((await importWalletDatabase(storage as never)).imported).toBe(false)
      expect(mockBackup).not.toHaveBeenCalled()
      expect(mockRegister).not.toHaveBeenCalled()
    }
  )

  it('rejects a view hidden by the same wildcard before copying', async () => {
    mockSource.exec('CREATE VIEW sqliteXview AS SELECT * FROM proven_txs')
    expect((await importWalletDatabase(storage as never)).imported).toBe(false)
    expect(mockBackup).not.toHaveBeenCalled()
  })

  it('continues accepting the canonical schema and real internal autoindexes', async () => {
    expect(
      mockSource.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'sqlite_autoindex_*'").all().length
    ).toBeGreaterThan(0)
    expect((await importWalletDatabase(storage as never)).imported).toBe(true)
    expect(mockBackup).toHaveBeenCalledTimes(1)
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })
})
