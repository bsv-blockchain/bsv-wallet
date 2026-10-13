/**
 * `ContactsStore` over the toolbox's own SQLite connection.
 *
 * Deliberately logic-free, same spirit as `mandala/settlementStore.ts`: every
 * decision (what counts as a match, how activity is aggregated) lives in the
 * callers of this module. What is here is statements.
 *
 * `name` is the one column this store treats as sacred: it is the user's own
 * label for the counterparty, and no method here ever overwrites it except
 * `renameContact`, which exists for exactly that. A background identity
 * refresh calls `refreshContactCache` instead, which never touches `name`.
 *
 * Access pattern matches `settlementStore.ts`: the caller hands in
 * `storage.sqliteDb` and this module only ever issues parameterised statements
 * against it.
 */

/** Everything these statements bind. */
export type ContactsBindValue = string | number | null

/** Structurally satisfied by expo-sqlite's `SQLiteDatabase` and by the
 * `node:sqlite` adapter the tests use. */
export interface ContactsDb {
  runAsync(sql: string, params: ContactsBindValue[]): Promise<{ changes: number }>
  getAllAsync(sql: string, params: ContactsBindValue[]): Promise<unknown[]>
  getFirstAsync(sql: string, params: ContactsBindValue[]): Promise<unknown>
}

/** How a contact entered the address book. */
export type ContactSource = 'manual' | 'qr' | 'pay' | 'search'

export interface ContactRow {
  contactId: number
  userId: number
  identityKey: string
  /** The user's own label. Never overwritten by a cache refresh. */
  name: string
  cachedHandle?: string
  cachedAvatarUrl?: string
  cachedCertifier?: string
  source: ContactSource
  createdAt: string
  updatedAt: string
  /** Starred by the user. */
  favourite: boolean
  /** When the user took them out of the address book; set means hidden from
   * lists and searches but kept, so it can be undone. */
  removedAt?: string
}

interface ContactDbRow {
  contactId: number
  userId: number
  identityKey: string
  name: string
  cachedHandle: string | null
  cachedAvatarUrl: string | null
  cachedCertifier: string | null
  source: string
  created_at: string
  updated_at: string
  // added by ensureContactsColumns; absent on a table that predates them
  favourite?: number | null
  removedAt?: string | null
}

function toContact(row: ContactDbRow): ContactRow {
  return {
    contactId: row.contactId,
    userId: row.userId,
    identityKey: row.identityKey,
    name: row.name,
    cachedHandle: row.cachedHandle ?? undefined,
    cachedAvatarUrl: row.cachedAvatarUrl ?? undefined,
    cachedCertifier: row.cachedCertifier ?? undefined,
    source: row.source as ContactSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    favourite: !!row.favourite,
    removedAt: row.removedAt ?? undefined
  }
}

export interface ContactsStore {
  /** The address book: everyone not removed. */
  listContacts(userId: number): Promise<ContactRow[]>
  /** Case-insensitive substring match on `name` and `cachedHandle`. Forgiving,
   * not scored — "fuzzy" in the design sense, not a ranked fuzzy algorithm. */
  searchContacts(userId: number, query: string): Promise<ContactRow[]>
  /** Including a removed one (check `removedAt`): adding them again restores them. */
  getContact(userId: number, identityKey: string): Promise<ContactRow | undefined>
  /** Throws on a duplicate (userId, identityKey) — callers check `getContact` first when they need "already a contact" as a non-throwing fact. */
  createContact(args: {
    userId: number
    identityKey: string
    name: string
    cachedHandle?: string
    cachedAvatarUrl?: string
    cachedCertifier?: string
    source: ContactSource
  }): Promise<ContactRow>
  /** The user's own edit. The only method that may change `name`. */
  renameContact(userId: number, identityKey: string, name: string): Promise<void>
  /** A background identity refresh. Never touches `name`. */
  refreshContactCache(
    userId: number,
    identityKey: string,
    cache: { cachedHandle?: string; cachedAvatarUrl?: string; cachedCertifier?: string }
  ): Promise<void>
  deleteContact(userId: number, identityKey: string): Promise<void>
  /** Star or unstar. */
  setFavourite(userId: number, identityKey: string, favourite: boolean): Promise<void>
  /** Take out of the address book, keeping the row so `restoreContact` can undo it. */
  removeContact(userId: number, identityKey: string): Promise<void>
  restoreContact(userId: number, identityKey: string): Promise<void>
}

