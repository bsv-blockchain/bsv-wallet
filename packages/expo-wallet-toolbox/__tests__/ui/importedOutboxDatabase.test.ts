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

describe('imported outgoing payment quarantine', () => {
  it('does not make a pre-cancellation PeerPay token actionable after import', async () => {
    const original = [
      {
        id: 'old-send',
        createdAt: '2026-11-01',
        recipient: '02aa',
        messageBoxUrl: 'https://box',
        status: 'unsent',
        txid: 'ab'.repeat(32),
        token: {
          amount: 17,
          transaction: [1, 2, 3],
          customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }
        }
      }
    ]
    mockSource
      .prepare('INSERT INTO key_value_store (key, value, updated_at) VALUES (?, ?, ?)')
      .run('peerpay_outbox', JSON.stringify(original), '2026-11-01')
    const result = await importWalletDatabase(storage as never)
    expect(result.imported).toBe(true)
    const row = mockDestination!.prepare('SELECT value FROM key_value_store WHERE key = ?').get('peerpay_outbox')!
    const imported = JSON.parse(row.value as string)
    expect(imported).toEqual([{ ...original[0], status: 'import_hold' }])
    expect(jest.requireActual('../../core/peerpay/outbox').unsentEntries(imported)).toEqual([])
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })
})
