/**
 * The direct rail: pay an identity key over a live link (`@bsv/webrtpay`), and finish through
 * the message box when the link cannot. The live half of the handle rail: the same token, the
 * same outbox row, the same drain.
 *
 * One payment is one transaction and one outbox row (`via: 'direct'`). The token is minted by
 * `mintPeerPayToken`, exactly as `sendViaHandle` mints it, so when the link cannot finish a
 * payment the row is an ordinary unsent handle-rail row: `TaskDrainOutbox` delivers the same
 * token to the recipient's message box and broadcasts it, and the recipient's wallet credits it
 * once (its inbox shares the direct-pay seen store; see `core/directpay/receive.ts`).
 *
 * Nine steps, in this order:
 *   1 dial and authenticate the recipient (nothing exists yet)
 *   2 mint the token with noSend   3 check it can be delivered   4 persist it
 *   5 mark it delivering   6 send it over the link and wait for the ack
 *   7 mark it delivered   8 broadcast   9 mark it sent
 *
 * Broadcast after the ack. BSV Desktop broadcasts before it sends over the link. Here the
 * handle rail's order holds (`handle.ts`, `sendViaHandle`: deliver, then broadcast), so a
 * payment that never reached the recipient leaves nothing on chain, and a stop before step 6
 * can still abort the action and free its inputs. The recipient's wallet takes an unbroadcast
 * transaction from the link as it already does from the inbox, where the token arrives before
 * the broadcast too; webrtpay verifies a payment against the derived key, not the network. The
 * price: between the ack and step 8 the recipient holds a transaction the network has not seen,
 * and a broadcast that fails then is retried by the drain from the `delivered` row.
 *
 * What a failure leaves:
 * - Steps 1–5: nothing was sent. A `NotSentError` (from `core/directpay/payFlow`), after the
 *   minted action is aborted and its row removed; a dial failure carries why, so `payIdentity`
 *   can offer the message box.
 * - Step 6 throws, or the recipient answers `rejected`: the recipient may hold a signed,
 *   spendable copy, so the payment can only go forward, never be aborted (SEC2-031, as for an
 *   abandoned handle-rail row). The row stays `delivering`; the drain sends the same token to
 *   the message box and broadcasts it. Throws {@link DirectDeliveryUnconfirmedError}, which
 *   `payIdentity` reads as "may already have been sent".
 * - Steps 7–9 after a good ack: the recipient has it. Returns `broadcast: 'pending'`; the drain
 *   broadcasts from the `delivered` row.
 *
 * A wallet with the message box turned off cannot pay live: a link that drops after step 6
 * would leave a payment with no way to finish it.
 *
 * Race, as on the handle rail: a drain that runs while a payment is between steps 4 and 9 sees
 * an unsent row and may deliver it through the message box at the same time. That costs a
 * second delivery of the same token (credited once) and can put the broadcast before the ack;
 * it never makes a second transaction.
 */
import {
  abortPeerPayNosend,
  broadcastNoSend,
  cancelOutboxPayment,
  mintPeerPayToken,
  NO_MESSAGE_BOX,
  type HandleRailWallet,
  type MintedPeerPayToken
} from './handle'
import { markOutboxSent, saveOutboxEntry, updateOutboxEntry } from '../../peerpay/outbox'
import { TaskDrainOutbox } from '../../monitor/TaskDrainOutbox'
import { NotSentError } from '../../directpay/payFlow'
import { dialFailure } from '../../directpay/dialFailure'
import { MAX_LIVE_TRANSACTION_BYTES } from '../../directpay/settings'
import type { DirectPayClientLike, DirectPaymentAck, DirectPeer, WebRTPayModule } from '../../directpay/webrtpay'

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

/** How a direct payment ended when the recipient answered. */
export interface DirectSendResult {
  outboxId: string
  txid: string
  /** What the transaction pays the recipient. */
  satoshis: number
  /** `accepted`: in the recipient's wallet; `received`: kept on their device until it can be. */
  ackStatus: 'accepted' | 'received'
  /** `pending`: the broadcast after the ack failed; the outbox drain retries it. */
  broadcast: 'sent' | 'pending'
}

/**
 * The payment was sent over the link, but the recipient did not confirm it (`no_ack`) or
 * refused it (`rejected`). It may already be theirs, so it is not cancelled: the outbox drain
 * delivers the same transaction through the message box. Never pay it again by hand.
 */
