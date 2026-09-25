import { Beef } from '@bsv/sdk'
import type { PaymentFrame, TokenPayment } from './codec'
import { MANDALA_ACTION_LABEL, MANDALA_BASKET } from '../mandala/bundle'
import type { AdmissionEntryWire } from '../mandala/types'
import { isRetriableInternalizeFailure } from '../mandala/drain'

export const PENDING_KEY = 'localpay_pending'
/**
 * Counts written beside the queue so the home and pay screens can render their
 * badge without parsing the queue itself. Every entry carries a full AtomicBEEF,
 * and the badge was re-parsing all of them — on the JS thread, on both screens,
 * on every status change — to learn a number.
 */
export const PENDING_SUMMARY_KEY = 'localpay_pending_summary'
export const PEERPAY_PROTOCOL_ID: [number, string] = [2, '3241645161d8']
export const PEERPAY_LABEL = 'localpay'

export type PendingStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface PendingPayment {
  id: string
  receivedAt: string
  frame: PaymentFrame
  status: PendingStatus
  failureReason?: string
  lastAttemptAt?: string
  /**
   * Which transport this frame arrived over ('awdl' | 'nearby' | 'ble' | 'qr'),
   * when the caller knows it. Threaded through so `processPending` can
   * back-attribute the `offline_actions` row this internalize may create —
   * see `attribute`.
   */
  receivedVia?: string
  /** Failed internalize attempts. Absent on entries written before the ceiling. */
  attempts?: number
}

/**
 * How many times a received frame is re-internalized before the queue stops
 * trying. Structurally bad frames used to be retried on every wallet build and
 * every nearby settle, forever, each one re-validating a full BEEF — and the
 * badge went on calling them "waiting", which they were not.
 */
export const MAX_PENDING_ATTEMPTS = 3

export function isPendingExhausted(p: PendingPayment): boolean {
  return p.status === 'failed' && (p.attempts ?? 0) >= MAX_PENDING_ATTEMPTS
}

export interface PendingSummary {
  /** Still worth retrying. */
  waiting: number
  /** Out of attempts: real money this device could not credit. */
  stuck: number
}

export interface KVStorage {
  getKeyValue(k: string): Promise<string | undefined>
  setKeyValue(k: string, v: string): Promise<void>
}

/** Thrown after a corrupt `PENDING_KEY` blob has been copied aside, never treated as empty. */
export class PendingCorruptError extends Error {
  constructor(message = 'pending queue JSON is corrupt') {
    super(message)
    this.name = 'PendingCorruptError'
  }
}

let pendingCorruptNotice = false

/** True after a quarantine until a later successful parse of `PENDING_KEY`. */
export function getPendingCorruptNotice(): boolean {
  return pendingCorruptNotice
}

/**
 * Every byte field of a frame travels as a `number[]`: `JSON.stringify` turns a
 * `Uint8Array` into an index-keyed object, and a token frame's linkage
 * payloads, certificates and σ_I signatures came back that way for as long as
 * only `transaction` was converted. `processPending` then handed the mangled
 * frame to `onTokenHeld`, whose `putLinkage` bound a plain object — which
 * expo-sqlite on Android stringifies into a TEXT row, unreadable by every later
 * send that walked the received coin's ancestry (2026-09-16).
 */
type WireBytes = number[]

interface WireToken extends Omit<TokenPayment, 'certificates' | 'linkage' | 'admissions'> {
  certificates: WireBytes[]
  linkage: Array<{ txid: string; payload: WireBytes }>
  admissions: Array<Omit<AdmissionEntryWire, 'signature'> & { signature: WireBytes }>
}

interface Serialised extends Omit<PendingPayment, 'frame'> {
  frame: Omit<PaymentFrame, 'transaction' | 'token'> & { transaction: WireBytes; token?: WireToken }
}

/**
 * Bytes as this queue wrote them (`number[]`), as it used to write them (the
 * index-keyed object JSON makes of a `Uint8Array` — entries like that are still
 * sitting in queues on devices), or already revived. Never throws: `readAll`
 * quarantines the WHOLE queue on a throw, and one unreadable byte field must not
 * cost every other payment in it. An unreadable field comes back EMPTY, which
 * every consumer treats as "nothing held" (`putLinkage` refuses to store it).
 */
function reviveBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const out = new Uint8Array(entries.length)
    for (const [key, byte] of entries) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index >= out.length || typeof byte !== 'number') {
        return new Uint8Array(0)
      }
      out[index] = byte
    }
    return out
  }
  return new Uint8Array(0)
}

function toWire(p: PendingPayment): Serialised {
  const { token, ...frame } = p.frame
  return {
    ...p,
    frame: {
      ...frame,
      transaction: Array.from(p.frame.transaction),
      ...(token
        ? {
            token: {
              ...token,
              certificates: token.certificates.map(c => Array.from(c)),
              linkage: token.linkage.map(l => ({ txid: l.txid, payload: Array.from(l.payload) })),
              admissions: token.admissions.map(a => ({ ...a, signature: Array.from(a.signature) }))
            }
          }
        : {})
    }
  }
}

function fromWire(s: Serialised): PendingPayment {
  const { token, ...frame } = s.frame
  return {
    ...s,
    frame: {
      ...frame,
      transaction: reviveBytes(s.frame.transaction),
      ...(token
        ? {
            token: {
              ...token,
              certificates: (token.certificates ?? []).map(reviveBytes),
              linkage: (token.linkage ?? []).map(l => ({ txid: l.txid, payload: reviveBytes(l.payload) })),
              admissions: (token.admissions ?? []).map(a => ({ ...a, signature: reviveBytes(a.signature) }))
            }
          }
        : {})
    }
  }
}

// All read-modify-write sequences on the queue share one storage key, so they
// must not interleave: a concurrent write built from a stale read silently
// drops entries. Every mutating path runs through this chain.
let queueLock: Promise<unknown> = Promise.resolve()

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn)
  queueLock = run.catch(() => undefined)
  return run
}

async function readAll(storage: KVStorage): Promise<PendingPayment[]> {
  // A storage failure must NOT be reported as "empty" — callers write back
  // what they read, so swallowing it here destroys the queue.
  const raw = await storage.getKeyValue(PENDING_KEY)
  if (!raw) {
    pendingCorruptNotice = false
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      // XR-092: a syntactically valid non-array (an object, string, number,
      // or null) is just as wrong-shaped as invalid JSON. Silently reading it
      // as an empty queue cleared the corruption notice and left `writeAll`'s
      // very next save free to destructively overwrite whatever this value
      // actually held. Thrown here so it takes the exact same quarantine path
      // as a JSON.parse failure, below — never treated as "nothing pending".
      throw new Error('localpay_pending is not an array')
    }
    pendingCorruptNotice = false
    return (parsed as Serialised[]).map(fromWire)
  } catch {
    pendingCorruptNotice = true
    try {
      await storage.setKeyValue(`localpay_pending_corrupt_${Date.now()}`, raw)
      // Repair only after a successful quarantine copy. Compare-and-swap: this
      // path is not under withQueueLock (nesting would deadlock writers that
      // already hold it), so only write [] while PENDING_KEY still equals the
      // corrupt blob we observed — a stale peer must not wipe a later save.
      const still = await storage.getKeyValue(PENDING_KEY)
      if (still === raw) {
        await storage.setKeyValue(PENDING_KEY, '[]')
        // The summary describes the queue, so it must not outlive it: a stale
        // count beside a quarantined blob would keep promising payments that
        // are no longer in the live key.
        await storage.setKeyValue(PENDING_SUMMARY_KEY, JSON.stringify({ waiting: 0, stuck: 0 }))
      }
    } catch {
      // Quarantine/repair is best-effort; if copy or CAS fails, leave live key.
    }
    throw new PendingCorruptError()
  }
}

function summarise(list: PendingPayment[]): PendingSummary {
  let waiting = 0
  let stuck = 0
  for (const p of list) {
    if (p.status === 'completed') continue
    if (isPendingExhausted(p)) stuck++
    else waiting++
  }
  return { waiting, stuck }
}

async function writeAll(storage: KVStorage, list: PendingPayment[]): Promise<void> {
  const keep = list.filter(p => p.status !== 'completed')
  await storage.setKeyValue(PENDING_KEY, JSON.stringify(keep.map(toWire)))
  // Written after the queue, never before: a summary that ran ahead of the data
  // would promise a payment the queue does not hold.
  await storage.setKeyValue(PENDING_SUMMARY_KEY, JSON.stringify(summarise(keep)))
}

