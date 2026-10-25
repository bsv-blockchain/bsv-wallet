/**
 * The handle rail's token half (plan 07 Task 13): hand-over send, MessageBox
 * redelivery and inbox receive over the `mandala-color` box (IC §7.2).
 *
 * `@bsv/mandala` builds, parses, verifies and settles (design §9 B7); the
 * color module holds custody; the host ledger records what this host
 * verified; this file only orders the steps and keeps the wallet's
 * `color_transfers` journal true to them.
 *
 * Send, in this order (stability mandate):
 *  1. Refuse what the request alone decides (amount domain, recipient) and a
 *     second send of the same asset while one is in flight. The latch is taken
 *     with no await before it, so a double tap sees it.
 *  2. `sendHandover` builds and signs `noSend`, builds the envelope from the
 *     host wallet's own custody and records the hand-over `pending` in the
 *     host ledger. Nobody has the bytes yet.
 *  3. Keep the v4 body (for redelivery), then journal the row `handed_over`
 *     (W4) BEFORE delivering: a lost MessageBox
 *     response may still have delivered, so from here the abort guard refuses
 *     and the broadcast hold holds. A crash before this insert leaves a signed
 *     action no recipient has seen; with no row the guard lets it be released.
 *     A journal FAULT here is answered by releasing the action, never by
 *     delivering bytes the journal does not know.
 *  4. `deliverHandover`. Success is the ACK (IC §7.2) and is journaled.
 *     Failure is still `sent`: a second send would be a second payment. The
 *     tick redelivers it (`redeliverPending`).
 *  5. Only a delivered hand-over is named to `settleNow` (post-ACK submit,
 *     B5), and only when online, raced against a timeout so a slow overlay
 *     never holds the payer's screen. The settle keeps running.
 *
 * Redelivery and resend send the v4 body kept at send time (`bodies`): the
 * exact bytes, receipt fields and evidence the first delivery carried. They
 * never contact the overlay. A resend reads the body, and opens the box,
 * BEFORE it hands a parked payment over: a resend that cannot deliver leaves
 * the row exactly as it found it.
 *
 * Receive runs the lib's recipient path with the host ledger (online submit,
 * or offline COVER with the S1 hop checks), which records what it verified
 * before the plain receipt is internalized. A credit is journaled `settled`
 * when the ledger says σ was verified and `held` when it was credited on
 * COVER evidence (`offline`); `settleNow`/the drain settles a held one.
 */
import { Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import {
  MAX_UINT64,
  deliverHandover,
  receiveHandovers,
  sendHandover,
  type HandoverBodyV4,
  type HandoverResult,
  type HostLedger,
  type MessageBoxLike,
  type MessageBoxSender
} from '@bsv/mandala'
import { devLog } from '../logging'
import type { TokenSendResult, TokenSettleState } from './runtime'
import type { TransferJournal } from './transferJournal'
import type { ColorTransferRow, ColorTransferState } from './types'

/** The MessageBox surface the hand-over send and receive need, as one structural type. */
export type MandalaMessageBox = MessageBoxSender & MessageBoxLike

export interface HandleDeps {
  /** The PUBLISHED manager, bound to the admin originator. */
  wallet: WalletInterface
  identityKey: () => Promise<string>
  journal: TransferJournal
  /** The host's UNDERLYING wallet: the hand-over envelope is built from its custody. */
  hostWallet: WalletInterface
  /** The host ledger shared with the issuer-v1 handler. */
  ledger: HostLedger
  /** The settler's `markSettled` (module flag, then journal row). */
  markSettled: (txid: string) => Promise<void>
  /** The v4 bodies of this device's own hand-overs, kept for redelivery. */
  bodies: HandoverBodies
  messageBox: () => Promise<MandalaMessageBox>
  settleNow: (txid: string) => Promise<TokenSettleState>
  isOnline: () => Promise<boolean>
  /** Message ids this session already handled (the lib's dedupe set). */
  processed: Set<string>
  now: () => Date
  /** Plain reason a recipient cannot receive tokens, or null. */
  recipientRefusal: (recipient: string) => string | null
  /**
   * Moves `held` receipts to `settled` when the module inventory shows no
   * unsettled record for them (the runtime's `reconcileHeld`). A view fault
   * leaves them held.
   */
  reconcileHeld: (txids: readonly string[]) => Promise<void>
  /** Journal or delivery state changed. */
  onChange?: () => void
  /** How long a send waits for its own settle before returning. Default 8 000 ms. */
  settleTimeoutMs?: number
}

const DEFAULT_SETTLE_TIMEOUT_MS = 8_000

/**
 * Where the v4 body of each own hand-over is kept for redelivery: the lib is
 * run with `journal: false`, and the host ledger keeps the bytes but not the
 * receipt fields or the σ / envelope evidence the body carries.
 */
export interface HandoverBodies {
  /** Durable before it resolves; a failure throws. */
  put(txid: string, body: HandoverBodyV4): Promise<void>
  /** The stored body, or undefined when there is none (or it is unreadable). */
  get(txid: string): Promise<HandoverBodyV4 | undefined>
}

/** KV key of an own hand-over's v4 body. */
export function handoverBodyKey(txid: string): string {
  return `bsvwallet.color.handover.${txid}`
}

/** `HandoverBodies` over the wallet's key-value table. */
export function createHandoverBodies(kv: {
  getKeyValue(key: string): Promise<string | undefined>
  setKeyValue(key: string, value: string): Promise<void>
}): HandoverBodies {
  return {
    put: async (txid, body) => {
      await kv.setKeyValue(handoverBodyKey(txid), JSON.stringify(body))
    },
    get: async txid => {
      const text = await kv.getKeyValue(handoverBodyKey(txid))
      if (text === undefined) return undefined
      try {
        const body = JSON.parse(text) as HandoverBodyV4
        return body?.v === 4 && body.kind === 'handover' ? body : undefined
      } catch {
        return undefined
      }
    }
  }
}

/** The subject txid of a v4 body's AtomicBEEF, or undefined when unreadable. */
function bodyTxid(body: HandoverBodyV4): string | undefined {
  try {
    return Transaction.fromAtomicBEEF(Utils.toArray(body.transaction, 'hex')).id('hex')
  } catch {
    return undefined
  }
}

/** Errors the module/lib throw for a profile or argument fault: a refusal, nothing was sent. */
const REFUSAL_ERROR_NAMES = new Set([
  'UnsupportedProfileError',
  'ProfileParamsError',
  'ProfileDataError',
  // The user's own "no" at the spend prompt.
  'ColorConsentDeclinedError'
])

// Per-deps state. One `HandleDeps` is built per runtime, so these are per
// runtime; a WeakMap lets a discarded runtime take its state with it.
const sendLatches = new WeakMap<HandleDeps, Set<string>>()
const deliveringTxids = new WeakMap<HandleDeps, Set<string>>()
const redeliverFlights = new WeakMap<HandleDeps, Promise<number>>()
const receiveFlights = new WeakMap<HandleDeps, Promise<{ credited: number; failed: number; incomplete?: true }>>()

function setOf(map: WeakMap<HandleDeps, Set<string>>, d: HandleDeps): Set<string> {
  let s = map.get(d)
  if (!s) {
    s = new Set()
    map.set(d, s)
  }
  return s
}

function notify(d: HandleDeps): void {
  try {
    d.onChange?.()
  } catch (e) {
    devLog('[mandala] handle: a change listener threw:', e)
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `e.name`, or the `[ClassName] ` message marker a bridged error keeps (IC D22). */
function errorName(e: unknown): string | undefined {
  const name = (e as { name?: unknown } | null)?.name
  if (typeof name === 'string' && name !== 'Error') return name
  return /^\[([A-Za-z]+Error)\]/.exec(messageOf(e))?.[1]
}

/** Maps a `sendHandover` throw on `.name` (IC §2.4, D22). */
export function sendErrorResult(e: unknown): TokenSendResult {
  const name = errorName(e)
  const message = messageOf(e)
  if (name !== undefined && REFUSAL_ERROR_NAMES.has(name)) return { kind: 'refused', code: name, message }
  if (name === 'ColorProviderError') {
    const { code, transport } = e as { code?: unknown; transport?: unknown }
    if (transport !== true) return { kind: 'refused', code: typeof code === 'string' ? code : name, message }
  }
  return { kind: 'unavailable', message }
}

/** `settleNow(txid)` when online, raced against the timeout. `undefined` when not asked or not answered. */
async function settleSoon(d: HandleDeps, txid: string): Promise<TokenSettleState | undefined> {
  let online = false
  try {
    online = await d.isOnline()
  } catch (e) {
    devLog('[mandala] handle: the connectivity probe failed; not settling now:', e)
  }
  if (!online) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), d.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      d.settleNow(txid).catch((e: unknown) => {
        devLog(`[mandala] handle: settling ${txid} failed:`, e)
        return undefined
      }),
      timeout
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Best-effort release of a signed action nobody has seen. The abort guard
 * decides. Once released, the host ledger stops vouching for its change
 * (`sendHandover` recorded it `pending`), as the lib does for its own release.
 */
export async function releaseUnseenHandover(
  d: { wallet: WalletInterface; ledger: HostLedger },
  h: Pick<HandoverResult, 'txid' | 'reference' | 'receipt'>
): Promise<void> {
  let released = false
  try {
    const r = await d.wallet.abortAction({ reference: h.reference })
    released = r?.aborted === true
    if (!released) devLog(`[mandala] the unjournaled hand-over ${h.txid} was not released`)
  } catch (e) {
    devLog(`[mandala] releasing the unjournaled hand-over ${h.txid} failed:`, e)
  }
  if (!released) return
  try {
    await d.ledger.put({
      v: 1,
      txid: h.txid,
      assetId: h.receipt.assetId,
      state: 'refused',
      own: true,
      outputs: [],
      code: 'ERR_RELEASED',
      at: Date.now()
    })
  } catch (e) {
    devLog(`[mandala] the released hand-over ${h.txid} is still recorded pending in the host ledger:`, e)
  }
}

export async function sendToHandle(
  d: HandleDeps,
  a: { assetId: string; recipientIdentityKey: string; units: bigint; note?: string }
): Promise<TokenSendResult> {
  // Everything up to the latch is synchronous: a double tap must see it.
  const units = a.units
  if (typeof units !== 'bigint' || units < 1n || units > MAX_UINT64) {
    return {
      kind: 'refused',
      code: 'ERR_INVALID_AMOUNT',
      message: 'A token amount must be a whole number from 1 to 18446744073709551615 base units'
    }
  }
  const refusal = d.recipientRefusal(a.recipientIdentityKey)
  if (refusal !== null) return { kind: 'refused', code: 'ERR_RECIPIENT', message: refusal }
  const latch = setOf(sendLatches, d)
  if (latch.has(a.assetId)) {
    return {
      kind: 'refused',
      code: 'ERR_SEND_IN_FLIGHT',
      message: 'A payment of this token is already being sent; wait for it to finish'
    }
  }
  latch.add(a.assetId)
  try {
    return await runSend(d, { ...a, units, recipientKey: a.recipientIdentityKey.trim().toLowerCase() })
  } finally {
    latch.delete(a.assetId)
  }
}

async function runSend(
  d: HandleDeps,
  a: { assetId: string; recipientKey: string; units: bigint; note?: string }
): Promise<TokenSendResult> {
  let identityKey: string
  try {
    identityKey = await d.identityKey()
  } catch (e) {
    return { kind: 'unavailable', message: messageOf(e) }
  }
  const note = a.note !== undefined && a.note.trim() !== '' ? a.note : undefined

  let h: HandoverResult
  try {
    h = await sendHandover({
      wallet: d.wallet,
      identityKey,
      assetId: a.assetId,
      amount: a.units,
      recipientKey: a.recipientKey,
      ...(note !== undefined ? { note } : {}),
      hostWallet: d.hostWallet,
      ledger: d.ledger,
      // The wallet owns this send's durability: the `color_transfers` row
      // (written next), the kept body and the host ledger. The lib's txJournal would
      // keep a 'signed'/'delivered' entry holding the tx hex that only
      // `settleHandover`/`reconcileWallet` clear, and this wallet runs
      // neither, so with the default it grew by one tx per send. The lib's
      // precondition for `false` (run `reconcileWallet` with `sweep: false`)
      // holds vacuously: no sweep runs here at all.
      journal: false
    })
  } catch (e) {
    return sendErrorResult(e)
  }

  // Signed. From here nothing may throw out, and nothing is delivered that
  // the journal does not hold.
  const self = a.recipientKey === identityKey.toLowerCase()
  const delivering = setOf(deliveringTxids, d)
  delivering.add(h.txid)
  try {
    try {
      // The body first: a row that can be redelivered must have one.
      await d.bodies.put(h.txid, h.body)
      const wrote = await d.journal.insert({
        txid: h.txid,
        role: 'sent',
        state: 'handed_over',
        // A send to self owes no delivery: nothing for the tick to redeliver.
        delivered: self,
        reference: h.reference,
        rail: 'handle',
        units: a.units,
        counterpartyKey: a.recipientKey,
        outputIndex: h.outputIndex,
        assetId: a.assetId,
        ...(note !== undefined ? { note } : {}),
        derivationPrefix: h.receipt.derivationPrefix,
        derivationSuffix: h.receipt.derivationSuffix,
        senderIdentityKey: h.receipt.senderIdentityKey
      })
      if (!wrote) {
        // A fresh txid cannot already have a row unless this very send was
        // journaled before; anything else is not ours to deliver.
        const existing = await d.journal.get(h.txid)
        if (existing?.role !== 'sent' || existing.reference !== h.reference) {
          await releaseUnseenHandover(d, h)
          return { kind: 'unavailable', message: `color_transfers already holds ${h.txid} for another transfer` }
        }
      }
    } catch (e) {
      devLog(`[mandala] handle: journaling the hand-over ${h.txid} failed; releasing it undelivered:`, e)
      await releaseUnseenHandover(d, h)
      return { kind: 'unavailable', message: messageOf(e) }
    }
    notify(d)

    let delivered = self
    if (!self) {
      try {
        await deliverHandover({
          messageBoxClient: await d.messageBox(),
          recipientKey: a.recipientKey,
          handover: h
        })
        delivered = true
      } catch (e) {
        devLog(`[mandala] handle: delivering ${h.txid} failed; the tick redelivers it:`, e)
      }
      if (delivered) await markDelivered(d, h.txid)
    }

    let settled = false
    if (delivered) settled = (await settleSoon(d, h.txid)) === 'settled'
    return { kind: 'sent', txid: h.txid, settled, notified: delivered }
  } finally {
    delivering.delete(h.txid)
  }
}

/** Journals a delivery. A failed write only means a harmless duplicate redelivery later. */
async function markDelivered(d: HandleDeps, txid: string): Promise<void> {
  try {
    await d.journal.setDelivered(txid, true)
    notify(d)
  } catch (e) {
    devLog(`[mandala] handle: recording the delivery of ${txid} failed:`, e)
  }
}

/** States a sent row may be (re)delivered from without a transition. */
const DELIVERABLE_STATES: readonly ColorTransferState[] = ['handed_over', 'settled']
/** The payer's own states: delivering hands it over, so the row moves first (W4). */
const UNHANDED_STATES: readonly ColorTransferState[] = ['built', 'parked']

type DeliverOutcome = 'resent' | 'not-found' | 'unavailable'

/** Everything a (re)delivery needs, gathered before anything is changed. */
interface PreparedDelivery {
  recipientKey: string
  handover: Pick<HandoverResult, 'txid' | 'body'>
  box: MandalaMessageBox
}

/**
 * Reads the kept v4 body of a sent row and opens the box. Reads only: the
 * body must be present and carry the row's own tx and asset, and the box must
 * open, or nothing is to be delivered.
 */
async function prepareRow(
  d: HandleDeps,
  row: ColorTransferRow
): Promise<PreparedDelivery | 'not-found' | 'unavailable'> {
  const { txid } = row
  if (
    row.role !== 'sent' ||
    !row.counterpartyKey ||
    !row.derivationPrefix ||
    !row.derivationSuffix ||
    !row.senderIdentityKey
  ) {
    return 'not-found'
  }
  let body: HandoverBodyV4 | undefined
  try {
    body = await d.bodies.get(txid)
  } catch (e) {
    devLog(`[mandala] handle: reading the kept body of ${txid} failed:`, e)
    return 'unavailable'
  }
  if (!body || body.assetId !== row.assetId || bodyTxid(body) !== txid) return 'not-found'
  let box: MandalaMessageBox
  try {
    box = await d.messageBox()
  } catch (e) {
    devLog(`[mandala] handle: the MessageBox for ${txid} could not be opened:`, e)
    return 'unavailable'
  }
  return { recipientKey: row.counterpartyKey, box, handover: { txid, body } }
}

/** Delivers a prepared hand-over and journals the ACK. */
async function deliverPrepared(d: HandleDeps, row: ColorTransferRow, p: PreparedDelivery): Promise<DeliverOutcome> {
  try {
    await deliverHandover({
      messageBoxClient: p.box,
      recipientKey: p.recipientKey,
      handover: p.handover
    })
  } catch (e) {
    devLog(`[mandala] handle: redelivering ${row.txid} failed:`, e)
    return 'unavailable'
  }
  await markDelivered(d, row.txid)
  return 'resent'
}

async function deliverRow(d: HandleDeps, row: ColorTransferRow): Promise<DeliverOutcome> {
  const prepared = await prepareRow(d, row)
  return typeof prepared === 'string' ? prepared : await deliverPrepared(d, row, prepared)
}

/**
 * Redelivers every sent hand-over whose delivery is not known to have
 * happened, whatever rail it first took: a parked nearby payment a resend
 * handed over, then failed to deliver, is owed a delivery too. (The nearby
 * rail journals a hand-over it confirmed over BLE `delivered: true`, so this
 * never re-sends one the recipient acknowledged.) Single-flight per runtime;
 * never throws. Returns how many were delivered. Each one delivered is then
 * named to `settleNow` (post-ACK).
 */
export function redeliverPending(d: HandleDeps): Promise<number> {
  const existing = redeliverFlights.get(d)
  if (existing) return existing
  const running = (async () => {
    let rows: ColorTransferRow[]
    try {
      rows = await d.journal.list({ states: ['handed_over'], role: 'sent' })
    } catch (e) {
      devLog('[mandala] handle: listing undelivered hand-overs failed:', e)
      return 0
    }
    const delivering = setOf(deliveringTxids, d)
    let count = 0
    for (const row of rows) {
      if (row.delivered || delivering.has(row.txid)) continue
      delivering.add(row.txid)
      try {
        if ((await deliverRow(d, row)) === 'resent') {
          count++
          await settleSoon(d, row.txid)
        }
      } catch (e) {
        devLog(`[mandala] handle: redelivering ${row.txid} failed:`, e)
      } finally {
        delivering.delete(row.txid)
      }
    }
    return count
  })()
  redeliverFlights.set(d, running)
  const clear = (): void => {
    if (redeliverFlights.get(d) === running) redeliverFlights.delete(d)
  }
  running.then(clear, clear)
  return running
}

/**
 * Re-delivers one sent hand-over over MessageBox, whatever rail it first took.
 *
 * Everything the delivery needs (custody fields, evidence, bytes, an open
 * box) is gathered first; a resend that cannot have them returns without
 * touching the row, so a parked payment stays parked and cancellable. Only
 * then is a payment not yet handed over (`built`/`parked`) journaled
 * `handed_over` (a compare-and-set: a concurrent cancel wins and nothing is
 * delivered), so the abort guard refuses from the moment the bytes may leave.
 * A delivery that fails after that stays `handed_over`, undelivered, for
 * `redeliverPending`: its bytes may have landed, so it is never parked again.
 *
 * Received rows and final refusals are `'not-found'`: there is nothing to
 * deliver. Never contacts the overlay.
 */
export async function resendTransfer(d: HandleDeps, txid: string): Promise<'resent' | 'not-found' | 'unavailable'> {
  let row: ColorTransferRow | undefined
  try {
    row = await d.journal.get(txid)
  } catch (e) {
    devLog(`[mandala] handle: reading ${txid} for a resend failed:`, e)
    return 'unavailable'
  }
  if (!row || row.role !== 'sent') return 'not-found'
  const unhanded = UNHANDED_STATES.includes(row.state)
  if (!unhanded && !DELIVERABLE_STATES.includes(row.state)) return 'not-found'
  const delivering = setOf(deliveringTxids, d)
  delivering.add(txid)
  try {
    const prepared = await prepareRow(d, row)
    if (typeof prepared === 'string') return prepared
    if (unhanded) {
      let moved: boolean
      try {
        moved = await d.journal.advance(txid, UNHANDED_STATES, 'handed_over')
      } catch (e) {
        devLog(`[mandala] handle: handing over ${txid} for a resend failed:`, e)
        return 'unavailable'
      }
      if (!moved) {
        // Moved under us (a cancel, a release, a refusal): re-read and decide again.
        let now: ColorTransferRow | undefined
        try {
          now = await d.journal.get(txid)
        } catch (e) {
          devLog(`[mandala] handle: re-reading ${txid} for a resend failed:`, e)
          return 'unavailable'
        }
        if (!now || !DELIVERABLE_STATES.includes(now.state)) return 'not-found'
        row = now
      } else {
        notify(d)
      }
    }
    return await deliverPrepared(d, row, prepared)
  } finally {
    delivering.delete(txid)
  }
}

const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/

/** What this session learned of each listed message: who sent it. */
interface ListedMessage {
  sender?: string
}

/**
 * Reads the sender of a listed hand-over, leniently: display data (the
 * counterparty) for credits the lib already verified, never a decision input.
 */
function readListed(message: unknown): [string, ListedMessage] | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const m = message as { messageId?: unknown; sender?: unknown }
  const id = typeof m.messageId === 'string' || typeof m.messageId === 'number' ? String(m.messageId) : undefined
  if (id === undefined) return undefined
  const out: ListedMessage = {}
  if (typeof m.sender === 'string' && IDENTITY_KEY.test(m.sender)) out.sender = m.sender
  return [id, out]
}

/**
 * Drains the `mandala-color` box through lib `receiveHandovers` (with the
 * host ledger: online submit or offline COVER, recorded before the plain
 * receipt is internalized) and journals each credit, `held` when it was
 * credited offline and `settled` when the ledger holds a verified σ. Held
 * ones are then offered to `reconcileHeld`. Single-flight per runtime.
 *
 * `incomplete: true` means the box could not be read at all, which is never
 * the same answer as an empty box. A journal fault after a credit is logged:
 * the broadcast hold treats a missing row as held, and `reconcileHeld`
 * journals the receipt from the module's inventory on the next tick.
 */
export function receiveFromInbox(d: HandleDeps): Promise<{ credited: number; failed: number; incomplete?: true }> {
  const existing = receiveFlights.get(d)
  if (existing) return existing
  const running = runReceive(d)
  receiveFlights.set(d, running)
  const clear = (): void => {
    if (receiveFlights.get(d) === running) receiveFlights.delete(d)
  }
  running.then(clear, clear)
  return running
}

async function runReceive(d: HandleDeps): Promise<{ credited: number; failed: number; incomplete?: true }> {
  const listed = new Map<string, ListedMessage>()
  let result: Awaited<ReturnType<typeof receiveHandovers>>
  try {
    const box = await d.messageBox()
    // Observe the listing the lib makes (no second request, no extra ack).
    const observed: MessageBoxLike = {
      listMessages: async args => {
        const messages = await box.listMessages(args)
        if (Array.isArray(messages)) {
          for (const m of messages) {
            const entry = readListed(m)
            if (entry) listed.set(entry[0], entry[1])
          }
        }
        return messages
      },
      acknowledgeMessage: async args => await box.acknowledgeMessage(args)
    }
    result = await receiveHandovers({
      wallet: d.wallet,
      messageBoxClient: observed,
      processed: d.processed,
      ledger: d.ledger,
      markSettled: d.markSettled
    })
  } catch (e) {
    devLog('[mandala] handle: the token inbox could not be read:', e)
    return { credited: 0, failed: 0, incomplete: true }
  }

  let changed = false
  for (const credit of result.accepted) {
    const seen = listed.get(String(credit.messageId))
    try {
      // `offline` is the host ledger's own state for this tx (B7): `pending`
      // (COVER evidence, not yet admitted) or `settled` (σ verified by this
      // host). A row already `held` is moved by markSettled, never here.
      if (
        await d.journal.insert({
          txid: credit.txid,
          role: 'received',
          assetId: credit.assetId,
          units: credit.amount,
          outputIndex: credit.outputIndex,
          rail: 'handle',
          state: credit.offline ? 'held' : 'settled',
          delivered: false,
          ...(seen?.sender !== undefined ? { counterpartyKey: seen.sender } : {})
        })
      ) {
        changed = true
      }
    } catch (e) {
      devLog(`[mandala] handle: journaling the inbox credit ${credit.txid} failed:`, e)
    }
  }
  if (changed) notify(d)
  if (result.accepted.length > 0) {
    // A replay of a credit journaled `held` earlier that is now settled is
    // moved by markSettled; this also catches one whose markSettled write
    // failed. A view fault leaves it held for the next tick.
    try {
      await d.reconcileHeld(result.accepted.map(c => c.txid))
    } catch (e) {
      devLog('[mandala] handle: reconciling inbox credits failed; they stay held:', e)
    }
  }
  return { credited: result.accepted.length, failed: result.failed.length }
}