export class DirectDeliveryUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly outboxId: string,
    readonly why: 'no_ack' | 'rejected',
    readonly reason = ''
  ) {
    super(message)
    this.name = 'DirectDeliveryUnconfirmedError'
  }
}

/**
 * Pays `recipient` over a live link (see the file header for the order and what each failure
 * leaves). `client` is the open wallet's `DirectPayClient`; `signal` cancels the dial, and
 * stops the payment before it is made. `signalingDown` says whether this wallet's own way of
 * reaching others is down (no network, or its relay cannot be reached): a dial nobody answered
 * then says nothing about the recipient, and fails as `unavailable` rather than `offline`.
 */
export async function sendViaDirect(args: {
  wallet: HandleRailWallet
  adminOriginator: string
  client: Pick<DirectPayClientLike, 'connect' | 'sendPayment'>
  webrtpay: Pick<WebRTPayModule, 'validatePaymentToken' | 'MAX_DIRECT_TRANSACTION_BYTES'>
  storage: StorageLike
  recipient: string
  satoshis: number
  /** This wallet's message box host, where the drain finishes a payment the link could not. */
  messageBoxUrl: string
  /** The recipient's message-box host from a BRC-125 `url` extension, for the drain. */
  recipientHost?: string
  note?: string
  recipientName?: string
  signal?: AbortSignal
  signalingDown?: () => boolean | Promise<boolean>
}): Promise<DirectSendResult> {
  const { wallet, adminOriginator, client, storage, recipient, messageBoxUrl, recipientHost, signal } = args
  if (!messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) {
    throw new NotSentError('A live payment needs a message box to finish through', 'The message box is turned off.')
  }
  const satoshis = Math.round(Number(args.satoshis))
  if (!Number.isFinite(satoshis) || satoshis <= 0) throw new NotSentError('Invalid amount')

  const peer = await dial(client, recipient, signal, args.signalingDown)
  try {
    // The dial pins the recipient; a different key here would be a bug, not a payee.
    if (peer.peerIdentityKey !== recipient) throw new NotSentError('The connected wallet is not the recipient')
    if (signal?.aborted) throw new NotSentError('Cancelled', '', 'aborted')

    let minted: MintedPeerPayToken
    try {
      minted = await mintPeerPayToken({ ...args, satoshis })
    } catch (e) {
      // createAction refused (not enough funds, a denied permission): nothing exists.
      throw new NotSentError('The wallet could not make the payment', messageOf(e))
    }
    const { txid, token } = minted
    const note = token.note?.slice(0, 500)

    const refusal = whyNotDeliverable(args.webrtpay, peer, token, note, signal)
    if (refusal) {
      await abortMinted(wallet, adminOriginator, txid)
      throw refusal
    }

    let outboxId: string
    try {
      outboxId = await saveOutboxEntry(storage, { recipient, token, messageBoxUrl, txid, recipientHost, via: 'direct' })
    } catch (e) {
      await abortMinted(wallet, adminOriginator, txid)
      throw new NotSentError('The payment could not be saved', messageOf(e))
    }

    try {
      // Checkpoint before the link round-trip: from here the recipient may hold the token, so
      // cancel must never abort it (see cancelOutboxPayment).
      await updateOutboxEntry(storage, outboxId, { delivering: true })
    } catch (e) {
      try {
        await cancelOutboxPayment({ wallet, adminOriginator, storage, entry: { id: outboxId, txid, recipient } })
      } catch (cancelErr) {
        console.warn('[direct] could not cancel an unsent payment:', messageOf(cancelErr))
      }
      throw new NotSentError('The payment could not be saved', messageOf(e))
    }

    let ack: DirectPaymentAck
    try {
      ack = await client.sendPayment(peer, token, note ? { note } : undefined)
    } catch (e) {
      await leaveForMessageBox(storage, outboxId, `No answer over the link: ${messageOf(e)}`)
      throw new DirectDeliveryUnconfirmedError(
        "The recipient's wallet did not confirm the payment; it will be delivered through the message box.",
        outboxId,
        'no_ack'
      )
    }
    if (ack.status === 'rejected') {
      await leaveForMessageBox(storage, outboxId, `Refused over the link: ${ack.reason || 'no reason given'}`)
      throw new DirectDeliveryUnconfirmedError(
        "The recipient's wallet refused the payment; it will be delivered through the message box.",
        outboxId,
        'rejected',
        ack.reason ?? ''
      )
    }

    let broadcast: DirectSendResult['broadcast'] = 'sent'
    try {
      await updateOutboxEntry(storage, outboxId, { delivered: true })
      await broadcastNoSend(wallet, adminOriginator, txid)
      await markOutboxSent(storage, outboxId)
    } catch (e) {
      broadcast = 'pending'
      await leaveForMessageBox(storage, outboxId, messageOf(e))
    }
    return { outboxId, txid, satoshis: minted.satoshis, ackStatus: ack.status, broadcast }
  } finally {
    peer.close()
  }
}

