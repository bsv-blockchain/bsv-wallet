import { Platform } from 'react-native'
import { type StorageExpoSQLite, parseDbFilename } from '@bsv/expo-wallet-toolbox'

/**
 * expo-file-system and expo-sharing both ship untransformed ESM/raw-TS
 * entry points that Jest cannot parse when eagerly pulled in via the `ui`
 * package barrel, so both are required lazily here rather than imported at
 * module scope — same pattern as this package's other native-module-boundary
 * fixes (expo-router, expo-blur, ui/exportTransactions.ts's expo-file-system
 * use).
 */
function loadExpoFileSystem(): typeof import('expo-file-system') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-file-system') as typeof import('expo-file-system')
}
function loadExpoSharing(): typeof import('expo-sharing') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-sharing') as typeof import('expo-sharing')
}

/**
 * Build an export filename with the current timestamp.
 *
 * Strips any existing timestamp from the source DB name and replaces it with
 * the current time (Unix seconds).  This ensures each export produces a
 * uniquely identifiable snapshot.
 *
 * Examples:
 *   wallet-a1b2c3d4-mainnet.db          → wallet-a1b2c3d4-mainnet-1741305600.db
 *   wallet-a1b2c3d4-mainnet-1700000.db  → wallet-a1b2c3d4-mainnet-1741305600.db
 */
function exportFilename(dbName: string): string {
  const parsed = parseDbFilename(dbName)
  const ts = Math.floor(Date.now() / 1000)
  if (parsed) {
    return `wallet-${parsed.keySuffix}-${parsed.chain}net-${ts}.db`
  }
  // Fallback: strip .db, append timestamp
  return dbName.replace(/\.db$/, `-${ts}.db`)
}

/**
 * Exports the currently active wallet database as a timestamped `.db` file
 * and presents the OS share dialogue so the user can save or send it.
 *
 * On iOS the file is copied from disk; on Android `serializeAsync` is used
 * to avoid filesystem permission issues with the native database directory.
 *
 * Returns the number of database files exported (0 or 1).
 */
export async function exportAllWalletDatabases(storage: StorageExpoSQLite | null): Promise<number> {
  if (Platform.OS === 'android') {
    return exportAndroid(storage)
  }

  return exportIOS(storage)
}

async function exportIOS(storage: StorageExpoSQLite | null): Promise<number> {
  if (!storage?.db?.databasePath) return 0

  const { File, Directory, Paths } = loadExpoFileSystem()
  const { shareAsync } = loadExpoSharing()

  const dbPath = storage.db.databasePath
  const sourceFile = new File(dbPath)
  if (!sourceFile.exists) return 0

  const outName = exportFilename(storage.dbName)
  const tempDir = new Directory(Paths.cache, 'bsv-wallet-export')
  if (tempDir.exists) tempDir.delete()
  tempDir.create({ intermediates: true })

  try {
    sourceFile.copy(new File(tempDir, outName))
    await shareAsync(new File(tempDir, outName).uri, {
      mimeType: 'application/octet-stream',
      dialogTitle: outName
    })
  } finally {
    try {
      tempDir.delete()
    } catch {}
  }

  return 1
}

async function exportAndroid(storage: StorageExpoSQLite | null): Promise<number> {
  if (!storage?.db) return 0

  const { File, Directory, Paths } = loadExpoFileSystem()
  const { shareAsync } = loadExpoSharing()

  const outName = exportFilename(storage.dbName)
  const tempDir = new Directory(Paths.cache, 'bsv-wallet-export')
  if (tempDir.exists) tempDir.delete()
  tempDir.create({ intermediates: true })

  try {
    // serializeAsync dumps the live database to bytes — no file-system
    // permission issues accessing the native database directory.
    const bytes = await storage.db.serializeAsync()
    const outFile = new File(tempDir, outName)
    outFile.write(bytes)

    await shareAsync(outFile.uri, {
      mimeType: 'application/octet-stream',
      dialogTitle: outName
    })
  } finally {
    try {
      tempDir.delete()
    } catch {}
  }

  return 1
}
