import { Beef, Transaction } from '@bsv/sdk'
import { decodeToken } from '@bsv/mandala'
import type { PaymentFrame, TokenPayment } from './codec'
import type { NearbyTokenDeps } from '../mandala/runtime'
import { isRetriableReceiptFailure, isTransportReceiptFailure, receiptFailureCode } from '../mandala/receipt'
import { failedPostReason } from '../pay/creditErrors'

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

/**
 * XR-101. internalizeAction's real contract (validateStringLength in
 * @bsv/sdk's validationHelpers) THROWS WERR_INVALID_PARAMETER — never
 * truncates — for a `description` over 2000 UTF-8 bytes. The peer `note` this
 * builds the description from arrives over the wire with no length cap of its
 * own (the 280-char TextInput limit is a UI convenience, not a decoder check),
 * so an oversized note used to fail internalizeAction on every retry until
 * `MAX_PENDING_ATTEMPTS` tripped, permanently stranding an already-accepted
 * payment. Capping here keeps a real payment creditable regardless of note
 * length, without rejecting the frame outright.
 */
export const MAX_INTERNALIZE_DESCRIPTION_BYTES = 2000

const descriptionEncoder = new TextEncoder()
const descriptionDecoder = new TextDecoder()

/**
 * Truncates on the UTF-8 byte boundary, not the JS string index — slicing by
 * character count alone can still overshoot the byte ceiling for non-ASCII
 * text. A multi-byte character cut in half at the boundary decodes back as
 * U+FFFD under TextDecoder's default lenient mode rather than throwing, which
 * is fine here: this is a display fallback, not the payment amount.
 */
