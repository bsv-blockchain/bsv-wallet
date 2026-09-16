/**
 * Resend for a TOKEN transfer, whatever rail it first went out on.
 *
 * "The counterparty says they never got it" has one honest answer for a
 * stablecoin: deliver the transfer notification again, over the message box,
 * because that is the one rail that confirms delivery and the one inbox every
 * recipient wallet drains. A nearby hand-over whose code was never scanned, a
 * handle-rail transfer whose notify failed and fell out of the lib's journal —
 * both end here with the SAME body `transferTokens` sends at transfer time, so
 * the recipient's `receiveTokens` needs nothing new to credit it (it acks by
 * messageId and treats an already-internalized output as a no-op).
 *
 * Everything the body needs is already on the payer's device, on both rails:
 *
 *  · recipient, the blinded sender A′ and the keyID — the lib's blinding
 *    journal, written by `transferTokens` (`blindingPut`) and by the nearby
 *    build (`blindingReserve` + `commitBlinding`). Fallback: the payee output's
 *    own `recipientCustomInstructions` marker, which both rails write too;
 *  · which output is the payee's — that same marker, because the handle rail
 *    randomises output order;
 *  · the transaction — the existing network-first / local-second resend lookup;
 *  · assetId and amount — DECODED from the output's script, never a stored claim;
 *  · a cached σ_I when this device holds one, so the recipient can credit
 *    without waiting on its own overlay round-trip (§4.5). Optional by design.
 *
 * Nothing here contacts the overlay, decides settlement, or touches the
 * transaction's own status: a resend is a delivery, not a payment.
 */
import { Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { isDuplicateMessageError } from '../peerpay/control'

/** The recipient-side inbox `receiveTokens` drains (`@bsv/mandala` `MESSAGEBOX`). */
export const MANDALA_MESSAGE_BOX = 'mandala-payments'

/** The FT derivation protocol, as the lib's `FT_PROTOCOL`. */
const FT_PROTOCOL: [number, string] = [2, 'mandala token']

export type TokenResendFailure = 'no_record' | 'no_transaction'
export type TokenResendOutcome = { ok: true } | { ok: false; reason: TokenResendFailure }

/** What the payer remembers about who the payment was for and how it was locked. */
export interface TokenResendRecord {
  recipient: string
  /** A′ — what went on the wire as the sender; the recipient derives against it. */
  senderBlinded: string
  keyID: string
}

export interface TokenResendAction {
  labels?: string[]
  outputs?: { outputIndex?: number; customInstructions?: string }[]
}

export interface PendingTokenNotification {
  txid: string
  recipient: string
  messageBox: string
  body: object
  at: number
}

export interface TokenResendDeps {
  /** The lib's blinding journal, by txid. */
  blindingRecord: (txid: string) => Promise<TokenResendRecord | undefined>
  /** The `mandala`-labelled wallet action for the txid, with its outputs. */
  listAction: (txid: string) => Promise<TokenResendAction | undefined>
  /** AtomicBEEF for the txid — `makeResendBeef` in production. */
  refetch: (txid: string) => Promise<number[] | undefined>
  /** This device's cached σ_I for the txid, if any. */
  admission: (
    txid: string
  ) => Promise<{ outputsToAdmit: number[]; signatureHex: string; signerKey: string } | undefined>
  /** The lib's notification journal: `notifyPut` / `notifyRemove`. */
  journal: { put(entry: PendingTokenNotification): Promise<void>; remove(txid: string): Promise<void> }
  sendMessage: (args: { recipient: string; messageBox: string; body: object }) => Promise<unknown>
  /** Unwraps metadata the permissions manager encrypted on its way to storage. */
  decryptMetadata?: (value: string) => Promise<string>
  now?: () => number
}

interface Marker extends Partial<TokenResendRecord> {
  outputIndex: number
}

/** The payee output's `recipientCustomInstructions`, and which output carried it. */
async function findMarker(action: TokenResendAction | undefined, decrypt?: (v: string) => Promise<string>): Promise<Marker | undefined> {
  for (const output of action?.outputs ?? []) {
    const raw = output.customInstructions
    if (typeof raw !== 'string' || raw === '') continue
    let text = raw
    if (decrypt) {
      try {
        text = await decrypt(raw)
      } catch {
        // Not encrypted, or not ours to read — try it as it is.
      }
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof parsed.senderBlinded !== 'string') continue
    return {
      outputIndex: typeof output.outputIndex === 'number' ? output.outputIndex : 0,
      recipient: typeof parsed.recipient === 'string' ? parsed.recipient : undefined,
      senderBlinded: parsed.senderBlinded,
      keyID: typeof parsed.keyID === 'string' ? parsed.keyID : undefined
    }
  }
  return undefined
}

export async function resendTokenTransfer(txid: string, deps: TokenResendDeps): Promise<TokenResendOutcome> {
  const [journaled, action] = await Promise.all([deps.blindingRecord(txid), deps.listAction(txid)])
  const marker = await findMarker(action, deps.decryptMetadata)

  const recipient = journaled?.recipient ?? marker?.recipient
  const senderBlinded = journaled?.senderBlinded ?? marker?.senderBlinded
  const keyID = journaled?.keyID ?? marker?.keyID
  if (!recipient || !senderBlinded || !keyID) return { ok: false, reason: 'no_record' }
  // The nearby build never randomises outputs, so a record with no marker
  // (an older action whose instructions did not survive) still names index 0.
  const outputIndex = marker?.outputIndex ?? 0

  const transaction = await deps.refetch(txid)
  if (!transaction) return { ok: false, reason: 'no_transaction' }
  let assetId: string
  let amount: number
  try {
    const script = Transaction.fromAtomicBEEF(transaction).outputs[outputIndex]?.lockingScript
    if (!script) return { ok: false, reason: 'no_transaction' }
    ;({ assetId, amount } = MandalaToken.decode(script))
  } catch {
    return { ok: false, reason: 'no_transaction' }
  }

  const cached = await deps.admission(txid)
  const body = {
    assetId,
    amount: String(amount),
    transaction,
    keyID,
    outputIndex,
    protocolID: FT_PROTOCOL,
    sender: senderBlinded,
    senderMode: 'blinded' as const,
    ...(cached
      ? {
          admission: {
            txid,
            outputsToAdmit: cached.outputsToAdmit,
            signature: cached.signatureHex,
            signerKey: cached.signerKey
          }
        }
      : {})
  }

  // Journal FIRST, exactly as `transferTokens` does: a send that fails after
  // this is retried by `reconcileNotifications` on the next drain tick, and a
  // duplicate delivery is safe on the receiving side.
  await deps.journal.put({ txid, recipient, messageBox: MANDALA_MESSAGE_BOX, body, at: (deps.now ?? Date.now)() })
  try {
    await deps.sendMessage({ recipient, messageBox: MANDALA_MESSAGE_BOX, body })
  } catch (e) {
    // The box already holds this exact message: the recipient has what the
    // resend was trying to give them, which is the wanted end state.
    if (!isDuplicateMessageError(e)) throw e
  }
  await deps.journal.remove(txid)
  return { ok: true }
}
