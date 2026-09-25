/**
 * Vault salts across backup and database import (spec §7 "Restore").
 *
 * A current vault output's salt is retained by its exact v6 customInstructions;
 * the unspent locking script contains only salted table commitments. The same
 * record carries the vault id, revision, and full public key records used to
 * rebuild local state and the exact expected lock.
 * The transfer layer accepts those records only after byte-for-byte lock
 * reconstruction. Restore correctness therefore includes two storage claims:
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
import { CompletedProtoWallet, PrivateKey, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { decodeChunk, emptyChunk, encodeChunk } from '../../core/backup/codec'
import { deriveBackupWallet } from '../../core/backup/derive'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import {
  buildLock,
  commitment,
  decodeVaultInstructions,
  decodeVaultInstructionsV7,
  encodeVaultInstructions,
  encodeVaultInstructionsV7,
  vaultSaltHmacData,
  type VaultInstructionsV6,
  type VaultInstructionsV7
} from '../../core/services/vault/r1comb'
import type { SyncChunk } from '../../core/toolboxTypes'

const KEY = new PrivateKey(7).toArray('be', 32)
const NOW = '2026-09-10T00:00:00.000Z'

// encodeVaultInstructions rejects any key that is not a real P-256 point (compressPubkey
// re-derives it and compares), so the fixture keys are actual compressed pubkeys for fixed
// scalars rather than arbitrary hex — same pattern __tests__/vault/r1comb.test.ts uses.
const PUBKEYS = [
  Utils.toHex(Array.from(p256.getPublicKey(Uint8Array.from({ length: 32 }, () => 1), true))),
  Utils.toHex(Array.from(p256.getPublicKey(Uint8Array.from({ length: 32 }, () => 2), true)))
]

const VAULT_ID = 'cd'.repeat(32)
const VAULT: VaultInstructionsV6 = {
  v: 6,
  type: 'R1C',
  salt: 'ef'.repeat(32),
  saltKeyId: '1',
  chain: 'main',
  vaultId: VAULT_ID,
  revision: 1,
  createdAt: Date.parse(NOW),
  keys: [
    { serial: '10000001', slot: 0x82, pubkey: PUBKEYS[0], nickname: 'Primary', enrolledAt: Date.parse(NOW) },
    { serial: '10000002', slot: 0x82, pubkey: PUBKEYS[1], nickname: 'Backup', enrolledAt: Date.parse(NOW) }
  ]
}

// The exact same enrollment, as a v7 record — the only difference from VAULT
// is that `salt` does not exist here at all (INT-10's structural claim).
const VAULT_V7: VaultInstructionsV7 = {
  v: 7,
  type: 'R1C',
  saltKeyId: '1',
  chain: 'main',
  vaultId: VAULT_ID,
  revision: 1,
  createdAt: Date.parse(NOW),
  keys: VAULT.keys
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
    const storage = new StorageExpoSQLite({ chain: 'main' } as never)
    ;(storage as unknown as { db: unknown }).db = db

    const results = await storage.findOutputs({ partial: { userId: 1 } } as never)
    expect(results).toHaveLength(1)
    expect(decodeVaultInstructions(results[0].customInstructions)).toEqual(VAULT)

    raw.close()
  })
})

/**
 * INT-10, v7 half: a v7 record carries no `salt` field at any hop — the
 * v6 cases above are untouched (that invariant, "the customInstructions
 * round-trip byte-for-byte," stays exactly as tested; what changes for v7 is
 * that there is no salt in the record to round-trip at all). And the literal
 * text of I2: a device holding the DB rows (v7 customInstructions), the
 * backup ciphertext, a committed YubiKey and its correct PIN, but NOT the
 * live mnemonic-derived root, cannot compute the salt HMAC or decrypt the
 * descriptor — there is nothing left to steal from storage, so recovery
 * without the mnemonic fails closed structurally, not just by policy.
 */
