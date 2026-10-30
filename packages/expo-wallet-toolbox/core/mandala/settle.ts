/**
 * Settlement of token hand-overs and receipts on the host (design §9 B7, IC
 * §8.2 Revision 3).
 *
 * The color module no longer settles anything. The host does, with the lib:
 *
 *  · a SENT hand-over the recipient acknowledged (journal `handed_over`,
 *    `delivered`) is submitted by `settleHandover` with the exact bytes and
 *    envelope `sendHandover` recorded in the host ledger. A verified σ
 *    settles it; a final verdict refuses it.
 *  · a RECEIVED coin credited offline (ledger `pending`) is submitted by
 *    `settleReceipts` with its stored chain; a verified σ covering the
 *    credited output settles it.
 *
 * Both end in the host-only `color.markSettled(txid)`, which clears
 * `color_offline` on the tx's outputs. The wallet hands the lib a
 * `markSettled` that ALSO moves the `color_transfers` row to `settled`, in
 * that order and before the lib's own post-admission broadcast starts, so the
 * broadcast hold (keyed on the journal, W1) already releases that broadcast.
 *
 * Rules every function here keeps (stability mandate):
 *  · Journal moves are compare-and-set only (`journal.advance`), so a drain
 *    tick racing a screen, or a verdict replayed after a crash, can never move
 *    a row twice or out of a final state.
 *  · `built`/`parked` rows are the payer's own and are never submitted (FIX
 *    F), and neither is a `handed_over` row whose delivery is not known to
 *    have happened (B5: the sender submits only after the recipient's ACK).
 *    A final row is never submitted.
 *  · A refused own hand-over is journaled `refused` FIRST and only then
 *    aborted, so the abort guard (which refuses aborts of `handed_over` and
 *    `settled` rows) lets its inputs go. `settleNow` of a `refused` row
 *    retries the abort, so a crash between the two steps never strands the
 *    inputs. Within one settler the abort is coalesced per reference (a
 *    racing `settleAll` and `settleNow` abort once) and not repeated after it
 *    succeeded.
 *  · Every unknown answer fails closed: an unreadable admission answer is
 *    `undefined` (never `false`), and an inventory record that is offline or
 *    restricted is never journaled as `settled`.
 */
import { Transaction, Utils, type LookupAnswer, type WalletInterface } from '@bsv/sdk'
import type { ColorOverlayProvider } from '@bsv/color-permission-module'
import { COLOR_OFFLINE_TAG } from '@bsv/color-permission-module'
import {
  settleHandover as libSettleHandover,
  settleReceipts as libSettleReceipts,
  type HostLedger,
  type LedgerRecord,
  type ReceiptSettleResult,
  type SettleResult
} from '@bsv/mandala'
import { devLog } from '../logging'
import type { InventoryRecord } from './assets'
import type { TokenSettleState } from './runtime'
import type { TransferJournal } from './transferJournal'
import type { ColorTransferRow, ColorTransferState } from './types'

export interface SettleDeps {
  /** The bound manager: the lib's post-admission `sendWith` runs through it. */
  wallet: WalletInterface
  journal: TransferJournal
  /** The host ledger shared with the issuer-v1 handler. */
  ledger: HostLedger
  /** The module's host-only `markSettled(txid)` (clears `color_offline`). */
  markSettled: (txid: string) => Promise<void>
  /** This chain's overlay identity key K. */
  overlayIdentityKey: string
  /** The bound manager's `abortAction({ reference })`, behind the abort guard. */
  abort: (reference: string) => Promise<{ aborted: boolean }>
  onChange: () => void
  /** Lib seams (tests replace them). */
  settleHandover?: typeof libSettleHandover
  settleReceipts?: typeof libSettleReceipts
}

/** Every state a verdict may move a row out of. Final states are never left. */
const OPEN_STATES: readonly ColorTransferState[] = ['built', 'parked', 'handed_over', 'held']

/** The transport-failure code (overlay unreachable, no typed verdict). */
export const ERR_UNAVAILABLE = 'ERR_UNAVAILABLE'

/** One settlement outcome, sent or received, as the drain reports it. */
export interface SettleOutcome {
  txid: string
  assetId: string
  status: 'admitted' | 'retry' | 'refused'
  code?: string
}

export interface SettleReport {
  results: SettleOutcome[]
}

/**
 * Aborts the action behind a REFUSED own hand-over so its reserved inputs come
 * back. Only for a row that reads `refused`, so the abort guard allows it.
 * Never throws: a failed abort is retried by the next `settleNow` of the row.
 */