export function truncateUtf8Bytes(s: string, maxBytes: number): string {
  const bytes = descriptionEncoder.encode(s)
  if (bytes.length <= maxBytes) return s
  return descriptionDecoder.decode(bytes.slice(0, maxBytes))
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
 * `Uint8Array` into an index-keyed object, and a token frame's byte fields
 * came back that way for as long as only `transaction` was converted
 * (2026-09-16). The v7 token block's only byte fields are `certificates`;
 * its evidence members are JSON already and are stored as they are.
 */
type WireBytes = number[]

interface WireToken extends Omit<TokenPayment, 'certificates'> {
  certificates: WireBytes[]
}

interface Serialised extends Omit<PendingPayment, 'frame'> {
  frame: Omit<PaymentFrame, 'transaction' | 'token'> & { transaction: WireBytes; token?: WireToken }
}

/**
 * Bytes as this queue wrote them (`number[]`), as it used to write them (the
 * index-keyed object JSON makes of a `Uint8Array` — entries like that are still
 * sitting in queues on devices), or already revived. Never throws: `readAll`
 * quarantines the WHOLE queue on a throw, and one unreadable byte field must not
 * cost every other payment in it. An unreadable field comes back EMPTY.
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
              certificates: token.certificates.map(c => Array.from(c))
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
              certificates: (Array.isArray(token.certificates) ? token.certificates : []).map(reviveBytes)
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

/**
 * Failures that must never be allowed to abandon a payment (FIX I).
 *
 * `MAX_PENDING_ATTEMPTS` burns an attempt on an `internalizeAction` failure,
 * but a transient `Block header not found for height N` from a fresh-block
 * BUMP this device has not caught up on yet is a header lag, not a bad frame:
 * the money is real and the next tick will credit it. A structurally bad BEEF
 * is the opposite, and is deliberately NOT matched here.
 *
 * Moved here from the deleted `mandala/drain.ts` (plan 07 Task 16) with its
 * patterns unchanged, less the pre-internalize settlement-write one: that
 * write no longer exists (a missing `color_transfers` row already holds, W1).
 */
const RETRIABLE_INTERNALIZE_PATTERNS: readonly RegExp[] = [
  /header not found/i,
  /no header/i,
  /chain ?tracker/i,
  /network request failed/i,
  /timed? ?out/i,
  /econnreset|econnrefused|enotfound|fetch failed/i,
  // internalizeAction posts an unproven payment itself (wallet-toolbox-mobile
  // 2.14.7+); when no broadcaster answered, `failedPostReason` says so.
  /no broadcaster could be reached/i
]

export function isRetriableInternalizeFailure(reason: string | undefined): boolean {
  if (!reason) return false
  return RETRIABLE_INTERNALIZE_PATTERNS.some(p => p.test(reason))
}

/**
 * How a failure moves the attempt counter.
 *
 * - `auto` (default): one attempt, unless the reason is environmental (FIX I).
 * - `free`: no attempt (a retryable overlay verdict; the money is real and
 *   the overlay itself said "later").
 * - `exhaust`: straight to the ceiling (a definitive receipt refusal: the
 *   same receipt can only be refused again).
 */
export type AttemptPolicy = 'auto' | 'free' | 'exhaust'

function nextAttempts(p: PendingPayment, status: PendingStatus, reason: string | undefined, policy: AttemptPolicy) {
  // Counted on failure only: 'processing' is set on the way in to every
  // attempt, so counting there would burn the ceiling without anything having
  // gone wrong.
  if (status !== 'failed') return p.attempts
  if (policy === 'exhaust') return Math.max(p.attempts ?? 0, MAX_PENDING_ATTEMPTS)
  if (policy === 'free') return p.attempts
  return isRetriableInternalizeFailure(reason) ? p.attempts : (p.attempts ?? 0) + 1
}

export async function updateStatus(
  storage: KVStorage,
  id: string,
  status: PendingStatus,
  failureReason?: string,
  attemptPolicy: AttemptPolicy = 'auto'
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
            attempts: nextAttempts(p, status, failureReason, attemptPolicy)
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
 * The runtime's `nearby.accept`: runs the lib's recipient path on a TOKEN
 * frame (B7: verify online or by COVER, record in the host ledger, then
 * internalize the plain receipt). Throws what the lib throws.
 */
export type TokenAcceptHook = NearbyTokenDeps['accept']

/**
 * The runtime's `nearby.onReceived`: told how a TOKEN frame's receipt
 * settled, credited (`ok`) or failed (`final` = refused for good).
 * The runtime journals `held`/`settled`/`refused` in `color_transfers`.
 *
 * Supplied by the caller rather than called directly from here: this module
 * knows about the KV-backed queue and nothing else. Optional, and its failure
 * is never the payment's: a credit stays a credit.
 */
export type TokenReceiveHook = NearbyTokenDeps['onReceived']

/** What `internalizeAction` is told about a BSV frame's output. */
function walletPaymentOutput(frame: PaymentFrame): Record<string, unknown> {
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

/**
 * The facts the receive hook reports, read from the frame itself: the txid
 * `internalizeAction` credits (the AtomicBEEF subject) and the exact units of
 * the named output (never a frame field). Undefined when the bytes do not
 * yield them; the module still decides the internalize, and a receipt nobody
 * journals is held by the broadcast hold all the same (a missing row holds, W1).
 */
function tokenReceiptFacts(frame: PaymentFrame): Parameters<TokenReceiveHook>[0] | undefined {
  if (frame.kind !== 'token' || frame.token === undefined) return undefined
  try {
    const tx = Transaction.fromAtomicBEEF(Array.from(frame.transaction))
    const txid = tx.id('hex')
    const output = tx.outputs[frame.outputIndex]
    const decoded = output ? decodeToken(output.lockingScript, txid, frame.outputIndex) : null
    if (decoded === null || decoded.role !== 'value' || decoded.assetId !== frame.token.assetId) return undefined
    return {
      txid,
      assetId: frame.token.assetId,
      units: decoded.amount,
      counterpartyKey: frame.senderIdentityKey,
      outputIndex: frame.outputIndex
    }
  } catch (e) {
    console.warn('[localpay] could not read the token receipt’s own facts:', messageOf(e))
    return undefined
  }
}

/** Runs the receive hook; its failure is logged, never the payment's. */
async function reportReceipt(
  onTokenReceived: TokenReceiveHook | undefined,
  facts: Parameters<TokenReceiveHook>[0] | undefined,
  outcome: Parameters<TokenReceiveHook>[1]
): Promise<void> {
  if (!onTokenReceived || !facts) return
  try {
    await onTokenReceived(facts, outcome)
  } catch (e) {
    console.warn('[localpay] the token receipt hook failed:', messageOf(e))
  }
}

export async function processPending(
  wallet: InternalizingWallet,
  storage: KVStorage,
  originator: string,
  attribute?: AttributePayment,
  /**
   * TOKEN FRAMES ONLY: the runtime's `nearby.onReceived`, run once the
   * receipt settles either way.
   *
   * There is deliberately no hook BEFORE the internalize. The toolbox forces
   * a broadcast inside `internalizeAction`, and what holds an unsettled
   * 1Color tx there is the broadcast hold: the lib records the receipt in the
   * host ledger before it internalizes (B7), which marks the tx as this
   * wallet's custody, and its `color_transfers` row is not `settled` (a
   * MISSING row holds). So the journal row written after the credit can only
   * release, never fail open.
   */
  onTokenReceived?: TokenReceiveHook,
  /**
   * TOKEN FRAMES ONLY: the runtime's `nearby.accept`. Without it a token
   * frame is never internalized here (no plain internalize can credit a
   * Mandala receipt the host has not verified); it fails retriably.
   */
  acceptToken?: TokenAcceptHook
): Promise<{ id: string; success: boolean; error?: string }[]> {
  const results: { id: string; success: boolean; error?: string }[] = []
  for (const p of await getRetryable(storage)) {
    await updateStatus(storage, p.id, 'processing')
    const isToken = p.frame.kind === 'token'
    const facts = isToken ? tokenReceiptFacts(p.frame) : undefined
    let offline = false
    try {
      if (isToken) {
        // The BRC-207 receipt path of the lib (B7): the v4 body rebuilt from
        // the frame, verified online or by COVER, recorded in the host ledger,
        // then the plain receipt internalized into `p color <assetTag>`.
        if (!acceptToken) throw new Error('token receipts are not available on this network (ERR_UNAVAILABLE)')
        offline = (await acceptToken(p.frame)).offline
      } else {
        await wallet.internalizeAction(
          {
            tx: Array.from(p.frame.transaction),
            outputs: [walletPaymentOutput(p.frame)],
            // The activity list uses the description as the row title, so it
            // says what happened — never who: a nearby transfer is blinded, so
            // the payer's key it used to carry told the user nothing. The
            // counterparty face is recovered from outputs.senderIdentityKey,
            // which is why the rail label carries no key. A sender's note on
            // the frame overrides this fixed wording, same as the message-box
            // rail's PeerPay note.
            description: truncateUtf8Bytes(
              (p.frame.note?.trim() || 'Received BSV').padEnd(5),
              MAX_INTERNALIZE_DESCRIPTION_BYTES
            ),
            labels: [PEERPAY_LABEL]
          },
          originator
        )
      }
    } catch (e) {
      const error = failedPostReason(e) ?? messageOf(e)
      if (isToken) {
        // A definitive refusal (the lib's receive classifier: a malformed or
        // contradicting body, a refused hop, a final verdict) goes straight to
        // the ceiling and is journaled `refused`. A transport failure never
        // burns an attempt. Anything else follows the BSV rule (FIX I).
        const final = !isRetriableReceiptFailure(e)
        await updateStatus(storage, p.id, 'failed', error, final ? 'exhaust' : isTransportReceiptFailure(e) ? 'free' : 'auto')
        await reportReceipt(onTokenReceived, facts, { ok: false, code: receiptFailureCode(e), final })
      } else {
        await updateStatus(storage, p.id, 'failed', error)
      }
      results.push({ id: p.id, success: false, error })
      continue
    }

    // Credited. The receipt is reported BEFORE the entry is marked completed:
    // a crash in between re-runs the (idempotent, 0207 A.83) internalize and
    // the (INSERT OR IGNORE) journal write, where the other order would leave
    // a credit nobody ever journals. Its failure never un-credits the coin.
    if (isToken) await reportReceipt(onTokenReceived, facts, { ok: true, offline })
    try {
      await updateStatus(storage, p.id, 'completed')
    } catch (e) {
      // The coin is credited; a queue write fault leaves the entry to be
      // replayed (idempotently) on the next pass, never marked failed.
      console.warn('[localpay] credited, but the queue could not record it:', messageOf(e))
    }
    results.push({ id: p.id, success: true })

    // Best-effort, and deliberately isolated: by this point the payment has
    // already completed successfully, so a failure here — a bad frame, a
    // locked db — must not retroactively turn it into a 'failed' entry, and
    // must not stop the loop from reaching whatever else is queued behind it.
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
