import { Beef } from '@bsv/sdk'
import { ackControlMessages, listControlMessages, parseControlMessage } from './control'
import { getOutboxEntries, type OutboxEntry } from './outbox'
import { rebuildPeerPayToken } from './rebuildToken'

/** The message box outbound payments are delivered into. Same name as handle.ts. */
const PAYMENT_INBOX = 'payment_inbox'

/** Stored unanswered `resend_request`s so Home can show a banner without re-listing. */
export const UNANSWERED_RESENDS_KEY = 'peerpay_unanswered_resends'

const PUBKEY_LABEL = /^(02|03)[0-9a-fA-F]{64}$/

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

export type PeerPayActionLike = {
  txid?: string
  labels?: string[]
  outputs?: { customInstructions?: string | object; satoshis?: number }[]
}

export type PendingResend = { txid: string; sender: string }

type ListAckClient = {
  listMessages(args: { messageBox: string; host?: string; acceptPayments?: boolean }): Promise<
    { messageId: string; sender: string; body: unknown }[]
  >
  acknowledgeMessage(args: { messageIds: string[] }): Promise<unknown>
}

type ResendClient = ListAckClient & {
  sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown>
}

function txidFromInboxBody(body: unknown): string | undefined {
  let value: unknown = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const obj = value as { transaction?: unknown; token?: { transaction?: unknown } }
  const tx = Array.isArray(obj.transaction)
    ? obj.transaction
    : Array.isArray(obj.token?.transaction)
      ? obj.token.transaction
      : undefined
  if (!tx) return undefined
  try {
    const txid = Beef.fromBinary(Array.from(tx as number[])).atomicTxid
    return typeof txid === 'string' && txid.length > 0 ? txid : undefined
  } catch {
    return undefined
  }
}

/**
 * Drop a still-uncredited token for `txid` from `sender`. Already-internalized
 * txs are left alone — a cancel after broadcast cannot un-mine.
 * Empty `sender` matches nothing (fail closed).
 */
async function dropInboxTokenForTxid(
  client: ListAckClient,
  txid: string,
  sender: string
): Promise<'dropped' | 'gone' | 'refused'> {
  const listed = await client.listMessages({
    messageBox: PAYMENT_INBOX,
    acceptPayments: false
  })
  const rows = Array.isArray(listed) ? listed : []
  const ids = rows
    .filter(m => m.sender === sender && sender !== '' && txidFromInboxBody(m.body) === txid)
    .map(m => String(m.messageId))
  if (ids.length > 0) {
    await client.acknowledgeMessage({ messageIds: ids })
    return 'dropped'
  }
  if (rows.some(m => txidFromInboxBody(m.body) === txid)) return 'refused'
  return 'gone'
}

/** Drop authenticated inbox tokens, then ack the control message. */
async function consumePaymentCancelled(
  client: ListAckClient,
  msg: { messageId: string; sender?: unknown },
  txid: string
): Promise<void> {
  const sender = typeof msg.sender === 'string' ? msg.sender : ''
  try {
    const result = await dropInboxTokenForTxid(client, txid, sender)
    if (result === 'refused') return
  } catch {
    // Leave the control message so a later poll retries the inbox drop.
    return
  }
  await ackControlMessages(client, [msg.messageId])
}

function recipientFromLabels(labels: string[] | undefined): string | undefined {
  return labels?.find(l => PUBKEY_LABEL.test(l))
}

function outboxTxid(entry: OutboxEntry): string | undefined {
  if (typeof entry.txid === 'string' && entry.txid.length > 0) return entry.txid
  try {
    const txid = Beef.fromBinary(Array.from(entry.token.transaction)).atomicTxid
    return typeof txid === 'string' && txid.length > 0 ? txid : undefined
  } catch {
    return undefined
  }
}

function actionFromOutbox(entry: OutboxEntry, txid: string): PeerPayActionLike {
  return {
    txid,
    labels: ['peerpay'],
    outputs: [
      {
        customInstructions: entry.token.customInstructions,
        satoshis: entry.token.amount
      }
    ]
  }
}

export function makeListPeerPayAction(
  wallet:
    | {
        listActions(
          args: unknown,
          originator?: string
        ): Promise<{ actions: PeerPayActionLike[] }>
      }
    | null
    | undefined,
  adminOriginator: string
): (txid: string) => Promise<PeerPayActionLike | undefined> {
  let cache: Promise<PeerPayActionLike[] | undefined> | undefined
  return async txid => {
    if (!wallet) return undefined
    if (!cache) {
      cache = wallet
        .listActions(
          { labels: ['peerpay'], includeOutputs: true, includeLabels: true, limit: 1000 },
          adminOriginator
        )
        .then(r => r.actions ?? [])
        .catch(() => undefined)
    }
    const actions = await cache
    return actions?.find(a => a.txid === txid)
  }
}

