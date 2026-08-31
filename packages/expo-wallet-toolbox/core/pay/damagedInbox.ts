export type DamagedInboxReason = 'unparseable' | 'bad_shape'

export interface DamagedInboxMessage {
  messageId: string
  sender: string
  reason: DamagedInboxReason
}

/** True when body looks like a PeerPay payment token. */
export function isPaymentTokenShape(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false
  const custom = (body as { customInstructions?: unknown }).customInstructions
  if (custom === null || typeof custom !== 'object') return false
  const { derivationPrefix, derivationSuffix } = custom as {
    derivationPrefix?: unknown
    derivationSuffix?: unknown
  }
  if (typeof derivationPrefix !== 'string' || typeof derivationSuffix !== 'string') return false
  const transaction = (body as { transaction?: unknown }).transaction
  if (!Array.isArray(transaction)) return false
  return transaction.every(n => typeof n === 'number')
}

function reasonForBody(body: unknown): DamagedInboxReason {
  if (typeof body === 'string') {
    try {
      JSON.parse(body)
      return 'bad_shape'
    } catch {
      return 'unparseable'
    }
  }
  if (body !== null && typeof body === 'object') return 'bad_shape'
  return 'unparseable'
}

/**
 * Diff raw payment_inbox messages against those listIncomingPayments kept.
 * Missing ids and wrong-shaped bodies become attention rows.
 */
export function listDamagedInboxMessages(args: {
  raw: { messageId: string; sender: string; body: unknown }[]
  parsed: { messageId: string }[]
}): DamagedInboxMessage[] {
  const parsedIds = new Set(args.parsed.map(p => String(p.messageId)))
  const damaged: DamagedInboxMessage[] = []

  for (const msg of args.raw) {
    const messageId = String(msg.messageId)
    const sender = String(msg.sender ?? '')

    if (!parsedIds.has(messageId)) {
      damaged.push({ messageId, sender, reason: reasonForBody(msg.body) })
      continue
    }

    // listIncomingPayments keeps any JSON; still shape-check object bodies.
    if (msg.body !== null && typeof msg.body === 'object' && !isPaymentTokenShape(msg.body)) {
      damaged.push({ messageId, sender, reason: 'bad_shape' })
    }
  }

  return damaged
}