export async function savePending(
  storage: KVStorage,
  frame: PaymentFrame,
  receivedVia?: string
): Promise<PendingPayment> {
  return withQueueLock(async () => {
    const entry: PendingPayment = {
      id: `${Date.now()}_${frame.senderIdentityKey.slice(0, 8)}`,
      receivedAt: new Date().toISOString(),
      frame,
      status: 'pending',
      receivedVia
    }
    let existing: PendingPayment[]
    try {
      existing = await readAll(storage)
    } catch (e) {
      // readAll already repaired PENDING_KEY to []; still throw so this call
      // does not silently succeed while the notice should show.
      if (e instanceof PendingCorruptError) throw e
      throw e
    }
    await writeAll(storage, [...existing, entry])
    return entry
  })
}

/**
 * XR-098: atomically claims a session for exactly one delivery.
 *
 * `isSessionSpent`, `savePending` and `markSessionSpent` used to be three
 * separate operations — the first unlocked, the other two each under their
 * own `withQueueLock` — so a caller's own "check, then persist, then burn"
 * sequence was not atomic: two concurrent deliveries for the same session
 * (radio racing a QR scan of the same static code, or any other overlap)
 * could each observe `isSessionSpent` false before either had written
 * anything, and both would durably queue a payment for a session meant to be
 * spent exactly once. Folding the check, the persist and the burn into ONE
 * `withQueueLock` critical section makes the claim indivisible: whichever
 * call actually runs first inside the lock is the only one that can ever see
 * this session unspent again. Calls the un-locked primitives directly
 * (`readSpent`, `readAll`, `writeAll`) rather than `isSessionSpent` /
 * `savePending` / `markSessionSpent` themselves — nesting `withQueueLock`
 * inside itself would deadlock.
 */
export async function claimAndSavePending(
  storage: KVStorage,
  sessionId: Uint8Array,
  frame: PaymentFrame,
  receivedVia?: string
): Promise<{ claimed: true; entry: PendingPayment } | { claimed: false }> {
  return withQueueLock(async () => {
    const key = sessionKey(sessionId)
    const spent = await readSpent(storage)
    if (spent.includes(key)) return { claimed: false }

    const entry: PendingPayment = {
      id: `${Date.now()}_${frame.senderIdentityKey.slice(0, 8)}`,
      receivedAt: new Date().toISOString(),
      frame,
      status: 'pending',
      receivedVia
    }
    const existing = await readAll(storage)
    await writeAll(storage, [...existing, entry])
    // Only after the entry is durably written — same ordering the caller
    // relied on before this was atomic. Best-effort, same as
    // `markSessionSpent`'s own callers already treated it: the frame is
    // already queued, so a failure here is not a payment failure and must
    // not be reported as one — internalizeAction is idempotent on a repeat
    // of the same output, so a replay from here cannot double-credit.
    try {
      await storage.setKeyValue(SPENT_KEY, JSON.stringify([...spent, key]))
    } catch (e) {
      console.warn('[localpay] claimAndSavePending could not mark the session spent:', messageOf(e))
    }
    return { claimed: true, entry }
  })
}

export async function getPending(storage: KVStorage): Promise<PendingPayment[]> {
  return readAll(storage)
}

/** `processing` is included: a crash mid-flight must not strand a payment. */
export async function getUnprocessed(storage: KVStorage): Promise<PendingPayment[]> {
  return (await readAll(storage)).filter(p => p.status !== 'completed')
}

/** What `processPending` should attempt: unprocessed, minus what has given up. */
export async function getRetryable(storage: KVStorage): Promise<PendingPayment[]> {
  return (await getUnprocessed(storage)).filter(p => !isPendingExhausted(p))
}

/**
 * Home/Pay overlay: never treat a corrupt blob as an empty queue.
 *
 * Reads the summary key when there is one, so the common case costs a single
 * small read instead of parsing every queued AtomicBEEF. Falls back to the
 * queue itself — and writes the summary — for a store written before the
 * summary existed.
 */
