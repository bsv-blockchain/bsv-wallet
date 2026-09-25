import { Platform } from 'react-native'
import * as SQLite from 'expo-sqlite'
import {
  type StorageExpoSQLite,
  i18n,
  parseDbFilename,
  getRegisteredDbs,
  registerDb,
  selectLatestDb,
  parseTimestampFromFilename,
  prepareSqliteImageForDeserialize,
  PENDING_KEY,
  PENDING_SUMMARY_KEY,
  createTables
} from '@bsv/expo-wallet-toolbox'
import { showAlert } from './components/ui/AlertCard'
import { showToast } from './components/ui/Toast'

/**
 * expo-file-system and expo-document-picker both ship untransformed ESM/raw-TS
 * entry points that Jest cannot parse when eagerly pulled in via the `ui`
 * package barrel, so both are required lazily here rather than imported at
 * module scope — same pattern as this package's other native-module-boundary
 * fixes (expo-router, expo-blur, ui/exportTransactions.ts's expo-file-system
 * use). expo-sqlite stays a static import: it is fully intercepted by this
 * repo's Jest `moduleNameMapper` (`^expo-sqlite$`), so the real ESM entry
 * point is never loaded under test regardless of import style.
 */
function loadExpoFileSystem(): typeof import('expo-file-system') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-file-system') as typeof import('expo-file-system')
}
function loadDocumentPicker(): typeof import('expo-document-picker') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-document-picker') as typeof import('expo-document-picker')
}

export interface ImportResult {
  imported: boolean
  filename?: string
  keySuffix?: string
  chain?: string
}

/**
 * How far a filename's embedded timestamp may sit in the future before the
 * import is refused outright. Without this, a forged timestamp is a way to
 * make an attacker-authored database permanently win `selectLatestDb` on
 * every later build (XR-079).
 */
const MAX_FUTURE_SKEW_SECONDS = 300

/**
 * A conservative ceiling on how large a picked wallet backup may be. Without
 * one, `DocumentPicker` accepts any file type at all and the import path
 * unconditionally materializes the whole thing into a JS byte array
 * (`pickedFile.bytes()`) before any format check, and `prepareSqliteImageForDeserialize`
 * can then allocate a second full-size copy on top of that for any
 * WAL-header-shaped input — so an oversized file (deliberately crafted or
 * merely a bad pick) can exhaust device memory/storage and freeze or kill the
 * app during an explicit, user-initiated import (XR-087). Comfortably above
 * any real wallet database this app would ever produce, while still bounding
 * the worst case.
 */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024 // 256 MiB

async function rejectAsUntrusted(): Promise<ImportResult> {
  await showAlert({
    title: i18n.t('import_untrusted_file'),
    message: i18n.t('import_untrusted_file_detail'),
    buttons: [{ text: i18n.t('done'), key: 'ok' }]
  })
  return { imported: false }
}

/**
 * Reject a picked file that is too large (or whose size the picker did not
 * report at all — untrusted metadata that fails closed) to safely read into
 * memory, and best-effort delete whatever `copyToCacheDirectory: true`
 * already placed in the cache for it (XR-087).
 */
async function rejectAsOversized(cacheUri: string | undefined): Promise<ImportResult> {
  if (cacheUri) {
    try {
      const { File } = loadExpoFileSystem()
      new File(cacheUri).delete()
    } catch {}
  }
  await showAlert({
    title: i18n.t('import_oversized_file'),
    message: i18n.t('import_oversized_file_detail'),
    buttons: [{ text: i18n.t('done'), key: 'ok' }]
  })
  return { imported: false }
}

/**
 * Read the (sole) settings row directly out of the deserialized source
 * image, before any of its bytes are written to disk under an authoritative
 * name. Returns `null` if the row is missing, duplicated, or unreadable —
 * any of which means the image cannot be trusted to belong to this wallet
 * (XR-079/XR-080).
 */