async function releaseRefused(row: ColorTransferRow | undefined, abort: SettleDeps['abort']): Promise<void> {
  if (row?.state !== 'refused' || row.role !== 'sent' || !row.reference) return
  try {
    const r = await abort(row.reference)
    if (!r?.aborted) devLog(`[mandala] settle: the refused hand-over ${row.txid} was not aborted`)
  } catch (e) {
    devLog(`[mandala] settle: aborting the refused hand-over ${row.txid} failed:`, e)
  }
}

/** The exact submit bytes of an own hand-over, from its host-ledger record. */
function ownSubmit(
  rec: LedgerRecord | undefined,
  txid: string
): { tx: number[]; offChainValues: number[] } | undefined {
  const tip = rec?.submits?.find(s => s.txid === txid)
  const beefHex = tip?.beefHex ?? rec?.beefHex
  if (tip === undefined || beefHex === undefined || tip.offChainHex === '') return undefined
  return { tx: Utils.toArray(beefHex, 'hex'), offChainValues: Utils.toArray(tip.offChainHex, 'hex') }
}

export interface Settler {
  settleNow(txid: string): Promise<TokenSettleState>
  settleAll(): Promise<number>
  /** `settleAll` with every outcome, sharing its single flight. */
  settleAllReport(): Promise<{ changed: number; report: SettleReport }>
  /** The `markSettled` the lib is handed: module first, then the journal row. */
  markSettled(txid: string): Promise<void>
}

