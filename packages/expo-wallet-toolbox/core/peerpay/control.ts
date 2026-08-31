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

const RESEND_REASONS: ReadonlySet<string> = new Set([
  'corrupt',
  'uncreditible',
  'double_spent',
  'bounced_offline'
])

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

export async function sendControlMessage(
  client: { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> },
  args: { recipient: string; message: PaymentControlMessage }
): Promise<void> {
  await client.sendMessage({
    recipient: args.recipient,
    messageBox: PAYMENT_CONTROL_BOX,
    body: JSON.stringify(args.message)
  })
}