export async function readUnprocessedPending(
  storage: KVStorage
): Promise<{ count: number; stuck: number; corrupt: boolean }> {
  // Never let the cheap path answer for a queue already known to be corrupt:
  // the notice is what puts the repair prompt in front of the user.
  try {
    const raw = getPendingCorruptNotice() ? undefined : await storage.getKeyValue(PENDING_SUMMARY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PendingSummary>
      if (typeof parsed.waiting === 'number' && typeof parsed.stuck === 'number') {
        return { count: parsed.waiting, stuck: parsed.stuck, corrupt: false }
      }
    }
  } catch {
    // Unreadable summary: fall through and rebuild it from the queue.
  }
  try {
    const all = await getUnprocessed(storage)
    const summary = summarise(all)
    try {
      await storage.setKeyValue(PENDING_SUMMARY_KEY, JSON.stringify(summary))
    } catch {
      // A summary that cannot be cached still answers this call.
    }
    return { count: summary.waiting, stuck: summary.stuck, corrupt: false }
  } catch (e) {
    if (e instanceof PendingCorruptError || getPendingCorruptNotice()) {
      return { count: 0, stuck: 0, corrupt: true }
    }
    throw e
  }
}

/**
 * Nearby pending can internalize while offline: `internalizeAction` parks the
 * broadcast via the storage hold. Connectivity no longer gates the queue.
 */
export function canInternalizePending(_online: boolean): boolean {
  return true
}

export async function updateStatus(
  storage: KVStorage,
  id: string,
  status: PendingStatus,
  failureReason?: string
): Promise<void> {
  return withQueueLock(async () => {
    let all: PendingPayment[]
    try {
      all = await readAll(storage)
    } catch (e) {
      if (e instanceof PendingCorruptError) throw e
      throw e
    }
    const next = all.map(p =>
      p.id === id
        ? {
            ...p,
            status,
            failureReason,
            lastAttemptAt: new Date().toISOString(),
            // Counted on failure only: 'processing' is set on the way in to
            // every attempt, so counting there would burn the ceiling without
            // anything having gone wrong.
            //
            // FIX I. And not on EVERY failure either: a transient `Block header
            // not found for height N` from a fresh-block BUMP this device has
            // not caught up on is a header lag, not a bad frame — the money is
            // real and the next tick credits it. Burning an attempt on it is
            // how a good payment reached `MAX_PENDING_ATTEMPTS` and stopped
            // being retried. A structurally bad BEEF is deliberately NOT
            // matched by `isRetriableInternalizeFailure` and still counts.
            attempts:
              status === 'failed' && !isRetriableInternalizeFailure(failureReason) ? (p.attempts ?? 0) + 1 : p.attempts
          }
        : p
    )
    await writeAll(storage, next)
  })
}

interface InternalizingWallet {
  internalizeAction(args: unknown, originator?: string): Promise<unknown>
}

/**
 * Backfills the identity of whoever handed over a payment, and how, onto the
 * `offline_actions` row `internalizeAction` may have just created for it (only
 * when this device was offline at the time — see `holdReqsOffline`, the sole
 * writer of that row, which never sees the frame and so writes both columns
 * null). Supplied by the caller rather than called directly from here: this
 * module knows nothing about SQLite or the `offline_actions` table, only about
 * the KV-backed queue in `PENDING_KEY`, and should stay that way.
 */
type AttributePayment = (txid: string, info: { senderIdentityKey: string; receivedVia?: string }) => Promise<void>

/**
 * Called once a TOKEN frame has been credited, with the frame and the txid
 * that was credited.
 *
 * This is the moment this device becomes responsible for submitting the chain
 * (settlement rule 3), so it is where the `token_settlements` row and the
 * evidence the frame carried — its admissions and linkage payloads — have to
 * be persisted. Supplied by the caller rather than called directly from here,
 * for the same reason `attribute` is: this module knows about the KV-backed
 * queue and nothing else, and should stay that way.
 *
 * Optional, and its failure is never the payment's failure: the coin is
 * already credited by the time it runs, and the drain re-reads its own tables
 * on every online tick.
 */
export type TokenCreditedHook = (frame: PaymentFrame, txid: string) => Promise<void>

