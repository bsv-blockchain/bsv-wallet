/**
 * The handle rail's token half (plan 07 Task 13): hand-over send, MessageBox
 * redelivery and inbox receive over the `mandala-color` box (IC §7.2).
 *
 * `@bsv/mandala` builds and parses; the color module holds custody and
 * evidence; this file only orders the steps and keeps the wallet's
 * `color_transfers` journal true to them.
 *
 * Send, in this order (stability mandate):
 *  1. Refuse what the request alone decides (amount domain, recipient) and a
 *     second send of the same asset while one is in flight. The latch is taken
 *     with no await before it, so a double tap sees it.
 *  2. `sendHandover` builds and signs `noSend`. Nobody has the bytes yet.
 *  3. Journal the row `handed_over` (W4) BEFORE delivering: a lost MessageBox
 *     response may still have delivered, so from here the abort guard refuses
 *     and the broadcast hold holds. A crash before this insert leaves a signed
 *     action no recipient has seen; with no row the guard lets it be released.
 *     A journal FAULT here is answered by releasing the action, never by
 *     delivering bytes the journal does not know.
 *  4. `deliverHandover`. Success is the ACK (IC §7.2) and is journaled.
 *     Failure is still `sent`: a second send would be a second payment. The
 *     tick redelivers it (`redeliverPending`).
 *  5. Only a delivered hand-over is named to `settleNow` (post-ACK intent,
 *     IC §2.3), and only when online, raced against a timeout so a slow
 *     overlay never holds the payer's screen. The settle keeps running.
 *
 * Redelivery and resend rebuild the §7.2 body from the row (custody fields
 * written at send time), `handoffEvidence` (profileData) and the AtomicBEEF
 * from `refetch`. They never contact the overlay.
 */
import type { WalletInterface } from '@bsv/sdk'
import type { ColorPermissionModule } from '@bsv/color-permission-module'
import {
  ATTESTED_PROFILE_ID,
  MAX_UINT64,
  deliverHandover,
  receiveHandovers,
  sendHandover,
  type HandoverResult,
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
  color: Pick<ColorPermissionModule, 'handoffEvidence'>
  messageBox: () => Promise<MandalaMessageBox>
  settleNow: (txid: string) => Promise<TokenSettleState>
  isOnline: () => Promise<boolean>
  /** Caches a received receipt's attested deploy tx (W7). Never throws. */
  rememberDeploy: (hex: string) => Promise<void>
  /** AtomicBEEF of a txid: the network first, then this device's own copy. */
  refetch: (txid: string) => Promise<number[] | undefined>
  /** Message ids this session already handled (the lib's dedupe set). */
  processed: Set<string>
  now: () => Date
  /** Plain reason a recipient cannot receive tokens, or null. */
  recipientRefusal: (recipient: string) => string | null
  /** Journal or delivery state changed. */
  onChange?: () => void
  /** How long a send waits for its own settle before returning. Default 8 000 ms. */
  settleTimeoutMs?: number
}

const DEFAULT_SETTLE_TIMEOUT_MS = 8_000

