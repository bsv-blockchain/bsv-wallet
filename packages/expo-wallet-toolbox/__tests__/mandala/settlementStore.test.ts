/**
 * The four settlement tables and the store over them, run against REAL SQLite.
 *
 * node:sqlite gives jest the actual engine, so these tests execute the same
 * `createTables()` the app runs on device and then the same statements the
 * store issues. A CHECK constraint that drifted from the state machine, or an
 * `advanceSettlement` that stopped being a single guarded UPDATE, fails here
 * rather than on a phone holding real money.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import type { SettlementStore, TokenSettlementRow } from '../../core/mandala/types'

/** expo-sqlite's async surface over node:sqlite's sync one. */
function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

import { ensureTokenSettlementColumns } from '../../core/storage/schema/createTables'

const TIP = 'aa'.repeat(32)
const PARENT = 'bb'.repeat(32)
const KEY = '02' + 'cd'.repeat(32)

let raw: DatabaseSync
let store: SettlementStore & { settlementTxidsIn(txids: string[]): Promise<Set<string>> }

const base = (over: Partial<TokenSettlementRow> = {}) => ({
  txid: TIP,
  role: 'received' as const,
  assetId: `${'ee'.repeat(32)}.0`,
  state: 'held' as const,
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: KEY,
  ...over
})

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
  store = createSettlementStore(adapt(raw) as unknown as SettlementDb)
})

afterEach(() => raw.close())

describe('schema', () => {
  it('creates all four settlement tables', () => {
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      r => r.name
    )
    expect(names).toEqual(
      expect.arrayContaining([
        'token_settlements',
        'token_admissions',
        'token_admission_edges',
        'token_linkage_payloads'
      ])
    )
  })

  it('indexes the columns the drain and the UI actually filter on', () => {
    const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      r => r.name
    )
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_token_settlements_state',
        'idx_token_settlements_role',
        'idx_token_admission_edges_child',
        'idx_token_admission_edges_parent'
      ])
    )
  })

  it('is safe to run twice — additive migration, never a drop', async () => {
    await store.upsertSettlement(base())
    await createTables(adapt(raw) as never)
    expect(await store.getSettlement(TIP)).toBeDefined()
  })

  it('indexes `reference`, which every abortAction in the wallet is matched against', () => {
    const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
      r => r.name
    )
    expect(idx).toContain('idx_token_settlements_reference')
  })

  /**
   * `token_settlements` shipped before `reference` existed and cannot be
   * re-created over live money rows, so the column arrives by guarded ALTER —
   * and the existing rows must survive it, reading back as "unknown reference",
   * which the abort guard never blocks on.
   */
  it('adds `reference` to a table that shipped without it, keeping every row', async () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`
      CREATE TABLE token_settlements (
        txid TEXT PRIMARY KEY, role TEXT NOT NULL, assetId TEXT NOT NULL, state TEXT NOT NULL,
        counterpartyKey TEXT, amountBaseUnits INTEGER, overlayUrl TEXT NOT NULL, overlayIdentityKey TEXT NOT NULL,
        admissionOutputsJson TEXT, admissionSignatureHex TEXT, refusedCode TEXT, refusedPayloadHash TEXT,
        poisonedByTxid TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );`)
    legacy
      .prepare(
        `INSERT INTO token_settlements (txid, role, assetId, state, overlayUrl, overlayIdentityKey, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(TIP, 'sent', 'a.0', 'admitted', 'u', KEY, 'n', 'n')

    await ensureTokenSettlementColumns(adapt(legacy) as never)
    // Idempotent: a second boot must not throw "duplicate column name".
    await ensureTokenSettlementColumns(adapt(legacy) as never)

    const legacyStore = createSettlementStore(adapt(legacy) as unknown as SettlementDb)
    const row = await legacyStore.getSettlement(TIP)
    expect(row).toMatchObject({ txid: TIP, state: 'admitted' })
    expect(row?.reference).toBeUndefined()
    legacy.close()
  })

  it('refuses a state the machine does not define', () => {
    expect(() =>
      raw
        .prepare(
          `INSERT INTO token_settlements (txid, role, assetId, state, overlayUrl, overlayIdentityKey,
             createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(TIP, 'received', 'a.0', 'settled', 'u', KEY, 'n', 'n')
    ).toThrow()
  })
})

