/**
 * Receiving a direct (live) payment: verify it pays this wallet, take it into the wallet at
 * once, and answer the payer. Ported from BSV Desktop's `directPayments.ts` (receive half).
 *
 * A payment is internalized like an inbox payment: protocol `wallet payment`, label `peerpay`,
 * and the sender's note (else their abbreviated key) as the description (`creditDescription`),
 * so a payment reads the same in Activity whichever way it came.
 *
 * Once. Every payment has a {@link paymentKey}; the seen store records the ones this wallet
 * took, and the inbox credit path (`internalizeIncoming` with `seen`) reads and writes the same
 * store. So a payment that arrives live and again through the message box (the payer's link
 * dropped before the ack, so it sent the same token there) is credited, and announced, once.
 *
 * Kept. A failure `classifyCreditError` calls environmental (offline, headers behind, a locked
 * database, or no broadcaster could take the payment when internalizeAction posted it) keeps
 * the payment on this device and answers `received`: by then the payer may
 * broadcast it, so it is better kept than refused. Anything else is refused (`rejected`), which
 * is safe at that point because the payer still has the payment and sends it through the
 * message box instead. A kept payment was acknowledged, so its payer will not send it again,
 * and only this device has its derivation: it is never dropped until the wallet has it.
 * {@link retryKeptDirectPayments} offers it again; one the wallet refuses outright (it does not
 * pay this wallet, or its inputs were double spent), or still cannot take after
 * {@link NEEDS_ATTENTION_ATTEMPTS} counted tries more than a day after it arrived, is flagged as
 * needing attention, and only the user may dismiss it.
 *
 * Both lists live in the device store (`deviceKVStorage`), keyed by identity key and network,
 * so they outlive the wallet's database. A kept list this version cannot read is never written
 * over (no payment is kept while it is unreadable), and entries it does not recognise are
 * written back as they were: either may hold the only copy of a payment.
 */
import { Transaction, Utils } from '@bsv/sdk'
import type { KVStorage } from '../localpay/pending'
import type { CreditFailureKind } from '../pay/creditErrors'
import { creditDescription } from '../pay/rails/handle'
import { getDirectPayConfig } from '../toolboxConfig'
import { deviceKVStorage } from './deviceStore'
import { paymentKey } from './paymentKey'
import {
  isWebRTPayError,
  type DirectPaySeenStore,
  type IncomingDirectPayment,
  type WebRTPayModule,
  type WebRTPayWallet
} from './webrtpay'

/** Payment keys remembered per wallet and network, newest kept. */
export const SEEN_LIMIT = 2000
/** Payments waiting for the wallet; a new one is refused while this many wait (those needing attention do not count). */
export const KEPT_LIMIT = 50
/** Characters of stored kept-list JSON (transactions are kept as base64). */
export const KEPT_BUDGET = 1_000_000
/**
 * A kept payment the wallet still cannot take needs attention only after this many counted
 * tries AND this long after it arrived, so a lagging chain tracker has time to catch up.
 * Environmental failures do not count as tries.
 */
export const NEEDS_ATTENTION_ATTEMPTS = 5
export const NEEDS_ATTENTION_AGE_MS = 24 * 60 * 60 * 1000

export const DIRECT_PAY_SEEN_PREFIX = 'direct_pay_seen_v1:'
export const KEPT_DIRECT_PAYMENTS_PREFIX = 'direct_pay_kept_v1:'

const seenStorageKey = (identity: string, chain: string) => `${DIRECT_PAY_SEEN_PREFIX}${identity}:${chain}`
const keptStorageKey = (identity: string, chain: string) => `${KEPT_DIRECT_PAYMENTS_PREFIX}${identity}:${chain}`

/** Reasons sent to the payer: fixed text, so nothing about this wallet's internals leaks. */
const NOT_ACCEPTED = 'The wallet could not verify or record this payment'
const CANNOT_KEEP = 'The wallet cannot take payments right now; try again later'

/** Where a wallet's direct-pay lists are kept, and which wallet and network they are for. */
export interface DirectPayStore {
  storage: KVStorage
  identity: string
  chain: string
}

// ---- storage ------------------------------------------------------------------------------

// The live receive, the inbox credit pass and a retry pass can all change one list. Serialize
// each list's whole read-modify-write (as outbox.ts does), so one cannot write back a stale copy
// over a payment another just kept.
const tails = new WeakMap<KVStorage, Map<string, Promise<void>>>()