/** Errors the module throws for a profile or evidence fault: a refusal, nothing was sent. */
const REFUSAL_ERROR_NAMES = new Set([
  'UnsupportedProfileError',
  'ProfileParamsError',
  'ProfileDataError',
  'AttestationEvidenceError',
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

/** Best-effort release of a signed action nobody has seen. The abort guard decides. */
async function releaseUnseen(d: HandleDeps, reference: string): Promise<void> {
  try {
    const r = await d.wallet.abortAction({ reference })
    if (!r?.aborted) devLog(`[mandala] handle: the unjournaled hand-over ${reference} was not released`)
  } catch (e) {
    devLog(`[mandala] handle: releasing the unjournaled hand-over ${reference} failed:`, e)
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
      ...(note !== undefined ? { note } : {})
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
          return { kind: 'unavailable', message: `color_transfers already holds ${h.txid} for another transfer` }
        }
      }
    } catch (e) {
      devLog(`[mandala] handle: journaling the hand-over ${h.txid} failed; releasing it undelivered:`, e)
      await releaseUnseen(d, h.reference)
      return { kind: 'unavailable', message: messageOf(e) }
    }
    notify(d)

    let delivered = self
    if (!self) {
      try {
        await deliverHandover({
          messageBoxClient: await d.messageBox(),
          recipientKey: a.recipientKey,
          handover: h,
          ...(note !== undefined ? { note } : {})
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

/**
 * Rebuilds the §7.2 hand-over of a sent row and delivers it. The row's
 * custody fields, the module's evidence and the bytes must all be present.
 */
async function deliverRow(d: HandleDeps, row: ColorTransferRow): Promise<DeliverOutcome> {
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
  let evidence: Awaited<ReturnType<HandleDeps['color']['handoffEvidence']>>
  try {
    evidence = await d.color.handoffEvidence(txid)
  } catch (e) {
    devLog(`[mandala] handle: reading the hand-over evidence of ${txid} failed:`, e)
    return 'unavailable'
  }
  if (!evidence || evidence.txid !== txid) return 'not-found'
  let tx: number[] | undefined
  try {
    tx = await d.refetch(txid)
  } catch (e) {
    devLog(`[mandala] handle: fetching the bytes of ${txid} failed:`, e)
  }
  if (!tx || tx.length === 0) return 'unavailable'

  const handover: HandoverResult = {
    txid,
    tx,
    reference: row.reference ?? '',
    outputIndex: row.outputIndex,
    receipt: {
      version: 1,
      assetId: row.assetId,
      derivationPrefix: row.derivationPrefix,
      derivationSuffix: row.derivationSuffix,
      senderIdentityKey: row.senderIdentityKey,
      profileData: evidence.profileData as Record<string, unknown>
    },
    // Not part of the §7.2 body.
    offChainValues: []
  }
  try {
    await deliverHandover({
      messageBoxClient: await d.messageBox(),
      recipientKey: row.counterpartyKey,
      handover,
      ...(row.note !== undefined ? { note: row.note } : {})
    })
  } catch (e) {
    devLog(`[mandala] handle: redelivering ${txid} failed:`, e)
    return 'unavailable'
  }
  await markDelivered(d, txid)
  return 'resent'
}

/**
 * Redelivers every `handle` hand-over whose delivery is not known to have
 * happened. Single-flight per runtime; never throws. Returns how many were
 * delivered. Each one delivered is then named to `settleNow` (post-ACK).
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
      if (row.rail !== 'handle' || row.delivered || delivering.has(row.txid)) continue
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
 * A payment not yet handed over (`built`/`parked`) is journaled `handed_over`
 * first, so the abort guard refuses from the moment the bytes may leave.
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
  if (UNHANDED_STATES.includes(row.state)) {
    try {
      if (await d.journal.advance(txid, UNHANDED_STATES, 'handed_over')) notify(d)
      row = await d.journal.get(txid)
    } catch (e) {
      devLog(`[mandala] handle: handing over ${txid} for a resend failed:`, e)
      return 'unavailable'
    }
    if (!row) return 'not-found'
  }
  if (!DELIVERABLE_STATES.includes(row.state)) return 'not-found'
  const delivering = setOf(deliveringTxids, d)
  delivering.add(txid)
  try {
    return await deliverRow(d, row)
  } finally {
    delivering.delete(txid)
  }
}

const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})+$/

/** What this session learned of each listed message: who sent it and its asset's attested deploy. */
interface ListedMessage {
  sender?: string
  declarationTx?: string
}

/**
 * Reads the sender and the attested `declarationTx` from a listed hand-over
 * body, leniently: this is display data (the counterparty, the asset's name)
 * for credits the module already accepted, never a decision input.
 */
function readListed(message: unknown): [string, ListedMessage] | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const m = message as { messageId?: unknown; sender?: unknown; body?: unknown }
  const id = typeof m.messageId === 'string' || typeof m.messageId === 'number' ? String(m.messageId) : undefined
  if (id === undefined) return undefined
  const out: ListedMessage = {}
  if (typeof m.sender === 'string' && IDENTITY_KEY.test(m.sender)) out.sender = m.sender
  try {
    const body = (typeof m.body === 'string' ? JSON.parse(m.body) : m.body) as {
      assetId?: unknown
      receipt?: { profileData?: Record<string, Record<string, { declarationTx?: unknown }>> }
    }
    const assetId = typeof body?.assetId === 'string' ? body.assetId : undefined
    const decl =
      assetId !== undefined ? body?.receipt?.profileData?.[ATTESTED_PROFILE_ID]?.[assetId]?.declarationTx : undefined
    if (typeof decl === 'string' && HEX.test(decl)) out.declarationTx = decl
  } catch {
    // An unreadable body is the lib's to judge; nothing to learn from it here.
  }
  return [id, out]
}

/**
 * Drains the `mandala-color` box through lib `receiveHandovers` and journals
 * each credit: `held` when it was accepted offline (`color_offline`),
 * `settled` when the overlay admitted it. Single-flight per runtime.
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
    result = await receiveHandovers({ wallet: d.wallet, messageBoxClient: observed, processed: d.processed })
  } catch (e) {
    devLog('[mandala] handle: the token inbox could not be read:', e)
    return { credited: 0, failed: 0, incomplete: true }
  }

  let changed = false
  for (const credit of result.accepted) {
    const seen = listed.get(String(credit.messageId))
    try {
      const wrote = await d.journal.insert({
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
      if (wrote) changed = true
      // A replay of a credit already journaled `held` (a crash before the
      // ack, or reconcileHeld got there first) that is now admitted.
      else if (!credit.offline && (await d.journal.advance(credit.txid, ['held'], 'settled'))) changed = true
    } catch (e) {
      devLog(`[mandala] handle: journaling the inbox credit ${credit.txid} failed:`, e)
    }
    if (seen?.declarationTx !== undefined) {
      try {
        await d.rememberDeploy(seen.declarationTx)
      } catch (e) {
        devLog('[mandala] handle: caching a received deploy failed:', e)
      }
    }
  }
  if (changed) notify(d)
  return { credited: result.accepted.length, failed: result.failed.length }
}
