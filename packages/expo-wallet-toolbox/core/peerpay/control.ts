/**
 * PeerPay payment-control channel.
 *
 * A dedicated MessageBox (`payment_control`), not the payment inbox. Receivers
 * post `resend_request` before acknowledging an uncreditable token so the
 * sender still has the derivation data. Inbound handling of these messages is
 * the sender's job (P1).
 */

export const PAYMENT_CONTROL_BOX = 'payment_control'

export type ResendReason = 'corrupt' | 'uncreditible' | 'double_spent' | 'bounced_offline'

export type PaymentControlMessage =
  | { type: 'resend_request'; txid: string; reason: ResendReason; messageId?: string }
  | { type: 'payment_cancelled'; txid: string }

const RESEND_REASONS: ReadonlySet<string> = new Set(['corrupt', 'uncreditible', 'double_spent', 'bounced_offline'])

function asObject(body: unknown): Record<string, unknown> | undefined {
  let value: unknown = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Unknown types, missing txid, or invalid reason → undefined (forward-compatible). */
export function parseControlMessage(body: unknown): PaymentControlMessage | undefined {
  const obj = asObject(body)
  if (!obj) return undefined
  const { type, txid } = obj
  if (typeof type !== 'string' || typeof txid !== 'string' || txid.length === 0) return undefined
  if (type === 'payment_cancelled') return { type, txid }
  if (type !== 'resend_request') return undefined
  if (typeof obj.reason !== 'string' || !RESEND_REASONS.has(obj.reason)) return undefined
  return {
    type: 'resend_request',
    txid,
    reason: obj.reason as ResendReason,
    ...(typeof obj.messageId === 'string' && obj.messageId.length > 0 ? { messageId: obj.messageId } : {})
  }
}

/**
 * `overrideHost` skips the overlay lookup and posts to a named box — for a control
 * message about a payment that was itself delivered to a link-named host.
 */
export async function sendControlMessage(
  client: {
    sendMessage(args: { recipient: string; messageBox: string; body: string }, overrideHost?: string): Promise<unknown>
  },
  args: { recipient: string; message: PaymentControlMessage },
  overrideHost?: string
): Promise<void> {
  await client.sendMessage(
    {
      recipient: args.recipient,
      messageBox: PAYMENT_CONTROL_BOX,
      body: JSON.stringify(args.message)
    },
    overrideHost
  )
}

export type ControlBoxMessage = { messageId: string; sender: string; body: unknown }

/** Raw `payment_control` messages. `acceptPayments: false` avoids fee auto-internalize. */
export async function listControlMessages(client: {
  listMessages(args: { messageBox: string; host?: string; acceptPayments?: boolean }): Promise<ControlBoxMessage[]>
}): Promise<ControlBoxMessage[]> {
  const listed = await client.listMessages({
    messageBox: PAYMENT_CONTROL_BOX,
    acceptPayments: false
  })
  return Array.isArray(listed) ? listed : []
}

export async function ackControlMessages(
  client: { acknowledgeMessage(args: { messageIds: string[] }): Promise<unknown> },
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0) return
  await client.acknowledgeMessage({ messageIds })
}

/**
 * Whether a failed delivery means the message box already holds this message.
 *
 * The box keys a message by an HMAC of its body against the recipient, so
 * re-delivering an unchanged payment token collides with the copy already
 * sitting in the recipient's box and the server refuses the write with a 400.
 *
 * That refusal is the outcome the caller wanted: the recipient HAS the message.
 * Reporting it as a failure sent the user back to a Resend button that could
 * never succeed — and the alternative, perturbing the body so it earns a fresh
 * id, would plant a second copy of a payment the recipient already holds.
 *
 * XR-046: matched ONLY on `@bsv/message-box-client`'s own structured
 * `ERR_DUPLICATE_MESSAGE` code (`Message Box send failed with HTTP 400
 * (ERR_DUPLICATE_MESSAGE).`), never on free prose. The client builds that
 * string itself from a server response field it validates against
 * `/^ERR_[A-Z0-9_]{1,64}$/` before embedding it — everything else in a
 * thrown Error's message is attacker/host-controlled text a malicious or
 * compromised recipientHost can fabricate at will for a 400 the recipient
 * never actually received, which would wrongly mark retryDelivery's caller
 * `delivered` and broadcast. Narrowing this does not close the deeper gap —
 * a bare, non-throwing `sendMessage` success is still accepted with no
 * recipient-authenticated receipt — closing that needs a receipt protocol
 * change out of scope for this fix.
 */
export function isDuplicateMessageError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (!/\b400\b/.test(text)) return false
  return /\bERR_DUPLICATE_MESSAGE\b/.test(text)
}