/** Any dial failure happens before the payment exists. */
async function dial(
  client: Pick<DirectPayClientLike, 'connect'>,
  recipient: string,
  signal: AbortSignal | undefined,
  signalingDown: (() => boolean | Promise<boolean>) | undefined
): Promise<DirectPeer> {
  try {
    return await client.connect(recipient, signal ? { signal } : undefined)
  } catch (error) {
    // Checked here rather than read from the error's wording (see dialFailure.ts).
    if (signal?.aborted) throw new NotSentError('Dial cancelled', messageOf(error), 'aborted')
    let failure = dialFailure(error)
    if (failure === 'offline' && (await isDown(signalingDown))) failure = 'unavailable'
    // The user sees a short prompt; the log keeps what actually failed.
    const e = error as { code?: unknown; reason?: unknown } | null
    console.warn('[direct] dial failed', { failure, code: e?.code, reason: e?.reason, message: messageOf(error) })
    throw new NotSentError(`The recipient could not be reached directly (${failure})`, messageOf(error), failure)
  }
}

async function isDown(signalingDown: (() => boolean | Promise<boolean>) | undefined): Promise<boolean> {
  try {
    return (await signalingDown?.()) === true
  } catch {
    return false
  }
}

/**
 * Why `token` must not be sent over `peer`, checked as the recipient will check it, or
 * undefined when it may. A closed link fails like a dial whose link did not come up, so the
 * message box can be offered for a fresh payment.
 */
function whyNotDeliverable(
  webrtpay: Pick<WebRTPayModule, 'validatePaymentToken' | 'MAX_DIRECT_TRANSACTION_BYTES'>,
  peer: DirectPeer,
  token: MintedPeerPayToken['token'],
  note: string | undefined,
  signal: AbortSignal | undefined
): NotSentError | undefined {
  if (signal?.aborted) return new NotSentError('Cancelled', '', 'aborted')
  const bytes = token.transaction.length
  // Live payments carry at most 1 MB (MAX_LIVE_TRANSACTION_BYTES), below the package's own cap.
  const limit = Math.min(MAX_LIVE_TRANSACTION_BYTES, webrtpay.MAX_DIRECT_TRANSACTION_BYTES)
  if (bytes > limit) {
    return new NotSentError(
      'This payment is too large to deliver directly',
      `${bytes} bytes; at most ${limit} can go over the link`,
      'too_large'
    )
  }
  try {
    webrtpay.validatePaymentToken(token, note)
  } catch (e) {
    return new NotSentError("The recipient's wallet would refuse this payment", messageOf(e))
  }
  if (!peer.isOpen) {
    return new NotSentError("The recipient's wallet closed the connection before the payment was sent", '', 'unknown')
  }
  return undefined
}

/** Frees a minted payment nobody else has seen. Best effort: a failure is logged, not thrown. */
async function abortMinted(wallet: HandleRailWallet, adminOriginator: string, txid: string): Promise<void> {
  try {
    if (!(await abortPeerPayNosend(wallet, adminOriginator, txid))) {
      console.warn('[direct] the minted payment was not aborted:', txid)
    }
  } catch (e) {
    console.warn('[direct] abortPeerPayNosend failed:', messageOf(e))
  }
}

/** Records why the link did not finish the payment and wakes the outbox drain. Never throws. */
async function leaveForMessageBox(storage: StorageLike, outboxId: string, why: string): Promise<void> {
  try {
    await updateOutboxEntry(storage, outboxId, { lastAttemptAt: new Date().toISOString(), lastError: why })
  } catch {
    // The row is unsent either way; the drain finds it.
  }
  TaskDrainOutbox.noteEnqueued()
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
