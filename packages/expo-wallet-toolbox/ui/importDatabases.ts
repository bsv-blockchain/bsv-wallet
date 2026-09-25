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
  PENDING_SUMMARY_KEY
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

async function rejectAsUntrusted(): Promise<ImportResult> {
  await showAlert({
    title: i18n.t('import_untrusted_file'),
    message: i18n.t('import_untrusted_file_detail'),
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
    if (
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