describe('token_settlements', () => {
  it('round-trips a row, JSON columns included', async () => {
    await store.upsertSettlement(
      base({ counterpartyKey: KEY, amountBaseUnits: 1234, admissionOutputs: [0, 2], admissionSignatureHex: '3045' })
    )
    const row = await store.getSettlement(TIP)
    expect(row).toMatchObject({
      txid: TIP,
      role: 'received',
      state: 'held',
      counterpartyKey: KEY,
      amountBaseUnits: 1234,
      admissionOutputs: [0, 2],
      admissionSignatureHex: '3045'
    })
    expect(row?.createdAt).toEqual(expect.any(String))
  })

  it('returns undefined for a txid it has never seen', async () => {
    expect(await store.getSettlement(PARENT)).toBeUndefined()
  })

  // The drain re-derives evidence on EVERY pass (FIX G). If upsert reset the
  // state column, each pass would drag an `admitted` row back to `held` and
  // re-submit forever.
  it('never rewinds state on a re-upsert — state belongs to advanceSettlement alone', async () => {
    await store.upsertSettlement(base({ state: 'held' }))
    await store.advanceSettlement(TIP, ['held'], 'admitted')
    await store.upsertSettlement(base({ state: 'held', amountBaseUnits: 99 }))

    const row = await store.getSettlement(TIP)
    expect(row?.state).toBe('admitted')
    expect(row?.amountBaseUnits).toBe(99)
  })

  it('lists by state and by role', async () => {
    await store.upsertSettlement(base({ txid: TIP, state: 'held', role: 'received' }))
    await store.upsertSettlement(base({ txid: PARENT, state: 'broadcast', role: 'sent' }))

    expect((await store.listSettlements({ state: ['held'] })).map(r => r.txid)).toEqual([TIP])
    expect((await store.listSettlements({ role: 'sent' })).map(r => r.txid)).toEqual([PARENT])
    expect(await store.listSettlements()).toHaveLength(2)
  })

  it('answers which of a batch of txids are token settlements', async () => {
    await store.upsertSettlement(base({ txid: TIP }))
    expect([...(await store.settlementTxidsIn([TIP, PARENT]))]).toEqual([TIP])
    expect(await store.settlementTxidsIn([])).toEqual(new Set())
  })
})

describe('advanceSettlement', () => {
  beforeEach(() => store.upsertSettlement(base({ state: 'held' })))

  it('advances from an allowed state and reports that it did', async () => {
    expect(await store.advanceSettlement(TIP, ['handed_over', 'held'], 'submitting')).toBe(true)
    expect((await store.getSettlement(TIP))?.state).toBe('submitting')
  })

  it('refuses — and writes nothing — when the row is not in one of `from`', async () => {
    const before = await store.getSettlement(TIP)
    expect(await store.advanceSettlement(TIP, ['submitting'], 'broadcast')).toBe(false)
    expect(await store.getSettlement(TIP)).toEqual(before)
  })

  it('reports false rather than inserting for a txid with no row', async () => {
    expect(await store.advanceSettlement(PARENT, ['held'], 'submitting')).toBe(false)
    expect(await store.getSettlement(PARENT)).toBeUndefined()
  })

  it('carries a patch through in the same statement', async () => {
    await store.advanceSettlement(TIP, ['held'], 'admitted', {
      admissionOutputs: [0, 1],
      admissionSignatureHex: '30440220'
    })
    expect(await store.getSettlement(TIP)).toMatchObject({
      state: 'admitted',
      admissionOutputs: [0, 1],
      admissionSignatureHex: '30440220'
    })
  })

  it('records a refusal code and a poisoning ancestor', async () => {
    await store.advanceSettlement(TIP, ['held'], 'refused', { refusedCode: 'ERR_CONSERVATION' })
    expect((await store.getSettlement(TIP))?.refusedCode).toBe('ERR_CONSERVATION')
    await store.upsertSettlement(base({ txid: PARENT, state: 'held' }))
    await store.advanceSettlement(PARENT, ['held'], 'orphaned', { poisonedByTxid: TIP })
    expect((await store.getSettlement(PARENT))?.poisonedByTxid).toBe(TIP)
  })

  it('moves updatedAt without touching createdAt', async () => {
    const before = await store.getSettlement(TIP)
    await new Promise(r => setTimeout(r, 2))
    await store.advanceSettlement(TIP, ['held'], 'submitting')
    const after = await store.getSettlement(TIP)
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before!.updatedAt))
  })
})

