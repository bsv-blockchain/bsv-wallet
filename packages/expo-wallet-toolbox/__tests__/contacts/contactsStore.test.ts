/**
 * `contacts` table + store, run against REAL SQLite — same pattern as
 * `__tests__/mandala/settlementStore.test.ts`.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
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
  // contacts.userId is a real FK into users(userId).
  const now = new Date().toISOString()
  raw
    .prepare('INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (?, ?, ?, ?)')
    .run(USER, now, now, 'ff'.repeat(32))
  raw
    .prepare('INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (?, ?, ?, ?)')
    .run(2, now, now, 'ee'.repeat(32))
})

afterEach(() => raw.close())

describe('schema', () => {
  it('creates the contacts table with a per-user unique identity key', () => {
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      r => r.name
    )
    expect(names).toContain('contacts')
    const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      r => r.name
    )
    expect(idx).toEqual(expect.arrayContaining(['idx_contacts_unique', 'idx_contacts_userId']))
  })

  it('is safe to run twice — additive migration, never a drop', async () => {
    await store.createContact({ userId: USER, identityKey: KEY_A, name: 'Alice', source: 'manual' })
    await createTables(adapt(raw) as never)
    expect(await store.getContact(USER, KEY_A)).toBeDefined()
  })
})

describe('createContact / getContact / listContacts', () => {
  it('round-trips a contact', async () => {
    const created = await store.createContact({
      userId: USER,
      identityKey: KEY_A,
      name: 'Alice',
      cachedHandle: 'alice',
      cachedAvatarUrl: 'https://example.com/a.png',
      source: 'qr'
    })
    expect(created.name).toBe('Alice')
    expect(created.source).toBe('qr')

    const fetched = await store.getContact(USER, KEY_A)
    expect(fetched).toMatchObject({ identityKey: KEY_A, name: 'Alice', cachedHandle: 'alice' })
  })

  it('scopes contacts to userId', async () => {
    await store.createContact({ userId: USER, identityKey: KEY_A, name: 'Alice', source: 'manual' })
    await store.createContact({ userId: 2, identityKey: KEY_A, name: 'Someone else', source: 'manual' })
    const mine = await store.listContacts(USER)
    expect(mine).toHaveLength(1)
    expect(mine[0].name).toBe('Alice')
  })

  it('refuses a second contact for the same (userId, identityKey)', async () => {
    await store.createContact({ userId: USER, identityKey: KEY_A, name: 'Alice', source: 'manual' })
    await expect(
      store.createContact({ userId: USER, identityKey: KEY_A, name: 'Alice again', source: 'manual' })
    ).rejects.toThrow()
  })

  it('lists contacts alphabetically by name', async () => {
    await store.createContact({ userId: USER, identityKey: KEY_B, name: 'Zoe', source: 'manual' })
    await store.createContact({ userId: USER, identityKey: KEY_A, name: 'Alice', source: 'manual' })
    const rows = await store.listContacts(USER)
    expect(rows.map(r => r.name)).toEqual(['Alice', 'Zoe'])
  })
})

describe('searchContacts', () => {
  beforeEach(async () => {
    await store.createContact({
      userId: USER,
      identityKey: KEY_A,
      name: 'Alice',
      cachedHandle: 'al1ce',
      source: 'manual'
    })
    await store.createContact({
      userId: USER,
      identityKey: KEY_B,
      name: 'Bob',
      cachedHandle: 'bobby',
      source: 'manual'
    })
  })

  it('matches by name, case-insensitively', async () => {
    const rows = await store.searchContacts(USER, 'ali')
    expect(rows.map(r => r.name)).toEqual(['Alice'])
  })

  it('matches by cached handle', async () => {
    const rows = await store.searchContacts(USER, 'bobby')
    expect(rows.map(r => r.name)).toEqual(['Bob'])
  })

  it('returns every contact ("Recent") on an empty query', async () => {
    const rows = await store.searchContacts(USER, '')
    expect(rows).toHaveLength(2)
  })
})

describe('renameContact', () => {
  it('changes only the name', async () => {
    await store.createContact({
      userId: USER,
      identityKey: KEY_A,
      name: 'Alice',
      cachedHandle: 'alice',
      source: 'manual'
    })
    await store.renameContact(USER, KEY_A, 'Alicia')
    const row = await store.getContact(USER, KEY_A)
    expect(row?.name).toBe('Alicia')
    expect(row?.cachedHandle).toBe('alice')
  })
})

describe('refreshContactCache', () => {
  it('updates cached fields without ever touching name', async () => {
    await store.createContact({ userId: USER, identityKey: KEY_A, name: 'My Friend', source: 'manual' })
    await store.refreshContactCache(USER, KEY_A, { cachedHandle: 'newhandle', cachedAvatarUrl: 'https://x/y.png' })
    const row = await store.getContact(USER, KEY_A)
    expect(row?.name).toBe('My Friend')
    expect(row?.cachedHandle).toBe('newhandle')
    expect(row?.cachedAvatarUrl).toBe('https://x/y.png')
  })
})

describe('deleteContact', () => {
  it('removes the row', async () => {
    await store.createContact({ userId: USER, identityKey: KEY_A, name: 'Alice', source: 'manual' })
    await store.deleteContact(USER, KEY_A)
    expect(await store.getContact(USER, KEY_A)).toBeUndefined()
  })
})
