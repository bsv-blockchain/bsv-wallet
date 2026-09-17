/**
 * Helpers for raw SQLite database images (the bytes of a `.db` file).
 */

/** "SQLite format 3\0" — the 16-byte magic at the start of every database file. */
const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]

const HEADER_WRITE_VERSION = 18
const HEADER_READ_VERSION = 19
const FORMAT_LEGACY = 1
const FORMAT_WAL = 2

function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC[i]) return false
  }
  return true
}

/**
 * Make a database image safe to hand to `deserializeDatabaseAsync`.
 *
 * The wallet database runs in WAL mode, so every export of it (an iOS byte
 * copy or an Android `serializeAsync` image) carries header bytes 18/19 = 2,
 * which tells SQLite the file is in WAL mode. `sqlite3_deserialize` loads the
 * image under the memdb VFS, which implements no shared-memory (`xShmMap`)
 * methods, so the pager's attempt to open the WAL fails with SQLITE_CANTOPEN
 * ("unable to open database file") on the first read — surfacing from
 * `backupDatabaseAsync` during import.
 *
 * The image itself is complete (the export checkpoints before copying, and
 * `serializeAsync` reads through the pager), so flipping the two version
 * bytes to rollback-journal mode (1) loses nothing. The caller's buffer is
 * not modified; a patched copy is returned only when a change is needed.
 * Non-SQLite input is returned as-is so the real validation error still
 * comes from SQLite.
 */
export function prepareSqliteImageForDeserialize(bytes: Uint8Array): Uint8Array {
  if (!hasSqliteMagic(bytes)) return bytes
  if (bytes[HEADER_WRITE_VERSION] !== FORMAT_WAL && bytes[HEADER_READ_VERSION] !== FORMAT_WAL) {
    return bytes
  }
  const out = new Uint8Array(bytes)
  if (out[HEADER_WRITE_VERSION] === FORMAT_WAL) out[HEADER_WRITE_VERSION] = FORMAT_LEGACY
  if (out[HEADER_READ_VERSION] === FORMAT_WAL) out[HEADER_READ_VERSION] = FORMAT_LEGACY
  return out
}