describe('vault v7 records carry no salt at rest (INT-10)', () => {
  it('decodeVaultInstructions(customInstructions) deep-equals the original v7 record after an encrypted round trip, with no salt field at any hop', async () => {
    const w = deriveBackupWallet(KEY, 'main')
    const base = emptyChunk('from', 'to', 'user') as unknown as Record<string, unknown>
    const encoded = encodeVaultInstructionsV7(VAULT_V7)
    expect(JSON.parse(encoded)).not.toHaveProperty('salt')
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
        customInstructions: encoded
      }
    ]
    const chunk = base as unknown as SyncChunk

    const encryptedChunk = await encodeChunk(w, chunk, 'main')
    // The salt-free plaintext never appears in the encrypted bytes either —
    // there is no salt substring to search for, unlike v6 where the salt
    // exists but is merely not exposed in the ciphertext by construction.
    const decoded = await decodeChunk(w, encryptedChunk, 'main')

    expect(decodeVaultInstructionsV7(decoded.outputs?.[0].customInstructions)).toEqual(VAULT_V7)
    expect(decoded.outputs?.[0].customInstructions).not.toMatch(/"salt"\s*:/)
  })

  it('findOutputs on a FRESH StorageExpoSQLite over a COPY of the file returns the same v7 customInstructions, still with no salt field', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vault-restore-v7-'))
    try {
      const sourcePath = path.join(dir, 'wallet.db')
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
        [NOW, NOW, 1, 1, 0, 500_000, 'b'.repeat(64), new Uint8Array(25), encodeVaultInstructionsV7(VAULT_V7)]
      )
      raw.close()

      const importedPath = path.join(dir, 'wallet-imported.db')
      copyFileSync(sourcePath, importedPath)
      raw = new DatabaseSync(importedPath)
      db = adapt(raw)
      const storage = new StorageExpoSQLite({ chain: 'main' } as never)
      ;(storage as unknown as { db: unknown }).db = db

      const results = await storage.findOutputs({ partial: { userId: 1 } } as never)
      expect(results).toHaveLength(1)
      expect(decodeVaultInstructionsV7(results[0].customInstructions)).toEqual(VAULT_V7)
      expect(results[0].customInstructions).not.toMatch(/"salt"\s*:/)

      raw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a wallet with the DB rows, the backup ciphertext, a committed key and the correct PIN, but a DIFFERENT root, cannot derive the salt or decrypt the descriptor', async () => {
    const serials = VAULT_V7.keys.map(k => k.serial)
    const chain = 'main'
    const keyId = `${chain}:${VAULT_V7.saltKeyId}`

    // The REAL wallet (correct mnemonic-derived root): reproduces the salt
    // that rebuilds the already-published lock, and can decrypt its own
    // descriptor ciphertext.
    const realWallet = new CompletedProtoWallet(new PrivateKey(KEY))
    const { hmac: realSalt } = await realWallet.createHmac({
      protocolID: [2, 'vault salt'],
      keyID: VAULT_V7.saltKeyId,
      counterparty: 'self',
      data: vaultSaltHmacData(serials)
    })
    const realSaltHex = Utils.toHex(realSalt)
    const expectedLock = buildLock({
      commitments: VAULT_V7.keys.map(k => commitment(k.pubkey, realSaltHex)),
      saltHex64: realSaltHex
    })
    const descriptorPlaintext = encodeVaultInstructionsV7(VAULT_V7)
    const { ciphertext } = await realWallet.encrypt({
      plaintext: Utils.toArray(descriptorPlaintext, 'utf8'),
      protocolID: [2, 'vault descriptor'],
      keyID: keyId,
      counterparty: 'self'
    })

    // A STOLEN DB (v7 customInstructions — no salt), a stolen backup blob, a
    // committed YubiKey and a correct PIN, but a DIFFERENT root key (no live
    // mnemonic session for THIS wallet) — exactly I2's threat model.
    const differentRootWallet = new CompletedProtoWallet(new PrivateKey(99))
    const { hmac: wrongSalt } = await differentRootWallet.createHmac({
      protocolID: [2, 'vault salt'],
      keyID: VAULT_V7.saltKeyId,
      counterparty: 'self',
      data: vaultSaltHmacData(serials)
    })
    const wrongSaltHex = Utils.toHex(wrongSalt)
    expect(wrongSaltHex).not.toBe(realSaltHex)
    // The wrong salt cannot rebuild the real, already-published lock.
    const wrongLock = buildLock({
      commitments: VAULT_V7.keys.map(k => commitment(k.pubkey, wrongSaltHex)),
      saltHex64: wrongSaltHex
    })
    expect(wrongLock.toHex()).not.toBe(expectedLock.toHex())
    // The wrong root cannot decrypt the real descriptor ciphertext either —
    // BRC-2 AES-256-GCM authentication fails closed rather than returning
    // garbage plaintext.
    await expect(differentRootWallet.decrypt({
      ciphertext,
      protocolID: [2, 'vault descriptor'],
      keyID: keyId,
      counterparty: 'self'
    })).rejects.toThrow()
  })
})
