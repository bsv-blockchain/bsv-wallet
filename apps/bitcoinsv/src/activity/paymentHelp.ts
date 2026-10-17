// "They didn't get it" helpers for a payment you sent, on the shared core:
//
// - Send it to them again: the same transaction, over their message box,
//   whatever rail it first took (nearby, @handle). The core rebuilds the
//   payment from this wallet's own records (resendPaymentDetails for BSV,
//   the Mandala runtime's resendTransfer for a stablecoin); receiving it is
//   idempotent, so a second copy of one they already have changes nothing.
//   A payment parked offline is then released, so this wallet sends it to
//   the network too (the root app's onSendPaymentDetails, WalletHomeScreen).
// - Show the payment code again: a nearby payment's sealed code, kept with
//   its offline row. Only the payee's still-open request can read it.
// - Check payment status: asks the network for the transaction's proof.
//
// An address payment has no one to message, so it can't be sent again.
import { PeerPayClient } from '@bsv/message-box-client'
import {
  NO_MESSAGE_BOX,
  findOfflineActionByTxid,
  getOnline,
  makeBeefRepair,
  makeListPeerPayAction,
  makeResendBeef,
  releaseParkedPayment,
  resendPaymentDetails,
  wocConfigFor
} from '@bsv/expo-wallet-toolbox'
import { makeMetadataDecryptor } from '@bsv/expo-wallet-toolbox/core/peerpay/metadataDecryptor'
import type { ActivityItem } from './items'

/** Rails that reached a person through an identity key: the ones a message box resend can reach again. */
const RESENDABLE = ['peerpay', 'localpay', 'mandala']

export function canResend(tx: Pick<ActivityItem, 'incoming' | 'txid' | 'labels'>): boolean {
  return !tx.incoming && !!tx.txid && tx.labels.some(l => RESENDABLE.includes(l))
}

export type ResendOutcome =
  | { ok: true }
  | { ok: false; reason: 'no_record' | 'no_recipient' | 'no_transaction' | 'no_message_box' | 'not_ready' }

/** What each failure means for the person tapping it. */
export const RESEND_FAILED: Record<Exclude<ResendOutcome, { ok: true }>['reason'], string> = {
  no_record: 'This payment can’t be sent again: this wallet has no record of how it was made.',
  no_recipient: 'This payment can’t be sent again: it doesn’t say who it was for.',
  no_transaction: 'The transaction couldn’t be found to send again. Try once you’re online.',
  no_message_box: 'Sending it again needs your message box. Check it in Settings.',
  not_ready: 'Your wallet isn’t ready yet. Try again in a moment.'
}

export async function resendPayment(args: {
  tx: Pick<ActivityItem, 'txid' | 'labels' | 'offlineStatus'>
  // the shared core's wallet pieces (useWallet, useMandala, useMessageBoxConfig)
  permissionsManager: unknown
  storage: unknown
  adminOriginator: string
  network: 'main' | 'test'
  messageBoxUrl: string | undefined
  mandalaRuntime?: { resendTransfer: (txid: string, deps: never) => Promise<{ ok: true } | { ok: false; reason: string }> } | null
}): Promise<ResendOutcome> {
  const { tx, permissionsManager: pm, storage, adminOriginator, network, messageBoxUrl, mandalaRuntime } = args
  const txid = tx.txid
  if (!txid || !pm || !storage) return { ok: false, reason: 'not_ready' }
  // network first, for a fresh proof; this wallet's own copy when the network
  // has never seen it (a nearby payment whose code was never scanned)
  const refetch = makeResendBeef({ refetch: makeBeefRepair({ woc: wocConfigFor(network), online: getOnline }), storage: storage as never })
  const decryptMetadata = makeMetadataDecryptor(pm, adminOriginator)
  const isToken = tx.labels.includes('mandala')
  let outcome: { ok: true } | { ok: false; reason: string }
  if (isToken) {
    if (!mandalaRuntime) return { ok: false, reason: 'not_ready' }
    outcome = await mandalaRuntime.resendTransfer(txid, { refetch, decryptMetadata } as never)
  } else {
    if (!messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) return { ok: false, reason: 'no_message_box' }
    const client = new PeerPayClient({ messageBoxHost: messageBoxUrl, walletClient: pm as never, originator: adminOriginator })
    outcome = await resendPaymentDetails({
      client,
      storage: storage as never,
      txid,
      listPeerPayAction: makeListPeerPayAction(pm as never, adminOriginator),
      decryptMetadata,
      refetch
    })
  }
  if (!outcome.ok) {
    const reason = outcome.reason as Exclude<ResendOutcome, { ok: true }>['reason']
    return { ok: false, reason: reason in RESEND_FAILED ? reason : 'no_record' }
  }
  // handed over for real now: a parked payment is released, so it goes to the network too
  if (tx.offlineStatus === 'parked') {
    try {
      await releaseParkedPayment({ storage: storage as never, txid, isTokenHold: isToken })
    } catch (e) {
      console.warn('[resend] sent, but the parked payment could not be released:', e instanceof Error ? e.message : e)
    }
  }
  return { ok: true }
}

/** A nearby payment's sealed code, if this wallet kept one. */
export async function storedPaymentCode(storage: unknown, txid: string | undefined): Promise<string | null> {
  if (!storage || !txid) return null
  const db = (storage as { sqliteDb?: unknown }).sqliteDb
  if (!db) return null
  try {
    const row = await findOfflineActionByTxid(db as never, txid)
    const payload = (row as { framePayload?: string | null } | null | undefined)?.framePayload
    return payload || null
  } catch {
    return null
  }
}
