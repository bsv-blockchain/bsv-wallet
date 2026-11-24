/**
 * The paymail rail: pay a legacy paymail (HandCash and similar) with BSV.
 *
 * Same shape as `sendViaHandle`: mint with noSend, write the outbox row, hand
 * the receiver the transaction, then broadcast with sendWith. The receiver gets
 * plain BEEF (HandCash refuses AtomicBEEF with a 503).
 *
 * A receiver that answers with an error may still hold the payment (HandCash
 * sends a malformed-transaction refusal as 503), so nothing is aborted until
 * the network has been asked twice and has not seen the txid. Arcade is never
 * asked: it does not know transactions it did not broadcast.
 */
import { Transaction } from '@bsv/sdk'
import type { LegacyPaymailClient, PostBeefResult } from '../paymail/client'
import {
  NETWORK_CALL_DEADLINE_MS,
  networkKnowsTxid,
  withDeadline,
  type NetworkVerdict,
  type StatusFn
} from '../paymail/networkCheck'
import {
  markOutboxSent,
  removeOutboxEntry,
  savePaymailOutboxEntry,
  updateOutboxEntry,
  getOutboxEntries,
  type PaymailOutboxEntry
} from '../../peerpay/outbox'
import { TaskDrainOutbox } from '../../monitor/TaskDrainOutbox'
import { abortNosendByTxid, broadcastNoSend, type HandleRailWallet } from './handle'

export const PAYMAIL_LABEL = 'paymail'

export function paymailAddressLabel(paymail: string): string {
  return `paymail:${paymail.toLowerCase()}`
}

export type PaymailFailure = 'not_sent' | 'refused' | 'maybe_sent' | 'abort_failed'

export class PaymailSendError extends Error {
  constructor(
    readonly kind: PaymailFailure,
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'PaymailSendError'
  }
}

export interface PaymailRailWallet extends Pick<HandleRailWallet, 'createAction' | 'listActions' | 'abortAction'> {}