export function createContactsStore(db: ContactsDb): ContactsStore {
  return {
    async listContacts(userId) {
      const rows = (await db.getAllAsync('SELECT * FROM contacts WHERE userId = ? AND removedAt IS NULL ORDER BY name COLLATE NOCASE ASC', [
        userId
      ])) as ContactDbRow[]
      return rows.map(toContact)
    },

    async searchContacts(userId, query) {
      const needle = `%${query.trim().toLowerCase()}%`
      if (query.trim() === '') return createContactsStore(db).listContacts(userId)
      const rows = (await db.getAllAsync(
        `SELECT * FROM contacts
         WHERE userId = ? AND removedAt IS NULL
           AND (lower(name) LIKE ? OR lower(coalesce(cachedHandle, '')) LIKE ?)
         ORDER BY name COLLATE NOCASE ASC`,
        [userId, needle, needle]
      )) as ContactDbRow[]
      return rows.map(toContact)
    },

    async getContact(userId, identityKey) {
      const row = (await db.getFirstAsync('SELECT * FROM contacts WHERE userId = ? AND identityKey = ?', [
        userId,
        identityKey
      ])) as ContactDbRow | null
      return row ? toContact(row) : undefined
    },

    async createContact(args) {
      const now = new Date().toISOString()
      await db.runAsync(
        `INSERT INTO contacts
           (created_at, updated_at, userId, identityKey, name, cachedHandle, cachedAvatarUrl, cachedCertifier, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          now,
          now,
          args.userId,
          args.identityKey,
          args.name,
          args.cachedHandle ?? null,
          args.cachedAvatarUrl ?? null,
          args.cachedCertifier ?? null,
          args.source
        ]
      )
      const created = await createContactsStore(db).getContact(args.userId, args.identityKey)
      if (!created) throw new Error('contacts: insert did not persist')
      return created
    },

    async renameContact(userId, identityKey, name) {
      await db.runAsync('UPDATE contacts SET name = ?, updated_at = ? WHERE userId = ? AND identityKey = ?', [
        name,
        new Date().toISOString(),
        userId,
        identityKey
      ])
    },

    async refreshContactCache(userId, identityKey, cache) {
      await db.runAsync(
        `UPDATE contacts
         SET cachedHandle = ?, cachedAvatarUrl = ?, cachedCertifier = ?, updated_at = ?
         WHERE userId = ? AND identityKey = ?`,
        [
          cache.cachedHandle ?? null,
          cache.cachedAvatarUrl ?? null,
          cache.cachedCertifier ?? null,
          new Date().toISOString(),
          userId,
          identityKey
        ]
      )
    },

    async deleteContact(userId, identityKey) {
      await db.runAsync('DELETE FROM contacts WHERE userId = ? AND identityKey = ?', [userId, identityKey])
    },

    async setFavourite(userId, identityKey, favourite) {
      await db.runAsync('UPDATE contacts SET favourite = ?, updated_at = ? WHERE userId = ? AND identityKey = ?', [
        favourite ? 1 : 0,
        new Date().toISOString(),
        userId,
        identityKey
      ])
    },

    async removeContact(userId, identityKey) {
      const now = new Date().toISOString()
      await db.runAsync('UPDATE contacts SET removedAt = ?, updated_at = ? WHERE userId = ? AND identityKey = ?', [
        now,
        now,
        userId,
        identityKey
      ])
    },

    async restoreContact(userId, identityKey) {
      await db.runAsync('UPDATE contacts SET removedAt = NULL, updated_at = ? WHERE userId = ? AND identityKey = ?', [
        new Date().toISOString(),
        userId,
        identityKey
      ])
    }
  }
}