async function readSourceIdentity(
  sourceDb: SQLite.SQLiteDatabase
): Promise<{ storageIdentityKey: string; chain: string } | null> {
  try {
    const rows = (await sourceDb.getAllAsync('SELECT storageIdentityKey, chain FROM settings')) as Array<{
      storageIdentityKey: string
      chain: string
    }>
    if (rows.length !== 1) return null
    const { storageIdentityKey, chain } = rows[0]
    if (!storageIdentityKey || !chain) return null
    return { storageIdentityKey, chain }
  } catch {
    return null
  }
}

/**
 * Collapse insignificant whitespace so two `sqlite_master.sql` texts that
 * differ only in formatting still compare equal. SQLite already strips a
 * leading `IF NOT EXISTS` from the stored text on its own, so this is the
 * only normalization needed before an exact structural comparison.
 */
function normalizeSql(sql: string | null): string {
  if (!sql) return ''
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * Split a `CREATE TABLE`'s parenthesized body into its top-level
 * column/constraint definitions, respecting nested parens (a `CHECK (x IN
 * (...))`'s internal commas, a table-level `FOREIGN KEY (...) REFERENCES
 * t(...)`'s, etc. must never cause a false split).
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of inner) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/**
 * Extract a `CREATE TABLE ... (...)` statement's column/constraint
 * definitions as an order-independent, whitespace-normalized multiset (a
 * sorted array). Returns `null` if `sql` does not look like a single
 * parenthesized table body (e.g. no `(` at all), in which case callers must
 * fail closed rather than treat two un-parseable strings as equivalent.
 *
 * Column ORDER is deliberately not part of the comparison: SQLite's `ALTER
 * TABLE ADD COLUMN` rewrites a table's stored `sqlite_master.sql` by
 * inserting the new column just before any trailing table-level constraint
 * clause, or — when the table has none — appending it at the very end of the
 * column list. `createTables()`'s own inline definitions place some
 * migrated-in columns earlier for readability, so a genuine device that ran
 * the real, shipped additive migration (e.g. `ensureTokenSettlementColumns`)
 * ends up with the exact same set of column/constraint definitions as a
 * fresh `createTables()` run, just in a different order — not tampering, and
 * not something `isSchemaTrusted` should reject. Every individual
 * column/constraint's own text (type, NOT NULL, UNIQUE, CHECK, default,
 * FOREIGN KEY, ...) is still compared exactly, so a weakened or removed
 * constraint, a retyped or dropped column, or an added one is still caught.
 */
function extractTableDefParts(sql: string | null): string[] | null {
  if (!sql) return null
  const start = sql.indexOf('(')
  const end = sql.lastIndexOf(')')
  if (start === -1 || end === -1 || end <= start) return null
  const inner = sql.slice(start + 1, end)
  return splitTopLevel(inner)
    .map(normalizeSql)
    .filter(p => p.length > 0)
    .sort()
}

function sameParts(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((part, i) => part === b[i])
}

/**
 * Reject a picked image that carries any schema object this wallet did not
 * itself create: a trigger, a view, a virtual table, any table/index name
 * outside its own real schema, or — just as dangerous — an allow-listed
 * table/index whose own definition was weakened (e.g. a dropped UNIQUE, a
 * retyped or removed column, a redefined index). `CREATE TABLE/INDEX IF NOT
 * EXISTS` (the whole of createTables()'s migration) is a no-op once an
 * object with that name already exists, so either kind of tampering would
 * otherwise survive forever and stay live for every later write this device
 * makes — so this runs against the deserialized image BEFORE it is ever
 * copied into the real, on-disk database directory (XR-082).
 *
 * The allow-list — both the set of names AND each name's exact canonical
 * `sql` text — is built by running the wallet's own createTables() against a
 * disposable reference database, rather than a hand-maintained copy, so it
 * can never drift out of sync with the real schema.
 *
 * A `table` object's `sql` is compared column-set-wise rather than as raw
 * text (see `extractTableDefParts`), because a genuine device that ran a
 * real, shipped `ALTER TABLE ADD COLUMN` migration (e.g.
 * `ensureTokenSettlementColumns`) ends up with its migrated-in columns in a
 * different position than `createTables()`'s current inline definition, with
 * no tampering involved (XR-082 follow-up). Every other object type (index,
 * and anything else that reaches this point) is still compared as exact
 * normalized text, since those are never rewritten by an additive migration.
 */
async function isSchemaTrusted(sourceDb: SQLite.SQLiteDatabase): Promise<boolean> {
  let refDb: SQLite.SQLiteDatabase | undefined
  try {
    refDb = await SQLite.openDatabaseAsync(':memory:')
    await createTables(refDb)
    const allowedRows = (await refDb.getAllAsync(
      `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`
    )) as Array<{ type: string; name: string; sql: string | null }>
    const allowed = new Map(allowedRows.map(r => [r.name, { type: r.type, sql: r.sql }]))

    const objects = (await sourceDb.getAllAsync(
      `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`
    )) as Array<{ type: string; name: string; sql: string | null }>
    for (const obj of objects) {
      if (obj.type === 'trigger' || obj.type === 'view') return false
      if (obj.sql && /^\s*create\s+virtual\s+table/i.test(obj.sql)) return false
      const canonical = allowed.get(obj.name)
      if (canonical === undefined) return false
      if (obj.type !== canonical.type) return false
      if (obj.type === 'table') {
        if (!sameParts(extractTableDefParts(obj.sql), extractTableDefParts(canonical.sql))) return false
      } else if (normalizeSql(obj.sql) !== normalizeSql(canonical.sql)) {
        return false
      }
    }
    return true
  } catch {
    return false
  } finally {
    try {
      await refDb?.closeAsync()
    } catch {}
  }
}

/**
 * Build a destination filename guaranteed not to collide with the currently
 * active database or any already-registered one. An import must never place
 * its bytes under a name another connection could already have open, and
 * must never silently become indistinguishable from — or overwrite — a file
 * already in the registry (XR-079/XR-084).
 */
function buildUniqueTargetFilename(keySuffix: string, chain: string, baseTs: number, taken: Set<string>): string {
  let ts = baseTs
  let name = `wallet-${keySuffix}-${chain}net-${ts}.db`
  while (taken.has(name)) {
    ts += 1
    name = `wallet-${keySuffix}-${chain}net-${ts}.db`
  }
  return name
}

/**
 * Let the user pick a wallet `.db` backup file and import it alongside any
 * existing databases.  The wallet context will use whichever database has the
 * highest timestamp in its filename.
 *
 * Platform handling:
 *   - Cross-platform: reads the picked file as bytes, deserializes into an
 *     in-memory SQLite DB, opens a new file-backed DB with the target name,
 *     then uses backupDatabaseAsync to copy the data across.  This avoids
 *     filesystem permission issues on Android.
 */
export async function importWalletDatabase(storage: StorageExpoSQLite | null): Promise<ImportResult> {
  const { File } = loadExpoFileSystem()
  const DocumentPicker = loadDocumentPicker()

  // ── 1. Pick file ──────────────────────────────────────────────────────────
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true
  })

  if (result.canceled || !result.assets?.length) {
    return { imported: false }
  }

  const asset = result.assets[0]
  const pickedName = asset.name

  // ── 1.5 Enforce a size ceiling ───────────────────────────────────────────
  // Picker metadata is untrusted, but it is still the cheapest possible
  // rejection — refuse before ever constructing a File or reading a byte
  // (XR-087). A missing size is treated the same as an oversized one: fail
  // closed rather than assume a small file.
  if (asset.size == null || asset.size > MAX_IMPORT_BYTES) {
    return rejectAsOversized(asset.uri)
  }

  // ── 2. Validate filename ──────────────────────────────────────────────────
  const parsed = parseDbFilename(pickedName)
  if (!parsed) {
    await showAlert({
      title: i18n.t('import_invalid_file'),
      message: i18n.t('import_invalid_file_detail'),
      buttons: [{ text: i18n.t('done'), key: 'ok' }]
    })
    return { imported: false }
  }

  const { keySuffix, chain } = parsed

  const nowSec = Math.floor(Date.now() / 1000)
  if (parsed.timestamp > nowSec + MAX_FUTURE_SKEW_SECONDS) {
    // A filename timestamp from the future can only be forged — reject
    // before it ever gets a chance to compete in selectLatestDb (XR-079).
    return rejectAsUntrusted()
  }

  // Used only for the conflict dialog's "will this become active" messaging
  // below — the actual on-disk destination filename is always synthesized
  // fresh in step 5, never reused from the picked name (XR-079/XR-084).
  const displayTs = parsed.timestamp === 0 ? nowSec : parsed.timestamp

  // ── 3. Check for conflicts ────────────────────────────────────────────────
  const existingDbs = await getRegisteredDbs(keySuffix, chain)

  if (existingDbs.length > 0) {
    const currentBest = selectLatestDb(existingDbs)
    const currentBestTs = parseTimestampFromFilename(currentBest)

    if (currentBestTs >= displayTs) {
      // Existing DB has a higher or equal timestamp — imported file will NOT
      // become the active database.
      const choice = await showAlert({
        title: i18n.t('import_conflict_title'),
        message: i18n.t('import_conflict_message'),
        buttons: [
          { text: i18n.t('cancel'), style: 'cancel', key: 'cancel' },
          { text: i18n.t('import_anyway'), style: 'destructive', key: 'import' }
        ]
      })
      if (choice !== 'import') return { imported: false }
    } else {
      // Imported file will become the active database.
      const choice = await showAlert({
        title: i18n.t('import_confirm_title'),
        message: i18n.t('import_confirm_message'),
        buttons: [
          { text: i18n.t('cancel'), style: 'cancel', key: 'cancel' },
          { text: i18n.t('import_wallet_data'), key: 'import' }
        ]
      })
      if (choice !== 'import') return { imported: false }
    }
  }

  // ── 4. Read bytes from picked file ────────────────────────────────────────
  const pickedFile = new File(asset.uri)
  let bytes: Uint8Array
  try {
    bytes = await pickedFile.bytes()
  } catch (e: any) {
    console.error('[importDatabases] Failed to read picked file:', e.message)
    showToast(e.message, { type: 'error' })
    return { imported: false }
  }

  // Picker-reported `asset.size` is untrusted metadata — re-check the actual
  // byte count before it ever reaches WAL normalization/deserialization,
  // which can allocate a second full-size copy on top of this one (XR-087).
  if (bytes.length > MAX_IMPORT_BYTES) {
    return rejectAsOversized(asset.uri)
  }

  // ── 5. Place the database via deserialize → backup ────────────────────────
  let sourceDb: SQLite.SQLiteDatabase | undefined
  let destDb: SQLite.SQLiteDatabase | undefined
  let untrusted = false
  let targetFilename = ''
  try {
    // Deserialize the imported bytes into an in-memory database. Exports of
    // the WAL-mode wallet DB carry a WAL header, which the in-memory VFS
    // cannot open (SQLITE_CANTOPEN), so the header is rewritten to
    // rollback-journal mode first.
    sourceDb = await SQLite.deserializeDatabaseAsync(prepareSqliteImageForDeserialize(bytes))

    // Authenticate the image against the currently unlocked wallet BEFORE any
    // of it is written to disk under an authoritative name: exactly one
    // settings row, whose storageIdentityKey and chain match this wallet's
    // own. A same-suffix foreign database, a multi-identity image, or a
    // picked file with no wallet schema at all are all rejected here
    // (XR-079/XR-080). `storage` is required — with no active wallet to
    // authenticate against, the image cannot be trusted either.
    const sourceIdentity = await readSourceIdentity(sourceDb)
    const expectedIdentityKey = storage?.getSettings().storageIdentityKey
    const expectedChain = storage?.chain
    const schemaTrusted = await isSchemaTrusted(sourceDb)
    if (
      !schemaTrusted ||
      !sourceIdentity ||
      !expectedIdentityKey ||
      !expectedChain ||
      sourceIdentity.storageIdentityKey !== expectedIdentityKey ||
      sourceIdentity.chain !== expectedChain
    ) {
      untrusted = true
    } else {
      // Always synthesize a fresh destination name: never the picked name,
      // never a name already registered, never the live database's own
      // filename. This is what actually stops a same-filename import from
      // overwriting (or racing) the active database (XR-079/XR-084).
      const taken = new Set<string>(existingDbs)
      if (storage.dbName) taken.add(storage.dbName)
      targetFilename = buildUniqueTargetFilename(keySuffix, chain, displayTs, taken)

      // Open (or create) a file-backed database with the target filename.
      // This places the file in the default expo-sqlite database directory.
      destDb = await SQLite.openDatabaseAsync(targetFilename)

      // Copy all data from the in-memory source into the file-backed dest
      await SQLite.backupDatabaseAsync({
        sourceDatabase: sourceDb,
        destDatabase: destDb
      })

      // backupDatabaseAsync just copied key_value_store verbatim, including
      // any localpay_pending queue the source had — a record placed there by
      // whoever wrote that file, never re-verified by processPending before
      // it is drained into internalizeAction/onTokenHeld. Quarantine at this
      // boundary, before the copy is ever registered or read: an imported
      // backup must never be able to seed the live queue (XR-081).
      await destDb.runAsync('DELETE FROM key_value_store WHERE key IN (?, ?)', [PENDING_KEY, PENDING_SUMMARY_KEY])

      // prewarmOwnRoots (core/headers/prewarm.ts) reads proven_txs's own
      // (height, merkleRoot) pairs straight off this device's active
      // database and trusts a match against them offline, forever, with no
      // further check — so an imported file's proven_txs rows would become
      // permanently-trusted chain proof for whatever heights it names. This
      // device already re-derives every proof it needs from its own header
      // sync and recordProof (see unprovenWithoutReqSql.ts's doc comment for
      // that self-healing path), so nothing legitimate is lost by refusing to
      // carry an import's copy of this table forward (XR-083).
      await destDb.runAsync('DELETE FROM proven_txs')

      // A 'queued'/'posting' offline_actions row is a signed, possibly
      // already-handed-off spend that only the automatic post-build drain
      // (WalletContext's TaskSendOffline) is waiting to rebroadcast. Nothing
      // distinguishes a row copied in by this import from one this device
      // queued itself, so without this, an imported snapshot that predates
      // the user aborting a payment would have it posted again, unattended,
      // the next time the app is online. Downgrade to 'import_hold' — a
      // status no drain query ever selects — so it stays put until reviewed;
      // never delete or otherwise mutate the row, since it may already have
      // been broadcast (XR-085).
      await destDb.runAsync(`UPDATE offline_actions SET status = 'import_hold' WHERE status IN ('queued', 'posting')`)
    }
  } catch (e: any) {
    console.error('[importDatabases] Failed to place database:', e.message)
    showToast(e.message, { type: 'error' })
    return { imported: false }
  } finally {
    try {
      await sourceDb?.closeAsync()
    } catch {}
    try {
      await destDb?.closeAsync()
    } catch {}
  }

  if (untrusted) {
    return rejectAsUntrusted()
  }

  // ── 6. Register in the wallet DB registry ─────────────────────────────────
  await registerDb(keySuffix, chain, targetFilename)

  return { imported: true, filename: targetFilename, keySuffix, chain }
}