describe('token_admissions', () => {
  const admission = {
    txid: PARENT,
    outputsToAdmit: [0, 2],
    signatureHex: '3045aa',
    signerKey: KEY,
    source: 'bundle' as const,
    obtainedAt: '2026-09-01T00:00:00.000Z'
  }

  it('round-trips an entry', async () => {
    await store.putAdmission(admission)
    expect(await store.getAdmission(PARENT)).toEqual(admission)
  })

  // A counterparty bundle must never overwrite what this device proved itself.
  it('lets first-hand evidence replace a cached bundle, never the reverse', async () => {
    await store.putAdmission(admission)
    await store.putAdmission({ ...admission, outputsToAdmit: [9], signatureHex: 'forged', source: 'bundle' })
    expect(await store.getAdmission(PARENT)).toEqual(admission)

    await store.putAdmission({ ...admission, outputsToAdmit: [1], signatureHex: 'real', source: 'submitted' })
    expect(await store.getAdmission(PARENT)).toMatchObject({
      outputsToAdmit: [1],
      signatureHex: 'real',
      source: 'submitted'
    })
  })
})

describe('token_admission_edges', () => {
  it('inserts idempotently and reads parents back', async () => {
    const edges = [
      { childTxid: TIP, parentTxid: PARENT, parentVout: 0 },
      { childTxid: TIP, parentTxid: PARENT, parentVout: 1 }
    ]
    await store.putEdges(edges)
    await store.putEdges(edges)
    expect(await store.parentsOf(TIP)).toEqual(edges)
    expect(await store.parentsOf(PARENT)).toEqual([])
  })

  it('accepts an empty batch', async () => {
    await expect(store.putEdges([])).resolves.toBeUndefined()
  })
})

describe('token_linkage_payloads', () => {
  it('round-trips payload bytes as a blob', async () => {
    const row = {
      txid: PARENT,
      payloadBytes: new Uint8Array([1, 2, 250]),
      overlayUrl: 'https://overlay.example',
      overlayIdentityKey: KEY,
      source: 'forwarded' as const,
      createdAt: '2026-09-01T00:00:00.000Z'
    }
    await store.putLinkage(row)
    const back = await store.getLinkage(PARENT)
    expect(back?.payloadBytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(back!.payloadBytes)).toEqual([1, 2, 250])
    expect(back).toMatchObject({ overlayUrl: row.overlayUrl, source: 'forwarded' })
  })

  it('is INSERT OR IGNORE — a second forward never rewrites the first payload', async () => {
    const row = {
      txid: PARENT,
      payloadBytes: new Uint8Array([1]),
      overlayUrl: 'u',
      overlayIdentityKey: KEY,
      source: 'forwarded' as const,
      createdAt: 'a'
    }
    await store.putLinkage(row)
    await store.putLinkage({ ...row, payloadBytes: new Uint8Array([9, 9]) })
    expect(Array.from((await store.getLinkage(PARENT))!.payloadBytes)).toEqual([1])
  })
})