export function createSettler(deps: SettleDeps): Settler {
  const settleHandover = deps.settleHandover ?? libSettleHandover
  const settleReceipts = deps.settleReceipts ?? libSettleReceipts
  const inFlight = new Map<string, Promise<TokenSettleState>>()
  let allInFlight: Promise<{ changed: number; report: SettleReport }> | undefined

  // The per-txid and settle-all single flights are separate, so a tick's
  // `settleAll()` racing a screen's `settleNow(T)` can both see T refused.
  // The journal CAS moves the row once; the abort is coalesced here:
  // concurrent aborts of one reference share a call, and a reference already
  // aborted by this settler is not asked again. A failed or declined abort is
  // never remembered, so the retry paths still run it.
  const abortInFlight = new Map<string, Promise<{ aborted: boolean }>>()
  const aborted = new Set<string>()
  const abortOnce = (reference: string): Promise<{ aborted: boolean }> => {
    if (aborted.has(reference)) return Promise.resolve({ aborted: true })
    const existing = abortInFlight.get(reference)
    if (existing) return existing
    const running = (async () => {
      const r = await deps.abort(reference)
      if (r?.aborted) aborted.add(reference)
      return r
    })()
    abortInFlight.set(reference, running)
    const clear = (): void => {
      if (abortInFlight.get(reference) === running) abortInFlight.delete(reference)
    }
    running.then(clear, clear)
    return running
  }

  const notify = (): void => {
    try {
      deps.onChange()
    } catch (e) {
      devLog('[mandala] settle: a change listener threw:', e)
    }
  }

  /** CAS to `settled`; true when this call moved the row. */
  const journalSettled = async (txid: string): Promise<boolean> => {
    const moved = await deps.journal.advance(txid, OPEN_STATES, 'settled')
    if (moved) notify()
    return moved
  }

  /**
   * The lib's `markSettled`: the module's flag first (so the coin stops being
   * `color_offline`), then the journal (so the hold releases). A module
   * failure throws before the journal moves, and the lib retries both.
   */
  const markSettled = async (txid: string): Promise<void> => {
    await deps.markSettled(txid)
    await journalSettled(txid)
  }

  /** Journals a final refusal (CAS) and releases a refused own hand-over. */
  const journalRefused = async (txid: string, code: string | undefined): Promise<boolean> => {
    const moved = await deps.journal.advance(txid, OPEN_STATES, 'refused', code !== undefined ? { code } : {})
    if (moved) notify()
    await releaseRefused(await deps.journal.get(txid), abortOnce)
    return moved
  }

  const currentState = async (txid: string): Promise<TokenSettleState> => {
    try {
      return (await deps.journal.get(txid))?.state ?? 'unavailable'
    } catch (e) {
      devLog(`[mandala] settle: could not read ${txid} from the journal:`, e)
      return 'unavailable'
    }
  }

  /** Post-ACK submit of one own hand-over. Never throws for an overlay outcome. */
  const settleSent = async (row: ColorTransferRow): Promise<SettleOutcome | undefined> => {
    const base = { txid: row.txid, assetId: row.assetId }
    const rec = await deps.ledger.get(row.txid)
    if (rec?.state === 'settled') {
      // Admitted before (a crash after the σ, or another settle): finish it.
      if (rec.marked !== true) await markSettled(row.txid)
      else await journalSettled(row.txid)
      return { ...base, status: 'admitted' }
    }
    if (rec?.state === 'refused') {
      await journalRefused(row.txid, rec.code)
      return { ...base, status: 'refused', ...(rec.code !== undefined ? { code: rec.code } : {}) }
    }
    const bytes = ownSubmit(rec, row.txid)
    if (bytes === undefined) {
      devLog(`[mandala] settle: no host-ledger submit bytes for the hand-over ${row.txid}; it stays ${row.state}`)
      return { ...base, status: 'retry', code: 'ERR_NO_CHAIN' }
    }
    let r: SettleResult
    try {
      r = await settleHandover({
        wallet: deps.wallet,
        handover: { txid: row.txid, ...bytes },
        assetId: row.assetId,
        overlayIdentityKey: deps.overlayIdentityKey,
        ledger: deps.ledger,
        markSettled
      })
    } catch (e) {
      devLog(`[mandala] settle: the hand-over ${row.txid} could not be submitted:`, e)
      return { ...base, status: 'retry', code: 'ERR_SETTLE' }
    }
    if (r.status === 'admitted') {
      // The lib ran markSettled already; a failure there is only warned, so
      // the row is moved here too (a CAS: a no-op when it already moved).
      await journalSettled(row.txid)
      return { ...base, status: 'admitted' }
    }
    if (r.status === 'refused') {
      await journalRefused(row.txid, r.code)
      return { ...base, status: 'refused', code: r.code }
    }
    return { ...base, status: 'retry', code: r.code }
  }

  /** Mirrors `settleReceipts` results onto the journal. */
  const applyReceiptResults = async (results: readonly ReceiptSettleResult[]): Promise<SettleOutcome[]> => {
    const out: SettleOutcome[] = []
    for (const r of results) {
      if (r.status === 'admitted') await journalSettled(r.txid)
      else if (r.status === 'refused') await journalRefused(r.txid, r.code)
      out.push({
        txid: r.txid,
        assetId: r.assetId,
        status: r.status,
        ...(r.code !== undefined ? { code: r.code } : {})
      })
    }
    return out
  }

  /** A held receipt: submit its pending chain, or catch the row up with a settled ledger record. */
  const settleReceived = async (row: ColorTransferRow): Promise<SettleOutcome[]> => {
    const results = await applyReceiptResults(
      await settleReceipts({
        ledger: deps.ledger,
        markSettled,
        overlayIdentityKey: deps.overlayIdentityKey,
        txids: [row.txid]
      })
    )
    if (results.length > 0) return results
    const rec = await deps.ledger.get(row.txid)
    if (rec?.state === 'settled' && rec.marked !== false) {
      await journalSettled(row.txid)
      return [{ txid: row.txid, assetId: row.assetId, status: 'admitted' }]
    }
    if (rec?.state === 'refused') {
      await journalRefused(row.txid, rec.code)
      return [
        {
          txid: row.txid,
          assetId: row.assetId,
          status: 'refused',
          ...(rec.code !== undefined ? { code: rec.code } : {})
        }
      ]
    }
    return []
  }

  const runOne = async (txid: string): Promise<TokenSettleState> => {
    const row = await deps.journal.get(txid)
    if (!row) return 'unavailable'
    // A crash between journaling a refusal and aborting its action leaves the
    // inputs reserved: the abort is retried from here.
    if (row.state === 'refused') await releaseRefused(row, abortOnce)
    if (row.role === 'sent') {
      if (row.state !== 'handed_over' || !row.delivered) return row.state
      await settleSent(row)
    } else {
      if (row.state !== 'held') return row.state
      await settleReceived(row)
    }
    return (await deps.journal.get(txid))?.state ?? 'unavailable'
  }

  const settleNow = (txid: string): Promise<TokenSettleState> => {
    const existing = inFlight.get(txid)
    if (existing) return existing
    const running = (async () => {
      try {
        return await runOne(txid)
      } catch (e) {
        devLog(`[mandala] settle: settling ${txid} failed:`, e)
        return await currentState(txid)
      }
    })()
    inFlight.set(txid, running)
    const clear = (): void => {
      if (inFlight.get(txid) === running) inFlight.delete(txid)
    }
    running.then(clear, clear)
    return running
  }

  /**
   * Every pending receipt and every delivered own hand-over, once. Faults per
   * item are logged and do not stop the rest; a ledger or journal read fault
   * for the whole pass propagates.
   */
  const runAll = async (): Promise<{ changed: number; report: SettleReport }> => {
    let changed = 0
    const counting = async <T>(fn: () => Promise<T>): Promise<T> => {
      const before = await deps.journal.list({ states: [...OPEN_STATES] })
      const r = await fn()
      const after = await deps.journal.statesOf(before.map(b => b.txid))
      for (const b of before) if (after.get(b.txid) !== b.state) changed++
      return r
    }
    const results = await counting(async () => {
      const out: SettleOutcome[] = []
      try {
        out.push(
          ...(await applyReceiptResults(
            await settleReceipts({ ledger: deps.ledger, markSettled, overlayIdentityKey: deps.overlayIdentityKey })
          ))
        )
      } catch (e) {
        devLog('[mandala] settle: settling pending receipts failed:', e)
      }
      // Held rows whose ledger record is already settled (a crash between the
      // two writes, or a receipt the handler settled with its own submit).
      for (const row of await deps.journal.list({ states: ['held'], role: 'received' })) {
        try {
          const rec = await deps.ledger.get(row.txid)
          if (rec?.state === 'settled' && rec.marked !== false) await journalSettled(row.txid)
        } catch (e) {
          devLog(`[mandala] settle: catching up ${row.txid} failed:`, e)
        }
      }
      for (const row of await deps.journal.list({ states: ['handed_over'], role: 'sent' })) {
        if (!row.delivered) continue
        try {
          const r = await settleSent(row)
          if (r) out.push(r)
        } catch (e) {
          devLog(`[mandala] settle: settling the hand-over ${row.txid} failed:`, e)
        }
      }
      return out
    })
    return { changed, report: { results } }
  }

  const settleAllReport = (): Promise<{ changed: number; report: SettleReport }> => {
    if (allInFlight) return allInFlight
    const running = runAll()
    allInFlight = running
    const clear = (): void => {
      if (allInFlight === running) allInFlight = undefined
    }
    running.then(clear, clear)
    return running
  }

  return {
    settleNow,
    settleAll: async () => (await settleAllReport()).changed,
    settleAllReport,
    markSettled
  }
}

