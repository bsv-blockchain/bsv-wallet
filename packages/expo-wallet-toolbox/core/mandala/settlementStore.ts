/**
 * `SettlementStore` over the toolbox's own SQLite connection.
 *
 * Deliberately logic-free, in the same spirit as `storage/methods/offlineActions.ts`:
 * every decision about WHEN a row may move lives in `mandala/drain.ts`, which is
 * unit-tested against a real in-memory SQLite. What is here is statements.
 *
 * Two rules the SQL itself enforces, because a convention would not survive a
 * crash or a second drain tick:
 *
 *  1. **`state` belongs to `advanceSettlement` alone.** `upsertSettlement` is
 *     the re-derivation path (FIX G — the drain re-runs it on every pass from
 *     the durable frame bytes), so if it wrote `state` it would drag an
 *     `admitted` row back to `held` every tick and re-submit forever. It
 *     therefore sets `state` only on the INSERT, and on conflict updates the
 *     descriptive columns alone.
 *  2. **`advanceSettlement` is one guarded UPDATE.** `... WHERE txid = ? AND
 *     state IN (...)` plus a changes-count check is a compare-and-swap: two
 *     interleaved drains cannot both believe they claimed the same row, and a
 *     row someone else already moved to a terminal state is never resurrected.
 *     There is no read-then-write anywhere in this file for that reason.
 *
 * Access pattern matches `StorageExpoSQLite`'s own use of `offline_actions`:
 * the caller hands in `storage.sqliteDb` and this module only ever issues
 * parameterised statements against it.
 */
import type {
  SettlementStore,
  TokenAdmissionEdge,
  TokenAdmissionRow,
  TokenLinkageRow,
  TokenSettlementRole,
  TokenSettlementRow,
  TokenSettlementState
} from './types'

/** Everything these statements bind. BLOB columns are why `Uint8Array` is here. */
export type SettlementBindValue = string | number | null | Uint8Array

/**
 * Structurally satisfied by expo-sqlite's `SQLiteDatabase` and by the
 * `node:sqlite` adapter the tests use. `runAsync` is narrowed to its result's
 * `changes` because `advanceSettlement`'s whole contract depends on it.
 */
export interface SettlementDb {
  runAsync(sql: string, params: SettlementBindValue[]): Promise<{ changes: number }>
  getAllAsync(sql: string, params: SettlementBindValue[]): Promise<unknown[]>
  getFirstAsync(sql: string, params: SettlementBindValue[]): Promise<unknown>
}

/** The store, plus the one batch question the storage guard needs to ask. */
export interface SqlSettlementStore extends SettlementStore {
  /**
   * Which of `txids` have a `token_settlements` row. One statement, because the
   * caller (`attemptToPostReqsToNetwork`'s token guard) asks this on the hot
   * path of every broadcast.
   */
  settlementTxidsIn(txids: string[]): Promise<Set<string>>
}

interface SettlementDbRow {
  txid: string
  role: string
  assetId: string
  state: string
  counterpartyKey: string | null
  amountBaseUnits: number | null
  overlayUrl: string
  overlayIdentityKey: string
  admissionOutputsJson: string | null
  admissionSignatureHex: string | null
  refusedCode: string | null
  refusedPayloadHash: string | null
  poisonedByTxid: string | null
  reference: string | null
  createdAt: string
  updatedAt: string
}

/** A JSON array column that will not throw the caller's drain pass for one bad row. */
function readNumberArray(json: string | null): number[] | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parsed.filter((n): n is number => typeof n === 'number')
  } catch {
    return undefined
  }
}

