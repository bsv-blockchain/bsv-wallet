/**
 * The proof that a profile holds nothing, which is what makes removing it safe.
 *
 * Removing a profile deletes its databases and stops monitoring it. The seed
 * still derives the same keys, so nothing on chain is destroyed — but a coin,
 * a half-sent payment or a payment not yet credited that lives only in that
 * database would no longer be looked after by anything. So this answers one
 * question, and answers it strictly: is there anything here a person could be
 * owed, or owe?
 *
 * It runs on the OPEN storage of the profile being removed, and it fails
 * closed. A check that threw says nothing about what is in the database, so
 * every error becomes `check-failed` and never `ok`; the one way to get `ok`
 * is for every check to have run and found nothing.
 *
 * The state lists are written the other way round from the spec's prose — as
 * what is TERMINAL, with everything else blocking. For every status that exists
 * today that is the same set, and a status added later blocks removal until
 * somebody decides it should not, which is the safe direction to be wrong in.
 *
 * Read-only. The localpay queue in particular is read raw rather than through
 * `getUnprocessed`: that reader repairs a corrupt queue as a side effect, and a
 * check that cleaned up its own evidence would pass the second time it ran.
 */
import type { BindValue } from '../storage/methods/offlineActions'
import { PENDING_JOURNAL_KEY } from '../identity/handleRegistry/registration'
import { PENDING_KEY } from '../localpay/pending'
import { getOutboxEntriesStrict, unsentEntries } from '../peerpay/outbox'

/** Why a profile cannot be removed. One code per thing found, for the UI to explain. */
export type RemovalBlocker =
  /** A spendable output in any basket, tokens included. */
  | 'spendable-outputs'
  /** A transaction that is not yet completed or failed. */
  | 'pending-transactions'
  /** A payment queued, being posted, parked or held for review. */
  | 'offline-queue'
  /** A token payment that has not reached a final state. */
  | 'token-settlements'
  /** A token balance, or tokens still settling. */
  | 'token-balance'
  /** A received payment waiting to be credited — stuck or corrupt ones included. */
  | 'localpay-pending'
  /** A payment sent but not yet delivered to its recipient. */
  | 'peerpay-outbox'
  /** A handle write that was started and not finished. */
  | 'handle-journal'
  /** A payment in the MessageBox inbox that the credit pass could not finish. */
  | 'inbox-pending'
  /** Something could not be read, so nothing can be said. */
  | 'check-failed'

export type ProfileEmptyResult = { ok: true } | { ok: false; reasons: RemovalBlocker[] }

/** The slice of `SQLiteDatabase` the checks need. */
export interface ProfileEmptyDb {
  getFirstAsync(sql: string, params: BindValue[]): Promise<unknown>
}

/**
 * Structurally satisfied by `StorageExpoSQLite`. `sqliteDb` is `undefined` once
 * the storage has been destroyed, and that reads as `check-failed`.
 */
export interface ProfileEmptyStorage {
  readonly sqliteDb: ProfileEmptyDb | undefined
  getKeyValue(key: string): Promise<string | undefined>
}

export interface AssertProfileEmptyDeps {
  /**
   * One forced pass over the MessageBox inbox, resolving when it has run to the
   * end. It runs FIRST, so whatever it credits is already in the database when
   * the checks below read it.
   *
   * `pending` is a payment still waiting to be credited; `attention` is one the
   * pass gave up on or could not parse. Either is money this device was told
   * about and does not hold yet. A pass that cannot run at all (offline, the
   * box unreachable) rejects, and that is `check-failed`: an unread inbox is
   * not an empty one. A wallet with no MessageBox host has nothing to drain and
   * resolves `{ attention: 0, pending: false }`.
   */
  creditInbox: () => Promise<{ attention: number; pending: boolean }>
  /**
   * The Mandala runtime's `balances()`, when this wallet has one. Belt and
   * braces only: the runtime's own token listing swallows its errors into an
   * empty list, so a zero here proves less than it appears to. The SQL checks
   * on outputs and settlements are what actually cover tokens, which is why
   * this may be left out.
   */
  mandalaBalances?: () => Promise<ReadonlyArray<{ baseUnits: number; unsettledBaseUnits: number }>>
}