/** Whether every result of a non-empty report is a transport `retry`: nothing could be asked. */
export function reportIsUnreachable(report: SettleReport | undefined): boolean {
  const results = report?.results ?? []
  return results.length > 0 && results.every(r => r.status === 'retry' && r.code === ERR_UNAVAILABLE)
}

/**
 * Reads a `color-admission` answer for ONE queried outpoint.
 *
 * `true`: the answer lists exactly that outpoint (its txid is derived from the
 * BEEF, as the module does; the optional `txid` hint must agree). `false`: an
 * empty output list. Anything else throws — an unrelated, malformed or
 * non-list answer is unreadable, and reading it as `false` would let a cancel
 * release inputs under a payee who already submitted.
 */
export function readHandoverAdmission(answer: LookupAnswer, outpoint: string): boolean {
  if (answer?.type !== 'output-list' || !Array.isArray(answer.outputs)) {
    throw new Error('color-admission: the overlay answer is not an output list')
  }
  if (answer.outputs.length === 0) return false
  for (const item of answer.outputs) {
    let tx: Transaction
    try {
      tx = Transaction.fromBEEF(item.beef, item.txid)
    } catch {
      throw new Error('color-admission: the overlay answer carries invalid BEEF')
    }
    const txid = tx.id('hex')
    if (item.txid !== undefined && item.txid !== txid) {
      throw new Error('color-admission: the overlay answer names a txid its BEEF does not carry')
    }
    if (!Number.isSafeInteger(item.outputIndex) || tx.outputs[item.outputIndex] === undefined) {
      throw new Error('color-admission: the overlay answer names a missing output')
    }
    if (`${txid}.${item.outputIndex}` !== outpoint) {
      throw new Error(`color-admission: the overlay answered an unrelated output ${txid}.${item.outputIndex}`)
    }
  }
  return true
}