export async function loadUnansweredResends(storage: StorageLike): Promise<PendingResend[]> {
  try {
    const raw = await storage.getKeyValue(UNANSWERED_RESENDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (row): row is PendingResend =>
        !!row &&
        typeof row === 'object' &&
        typeof (row as PendingResend).txid === 'string' &&
        (row as PendingResend).txid.length > 0 &&
        typeof (row as PendingResend).sender === 'string'
    )
  } catch {
    return []
  }
}

async function storeUnansweredResends(storage: StorageLike, pending: PendingResend[]): Promise<void> {
  await storage.setKeyValue(UNANSWERED_RESENDS_KEY, JSON.stringify(pending))
}

/**
 * List `resend_request`s and persist them. Does not rebuild or send —
 * only the Resend tap (`handleResendRequests`) and the activity chip do that.
 */
export async function listPendingResendRequests(args: {
  client: ListAckClient
  storage: StorageLike
}): Promise<{ pending: PendingResend[] }> {
  const messages = await listControlMessages(args.client)
  const pending: PendingResend[] = []
  for (const msg of messages) {
    const parsed = parseControlMessage(msg.body)
    if (parsed?.type === 'payment_cancelled') {
      try {
        await consumePaymentCancelled(args.client, msg, parsed.txid)
      } catch {
        // Inbox drop already retried inside consume; a failed control ack is
        // retried on the next poll. Do not skip remaining resend rows.
      }
      continue
    }
    if (!parsed || parsed.type !== 'resend_request') continue
    pending.push({
      txid: parsed.txid,
      sender: typeof msg.sender === 'string' ? msg.sender : ''
    })
  }
  await storeUnansweredResends(args.storage, pending)
  return { pending }
}

/**
 * Rebuild a token for `txid` and drop it in the recipient's payment inbox.
 * Used by the Resend tap and the activity-row "Send details again" chip.
 */
export async function resendPaymentDetails(args: {
  client: { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> }
  storage: StorageLike
  txid: string
  listPeerPayAction: (txid: string) => Promise<PeerPayActionLike | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<boolean> {
  const delivered = await rebuildAndDeliver(args)
  return delivered !== undefined
}

async function rebuildAndDeliver(args: {
  client: { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> }
  storage: StorageLike
  txid: string
  listPeerPayAction: (txid: string) => Promise<PeerPayActionLike | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<string | undefined> {
  const entries = await getOutboxEntries(args.storage)
  const entry = entries.find(e => outboxTxid(e) === args.txid)
  const listed = entry ? undefined : await args.listPeerPayAction(args.txid)
  const action = entry ? actionFromOutbox(entry, args.txid) : listed
  const recipient = entry?.recipient || recipientFromLabels(listed?.labels)
  if (!action || !recipient) return undefined

  const rebuilt = await rebuildPeerPayToken({
    action,
    recipient,
    refetch: args.refetch
  })
  if (!rebuilt) return undefined
  if (entry?.token.note) rebuilt.token.note = entry.token.note

  await args.client.sendMessage({
    recipient: rebuilt.recipient,
    messageBox: PAYMENT_INBOX,
    body: JSON.stringify(rebuilt.token)
  })
  return rebuilt.recipient
}

export async function handleResendRequests(args: {
  client: ResendClient
  storage: StorageLike
  listPeerPayAction: (txid: string) => Promise<PeerPayActionLike | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<{ resent: number; pending: PendingResend[] }> {
  const { client, storage, listPeerPayAction, refetch } = args
  const messages = await listControlMessages(client)
  let resent = 0
  const pending: PendingResend[] = []

  for (const msg of messages) {
    const parsed = parseControlMessage(msg.body)
    if (parsed?.type === 'payment_cancelled') {
      try {
        await consumePaymentCancelled(client, msg, parsed.txid)
      } catch {
        // Same as listPendingResendRequests: one cancel must not skip resends.
      }
      continue
    }
    if (!parsed || parsed.type !== 'resend_request') continue
    const sender = typeof msg.sender === 'string' ? msg.sender : ''
    try {
      const deliveredTo = await rebuildAndDeliver({
        client,
        storage,
        txid: parsed.txid,
        listPeerPayAction,
        refetch
      })
      if (!deliveredTo) {
        pending.push({ txid: parsed.txid, sender })
        continue
      }
      await ackControlMessages(client, [msg.messageId])
      resent++
    } catch {
      pending.push({ txid: parsed.txid, sender })
    }
  }

  await storeUnansweredResends(storage, pending)
  return { resent, pending }
}
