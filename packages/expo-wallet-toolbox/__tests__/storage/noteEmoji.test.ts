/**
 * A nearby-payment note travels: sender types it -> localpay codec ->
 * PENDING_KEY JSON queue -> `description` on the internalized action, a TEXT
 * column. The Android report (2026-09-17) was a note containing a
 * non-BMP emoji (🪿, 🦁 — outside the BMP, so UTF-16 encodes each as a
 * surrogate pair) failing to process. These pin that every layer the note
 * actually passes through in this package — the wire codec, the KV queue's
 * JSON round-trip, and a real TEXT column via node:sqlite — carries such
 * strings byte-for-byte, so a regression in any of them shows up here first.
 */
jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual('node:sqlite')
  class TestDatabase {
    db = new DatabaseSync(':memory:')
    async execAsync(sql: string) {
      this.db.exec(sql)
    }
    async runAsync(sql: string, params: unknown[] = []) {
      const result = this.db.prepare(sql).run(...params)
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) }
    }
    async getFirstAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).get(...params) ?? null
    }
    async getAllAsync(sql: string, params: unknown[] = []) {
      return this.db.prepare(sql).all(...params)
    }
    async withExclusiveTransactionAsync(fn: (transaction: TestDatabase) => Promise<void>) {
      this.db.exec('BEGIN')
      try {
        await fn(this)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    async closeAsync() {
      this.db.close()
    }
  }
  return { openDatabaseAsync: async () => new TestDatabase() }
})
jest.mock('../../core/diskSpace', () => ({ diskPressure: () => 'ok' }))

import { PrivateKey } from '@bsv/sdk'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { encodeFrame, decodeFrame, sealFrame, unsealFrame, FRAME_VERSION, type PaymentFrame } from '../../core/localpay/codec'
import { getPending, savePending, type KVStorage } from '../../core/localpay/pending'

const NOW = new Date('2026-09-17T12:00:00Z')
const IDENTITY = new PrivateKey(7).toPublicKey().toString()
const TXID = 'cd'.repeat(32)

// A goose, a lion, a family (multi-codepoint ZWJ sequence), a flag (regional
// indicator pair) and a skin-tone modifier — non-BMP surrogate pairs plus the
// other shapes "weird emoji" tends to mean, not just one plain astral glyph.
const WEIRD_NOTES = [
  '🪿',
  '🦁',
  'lunch 🪿🦁 split',
  '👨‍👩‍👧‍👦 family dinner',
  '🇨🇦 poutine run',
  '👍🏽 thanks',
  '🪿'.repeat(50)
]

describe('nearby-payment note: non-BMP emoji survive every layer it crosses', () => {
  const sample = (note: string): PaymentFrame => ({
    version: FRAME_VERSION,
    kind: 'bsv',
    senderIdentityKey: '02'.padEnd(66, 'a'),
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction: new Uint8Array([1, 2, 3]),
    note
  })

  it.each(WEIRD_NOTES)('round-trips %p through encodeFrame/decodeFrame', note => {
    expect(decodeFrame(encodeFrame(sample(note))).note).toBe(note)
  })

  it.each(WEIRD_NOTES)('round-trips %p through the sealed frame', note => {
    const psk = new Uint8Array(32).fill(7)
    expect(unsealFrame(sealFrame(sample(note), psk), psk).note).toBe(note)
  })

  it.each(WEIRD_NOTES)('round-trips %p through the JSON-backed pending queue', async note => {
    const raw = new Map<string, string>()
    const kv: KVStorage = {
      getKeyValue: async k => raw.get(k),
      setKeyValue: async (k, v) => void raw.set(k, v)
    }
    await savePending(kv, sample(note), 'ble')
    const [back] = await getPending(kv)
    expect(back.frame.note).toBe(note)
  })

  describe('a real TEXT column (node:sqlite), the description an internalized note becomes', () => {
    let storage: StorageExpoSQLite

    beforeEach(async () => {
      storage = new StorageExpoSQLite({ chain: 'main', identityKey: IDENTITY, databaseName: 'note-emoji-test' } as never)
      await storage.migrate('test', IDENTITY)
    })

    afterEach(async () => {
      await storage.destroy()
    })

    it.each(WEIRD_NOTES)('stores and reads back %p unchanged', async note => {
      const userId = await storage.insertUser({
        created_at: NOW,
        updated_at: NOW,
        userId: 0,
        identityKey: IDENTITY
      } as never)
      await storage.insertTransaction({
        created_at: NOW,
        updated_at: NOW,
        transactionId: 0,
        userId,
        status: 'unsigned',
        isOutgoing: true,
        satoshis: 1,
        description: note,
        reference: `ref-${Buffer.from(note).toString('hex').slice(0, 8)}`,
        txid: TXID
      } as never)
      const [back] = await storage.findTransactions({ partial: { txid: TXID } } as never)
      expect(back.description).toBe(note)
      // Character length, not byte length: a mangled surrogate pair (each half
      // treated as its own code unit) changes what `.length` reports even when
      // the column happily stores whatever bytes it was given.
      expect(back.description.length).toBe(note.length)
    })
  })
})