export interface PaymailRailDeps {
  wallet: PaymailRailWallet
  adminOriginator: string
  storage: {
    getKeyValue(key: string): Promise<string | undefined>
    setKeyValue(key: string, value: string): Promise<void>
  }
  client: LegacyPaymailClient
  getStatusForTxids: StatusFn
  /** Wait between the two network checks. Default 4000 ms. Tests pass 0. */
  recheckDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface PaymailSendResult {
  outboxId: string
  txid: string
  satoshis: number
  broadcastPending: boolean
}

const DEFAULT_RECHECK_DELAY_MS = 4000
/** Largest amount a wallet can hold. Above this is the send-max sentinel. */
const MAX_SATOSHIS = 2_099_999_999_999_998

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const inFlight = new Set<string>()

/** Run `work` only if no other flow holds `txid`. Returns undefined at once when it is held. */
export async function withTxidLock<T>(txid: string, work: () => Promise<T>): Promise<T | undefined> {
  if (inFlight.has(txid)) return undefined
  inFlight.add(txid)
  try {
    return await work()
  } finally {
    inFlight.delete(txid)
  }
}

/**
 * Two network checks with a delay between them. 'known' if either says known,
 * 'error' if either errors, else 'unknown'. A first error returns at once, so a
 * hung status service costs one deadline, not two.
 */
export async function confirmUnknown(
  deps: Pick<PaymailRailDeps, 'getStatusForTxids' | 'recheckDelayMs' | 'sleep'>,
  txid: string
): Promise<NetworkVerdict> {
  const first = await networkKnowsTxid(deps.getStatusForTxids, txid)
  if (first !== 'unknown') return first
  await (deps.sleep ?? defaultSleep)(deps.recheckDelayMs ?? DEFAULT_RECHECK_DELAY_MS)
  return networkKnowsTxid(deps.getStatusForTxids, txid)
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Record a failed attempt and make sure the drain looks at the row again.
 * Best effort: the caller is about to throw a typed error, and a storage fault
 * here must not replace it with a plain one.
 */
async function noteAttempt(deps: PaymailRailDeps, entry: PaymailOutboxEntry, lastError: string, extra = {}) {
  try {
    await updateOutboxEntry(deps.storage, entry.id, {
      lastAttemptAt: new Date().toISOString(),
      lastError,
      ...extra
    })
  } catch (e) {
    console.warn('[paymail] could not record the attempt:', errMessage(e))
  }
  TaskDrainOutbox.noteEnqueued()
}

/** Whether a noSend action for `txid` is still live (it can still be broadcast or aborted). */
async function nosendActionIsLive(
  wallet: Pick<PaymailRailWallet, 'listActions'>,
  adminOriginator: string,
  txid: string
): Promise<boolean> {
  const { actions } = await wallet.listActions({ labels: [PAYMAIL_LABEL], limit: 1000 }, adminOriginator)
  const match = actions.find(a => a.txid === txid)
  return match != null && (match as { status?: string }).status !== 'failed'
}

/**
 * Free the inputs held by the noSend action for `txid`, inside the deadline.
 * True when the abort landed or the action is already gone. An abort that
 * times out or throws may still land late, so the action is looked up again
 * before the funds are called stuck. False only when it is still live.
 */
async function releaseNosend(
  deps: Pick<PaymailRailDeps, 'wallet' | 'adminOriginator'>,
  txid: string
): Promise<boolean> {
  try {
    if (
      await withDeadline(abortNosendByTxid(deps.wallet, deps.adminOriginator, txid, PAYMAIL_LABEL), NETWORK_CALL_DEADLINE_MS)
    ) {
      return true
    }
  } catch {
    // fall through to the look-up
  }
  try {
    return !(await withDeadline(nosendActionIsLive(deps.wallet, deps.adminOriginator, txid), NETWORK_CALL_DEADLINE_MS))
  } catch {
    return false
  }
}

/**
 * The receiver has the payment (or the network does). Broadcast ours. If the
 * broadcast is not confirmed but the network already knows the txid, the
 * payment is complete: mark the row sent so the drain does not loop on it.
 */
async function broadcastOrSettle(
  deps: PaymailRailDeps,
  entry: PaymailOutboxEntry
): Promise<{ broadcastPending: boolean }> {
  try {
    await broadcastNoSend(deps.wallet, deps.adminOriginator, entry.txid)
    await markOutboxSent(deps.storage, entry.id)
    return { broadcastPending: false }
  } catch (e) {
    const verdict = await networkKnowsTxid(deps.getStatusForTxids, entry.txid)
    if (verdict === 'known') {
      await markOutboxSent(deps.storage, entry.id)
      await updateOutboxEntry(deps.storage, entry.id, { lastError: 'broadcast_not_confirmed' })
      return { broadcastPending: false }
    }
    await noteAttempt(deps, entry, errMessage(e))
    return { broadcastPending: true }
  }
}

/**
 * Act on the receiver's answer. Shared by send, retry and cancel. `allowAbort`
 * is true only for the first send; a retry never frees the inputs.
 */
export async function settlePaymailPost(
  deps: PaymailRailDeps,
  entry: PaymailOutboxEntry,
  post: PostBeefResult,
  opts: { allowAbort?: boolean } = {}
): Promise<{ broadcastPending: boolean }> {
  const allowAbort = opts.allowAbort ?? true

  if (post.kind === 'accepted') {
    await updateOutboxEntry(deps.storage, entry.id, {
      delivered: true,
      delivering: false,
      receiverTxid: post.txid,
      receiverNote: post.note
    })
    if (post.txid.toLowerCase() !== entry.txid.toLowerCase()) {
      console.warn('[paymail] receiver txid differs from ours', { ours: entry.txid, theirs: post.txid })
    }
    return broadcastOrSettle(deps, entry)
  }

  if (post.kind === 'network') {
    const code = post.message === 'unreadable_receipt' ? 'unreadable_receipt' : 'no_answer'
    await noteAttempt(deps, entry, post.message)
    throw new PaymailSendError('maybe_sent', 'The receiver did not answer. The payment may have gone through.', code)
  }

  // An HTTP answer that is not 2xx: a probable refusal, but a 5xx is not proof.
  const verdict = await confirmUnknown(deps, entry.txid)
  if (verdict === 'error') {
    await noteAttempt(deps, entry, 'status_unavailable')
    throw new PaymailSendError(
      'maybe_sent',
      'Could not check the network. The payment may have gone through.',
      'status_unavailable'
    )
  }
  if (verdict === 'known') {
    await updateOutboxEntry(deps.storage, entry.id, { delivered: true, delivering: false })
    return broadcastOrSettle(deps, entry)
  }

  if (!allowAbort) {
    await updateOutboxEntry(deps.storage, entry.id, {
      refused: true,
      lastAttemptAt: new Date().toISOString(),
      lastError: 'recipient_refused'
    })
    throw new PaymailSendError(
      'maybe_sent',
      'The receiver refused the payment. Cancel it to free the funds.',
      'refused_unconfirmed'
    )
  }

  const aborted = await releaseNosend(deps, entry.txid)
  if (aborted) {
    await removeOutboxEntry(deps.storage, entry.id)
    throw new PaymailSendError('refused', post.message, 'recipient_refused')
  }
  // The abort may still land late. Mark the row refused so the drain never posts
  // it again over inputs that may be freed; only a Cancel resolves it.
  await noteAttempt(deps, entry, 'abort_failed', { refused: true })
  throw new PaymailSendError(
    'abort_failed',
    'The receiver refused the payment, but the funds could not be freed.',
    'abort_failed'
  )
}

export async function sendViaPaymail(
  args: PaymailRailDeps & { paymail: string; satoshis: number; note?: string }
): Promise<PaymailSendResult> {
  const { wallet, adminOriginator, storage, client, paymail, note } = args

  const sats = Math.round(Number(args.satoshis))
  if (!Number.isFinite(sats) || sats <= 0) {
    throw new PaymailSendError('not_sent', 'Enter an amount above zero.', 'invalid_amount')
  }
  if (sats > MAX_SATOSHIS) {
    throw new PaymailSendError('not_sent', 'Send all is not supported for this address.', 'send_all_unsupported')
  }

  const dest = await client.getP2pDestination(paymail, sats)
  if (dest.kind === 'failed') throw new PaymailSendError('not_sent', dest.message, dest.reason)
  const destination = dest.destination

  let created: Awaited<ReturnType<PaymailRailWallet['createAction']>>
  try {
    created = await wallet.createAction(
      {
        description: (note?.trim() || paymail).slice(0, 500).padEnd(5),
        labels: [PAYMAIL_LABEL, paymailAddressLabel(paymail)],
        outputs: destination.outputs.map(o => ({
          lockingScript: o.script,
          satoshis: o.satoshis,
          outputDescription: 'Paymail payment'
        })),
        options: { noSend: true, randomizeOutputs: false }
      },
      adminOriginator
    )
  } catch (e) {
    throw new PaymailSendError('not_sent', errMessage(e), 'mint_failed')
  }
  if (!created?.tx || !created.txid) {
    throw new PaymailSendError('not_sent', 'The wallet did not return a transaction.', 'mint_failed')
  }
  const txid = created.txid

  const abortQuietly = async () => {
    try {
      await abortNosendByTxid(wallet, adminOriginator, txid, PAYMAIL_LABEL)
    } catch (abortErr) {
      console.warn('[paymail] abort of the unsent payment failed:', errMessage(abortErr))
    }
  }

  const createdTx = created.tx
  const settled = await withTxidLock(txid, async () => {
    let beefHex: string
    try {
      const tx = Transaction.fromAtomicBEEF(createdTx)
      const matches =
        tx.id('hex') === txid &&
        destination.outputs.every((o, i) => {
          const out = tx.outputs[i]
          return (
            out != null &&
            out.satoshis === o.satoshis &&
            out.lockingScript.toHex().toLowerCase() === o.script.toLowerCase()
          )
        })
      if (!matches) {
        await abortQuietly()
        throw new PaymailSendError('not_sent', 'The wallet built a different payment than asked.', 'mint_failed')
      }
      beefHex = tx.toHexBEEF()
    } catch (e) {
      if (e instanceof PaymailSendError) throw e
      await abortQuietly()
      throw new PaymailSendError('not_sent', 'The wallet returned a transaction that could not be read.', 'mint_failed')
    }
    const total = destination.outputs.reduce((sum, o) => sum + o.satoshis, 0)

    let outboxId: string
    try {
      outboxId = await savePaymailOutboxEntry(storage, {
        paymail,
        endpoint: destination.beefEndpoint,
        paymailReference: destination.reference,
        beefHex,
        satoshis: total,
        txid,
        note: note?.trim() || undefined
      })
    } catch (e) {
      await abortQuietly()
      throw e
    }

    // From here the row exists and the receiver may hold the payment. Whatever
    // fails must reach the caller as a typed error, so the UI blocks a second
    // payment instead of reporting "not sent".
    try {
      await updateOutboxEntry(storage, outboxId, { delivering: true })
      const post = await client.postBeef({
        endpoint: destination.beefEndpoint,
        beefHex,
        reference: destination.reference
      })
      const entry = (await getOutboxEntries(storage)).find(e => e.id === outboxId) as PaymailOutboxEntry | undefined
      if (!entry) {
        // The receiver may hold the payment but the row is gone: nothing to settle against.
        throw new PaymailSendError(
          'maybe_sent',
          'The payment record is missing. The payment may have gone through.',
          'outbox_missing'
        )
      }
      const result = await settlePaymailPost(args, entry, post, { allowAbort: true })
      return { outboxId, satoshis: total, broadcastPending: result.broadcastPending }
    } catch (e) {
      if (e instanceof PaymailSendError) throw e
      TaskDrainOutbox.noteEnqueued()
      throw new PaymailSendError(
        'maybe_sent',
        'The wallet could not save the payment state. The payment may have gone through.',
        'storage_error'
      )
    }
  })
  if (!settled) {
    throw new PaymailSendError('maybe_sent', 'This payment is already being handled.', 'in_progress')
  }
  return { outboxId: settled.outboxId, txid, satoshis: settled.satoshis, broadcastPending: settled.broadcastPending }
}

async function findPaymailRow(
  storage: PaymailRailDeps['storage'],
  id: string
): Promise<PaymailOutboxEntry | undefined> {
  const found = (await getOutboxEntries(storage)).find(e => e.id === id)
  return found && found.kind === 'paymail' ? found : undefined
}

/**
 * Retry a stuck paymail row: post the same BEEF again if the receiver never
 * accepted it, then broadcast. It never aborts. A refusal sets `refused` on the
 * row and only an explicit Cancel can free the funds.
 */
export async function retryPaymailDelivery(args: PaymailRailDeps & { entry: PaymailOutboxEntry }): Promise<void> {
  const { storage, client, entry } = args
  if (entry.status !== 'unsent' || entry.refused === true) return

  // XR-048: the stored txid is not authenticated. Re-derive it from the BEEF.
  let ownTxid: string | undefined
  try {
    ownTxid = Transaction.fromHexBEEF(entry.beefHex).id('hex')
  } catch {
    ownTxid = undefined
  }
  if (!ownTxid || ownTxid.toLowerCase() !== entry.txid.toLowerCase()) {
    throw new Error('outbox_txid_mismatch')
  }

  // XR-052: a Cancel can remove the row between awaits. Re-read before each side effect.
  const stillPending = async (): Promise<PaymailOutboxEntry | undefined> => {
    const row = await findPaymailRow(storage, entry.id)
    return row && row.status === 'unsent' && row.refused !== true ? row : undefined
  }

  await withTxidLock(entry.txid, async () => {
    if (!(await stillPending())) return
    await updateOutboxEntry(storage, entry.id, { lastAttemptAt: new Date().toISOString() })
    try {
      if (entry.delivered === true) {
        const row = await stillPending()
        if (!row) return
        const result = await broadcastOrSettle(args, row)
        if (result.broadcastPending) throw new Error('broadcast_not_confirmed')
        return
      }
      if (!(await stillPending())) return
      await updateOutboxEntry(storage, entry.id, { delivering: true })
      const post = await client.postBeef({
        endpoint: entry.endpoint,
        beefHex: entry.beefHex,
        reference: entry.paymailReference
      })
      const row = await stillPending()
      if (!row) return
      const result = await settlePaymailPost(args, row, post, { allowAbort: false })
      if (result.broadcastPending) throw new Error('broadcast_not_confirmed')
    } catch (e) {
      if (!(e instanceof PaymailSendError)) {
        const row = await findPaymailRow(storage, entry.id)
        if (row) await updateOutboxEntry(storage, entry.id, { lastError: errMessage(e) })
      }
      throw e
    }
  })
}

const statusUnavailable = () =>
  new PaymailSendError(
    'maybe_sent',
    'Could not check the network. The payment may have gone through.',
    'status_unavailable'
  )

const abortFailed = () =>
  new PaymailSendError('abort_failed', 'The funds could not be freed. Try again later.', 'abort_failed')

/**
 * Cancel a paymail payment on the user's say. The network answer decides: a
 * payment the network knows is finished, not cancelled.
 */
export async function cancelPaymailPayment(
  args: PaymailRailDeps & { entry: PaymailOutboxEntry }
): Promise<{ aborted: boolean; sent: boolean }> {
  const { storage, entry } = args
  const stored = await findPaymailRow(storage, entry.id)
  if (!stored) return { aborted: false, sent: false }
  if (stored.delivered === true) {
    throw new PaymailSendError(
      'maybe_sent',
      'The receiver has this payment. It cannot be cancelled. Finish it instead.',
      'already_delivered'
    )
  }
  const result = await withTxidLock(stored.txid, async () => {
    const maybePosted = stored.delivering === true || stored.lastAttemptAt != null
    const verdict = maybePosted ? await confirmUnknown(args, stored.txid) : await networkKnowsTxid(args.getStatusForTxids, stored.txid)
    if (verdict === 'error') throw statusUnavailable()
    if (verdict === 'known') {
      const settled = await broadcastOrSettle(args, stored)
      // The network already knows this txid, so the payment is out of our hands.
      // Mark the row sent even when our own broadcast is still pending: leaving
      // it unsent would let the drain re-POST a payment that cannot be cancelled.
      if (settled.broadcastPending) await markOutboxSent(storage, stored.id)
      return { aborted: false, sent: true }
    }
    if (await releaseNosend(args, stored.txid)) {
      await removeOutboxEntry(storage, stored.id)
      return { aborted: true, sent: false }
    }
    await noteAttempt(args, stored, 'abort_failed')
    throw abortFailed()
  })
  if (!result) throw new PaymailSendError('maybe_sent', 'This payment is already being handled.', 'in_progress')
  return result
}

/**
 * A noSend `paymail` action with no outbox row (a crash between the mint and
 * the row save, or a restore: key_value_store is not in the backup). The
 * network decides, as in a cancel.
 */
export async function resolveOrphanPaymailAction(
  args: Pick<PaymailRailDeps, 'wallet' | 'adminOriginator' | 'getStatusForTxids' | 'recheckDelayMs' | 'sleep'> & {
    txid: string
  }
): Promise<{ aborted: boolean; sent: boolean }> {
  const result = await withTxidLock(args.txid, async () => {
    const verdict = await confirmUnknown(args, args.txid)
    if (verdict === 'error') throw statusUnavailable()
    if (verdict === 'known') {
      await broadcastNoSend(args.wallet, args.adminOriginator, args.txid)
      return { aborted: false, sent: true }
    }
    if (await releaseNosend(args, args.txid)) return { aborted: true, sent: false }
    throw abortFailed()
  })
  if (!result) throw new PaymailSendError('maybe_sent', 'This payment is already being handled.', 'in_progress')
  return result
}