function toSettlement(row: SettlementDbRow): TokenSettlementRow {
  return {
    txid: row.txid,
    role: row.role as TokenSettlementRole,
    assetId: row.assetId,
    state: row.state as TokenSettlementState,
    counterpartyKey: row.counterpartyKey ?? undefined,
    amountBaseUnits: row.amountBaseUnits ?? undefined,
    overlayUrl: row.overlayUrl,
    overlayIdentityKey: row.overlayIdentityKey,
    admissionOutputs: readNumberArray(row.admissionOutputsJson),
    admissionSignatureHex: row.admissionSignatureHex ?? undefined,
    refusedCode: row.refusedCode ?? undefined,
    refusedPayloadHash: row.refusedPayloadHash ?? undefined,
    poisonedByTxid: row.poisonedByTxid ?? undefined,
    reference: row.reference ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/**
 * `payloadBytes` comes back from expo-sqlite as a `Uint8Array` and from
 * `node:sqlite` the same way, but a driver that hands back an ArrayBuffer or a
 * number[] must not silently become an empty payload — these bytes are the only
 * thing that lets a downstream device submit this txid at all.
 *
 * A TEXT value is the 2026-09-16 incident's residue: `putLinkage` was handed a
 * JSON-rehydrated payload (an index-keyed object, not a `Uint8Array`), and
 * expo-sqlite's Android binding stringified it as a java `Map` — `{0=1.0,
 * 2=250.0, 1=2.0}`, hash-ordered, Double-valued. Rows like that are on devices
 * and `INSERT OR IGNORE` would have kept them forever, so they are read back
 * into the bytes they always meant. Anything else that is not bytes still
 * throws, never becomes an empty payload.
 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return new Uint8Array(value as number[])
  if (typeof value === 'string') {
    const recovered = bytesFromJavaMapString(value)
    if (recovered) return recovered
  }
  throw new Error('token_linkage_payloads.payloadBytes is not readable as bytes')
}

function bytesFromJavaMapString(text: string): Uint8Array | undefined {
  const braced = /^\{(.*)\}$/s.exec(text.trim())
  if (!braced) return undefined
  const body = braced[1].trim()
  if (body === '') return new Uint8Array(0)
  const pairs = body.split(',')
  const out = new Uint8Array(pairs.length)
  const seen = new Set<number>()
  for (const pair of pairs) {
    const kv = /^\s*(\d+)=(\d+)(?:\.0+)?\s*$/.exec(pair)
    if (!kv) return undefined
    const index = Number(kv[1])
    const byte = Number(kv[2])
    if (index >= out.length || seen.has(index) || byte > 255) return undefined
    seen.add(index)
    out[index] = byte
  }
  return out
}

/** Columns `advanceSettlement` and `upsertSettlement` may write, and their SQL names. */
const PATCHABLE: { key: keyof TokenSettlementRow; column: string }[] = [
  { key: 'counterpartyKey', column: 'counterpartyKey' },
  { key: 'amountBaseUnits', column: 'amountBaseUnits' },
  { key: 'admissionOutputs', column: 'admissionOutputsJson' },
  { key: 'admissionSignatureHex', column: 'admissionSignatureHex' },
  { key: 'refusedCode', column: 'refusedCode' },
  { key: 'refusedPayloadHash', column: 'refusedPayloadHash' },
  { key: 'poisonedByTxid', column: 'poisonedByTxid' },
  { key: 'reference', column: 'reference' }
]

function patchValue(key: keyof TokenSettlementRow, value: unknown): SettlementBindValue {
  if (value === undefined || value === null) return null
  if (key === 'admissionOutputs') return JSON.stringify(value)
  return value as SettlementBindValue
}

export function createSettlementStore(db: SettlementDb): SqlSettlementStore {
  return {
    async getSettlement(txid: string): Promise<TokenSettlementRow | undefined> {
      const row = (await db.getFirstAsync('SELECT * FROM token_settlements WHERE txid = ?', [
        txid
      ])) as SettlementDbRow | null
      return row ? toSettlement(row) : undefined
    },

    /**
     * One indexed lookup (`idx_token_settlements_reference`), because this is
     * asked before EVERY `abortAction` the wallet makes — the overwhelming
     * majority of which are plain BSV actions with no row here at all. An empty
     * or absent reference can never match a row and is refused a query.
     */
    async getSettlementByReference(reference: string): Promise<TokenSettlementRow | undefined> {
      if (!reference) return undefined
      const row = (await db.getFirstAsync('SELECT * FROM token_settlements WHERE reference = ?', [
        reference
      ])) as SettlementDbRow | null
      return row ? toSettlement(row) : undefined
    },

    async listSettlements(filter = {}): Promise<TokenSettlementRow[]> {
      const where: string[] = []
      const params: SettlementBindValue[] = []
      if (filter.state && filter.state.length > 0) {
        where.push(`state IN (${filter.state.map(() => '?').join(',')})`)
        params.push(...filter.state)
      }
      if (filter.role !== undefined) {
        where.push('role = ?')
        params.push(filter.role)
      }
      const sql =
        'SELECT * FROM token_settlements' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY createdAt ASC, txid ASC'
      return ((await db.getAllAsync(sql, params)) as SettlementDbRow[]).map(toSettlement)
    },

    /**
     * Insert the row, or refresh only what a re-derivation can legitimately
     * know. `state`, `role` and the two terminal-verdict columns are never
     * touched on conflict — see rule 1 at the top of this file.
     */
    async upsertSettlement(row): Promise<void> {
      const now = new Date().toISOString()
      const createdAt = row.createdAt ?? now
      await db.runAsync(
        `INSERT INTO token_settlements
           (txid, role, assetId, state, counterpartyKey, amountBaseUnits, overlayUrl, overlayIdentityKey,
            admissionOutputsJson, admissionSignatureHex, refusedCode, refusedPayloadHash, poisonedByTxid,
            reference, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(txid) DO UPDATE SET
           assetId = excluded.assetId,
           counterpartyKey = COALESCE(excluded.counterpartyKey, token_settlements.counterpartyKey),
           amountBaseUnits = COALESCE(excluded.amountBaseUnits, token_settlements.amountBaseUnits),
           overlayUrl = excluded.overlayUrl,
           overlayIdentityKey = excluded.overlayIdentityKey,
           admissionOutputsJson = COALESCE(excluded.admissionOutputsJson, token_settlements.admissionOutputsJson),
           admissionSignatureHex = COALESCE(excluded.admissionSignatureHex, token_settlements.admissionSignatureHex),
           reference = COALESCE(excluded.reference, token_settlements.reference),
           updatedAt = excluded.updatedAt`,
        [
          row.txid,
          row.role,
          row.assetId,
          row.state,
          row.counterpartyKey ?? null,
          row.amountBaseUnits ?? null,
          row.overlayUrl,
          row.overlayIdentityKey,
          row.admissionOutputs ? JSON.stringify(row.admissionOutputs) : null,
          row.admissionSignatureHex ?? null,
          row.refusedCode ?? null,
          row.refusedPayloadHash ?? null,
          row.poisonedByTxid ?? null,
          row.reference ?? null,
          createdAt,
          now
        ]
      )
    },

    /**
     * One statement, compare-and-swap on `state`. False means the row was not
     * in one of `from` — either someone else moved it, or it does not exist —
     * and NOTHING was written, so a caller may treat false as "not mine to
     * advance" without a compensating read.
     */
    async advanceSettlement(
      txid: string,
      from: TokenSettlementState[],
      to: TokenSettlementState,
      patch: Partial<TokenSettlementRow> = {}
    ): Promise<boolean> {
      const sets = ['state = ?', 'updatedAt = ?']
      const params: SettlementBindValue[] = [to, new Date().toISOString()]
      for (const { key, column } of PATCHABLE) {
        if (patch[key] === undefined) continue
        sets.push(`${column} = ?`)
        params.push(patchValue(key, patch[key]))
      }
      params.push(txid, ...from)
      const placeholders = from.length > 0 ? from.map(() => '?').join(',') : `''`
      const result = await db.runAsync(
        `UPDATE token_settlements SET ${sets.join(', ')} WHERE txid = ? AND state IN (${placeholders})`,
        params
      )
      return (result?.changes ?? 0) > 0
    },

    async settlementTxidsIn(txids: string[]): Promise<Set<string>> {
      if (txids.length === 0) return new Set()
      const rows = (await db.getAllAsync(
        `SELECT txid FROM token_settlements WHERE txid IN (${txids.map(() => '?').join(',')})`,
        txids
      )) as { txid: string }[]
      return new Set(rows.map(r => r.txid))
    },

    async getAdmission(txid: string): Promise<TokenAdmissionRow | undefined> {
      const row = (await db.getFirstAsync('SELECT * FROM token_admissions WHERE txid = ?', [txid])) as {
        txid: string
        outputsToAdmitJson: string
        signatureHex: string
        signerKey: string
        source: TokenAdmissionRow['source']
        obtainedAt: string
      } | null
      if (!row) return undefined
      return {
        txid: row.txid,
        outputsToAdmit: readNumberArray(row.outputsToAdmitJson) ?? [],
        signatureHex: row.signatureHex,
        signerKey: row.signerKey,
        source: row.source,
        obtainedAt: row.obtainedAt
      }
    },

    /**
     * Idempotent, and asymmetric on purpose: first-hand evidence (this device
     * submitted, or fetched `GET /admin/admission/:txid` itself) replaces a
     * cached bundle entry, but a counterparty-supplied bundle NEVER overwrites
     * anything already on record. For a `bundle`/`minted` source against an
     * existing row the `WHERE` makes this exactly an `INSERT OR IGNORE`, which
     * is what the FIX G re-derivation pass needs.
     */
    async putAdmission(row: TokenAdmissionRow): Promise<void> {
      await db.runAsync(
        `INSERT INTO token_admissions (txid, outputsToAdmitJson, signatureHex, signerKey, source, obtainedAt)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(txid) DO UPDATE SET
           outputsToAdmitJson = excluded.outputsToAdmitJson,
           signatureHex = excluded.signatureHex,
           signerKey = excluded.signerKey,
           source = excluded.source,
           obtainedAt = excluded.obtainedAt
         WHERE excluded.source IN ('submitted','fetched')`,
        [row.txid, JSON.stringify(row.outputsToAdmit), row.signatureHex, row.signerKey, row.source, row.obtainedAt]
      )
    },

    async putEdges(edges: TokenAdmissionEdge[]): Promise<void> {
      for (const e of edges) {
        await db.runAsync(
          'INSERT OR IGNORE INTO token_admission_edges (childTxid, parentTxid, parentVout) VALUES (?,?,?)',
          [e.childTxid, e.parentTxid, e.parentVout]
        )
      }
    },

    async parentsOf(childTxid: string): Promise<TokenAdmissionEdge[]> {
      const rows = (await db.getAllAsync(
        `SELECT childTxid, parentTxid, parentVout FROM token_admission_edges
          WHERE childTxid = ? ORDER BY parentTxid ASC, parentVout ASC`,
        [childTxid]
      )) as TokenAdmissionEdge[]
      return rows.map(r => ({ childTxid: r.childTxid, parentTxid: r.parentTxid, parentVout: r.parentVout }))
    },

    async getLinkage(txid: string): Promise<TokenLinkageRow | undefined> {
      const row = (await db.getFirstAsync('SELECT * FROM token_linkage_payloads WHERE txid = ?', [txid])) as {
        txid: string
        payloadBytes: unknown
        overlayUrl: string
        overlayIdentityKey: string
        source: TokenLinkageRow['source']
        createdAt: string
      } | null
      if (!row) return undefined
      return {
        txid: row.txid,
        payloadBytes: toBytes(row.payloadBytes),
        overlayUrl: row.overlayUrl,
        overlayIdentityKey: row.overlayIdentityKey,
        source: row.source,
        createdAt: row.createdAt
      }
    },

    /**
     * Insert-or-ignore in effect: the payload for a txid is whatever its issuer
     * minted, forwarded verbatim. A second copy arriving on a later hop is by
     * construction the same bytes, and a *different* copy is a counterparty
     * trying to rewrite evidence this device already holds — so an existing
     * BLOB is never touched. The one row a new copy may replace is one that
     * holds no evidence at all — not a blob (see `toBytes`), or an empty one:
     * a driver stringifying a value this store should have refused, which it
     * now does, and an empty payload is likewise refused here because an
     * overlay cannot verify nothing and every reader already treats it as
     * "nothing held".
     */
    async putLinkage(row: TokenLinkageRow): Promise<void> {
      if (!(row.payloadBytes instanceof Uint8Array) || row.payloadBytes.length === 0) {
        throw new Error('token_linkage_payloads.payloadBytes must be a non-empty Uint8Array')
      }
      await db.runAsync(
        `INSERT INTO token_linkage_payloads
           (txid, payloadBytes, overlayUrl, overlayIdentityKey, source, createdAt)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(txid) DO UPDATE SET
           payloadBytes = excluded.payloadBytes,
           overlayUrl = excluded.overlayUrl,
           overlayIdentityKey = excluded.overlayIdentityKey,
           source = excluded.source,
           createdAt = excluded.createdAt
         WHERE typeof(token_linkage_payloads.payloadBytes) <> 'blob'
            OR length(token_linkage_payloads.payloadBytes) = 0`,
        [row.txid, row.payloadBytes, row.overlayUrl, row.overlayIdentityKey, row.source, row.createdAt]
      )
    }
  }
}
