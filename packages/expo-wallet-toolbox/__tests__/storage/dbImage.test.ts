/**
 * Import Wallet Data deserializes the picked `.db` bytes into an in-memory
 * SQLite database (`deserializeDatabaseAsync`) and backs it up into a
 * file-backed one. The wallet runs in WAL mode (StorageExpoSQLite sets
 * `PRAGMA journal_mode = WAL`), so every export — a byte copy on iOS, a
 * `serializeAsync` image on Android — carries header bytes 18/19 = 2 (WAL).
 * SQLite's memdb VFS has no `xShmMap`, so the pager's WAL open fails with
 * SQLITE_CANTOPEN "unable to open database file" (observed 2026-09-17 on
 * iOS importing a file exported moments earlier). The fix rewrites the header
 * to rollback-journal mode (1/1) before deserializing; this pins that
 * against a real WAL image produced by node:sqlite.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSqliteImageForDeserialize } from '../../core/storage/dbImage'

function buildImage(journalMode: 'WAL' | 'DELETE'): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'dbimage-'))
  const path = join(dir, 'wallet.db')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode = ${journalMode}`)
  db.exec('CREATE TABLE t (x INTEGER)')
  db.exec('INSERT INTO t VALUES (42)')
  if (journalMode === 'WAL') db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  const bytes = new Uint8Array(readFileSync(path))
  rmSync(dir, { recursive: true, force: true })
  return bytes
}

describe('prepareSqliteImageForDeserialize', () => {
  it('rewrites a WAL-mode header to rollback-journal mode', () => {
    const wal = buildImage('WAL')
    expect([wal[18], wal[19]]).toEqual([2, 2])

    const prepared = prepareSqliteImageForDeserialize(wal)
    expect([prepared[18], prepared[19]]).toEqual([1, 1])
    // Everything else is byte-identical.
    expect(prepared.length).toBe(wal.length)
    expect(prepared.subarray(0, 18)).toEqual(wal.subarray(0, 18))
    expect(prepared.subarray(20)).toEqual(wal.subarray(20))
  })

  it('does not mutate the caller’s buffer', () => {
    const wal = buildImage('WAL')
    prepareSqliteImageForDeserialize(wal)
    expect([wal[18], wal[19]]).toEqual([2, 2])
  })

  it('returns a rollback-journal image unchanged', () => {
    const plain = buildImage('DELETE')
    expect([plain[18], plain[19]]).toEqual([1, 1])
    expect(prepareSqliteImageForDeserialize(plain)).toEqual(plain)
  })

  it('leaves non-SQLite bytes alone', () => {
    const junk = new Uint8Array(100).fill(2)
    expect(prepareSqliteImageForDeserialize(junk)).toEqual(junk)
  })
})