/**
 * The prefix every pre-internalize settlement-write failure carries.
 *
 * `isRetriableInternalizeFailure` matches it, so a local storage fault here
 * never burns `MAX_PENDING_ATTEMPTS` (FIX I): the frame is durable, the money
 * is real, and the next tick repeats the same write.
 */
const SETTLEMENT_PREWRITE_FAILURE = 'could not record the settlement row before crediting'

/**
 * The FT derivation protocol a received token coin was locked under. Same
 * triple `verify.ts` checked the output against — written into
 * `customInstructions` because the basket-insertion path forces every
 * derivation field to undefined, and this is the only slot that survives to
 * the day the coin is spent.
 */
const FT_PROTOCOL_ID: [number, string] = [2, 'mandala token']

/** What `internalizeAction` is told about one frame's output. */
function internalizeOutput(frame: PaymentFrame): Record<string, unknown> {
  if (frame.kind === 'token' && frame.token) {
    // The toolbox never inspects a token script, credits no satoshis, and writes
    // the output `spendable: true, change: false` immediately — which is exactly
    // what makes a received-offline coin re-spendable before anyone has
    // submitted anything (spec §1.6's chained offline hops).
    return {
      outputIndex: frame.outputIndex,
      protocol: 'basket insertion',
      insertionRemittance: {
        basket: MANDALA_BASKET,
        customInstructions: JSON.stringify({
          protocolID: FT_PROTOCOL_ID,
          keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
          counterparty: frame.senderIdentityKey,
          direction: 'received'
        }),
        tags: ['mandala', 'received', frame.token.assetId]
      }
    }
  }
  return {
    outputIndex: frame.outputIndex,
    protocol: 'wallet payment',
    paymentRemittance: {
      derivationPrefix: frame.derivationPrefix,
      derivationSuffix: frame.derivationSuffix,
      senderIdentityKey: frame.senderIdentityKey
    }
  }
}

