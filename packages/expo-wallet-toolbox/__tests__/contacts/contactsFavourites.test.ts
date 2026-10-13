/**
 * Favourites and soft remove (Bitcoin SV Wallet, decision 10): additive
 * columns on the shared `contacts` table, run against REAL SQLite.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables, ensureContactsColumns } from '../../core/storage/schema/createTables'
import { createContactsStore, type ContactsDb } from '../../core/contacts/contactsStore'

function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

const USER = 1
const KEY_A = '02' + 'aa'.repeat(32)
const KEY_B = '03' + 'bb'.repeat(32)

let raw: DatabaseSync
let store: ReturnType<typeof createContactsStore>

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  store = createContactsStore(adapt(raw) as unknown as ContactsDb)
  const now = new Date().toISOString()
  raw.prepare('INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (?, ?, ?, ?)').run(USER, now, now, 'ff'.repeat(32))
  await store.createContact({ userId: USER, identityKey: KEY_A, name: 'Ana', source: 'manual' })
  await store.createContact({ userId: USER, identityKey: KEY_B, name: 'Ben', source: 'manual' })
})

afterEach(() => raw.close())

it('a new contact is not a favourite and not removed', async () => {
  const a = await store.getContact(USER, KEY_A)
  expect(a?.favourite).toBe(false)
  expect(a?.removedAt).toBeUndefined()
})

it('stars and unstars', async () => {
  await store.setFavourite(USER, KEY_A, true)
  expect((await store.getContact(USER, KEY_A))?.favourite).toBe(true)
  await store.setFavourite(USER, KEY_A, false)
  expect((await store.getContact(USER, KEY_A))?.favourite).toBe(false)
})

it('a removed contact leaves lists and searches but is kept, and can be restored', async () => {
  await store.removeContact(USER, KEY_A)
  expect((await store.listContacts(USER)).map(c => c.name)).toEqual(['Ben'])
  expect(await store.searchContacts(USER, 'an')).toEqual([])
  const kept = await store.getContact(USER, KEY_A)
  expect(kept?.removedAt).toEqual(expect.any(String))
  await store.restoreContact(USER, KEY_A)
  expect((await store.listContacts(USER)).map(c => c.name)).toEqual(['Ana', 'Ben'])
})

it('removing keeps the favourite star and the name', async () => {
  await store.setFavourite(USER, KEY_A, true)
  await store.removeContact(USER, KEY_A)
  await store.restoreContact(USER, KEY_A)
  const a = await store.getContact(USER, KEY_A)
  expect(a?.favourite).toBe(true)
  expect(a?.name).toBe('Ana')
})

it('adds the columns to a table that predates them, keeping its rows as before', async () => {
  const old = new DatabaseSync(':memory:')
  old.exec(`CREATE TABLE contacts (contactId INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    userId INTEGER NOT NULL, identityKey TEXT NOT NULL, name TEXT NOT NULL, cachedHandle TEXT, cachedAvatarUrl TEXT,
    cachedCertifier TEXT, source TEXT NOT NULL DEFAULT 'manual')`)
  old.prepare('INSERT INTO contacts (created_at, updated_at, userId, identityKey, name) VALUES (?, ?, ?, ?, ?)').run('t', 't', USER, KEY_A, 'Old')
  await ensureContactsColumns(adapt(old) as never)
  await ensureContactsColumns(adapt(old) as never) // idempotent
  const s = createContactsStore(adapt(old) as unknown as ContactsDb)
  const list = await s.listContacts(USER)
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ name: 'Old', favourite: false })
  expect(list[0].removedAt).toBeUndefined()
  old.close()
})
