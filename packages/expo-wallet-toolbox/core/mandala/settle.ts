/**
 * Settlement of token hand-overs and receipts through the color module (plan
 * 07 Task 12).
 *
 * The module owns settlement: it submits each stored tx to the issuer's
 * overlay, verifies the attestation and records it (IC §2.3). The wallet's
 * part is to say WHEN (a named txid is persisted submit intent) and to mirror
 * each verdict onto its own `color_transfers` journal, which is the one key
 * the broadcast hold and the abort refusal read (W1).
 *
 * Rules every function here keeps (stability mandate):
 *  · Journal moves are compare-and-set only (`journal.advance`), so a drain
 *    tick racing a screen, or a report replayed after a crash, can never move
 *    a row twice or out of a final state.
 *  · `built`/`parked` rows are the payer's own and are never named to the
 *    module (FIX F): a payment the user withheld is not settled by anyone else.
 *    A final row is never named either: naming persists intent, and intent on a
 *    cancelled payment would submit what the user withdrew.
 *  · A refused own hand-over is journaled `refused` FIRST and only then
 *    aborted, so the abort guard (which refuses aborts of `handed_over` and
 *    `settled` rows) lets its inputs go. The abort is retried by any later
 *    report that names the row while it reads `refused`, so a crash between
 *    the two steps never strands the inputs.
 *  · Every unknown answer fails closed: an unreadable admission answer is
 *    `undefined` (never `false`), and an inventory record that is offline or
 *    restricted is never journaled as `settled`.
 */
import { Transaction, type LookupAnswer } from '@bsv/sdk'
import type { ColorOverlayProvider, ColorPermissionModule, ColorSettleReport } from '@bsv/color-permission-module'
import { COLOR_OFFLINE_TAG } from '@bsv/color-permission-module'
import { devLog } from '../logging'
import type { InventoryRecord } from './assets'
import type { TokenSettleState } from './runtime'
import type { TransferJournal } from './transferJournal'
import type { ColorTransferState } from './types'

export interface SettleDeps {
  color: Pick<ColorPermissionModule, 'settle'>
  journal: TransferJournal
  /** The bound manager's `abortAction({ reference })`, behind the abort guard. */
  abort: (reference: string) => Promise<{ aborted: boolean }>
  onChange: () => void
}

/** Every state a verdict may move a row out of. Final states are never left. */
const OPEN_STATES: readonly ColorTransferState[] = ['built', 'parked', 'handed_over', 'held']
/**
 * The only states `settleNow` names to the module. Never `built`/`parked` (the
 * payer's own, FIX F) and never a final state.
 */
const SETTLEABLE_STATES: readonly ColorTransferState[] = ['handed_over', 'held']

/** The module's transport-failure code (IC §2.1). */
export const ERR_UNAVAILABLE = 'ERR_UNAVAILABLE'

/**
 * Mirrors one settle report onto the journal (IC §2.3 mapping).
 *
 *  · `admitted` → `settled` from any open state.
 *  · `refused` → `refused` (with the code) from any open state; then, for a
 *    `sent` row with a reference that reads `refused`, abort its action.
 *  · `retry` → nothing.
 *
 * A result whose asset differs from the row's is ignored (the row keeps
 * holding its broadcast). Journal faults propagate: the module has recorded
 * the verdict, and the next report that names the txid replays it.
 */
export async function applySettleReport(
  report: ColorSettleReport,
  d: Pick<SettleDeps, 'journal' | 'abort'>
): Promise<{ changed: number; settled: string[] }> {
  let changed = 0
  const settled: string[] = []
  for (const result of report?.results ?? []) {
    if (result.status !== 'admitted' && result.status !== 'refused') continue
    const row = await d.journal.get(result.txid)
    if (!row) continue
    if (row.assetId !== result.assetId) {
      devLog(`[mandala] settle: ${result.txid} reported for ${result.assetId}, journaled for ${row.assetId}; ignored`)
      continue
    }
    if (result.status === 'admitted') {
      if (await d.journal.advance(result.txid, OPEN_STATES, 'settled')) {
        changed++
        settled.push(result.txid)
      }
      continue
    }
    const patch = result.code !== undefined ? { code: result.code } : {}
    if (await d.journal.advance(result.txid, OPEN_STATES, 'refused', patch)) changed++
    const now = await d.journal.get(result.txid)
    if (now?.state === 'refused' && now.role === 'sent' && now.reference) {
      try {
        const r = await d.abort(now.reference)
        if (!r?.aborted) devLog(`[mandala] settle: the refused hand-over ${result.txid} was not aborted`)
      } catch (e) {
        devLog(`[mandala] settle: aborting the refused hand-over ${result.txid} failed:`, e)
      }
    }
  }
  return { changed, settled }
}

export interface Settler {
  settleNow(txid: string): Promise<TokenSettleState>
  settleAll(): Promise<number>
  /** `settleAll` with the module's report, sharing its single flight. */
  settleAllReport(): Promise<{ changed: number; report: ColorSettleReport }>
}

export function createSettler(d: SettleDeps): Settler {
  const inFlight = new Map<string, Promise<TokenSettleState>>()
  let allInFlight: Promise<{ changed: number; report: ColorSettleReport }> | undefined

  const notify = (): void => {
    try {
      d.onChange()
    } catch (e) {
      devLog('[mandala] settle: a change listener threw:', e)
    }
  }

  const currentState = async (txid: string): Promise<TokenSettleState> => {
    try {
      return (await d.journal.get(txid))?.state ?? 'unavailable'
    } catch (e) {
      devLog(`[mandala] settle: could not read ${txid} from the journal:`, e)
      return 'unavailable'
    }
  }

  const runOne = async (txid: string): Promise<TokenSettleState> => {
    const row = await d.journal.get(txid)
    if (!row) return 'unavailable'
    if (!SETTLEABLE_STATES.includes(row.state)) return row.state
    const report = await d.color.settle({ txids: [txid] })
    const { changed } = await applySettleReport(report, d)
    if (changed > 0) notify()
    return (await d.journal.get(txid))?.state ?? 'unavailable'
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

  const settleAllReport = (): Promise<{ changed: number; report: ColorSettleReport }> => {
    if (allInFlight) return allInFlight
    const running = (async () => {
      const report = await d.color.settle()
      const { changed } = await applySettleReport(report, d)
      if (changed > 0) notify()
      return { changed, report }
    })()
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
    settleAllReport
  }
}

/** Whether every result of a non-empty report is a transport `retry`: nothing could be asked. */
export function reportIsUnreachable(report: ColorSettleReport | undefined): boolean {
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
 *
 * Only the named txids are reconciled. Inserts are INSERT OR IGNORE and the
 * advance is a CAS, so a concurrent writer of the same row always wins.
 * Returns how many rows were written or moved.
 */
export async function reconcileHeldTransfers(
  d: { journal: TransferJournal; inventory: () => Promise<InventoryRecord[]> },
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

  let changed = 0
  for (const txid of candidates) {
    const records = (byTxid.get(txid) ?? []).slice().sort((a, b) => voutOf(a.outpoint) - voutOf(b.outpoint))
    if (records.length === 0) continue
    const unsettled = records.some(unsettledRecord)
    if (states.get(txid) === 'held') {
      if (!unsettled && (await d.journal.advance(txid, ['held'], 'settled'))) changed++
      continue
    }
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
