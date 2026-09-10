/**
 * Vault salts across backup and database import (spec §7 "Restore").
 *
 * A vault deposit's salt and key list live in exactly one place: the output's
 * customInstructions (spec §3.5) — nothing else on the phone can reconstruct
 * them. Restore correctness therefore reduces to two independent claims:
 *
 *  1. The encrypted backup chunk codec (encodeChunk/decodeChunk,
 *     core/backup/codec.ts) round-trips that string byte-for-byte.
 *  2. A database import — a whole-file restore, see ui/importDatabases.ts —
 *     preserves it in the outputs table.
 *
 * ui/importDatabases.ts and ui/exportDatabases.ts themselves call native
 * expo-sqlite APIs (serializeAsync, deserializeDatabaseAsync,
 * backupDatabaseAsync) that jest cannot load — __tests__/__mocks__/expo-sqlite.js
 * throws on every call by design — so there is no jest-testable path through
 * those two files directly. The second test below exercises the invariant
 * they both depend on: a raw copy of the SQLite file, reopened as a brand-new
 * StorageExpoSQLite instance, must return the same customInstructions.
 *
 * NOT covered here, by design: the end-to-end device check — back up a real
 * vault, wipe the device, restore from the real backup (or import a real
 * exported .db file) on hardware, and SPEND from the recovered output with an
 * enrolled YubiKey. That needs a physical YubiKey and a second device; it is
 * a spec §0 manual checklist item, not a jest task.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import { decodeChunk, emptyChunk, encodeChunk } from '../../core/backup/codec'
import { deriveBackupWallet } from '../../core/backup/derive'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { decodeVaultInstructions, encodeVaultInstructions, type VaultInstructionsV4 } from '../../core/services/vault/r1comb'

const KEY = new PrivateKey(7).toArray('be', 32)
const NOW = '2026-09-10T00:00:00.000Z'

// encodeVaultInstructions rejects any key that is not a real P-256 point (compressPubkey
// re-derives it and compares), so the fixture keys are actual compressed pubkeys for fixed
// scalars rather than arbitrary hex — same pattern __tests__/vault/r1comb.test.ts uses.
const VAULT: VaultInstructionsV4 = {
  v: 4,
  type: 'R1C',
  salt: 'ab'.repeat(32),
  keys: [
    Utils.toHex(Array.from(p256.getPublicKey(Uint8Array.from({ length: 32 }, () => 1), true))),
    Utils.toHex(Array.from(p256.getPublicKey(Uint8Array.from({ length: 32 }, () => 2), true)))
  ]
}

/** expo-sqlite's async surface over node:sqlite's sync one — the same adapter
 * __tests__/storage/walletBalanceSql.test.ts uses to run StorageExpoSQLite
 * against the real engine under jest (no reusable helper exists to import). */
function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

describe('vault salts survive backup encode/decode', () => {
  it('decodeVaultInstructions(customInstructions) deep-equals the original after an encrypted round trip', async () => {
    const w = deriveBackupWallet(KEY, 'main')
    const base = emptyChunk('from', 'to', 'user') as unknown as Record<string, unknown>
    base.outputs = [
      {
        outputId: 1,
        userId: 1,
        transactionId: 1,
        spendable: true,
        change: false,
        vout: 0,
        satoshis: 500_000,
        providedBy: 'you',
        customInstructions: encodeVaultInstructions(VAULT)
      }
    ]
    const chunk = base as unknown as SyncChunk

    const decoded = await decodeChunk(w, await encodeChunk(w, chunk, 'main'), 'main')

    expect(decodeVaultInstructions(decoded.outputs?.[0].customInstructions)).toEqual(VAULT)
  })
})

describe('vault salts survive a database file copy and reopen (import)', () => {
  let dir = ''

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('findOutputs on a FRESH StorageExpoSQLite over a COPY of the file returns the same customInstructions', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vault-restore-'))
    const sourcePath = path.join(dir, 'wallet.db')

    // ── write one vault output, then close the source (flushes to disk) ──
    let raw = new DatabaseSync(sourcePath)
    let db = adapt(raw)
    await createTables(db as never)

    await db.runAsync('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)', [
      NOW,
      NOW,
      '02' + 'a'.repeat(62)
    ])
    await db.runAsync(
      `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
       VALUES (?, ?, ?, 'completed', ?, 0, ?, ?)`,
      [NOW, NOW, 1, 'ref-1', 500_000, 'a'.repeat(64)]
    )
    await db.runAsync(
      `INSERT INTO outputs (created_at, updated_at, userId, transactionId, spendable, change,
         vout, satoshis, providedBy, txid, lockingScript, customInstructions)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, 'you', ?, ?, ?)`,
      [NOW, NOW, 1, 1, 0, 500_000, 'b'.repeat(64), new Uint8Array(25), encodeVaultInstructions(VAULT)]
    )
    raw.close()

    // ── "import": copy the whole file, open the COPY as a NEW instance ──
    const importedPath = path.join(dir, 'wallet-imported.db')
    copyFileSync(sourcePath, importedPath)
    raw = new DatabaseSync(importedPath)
    db = adapt(raw)
    const storage = new StorageExpoSQLite({ chain: 'test' } as never)
    ;(storage as unknown as { db: unknown }).db = db

    const results = await storage.findOutputs({ partial: { userId: 1 } } as never)
    expect(results).toHaveLength(1)
    expect(decodeVaultInstructions(results[0].customInstructions)).toEqual(VAULT)

    raw.close()
  })
})
