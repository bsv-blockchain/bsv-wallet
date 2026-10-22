/**
 * The contacts table, carried in the backup log's appData envelope (see appData.ts), so a
 * restore brings back the people a wallet knows, not just its money and history.
 *
 * Contacts are people by identity key (core/contacts/contactsStore.ts). Every row goes,
 * removed ones too — a removal is itself something to restore — with the user's own label,
 * the star, and the cached handle and avatar (refreshed in the background anyway). Never the
 * device-local `contactId` or `userId`: on restore the rows are written for the restoring
 * wallet's own local user.
 *
 * Same limit as the rest of appData (see its module docs): the snapshot only travels on a
 * push that carries a real entity change, so an edit made with no payment after it reaches
 * the log with the next payment.
 */
import type { ContactsDb, ContactSource } from '../contacts/contactsStore'

/** One contact as the backup carries it. */
export interface BackedUpContact {
  identityKey: string
  name: string
  cachedHandle?: string
  cachedAvatarUrl?: string
  cachedCertifier?: string
  source: ContactSource
  favourite: boolean
  removedAt?: string
  createdAt: string
  updatedAt: string
}

const SOURCES: ContactSource[] = ['manual', 'qr', 'pay', 'search']

interface Row {
  identityKey: string
  name: string
  cachedHandle: string | null
  cachedAvatarUrl: string | null
  cachedCertifier: string | null
  source: string
  created_at: string
  updated_at: string
  favourite: number | null
  removedAt: string | null
}

/** Every contact of a local user, removed ones included, as JSON; undefined when there are none. */
export async function captureContacts(db: ContactsDb, userId: number): Promise<string | undefined> {
  const rows = (await db.getAllAsync(
    'SELECT identityKey, name, cachedHandle, cachedAvatarUrl, cachedCertifier, source, created_at, updated_at, favourite, removedAt FROM contacts WHERE userId = ?',
    [userId]
  )) as Row[]
  if (rows.length === 0) return undefined
  const contacts: BackedUpContact[] = rows.map(r => ({
    identityKey: r.identityKey,
    name: r.name,
    ...(r.cachedHandle ? { cachedHandle: r.cachedHandle } : {}),
    ...(r.cachedAvatarUrl ? { cachedAvatarUrl: r.cachedAvatarUrl } : {}),
    ...(r.cachedCertifier ? { cachedCertifier: r.cachedCertifier } : {}),
    source: (SOURCES as string[]).includes(r.source) ? (r.source as ContactSource) : 'manual',
    favourite: !!r.favourite,
    ...(r.removedAt ? { removedAt: r.removedAt } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
  return JSON.stringify(contacts)
}

/** The contacts in a snapshot, never throwing: anything malformed is left out. */
export function parseContacts(raw: string | undefined): BackedUpContact[] {
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (c): c is BackedUpContact =>
      c != null &&
      typeof c === 'object' &&
      typeof (c as BackedUpContact).identityKey === 'string' &&
      (c as BackedUpContact).identityKey !== '' &&
      typeof (c as BackedUpContact).name === 'string' &&
      typeof (c as BackedUpContact).updatedAt === 'string'
  )
}

/**
 * Two devices' contacts as one: everyone from both, and where both know someone, whichever
 * changed them last (a rename, a star or a removal made on one phone wins over the older
 * state on the other).
 */
export function mergeContacts(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const byKey = new Map<string, BackedUpContact>()
  for (const c of [...parseContacts(a), ...parseContacts(b)]) {
    const key = c.identityKey.toLowerCase()
    const had = byKey.get(key)
    if (!had || Date.parse(c.updatedAt) > Date.parse(had.updatedAt)) byKey.set(key, c)
  }
  return JSON.stringify([...byKey.values()])
}

/**
 * Write a snapshot's contacts for a local user. Someone not here yet is added as they were
 * (label, star, removal, dates); someone already here is updated only when the backup's copy
 * is newer, so re-running an interrupted restore never rolls an edit back.
 */
export async function applyContacts(db: ContactsDb, userId: number, raw: string | undefined): Promise<number> {
  let written = 0
  for (const c of parseContacts(raw)) {
    const had = (await db.getFirstAsync('SELECT updated_at FROM contacts WHERE userId = ? AND identityKey = ?', [
      userId,
      c.identityKey
    ])) as { updated_at: string } | null | undefined
    const values = [
      c.name,
      c.cachedHandle ?? null,
      c.cachedAvatarUrl ?? null,
      c.cachedCertifier ?? null,
      SOURCES.includes(c.source) ? c.source : 'manual',
      c.favourite ? 1 : 0,
      c.removedAt ?? null,
      c.updatedAt
    ]
    if (!had) {
      await db.runAsync(
        `INSERT INTO contacts (name, cachedHandle, cachedAvatarUrl, cachedCertifier, source, favourite, removedAt, updated_at, created_at, userId, identityKey)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, c.createdAt || c.updatedAt, userId, c.identityKey]
      )
      written++
    } else if (Date.parse(c.updatedAt) > Date.parse(had.updated_at)) {
      await db.runAsync(
        `UPDATE contacts SET name = ?, cachedHandle = ?, cachedAvatarUrl = ?, cachedCertifier = ?, source = ?, favourite = ?, removedAt = ?, updated_at = ?
         WHERE userId = ? AND identityKey = ?`,
        [...values, userId, c.identityKey]
      )
      written++
    }
  }
  return written
}