export async function processPending(
  wallet: InternalizingWallet,
  storage: KVStorage,
  originator: string,
  attribute?: AttributePayment,
  onTokenCredited?: TokenCreditedHook,
  /**
   * TOKEN FRAMES ONLY, and it runs BEFORE `internalizeAction` — which is the
   * entire point of it existing beside `onTokenCredited` (§4.2, §4.3 guard #2).
   *
   * `internalizeAction` forces a broadcast of its own through
   * `shareReqsWithWorld` → `attemptToPostReqsToNetwork`, and the guard that
   * stops an unadmitted token transaction going out there is a lookup of this
   * txid in `token_settlements`. With the row written only afterwards — which
   * is all `onTokenCredited` can do — the guard finds nothing on the FIRST
   * internalize and falls straight through to a real, unmediated broadcast. The
   * common shop case (payee has Wi-Fi, payer none) hits that path every time.
   *
   * So the row and the frame's evidence land first, and a failure here is a
   * refusal to credit rather than an unguarded credit: the frame is already
   * durable in `localpay_pending`, so the next tick retries the whole step and
   * `isRetriableInternalizeFailure` keeps the ceiling from abandoning it.
   */
  onTokenHeld?: TokenCreditedHook
): Promise<{ id: string; success: boolean; error?: string }[]> {
  const results: { id: string; success: boolean; error?: string }[] = []
  for (const p of await getRetryable(storage)) {
    await updateStatus(storage, p.id, 'processing')
    try {
      if (onTokenHeld && p.frame.kind === 'token') {
        // Deliberately INSIDE the try: unlike every other settlement write in
        // this file, this one gates the credit instead of following it.
        let txid: string | undefined
        try {
          txid = Beef.fromBinary(p.frame.transaction).atomicTxid
        } catch (e) {
          // Unreadable bytes are not a settlement fault — let the internalize
          // below reject them with its own, more precise message, which
          // failure-matrix row 7 depends on being distinguishable.
          console.warn('[localpay] token frame would not parse before the settlement write:', messageOf(e))
        }
        if (txid) {
          try {
            await onTokenHeld(p.frame, txid)
          } catch (e) {
            throw new Error(`${SETTLEMENT_PREWRITE_FAILURE}: ${messageOf(e)}`)
          }
        }
      }
      await wallet.internalizeAction(
        {
          tx: Array.from(p.frame.transaction),
          outputs: [internalizeOutput(p.frame)],
          // The activity list uses the description as the row title, so it
          // says what happened — never who: a nearby transfer is blinded, so
          // the payer's key it used to carry told the user nothing. The
          // counterparty face is recovered from outputs.senderIdentityKey,
          // which is why the rail label carries no key. A token frame ALSO
          // carries the lib's own 'mandala' label: it is how the home screen
          // recognises a token row, and without it a received stablecoin
          // rendered as a BSV row over "+0 sats" (2026-09-16). A sender's note
          // on the frame overrides this fixed wording, same as the message-box
          // rail's PeerPay note.
          description: (p.frame.note?.trim() || (p.frame.kind === 'token' ? 'Received token' : 'Received BSV')).padEnd(
            5
          ),
          labels: p.frame.kind === 'token' ? [PEERPAY_LABEL, MANDALA_ACTION_LABEL] : [PEERPAY_LABEL]
        },
        originator
      )
      await updateStatus(storage, p.id, 'completed')
      results.push({ id: p.id, success: true })

      // The SECOND settlement write, and an idempotent re-derivation of the
      // first: `onTokenHeld` already wrote the row before the internalize, and
      // `upsertSettlement` never moves `state` on conflict, so this re-runs the
      // same population harmlessly and is what still covers a caller that
      // supplies only this hook. Isolated from the try/catch above for the same
      // reason `attribute` is: the coin is credited by this point, so a failing
      // write must not retroactively mark the payment 'failed' and
      // re-internalize it.
      if (onTokenCredited && p.frame.kind === 'token') {
        try {
          const txid = Beef.fromBinary(p.frame.transaction).atomicTxid
          if (txid) await onTokenCredited(p.frame, txid)
        } catch (e) {
          // The drain owns the `token_settlements` row independently and
          // re-reads its own tables on every online tick, so a lost write here
          // costs a later reconciliation pass, not the payment.
          console.warn(
            '[localpay] token credited but settlement write failed:',
            e instanceof Error ? e.message : String(e)
          )
        }
      }

      // Best-effort, and deliberately isolated from the try/catch above: by
      // this point the payment has already completed successfully, so a
      // failure here — a bad frame, a locked db — must not retroactively turn
      // it into a 'failed' entry, and must not stop the loop from reaching
      // whatever else is queued behind it.
      if (attribute) {
        try {
          // internalizeAction's own resolved value carries no txid (the SDK's
          // InternalizeActionResult is just `{ accepted: true }`), so it has to
          // be derived from the frame itself. `frame.transaction` is an
          // AtomicBEEF (see codec.ts), and `atomicTxid` is exactly the subject
          // txid `internalizeAction` used internally to build the request that
          // `holdReqsOffline` may have queued — see Beef.d.ts / the toolbox's
          // own `validateAtomicBeef`.
          const txid = Beef.fromBinary(p.frame.transaction).atomicTxid
          if (txid) {
            await attribute(txid, {
              senderIdentityKey: p.frame.senderIdentityKey,
              receivedVia: p.receivedVia
            })
          }
        } catch {
          // Not a readable BEEF, or the attribution write itself failed.
          // Either way this is silent: the payment already succeeded above.
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await updateStatus(storage, p.id, 'failed', error)
      results.push({ id: p.id, success: false, error })
    }
  }
  return results
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const SPENT_KEY = 'localpay_spent_sessions'

function sessionKey(sessionId: Uint8Array): string {
  return Array.from(sessionId, b => b.toString(16).padStart(2, '0')).join('')
}

async function readSpent(storage: KVStorage): Promise<string[]> {
  // Same as readAll: let storage errors propagate, swallow only parse failures.
  const raw = await storage.getKeyValue(SPENT_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

export async function markSessionSpent(storage: KVStorage, sessionId: Uint8Array): Promise<void> {
  return withQueueLock(async () => {
    const key = sessionKey(sessionId)
    const spent = await readSpent(storage)
    if (spent.includes(key)) return
    await storage.setKeyValue(SPENT_KEY, JSON.stringify([...spent, key]))
  })
}

export async function isSessionSpent(storage: KVStorage, sessionId: Uint8Array): Promise<boolean> {
  return (await readSpent(storage)).includes(sessionKey(sessionId))
}
