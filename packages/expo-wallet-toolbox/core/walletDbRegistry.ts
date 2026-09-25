/**
 * Wallet database filename registry.
 *
 * Tracks all known wallet `.db` filenames per identityKey-suffix + chain in
 * AsyncStorage so the wallet init code can pick the one with the highest
 * timestamp without needing to scan the filesystem (which is unreliable on
 * Android).
 *
 * Filename formats:
 *   Legacy  : wallet-<keySuffix>-<chain>net.db          → timestamp = 0
 *   Current : wallet-<keySuffix>-<chain>net-<unix_s>.db  → timestamp = <unix_s>
 */

// ── Filename parsing ────────────────────────────────────────────────────────

/**
 * Regex that matches both legacy and timestamped wallet DB filenames.
 *
 * Groups:
 *   1 – keySuffix  (8 hex chars from the end of the identityKey)
 *   2 – chain      (main | test | teratest)
 *   3 – timestamp  (digits, optional)
 */
const DB_FILENAME_RE = /^wallet-([a-fA-F0-9]{8})-(main|test|teratest)net(?:-(\d+))?\.db$/

export interface ParsedDbFilename {
  keySuffix: string
  chain: string // 'main' | 'test' | 'teratest'
  timestamp: number // 0 for legacy files without a timestamp segment
}

/**
 * Parse a wallet database filename into its constituent parts.
 * Returns `null` if the filename does not match the expected pattern.
 */
export function parseDbFilename(name: string): ParsedDbFilename | null {
  const m = DB_FILENAME_RE.exec(name)
  if (!m) return null
  return {
    keySuffix: m[1],
    chain: m[2],
    timestamp: m[3] ? Number(m[3]) : 0
  }
}

/**
 * Extract just the timestamp from a wallet DB filename.
 * Returns `0` for legacy (no-timestamp) filenames, or `-1` if the name is
 * not a valid wallet DB filename at all.
 */
export function parseTimestampFromFilename(name: string): number {
  const parsed = parseDbFilename(name)
  return parsed ? parsed.timestamp : -1
}

// ── Selection ───────────────────────────────────────────────────────────────

/**
 * Given an array of wallet DB filenames, return the one whose embedded
 * timestamp is the highest (i.e. the most recent database).
 *
 * If the array is empty an error is thrown.
 */
export function selectLatestDb(filenames: string[]): string {
  if (filenames.length === 0) {
    throw new Error('[walletDbRegistry] selectLatestDb called with empty list')
  }
  let best = filenames[0]
  let bestTs = parseTimestampFromFilename(best)
  for (let i = 1; i < filenames.length; i++) {
    const ts = parseTimestampFromFilename(filenames[i])
    if (ts > bestTs) {
      best = filenames[i]
      bestTs = ts
    }
  }
  return best
}

// ── AsyncStorage-backed registry ────────────────────────────────────────────

// Required lazily, on first call, rather than imported statically — this
// file is barrel-exported from the package root, and a static top-level
// `import` of a native module gets eagerly evaluated for every consumer of
// the barrel, which breaks a plain `jest` host that never touches the
// registry (no native module to resolve). Same class of issue documented on
// useHaptics.ts and services/vault/driver.ts/random.ts's lazy requires.
type AsyncStorageModule = typeof import('@react-native-async-storage/async-storage')['default']
let asyncStorage: AsyncStorageModule | undefined
function getAsyncStorage(): AsyncStorageModule {
  if (!asyncStorage) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    asyncStorage = require('@react-native-async-storage/async-storage').default as AsyncStorageModule
  }
  return asyncStorage
}

function registryKey(keySuffix: string, chain: string): string {
  return `walletDbs-${keySuffix}-${chain}net`
}

/**
 * Return all registered wallet DB filenames for the given identity + chain.
 */
export async function getRegisteredDbs(keySuffix: string, chain: string): Promise<string[]> {
  const raw = await getAsyncStorage().getItem(registryKey(keySuffix, chain))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * Append a filename to the registry (no-op if already present).
 */
export async function registerDb(keySuffix: string, chain: string, filename: string): Promise<void> {
  const existing = await getRegisteredDbs(keySuffix, chain)
  if (existing.includes(filename)) return
  existing.push(filename)
  await getAsyncStorage().setItem(registryKey(keySuffix, chain), JSON.stringify(existing))
}

/**
 * Remove a filename from the registry (no-op if not present).
 *
 * Used when a database this registry pointed at turns out to be unsafe to reuse — e.g. a
 * failed import-time restore left it only partially replayed (see XR-017) — so a later
 * `selectLatestDb` can never select it again. Removing the registry entry alone is enough
 * for that; deleting the underlying file is the caller's separate decision.
 */
export async function unregisterDb(keySuffix: string, chain: string, filename: string): Promise<void> {
  const existing = await getRegisteredDbs(keySuffix, chain)
  const next = existing.filter(f => f !== filename)
  if (next.length === existing.length) return
  await getAsyncStorage().setItem(registryKey(keySuffix, chain), JSON.stringify(next))
}

/**
 * XQ-008: "Delete Wallet" only ever closed the SQLite connection
 * (`storage.destroy()`) — it never deleted the underlying `.db` file(s) or
 * cleared this registry's entry for them, so a "deleted" wallet's complete
 * plaintext transaction/output/contact/note history stayed on disk
 * indefinitely and silently reattached with everything intact the next time
 * the same mnemonic was built on the same device.
 *
 * Deletes every filename this identity+chain's registry knows about (not
 * just `dbName`, in case an earlier build left a stale entry pointing at a
 * different file) via the host-supplied `deleteFile` — kept as a parameter
 * rather than a static `expo-sqlite` import so this stays a plain leaf module
 * a non-native host (e.g. Jest) can load without pulling in a native module,
 * same reasoning as `getAsyncStorage` above — and clears each one's registry
 * entry. `dbName` itself is always included even if the registry never
 * recorded it, so the file actually open at logout time can never be the one
 * left behind.
 *
 * Best-effort per file: one file's delete or unregister failing must not stop
 * the rest from being attempted, and a `dbName` that does not parse as a
 * wallet DB filename is treated as nothing to do rather than an error — this
 * runs during logout, after the decision to erase the wallet has already
 * been made elsewhere, and a cleanup failure here must never surface as (or
 * be mistaken for) that erasure failing.
 */
export async function purgeRegisteredDbFiles(
  dbName: string,
  deleteFile: (filename: string) => Promise<void>
): Promise<void> {
  const parsed = parseDbFilename(dbName)
  if (!parsed) return
  const { keySuffix, chain } = parsed
  const registered = await getRegisteredDbs(keySuffix, chain)
  const filenames = registered.includes(dbName) ? registered : [...registered, dbName]
  for (const filename of filenames) {
    try {
      await deleteFile(filename)
    } catch {
      // Best-effort — see doc comment above.
    }
    try {
      await unregisterDb(keySuffix, chain, filename)
    } catch {
      // Best-effort — see doc comment above.
    }
  }
}