// Terminal lists, not blocking lists — see the header.
const SPENDABLE_OUTPUTS = 'SELECT 1 AS found FROM outputs WHERE userId = ? AND spendable <> 0 LIMIT 1'
const OPEN_TRANSACTIONS =
  "SELECT 1 AS found FROM transactions WHERE userId = ? AND status NOT IN ('completed', 'failed') LIMIT 1"
// Equal to queued/posting/parked/import_hold for every status there is.
const OPEN_OFFLINE_ACTIONS =
  "SELECT 1 AS found FROM offline_actions WHERE userId = ? AND status NOT IN ('sent', 'rejected', 'acknowledged') LIMIT 1"
// No userId column: this table is one database's worth, and a database is one profile's.
const OPEN_SETTLEMENTS =
  "SELECT 1 AS found FROM token_settlements WHERE state NOT IN ('broadcast', 'admitted', 'refused', 'orphaned') LIMIT 1"
// A corrupt localpay queue is copied here and the live key reset (pending.ts `readAll`).
const QUARANTINED_PENDING =
  "SELECT 1 AS found FROM key_value_store WHERE key LIKE 'localpay\\_pending\\_corrupt\\_%' ESCAPE '\\' LIMIT 1"

async function exists(db: ProfileEmptyDb | undefined, sql: string, params: BindValue[]): Promise<boolean> {
  if (!db) throw new Error('assertProfileEmpty: the database is closed')
  return (await db.getFirstAsync(sql, params)) != null
}

/** Any entry that is not finished, or a queue that cannot be understood. */
async function receivedPaymentsWaiting(storage: ProfileEmptyStorage): Promise<boolean> {
  const raw = await storage.getKeyValue(PENDING_KEY)
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return true
    }
    if (!Array.isArray(parsed)) return true
    // `completed` entries are credited already, so what they were worth is in
    // `outputs`; the queue drops them on its next write anyway.
    if (parsed.some(entry => (entry as { status?: unknown } | null)?.status !== 'completed')) return true
  }
  return await exists(storage.sqliteDb, QUARANTINED_PENDING, [])
}

export async function assertProfileEmpty(
  storage: ProfileEmptyStorage,
  userId: number,
  deps: AssertProfileEmptyDeps
): Promise<ProfileEmptyResult> {
  // Bound into every query below: anything but a real row id would match
  // nothing, and "matched nothing" is the answer this function must never give
  // for a reason other than the profile being empty.
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, reasons: ['check-failed'] }

  const reasons: RemovalBlocker[] = []
  const note = (reason: RemovalBlocker) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  /** Every check runs even after one has failed, so the user is told all of it. */
  const check = async (blocker: RemovalBlocker, blocked: () => Promise<boolean>) => {
    try {
      if (await blocked()) note(blocker)
    } catch {
      note('check-failed')
    }
  }

  const db = storage.sqliteDb

  await check('inbox-pending', async () => {
    const pass = await deps.creditInbox()
    return !(pass.pending === false && pass.attention === 0)
  })
  await check('spendable-outputs', () => exists(db, SPENDABLE_OUTPUTS, [userId]))
  await check('pending-transactions', () => exists(db, OPEN_TRANSACTIONS, [userId]))
  await check('offline-queue', () => exists(db, OPEN_OFFLINE_ACTIONS, [userId]))
  await check('token-settlements', () => exists(db, OPEN_SETTLEMENTS, []))
  await check('token-balance', async () => {
    if (!deps.mandalaBalances) return false
    const balances = await deps.mandalaBalances()
    return balances.some(b => !(b.baseUnits === 0 && b.unsettledBaseUnits === 0))
  })
  await check('localpay-pending', () => receivedPaymentsWaiting(storage))
  await check('peerpay-outbox', async () => unsentEntries(await getOutboxEntriesStrict(storage)).length > 0)
  // Any value at all, not one parsed: `clearJournal` leaves `''` behind, and
  // that is the only thing that means "nothing in flight".
  await check('handle-journal', async () => !!(await storage.getKeyValue(PENDING_JOURNAL_KEY)))

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