/**
 * Whether the overlay already admitted `txid`'s journaled output. A txid with
 * no row is `false` (this wallet built nothing under it). Every failure to ask
 * or to read the answer — transport, typed refusal, malformed — is `undefined`.
 */
export async function isHandoverAdmitted(
  d: { journal: Pick<TransferJournal, 'get'>; provider: ColorOverlayProvider | undefined },
  txid: string
): Promise<boolean | undefined> {
  if (!d.provider) return undefined
  try {
    const row = await d.journal.get(txid)
    if (!row) return false
    const outpoint = `${txid}.${row.outputIndex}`
    return readHandoverAdmission(await d.provider.admission(row.assetId, [outpoint]), outpoint)
  } catch (e) {
    devLog(`[mandala] could not read the overlay admission of ${txid}:`, e)
    return undefined
  }
}

const RESTRICTED_TAG = 'color_state_restricted'

/** Records whose tags say the module has NOT settled their tx (offline credit, or refused). */
function unsettledRecord(r: InventoryRecord): boolean {
  return r.tags.includes(COLOR_OFFLINE_TAG) || r.tags.includes(RESTRICTED_TAG)
}

const voutOf = (outpoint: string): number => Number(outpoint.slice(outpoint.lastIndexOf('.') + 1))

/**
 * Journals held 1Color receipts the journal does not know, from the module's
 * inventory (Review Focus 4: a fresh install, a store loss, an externally
 * internalized receipt).
 *
 *  · No row, records present: a `received`/`external` row, `held` when any
 *    record is `color_offline` (or restricted), else `settled`. `units` sums
 *    the asset's records; `outputIndex` is the lowest vout. No records: skip.
 *  · A `held` row whose records are all present and none offline or
 *    restricted: `settled` (the module drops `color_offline` only once the tx
 *    has a settled record). No records: it stays `held`.
 *  · No row, but `ownSends` names the txid (an action this wallet funded,
 *    e.g. a third-party originator's token send): skipped. Its records are
 *    the sender's own token CHANGE, and a `received` row would show that
 *    change as an incoming credit. It stays held here; an admitted one is
 *    broadcast by the overlay (design §21), as an exact spend with no change
 *    always was. A fault answering `ownSends` propagates (nothing written).
 *
 * Only the named txids are reconciled. Inserts are INSERT OR IGNORE and the
 * advance is a CAS, so a concurrent writer of the same row always wins.
 * Returns how many rows were written or moved.
 */
export async function reconcileHeldTransfers(
  d: {
    journal: TransferJournal
    inventory: () => Promise<InventoryRecord[]>
    /** Of `txids`, the ones this wallet funded (its own outgoing actions). */
    ownSends?: (txids: readonly string[]) => Promise<ReadonlySet<string>>
  },
  txids: readonly string[]
): Promise<number> {
  const wanted = [...new Set(txids)]
  if (wanted.length === 0) return 0
  const states = await d.journal.statesOf(wanted)
  const candidates = wanted.filter(t => !states.has(t) || states.get(t) === 'held')
  if (candidates.length === 0) return 0

  const byTxid = new Map<string, InventoryRecord[]>()
  for (const r of await d.inventory()) {
    const txid = r.outpoint.slice(0, r.outpoint.lastIndexOf('.'))
    const list = byTxid.get(txid)
    if (list) list.push(r)
    else byTxid.set(txid, [r])
  }

  const unjournaled = candidates.filter(t => !states.has(t) && byTxid.has(t))
  const own = unjournaled.length > 0 && d.ownSends ? await d.ownSends(unjournaled) : new Set<string>()

  let changed = 0
  for (const txid of candidates) {
    const records = (byTxid.get(txid) ?? []).slice().sort((a, b) => voutOf(a.outpoint) - voutOf(b.outpoint))
    if (records.length === 0) continue
    const unsettled = records.some(unsettledRecord)
    if (states.get(txid) === 'held') {
      if (!unsettled && (await d.journal.advance(txid, ['held'], 'settled'))) changed++
      continue
    }
    if (own.has(txid)) continue
    const first = records[0]
    const units = records.filter(r => r.assetId === first.assetId).reduce((sum, r) => sum + r.units, 0n)
    const wrote = await d.journal.insert({
      txid,
      role: 'received',
      assetId: first.assetId,
      units,
      outputIndex: voutOf(first.outpoint),
      rail: 'external',
      state: unsettled ? 'held' : 'settled',
      delivered: false
    })
    if (wrote) changed++
  }
  return changed
}