function locked<T>(storage: KVStorage, key: string, fn: () => Promise<T>): Promise<T> {
  let byKey = tails.get(storage)
  if (!byKey) tails.set(storage, (byKey = new Map()))
  const run = (byKey.get(key) ?? Promise.resolve()).then(fn)
  byKey.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** The list stored under `key` (none stored reads as empty), or null when it cannot be read. */
async function readArray(storage: KVStorage, key: string): Promise<unknown[] | null> {
  try {
    const value: unknown = JSON.parse((await storage.getKeyValue(key)) ?? '[]')
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Which payments this wallet already took, by {@link paymentKey}, shared by the live receive
 * and the inbox credit path. Unreadable counts as empty: a lost record only means a redelivery
 * is offered to the wallet again, which keeps the output it already has. `add` never throws.
 */
export function createDirectPaySeenStore({ storage, identity, chain }: DirectPayStore): DirectPaySeenStore {
  const key = seenStorageKey(identity, chain)
  const read = async () => ((await readArray(storage, key)) ?? []).filter((k): k is string => typeof k === 'string')
  return {
    has: async paymentKey => (await read()).includes(paymentKey),
    add: paymentKey =>
      locked(storage, key, async () => {
        const keys = [...(await read()).filter(k => k !== paymentKey), paymentKey].slice(-SEEN_LIMIT)
        try {
          await storage.setKeyValue(key, JSON.stringify(keys))
        } catch {
          // The wallet has the payment by now; see above.
        }
      })
  }
}

/**
 * The seen store the inbox credit path passes to `internalizeIncoming`: this wallet's, in the
 * device store. Undefined when this build does not offer direct payments (nothing arrives live,
 * so there is nothing to credit twice) or the identity key is not known yet.
 */
export function inboxSeenStore(identity: string | undefined, chain: string): DirectPaySeenStore | undefined {
  if (!identity || getDirectPayConfig()?.enabled !== true) return undefined
  return createDirectPaySeenStore({ storage: deviceKVStorage, identity, chain })
}

// ---- receiving ----------------------------------------------------------------------------

/** What became of a payment from a peer. */
export interface DirectReceipt {
  /** The ack for the payer: in the wallet, or kept on this device until the wallet can take it. */
  status: 'accepted' | 'received'
  /**
   * This wallet had already taken or kept this payment (the payer delivered it again after
   * losing the ack, or it came through the inbox first). Announce a payment only when false.
   */
  repeat: boolean
  /** The wallet took the payment just now, so its balance changed (a kept one on redelivery too). */
  added: boolean
}

/**
 * Takes a payment from an authenticated peer into the wallet (once; see
 * {@link createDirectPaySeenStore}) and returns the ack. A failure `classify` calls
 * environmental keeps it for {@link retryKeptDirectPayments} and answers `received`.
 *
 * @throws a `WebRTPayError` for the payer, which the client turns into a `rejected` ack:
 * `invalid_payment` when it does not pay this wallet, `rejected` when the wallet refuses it or
 * it cannot be kept. Nothing is stored then; the payer still has the payment.
 */
export async function receiveDirectPayment(o: {
  webrtpay: Pick<WebRTPayModule, 'acceptDirectPayment' | 'WebRTPayError'>
  wallet: WebRTPayWallet
  originator: string
  store: DirectPayStore
  payment: IncomingDirectPayment
  /** The sender's note, from the link (`onPayment`'s `ctx.note`). */
  note?: string
  classify: (e: unknown) => CreditFailureKind
}): Promise<DirectReceipt> {
  const { webrtpay, store } = o
  let result: { txid: string; status: 'accepted' | 'duplicate' }
  try {
    result = await webrtpay.acceptDirectPayment(o.wallet, o.payment, {
      originator: o.originator,
      seen: createDirectPaySeenStore(store),
      labels: ['peerpay'],
      description: creditDescription(o.note, o.payment.sender)
    })
  } catch (error) {
    if (isWebRTPayError(webrtpay, error)) throw error
    if (o.classify(error) !== 'environmental') {
      throw new webrtpay.WebRTPayError('rejected', NOT_ACCEPTED, { cause: error })
    }
    const kept = await keepForRetry(webrtpay, store, toEntry(o.payment, o.note, error))
    return { status: 'received', repeat: !kept, added: false }
  }
  // A payment kept earlier was announced when it was kept.
  const wasKept = await forget(store, keyOf(o.payment, result.txid))
  return { status: 'accepted', repeat: result.status === 'duplicate' || wasKept, added: result.status === 'accepted' }
}

// ---- kept payments ------------------------------------------------------------------------

/**
 * Thrown by a retry pass's `run` to end the pass early (its time is up); the payment it was
 * about to offer, and every one after it, stays as it is for the next pass.
 */
export class RetryStopped extends Error {
  constructor(message = 'The retry pass stopped early') {
    super(message)
    this.name = 'RetryStopped'
  }
}

/** Why the wallet could not add a kept payment after retrying, so the user should look at it. */
export interface NeedsAttention {
  since: number
  /**
   * `refused`: it does not pay this wallet, or its inputs were double spent. `unverifiable`: the
   * wallet still could not take it after {@link NEEDS_ATTENTION_ATTEMPTS} tries, more than a day
   * after it arrived.
   */
  reason: 'refused' | 'unverifiable'
}

/** A kept payment as stored: everything needed to take it into the wallet. */
export interface KeptDirectPayment {
  messageId: string
  /** The payer's identity key. */
  sender: string
  note?: string
  token: {
    customInstructions: { derivationPrefix: string; derivationSuffix: string }
    /** Atomic BEEF, base64. */
    transaction: string
    amount: number
    outputIndex: number
  }
}

/** A payment kept on this device, acknowledged as received, that the wallet has not taken yet. */
export interface KeptDirectPaymentInfo {
  /** {@link paymentKey}: one entry per payment output. */
  key: string
  txid: string
  sender: string
  amount: number
  receivedAt: number
  /** Failed retries counted towards needing attention. */
  attempts: number
  /** The last failure (local text; never sent to the payer). */
  error: string
  /** Set once retrying stopped looking likely to work; the payment is still kept and retried. */
  needsAttention?: NeedsAttention
  payment: KeptDirectPayment
}

/**
 * Offers kept payments to the wallet again. One the wallet takes (or already has) leaves the
 * list; nothing else ever does. A failed retry is judged with `classify`: environmental is not
 * counted; double spent, or `invalid_payment` from the package, flags it as needing attention at
 * once; anything else counts a try, and needs attention after {@link NEEDS_ATTENTION_ATTEMPTS}
 * tries more than {@link NEEDS_ATTENTION_AGE_MS} after it arrived.
 *
 * `onNeedsAttention` hears of each payment once, when it is first flagged. Payments that need
 * attention are offered only with `includeNeedsAttention`. Each payment's wallet call goes
 * through `run`, which may throw {@link RetryStopped} to end the pass there. Returns how many
 * payments the wallet took. Run it single-flight per wallet.
 */
export async function retryKeptDirectPayments(o: {
  webrtpay: Pick<WebRTPayModule, 'acceptDirectPayment' | 'WebRTPayError'>
  wallet: WebRTPayWallet
  originator: string
  store: DirectPayStore
  classify: (e: unknown) => CreditFailureKind
  includeNeedsAttention?: boolean
  onNeedsAttention?: (kept: KeptDirectPaymentInfo) => void
  run?: <T>(call: () => Promise<T>) => Promise<T>
}): Promise<number> {
  const { webrtpay, store } = o
  const seen = createDirectPaySeenStore(store)
  const run = o.run ?? (<T>(call: () => Promise<T>) => call())
  let accepted = 0
  for (const entry of (await readKept(store))?.entries ?? []) {
    if (entry.needsAttention && !o.includeNeedsAttention) continue
    try {
      const result = await run(() =>
        webrtpay.acceptDirectPayment(o.wallet, toIncoming(entry), {
          originator: o.originator,
          seen,
          labels: ['peerpay'],
          description: creditDescription(entry.payment.note, entry.payment.sender)
        })
      )
      if (result.status === 'accepted') accepted++
    } catch (error) {
      if (error instanceof RetryStopped) break
      const verdict = retryVerdict(webrtpay, o.classify, error)
      if (verdict === 'temporary') continue
      const failed: KeptEntry = { ...entry, error: messageOf(error).slice(0, 500) }
      if (!entry.needsAttention) {
        if (verdict === 'unproven') failed.attempts = entry.attempts + 1
        const tooLong =
          failed.attempts >= NEEDS_ATTENTION_ATTEMPTS && Date.now() - entry.receivedAt > NEEDS_ATTENTION_AGE_MS
        if (verdict === 'refused' || tooLong) {
          failed.needsAttention = { since: Date.now(), reason: verdict === 'refused' ? 'refused' : 'unverifiable' }
        }
      }
      // Kept either way. If this write fails, the try is just not counted (or flagged) yet.
      if ((await rewrite(store, entry.key, () => failed)) === true && failed.needsAttention && !entry.needsAttention) {
        try {
          o.onNeedsAttention?.(infoOf(failed))
        } catch {
          // The flag is stored; the list shows it.
        }
      }
      continue
    }
    await forget(store, entry.key)
  }
  return accepted
}

/** A wallet's kept-payment list as this device holds it. */
export interface KeptDirectPaymentsList {
  /** The kept payments this version can read, oldest first. */
  payments: KeptDirectPaymentInfo[]
  /** The stored list cannot be read. It is left as it is, and no payment is kept until it can be. */
  unreadable: boolean
  /** Stored entries this version does not recognise; they are kept as they are. */
  unknown: number
}

/** The open wallet's kept payments. */
export async function listKeptDirectPayments(store: DirectPayStore): Promise<KeptDirectPaymentsList> {
  const stored = await readKept(store)
  if (!stored) return { payments: [], unreadable: true, unknown: 0 }
  return { payments: stored.entries.map(infoOf), unreadable: false, unknown: stored.unknown }
}

/**
 * Removes a kept payment because the user dismissed it. Only one that needs attention can go
 * (the others are still being retried), and the screen offers it only after its recovery
 * details were copied. Returns false when it is no longer kept (the wallet took it meanwhile).
 * Throws, removing nothing, when it does not need attention or the list cannot be written.
 */
export async function dismissKeptDirectPayment(store: DirectPayStore, key: string): Promise<boolean> {
  const stored = await readKept(store)
  if (!stored) throw new Error('The direct payments kept on this device could not be read, so nothing was removed.')
  const entry = stored.entries.find(e => e.key === key)
  if (!entry) return false
  if (!entry.needsAttention)
    throw new Error('Only a payment that needs attention can be dismissed; this one is still being retried.')
  const removed = await rewrite(store, key, () => undefined)
  if (removed === undefined) return false
  if (!removed) throw new Error('This payment could not be removed from this device. Try again.')
  return true
}

/**
 * Retry time: the payer no longer has the payment, so anything not known to be final keeps it.
 * `refused` is final: it does not pay this wallet (`invalid_payment`), or its inputs were
 * double spent. Environmental failures are `temporary` and not counted; the rest `unproven`.
 */
function retryVerdict(
  webrtpay: Pick<WebRTPayModule, 'WebRTPayError'>,
  classify: (e: unknown) => CreditFailureKind,
  error: unknown
): 'refused' | 'temporary' | 'unproven' {
  if (isWebRTPayError(webrtpay, error)) return error.code === 'invalid_payment' ? 'refused' : 'unproven'
  switch (classify(error)) {
    case 'environmental':
      return 'temporary'
    case 'double_spend':
      return 'refused'
    default:
      return 'unproven'
  }
}

/** A kept payment as stored. */
interface KeptEntry {
  key: string
  payment: KeptDirectPayment
  error: string
  receivedAt: number
  attempts: number
  needsAttention?: NeedsAttention
}

function infoOf(entry: KeptEntry): KeptDirectPaymentInfo {
  const { key, payment, error, receivedAt, attempts, needsAttention } = entry
  return {
    key,
    txid: key.split(':')[0],
    sender: payment.sender,
    amount: payment.token.amount,
    receivedAt,
    attempts,
    error,
    ...(needsAttention && { needsAttention }),
    payment
  }
}

/**
 * Adds the payment to the kept list, once; returns false when it was already there. Nothing
 * kept is ever dropped to make room: a payment that cannot be kept is refused instead (the
 * payer still has it), as is every payment while the stored list cannot be read.
 */
function keepForRetry(
  webrtpay: Pick<WebRTPayModule, 'WebRTPayError'>,
  store: DirectPayStore,
  entry: KeptEntry
): Promise<boolean> {
  const key = keptStorageKey(store.identity, store.chain)
  return locked(store.storage, key, async () => {
    try {
      const stored = await readKept(store)
      if (!stored) throw new Error('The kept payments on this device cannot be read.')
      if (stored.entries.some(e => e.key === entry.key)) return false
      if (stored.entries.filter(e => !e.needsAttention).length >= KEPT_LIMIT) {
        throw new Error('Too many payments are waiting for the wallet.')
      }
      const text = JSON.stringify([...stored.items, entry])
      if (text.length > KEPT_BUDGET) throw new Error('No room to keep this payment.')
      await store.storage.setKeyValue(key, text)
      return true
    } catch (cause) {
      throw new webrtpay.WebRTPayError('rejected', CANNOT_KEEP, { cause })
    }
  })
}

/** Removes a payment from the kept list and says whether it was there. A failed write leaves it. */
async function forget(store: DirectPayStore, key: string): Promise<boolean> {
  return (await rewrite(store, key, () => undefined)) !== undefined
}

/**
 * Replaces (`change` returns an entry) or removes (it returns undefined) the stored entry for
 * `key`, from the list as stored now. Every other stored item, recognised or not, is written
 * back exactly as it was read. Returns undefined when nothing was there to change (or the list
 * cannot be read: it is never written over), else whether the write succeeded.
 */
function rewrite(
  store: DirectPayStore,
  key: string,
  change: (entry: KeptEntry) => KeptEntry | undefined
): Promise<boolean | undefined> {
  const storageKey = keptStorageKey(store.identity, store.chain)
  return locked(store.storage, storageKey, async () => {
    const stored = await readKept(store)
    const index = stored?.items.findIndex(item => toKeptEntry(item)?.key === key) ?? -1
    if (!stored || index < 0) return undefined
    const replacement = change(toKeptEntry(stored.items[index])!)
    const items = stored.items.flatMap((item, i) => (i !== index ? [item] : replacement ? [replacement] : []))
    try {
      await store.storage.setKeyValue(storageKey, JSON.stringify(items))
    } catch {
      return false // the stored list stays as it was
    }
    return true
  })
}

/** Every stored item, and the recognised entries; null when the list itself cannot be read. */
async function readKept(
  store: DirectPayStore
): Promise<{ items: unknown[]; entries: KeptEntry[]; unknown: number } | null> {
  const items = await readArray(store.storage, keptStorageKey(store.identity, store.chain))
  if (!items) return null
  const entries = items.map(toKeptEntry).filter((e): e is KeptEntry => e !== undefined)
  return { items, entries, unknown: items.length - entries.length }
}

/** A stored item as a kept payment, or undefined when it is not one this version can retry. */
function toKeptEntry(e: unknown): KeptEntry | undefined {
  const item = e as Partial<KeptEntry> | null
  const payment = item?.payment
  const token = payment?.token
  const derivation = token?.customInstructions
  const recognised =
    typeof item?.key === 'string' &&
    typeof payment?.messageId === 'string' &&
    typeof payment.sender === 'string' &&
    typeof token?.transaction === 'string' &&
    Number.isSafeInteger(token.amount) &&
    Number.isSafeInteger(token.outputIndex) &&
    token.outputIndex >= 0 &&
    typeof derivation?.derivationPrefix === 'string' &&
    typeof derivation.derivationSuffix === 'string'
  if (!recognised || !item) return undefined
  const { needsAttention, ...rest } = item as KeptEntry
  return {
    ...rest,
    error: typeof item.error === 'string' ? item.error : '',
    attempts: Number.isSafeInteger(item.attempts) && item.attempts! > 0 ? item.attempts! : 0,
    receivedAt: Number.isFinite(item.receivedAt) ? item.receivedAt! : Date.now(),
    ...(isNeedsAttention(needsAttention) && { needsAttention })
  }
}

function isNeedsAttention(x: unknown): x is NeedsAttention {
  const n = x as Partial<NeedsAttention> | undefined
  return Number.isFinite(n?.since) && (n?.reason === 'refused' || n?.reason === 'unverifiable')
}

/** Same output index rule as the package: the token's, else the payment's, else 0. */
const outputIndexOf = (p: IncomingDirectPayment) => p.token.outputIndex ?? p.outputIndex ?? 0

const keyOf = (p: IncomingDirectPayment, txid: string) =>
  paymentKey(
    txid,
    outputIndexOf(p),
    p.token.customInstructions.derivationPrefix,
    p.token.customInstructions.derivationSuffix
  )

function toEntry(p: IncomingDirectPayment, note: string | undefined, error: unknown): KeptEntry {
  const {
    transaction,
    amount,
    customInstructions: { derivationPrefix, derivationSuffix }
  } = p.token
  const outputIndex = outputIndexOf(p)
  return {
    key: keyOf(p, Transaction.fromAtomicBEEF(transaction).id('hex')),
    payment: {
      messageId: p.messageId,
      sender: p.sender,
      ...(note ? { note } : {}),
      token: {
        customInstructions: { derivationPrefix, derivationSuffix },
        transaction: Utils.toBase64(transaction),
        amount,
        outputIndex
      }
    },
    error: messageOf(error).slice(0, 500),
    receivedAt: Date.now(),
    attempts: 0
  }
}

function toIncoming(entry: KeptEntry): IncomingDirectPayment {
  const { messageId, sender, token } = entry.payment
  return { messageId, sender, token: { ...token, transaction: Utils.toArray(token.transaction, 'base64') } }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
