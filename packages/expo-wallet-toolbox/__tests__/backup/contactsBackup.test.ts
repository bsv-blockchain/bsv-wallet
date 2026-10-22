/**
 * Contacts in the backup log (backup/contactsBackup.ts), against REAL SQLite: what one
 * phone's contacts table puts in a push comes back on another phone's fresh database.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { createContactsStore, type ContactsDb } from '../../core/contacts/contactsStore'
import { applyContacts, captureContacts, mergeContacts, parseContacts } from '../../core/backup/contactsBackup'
import { isEmptyAppData, mergeAppData } from '../../core/backup/appData'

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

const KEY_A = '02' + 'aa'.repeat(32)
const KEY_B = '03' + 'bb'.repeat(32)
const KEY_C = '02' + 'cc'.repeat(32)

async function phone(userId: number) {
  const raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  const now = new Date().toISOString()
  raw
    .prepare('INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (?, ?, ?, ?)')
    .run(userId, now, now, 'ff'.repeat(32))
  const db = adapt(raw) as unknown as ContactsDb
  return { raw, db, store: createContactsStore(db), userId }
}

const tick = () => new Promise(r => setTimeout(r, 5))

it('carries every contact, with its label, star and removal, to a fresh phone', async () => {
  const before = await phone(1)
  await before.store.createContact({
    userId: 1,
    identityKey: KEY_A,
    name: 'Ana',
    cachedHandle: 'ana@bitcoinsv.com',
    source: 'pay'
  })
  await before.store.createContact({ userId: 1, identityKey: KEY_B, name: 'Ben', source: 'manual' })
  await before.store.createContact({ userId: 1, identityKey: KEY_C, name: 'Cat', source: 'search' })
  await before.store.setFavourite(1, KEY_A, true)
  await before.store.removeContact(1, KEY_C)

  const snapshot = await captureContacts(before.db, 1)
  expect(parseContacts(snapshot)).toHaveLength(3)

  // restored for this phone's own local user, which needn't share the old one's id
  const after = await phone(7)
  expect(await applyContacts(after.db, 7, snapshot)).toBe(3)
  const ana = await after.store.getContact(7, KEY_A)
  expect(ana).toMatchObject({ name: 'Ana', cachedHandle: 'ana@bitcoinsv.com', source: 'pay', favourite: true })
  expect(ana?.removedAt).toBeUndefined()
  expect((await after.store.getContact(7, KEY_C))?.removedAt).toBeDefined()
  // removed people stay out of the list, as they were
  expect((await after.store.listContacts(7)).map(c => c.name)).toEqual(['Ana', 'Ben'])
  before.raw.close()
  after.raw.close()
})

it('has nothing to carry for a wallet without contacts', async () => {
  const p = await phone(1)
  expect(await captureContacts(p.db, 1)).toBeUndefined()
  p.raw.close()
})

it('never rolls back a newer edit with an older backup', async () => {
  const p = await phone(1)
  await p.store.createContact({ userId: 1, identityKey: KEY_A, name: 'Ana', source: 'manual' })
  const old = await captureContacts(p.db, 1)
  await tick()
  await p.store.renameContact(1, KEY_A, 'Ana Silva')
  expect(await applyContacts(p.db, 1, old)).toBe(0)
  expect((await p.store.getContact(1, KEY_A))?.name).toBe('Ana Silva')
  // and a newer backup does update
  const newer = JSON.stringify(
    parseContacts(old).map(c => ({ ...c, name: 'Ana S.', updatedAt: new Date(Date.now() + 60_000).toISOString() }))
  )
  expect(await applyContacts(p.db, 1, newer)).toBe(1)
  expect((await p.store.getContact(1, KEY_A))?.name).toBe('Ana S.')
  p.raw.close()
})

it('merges two phones’ contacts: everyone, each as last changed', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString()
  const a = JSON.stringify([
    { identityKey: KEY_A, name: 'Ana', source: 'manual', favourite: false, createdAt: at(0), updatedAt: at(10) },
    { identityKey: KEY_B, name: 'Ben', source: 'manual', favourite: false, createdAt: at(0), updatedAt: at(5) }
  ])
  const b = JSON.stringify([
    {
      identityKey: KEY_A.toUpperCase(),
      name: 'Ana Silva',
      source: 'manual',
      favourite: true,
      createdAt: at(0),
      updatedAt: at(20)
    }
  ])
  const merged = parseContacts(mergeContacts(a, b))
  expect(merged).toHaveLength(2)
  expect(merged.find(c => c.identityKey.toLowerCase() === KEY_A)).toMatchObject({ name: 'Ana Silva', favourite: true })
  expect(mergeContacts(undefined, b)).toBe(b)
})

it('leaves out what it can’t read, rather than failing the restore', () => {
  expect(parseContacts('not json')).toEqual([])
  expect(parseContacts(JSON.stringify([{ name: 'no key' }, null, 3]))).toEqual([])
})

it('rides in appData: not empty with contacts alone, and merged with the rest', () => {
  expect(isEmptyAppData({ contacts: '[]' })).toBe(false)
  expect(isEmptyAppData({})).toBe(true)
  const merged = mergeAppData(
    {
      contacts: JSON.stringify([
        {
          identityKey: KEY_A,
          name: 'Ana',
          source: 'manual',
          favourite: false,
          createdAt: 'x',
          updatedAt: '2026-10-01T00:00:00Z'
        }
      ])
    },
    undefined
  )
  expect(parseContacts(merged.contacts)).toHaveLength(1)
})
