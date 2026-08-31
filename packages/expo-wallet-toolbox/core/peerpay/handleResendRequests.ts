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

type ResendClient = {
  listMessages(args: { messageBox: string; host?: string; acceptPayments?: boolean }): Promise<
    { messageId: string; sender: string; body: unknown }[]
  >
  sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown>
  acknowledgeMessage(args: { messageIds: string[] }): Promise<unknown>
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
 * Rebuild a token for `txid` and drop it in the recipient's payment inbox.
 * Used by a NACK poll and by the activity-row "Send details again" chip.
 */
export async function resendPaymentDetails(args: {
  client: { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> }
  storage: StorageLike
  txid: string
  listPeerPayAction: (txid: string) => Promise<PeerPayActionLike | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
  recipient?: string
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
  recipient?: string
}): Promise<string | undefined> {
  const entries = await getOutboxEntries(args.storage)
  const entry = entries.find(e => outboxTxid(e) === args.txid)
  const listed = entry ? undefined : await args.listPeerPayAction(args.txid)
  const action = entry ? actionFromOutbox(entry, args.txid) : listed
  const recipient =
    entry?.recipient || recipientFromLabels(listed?.labels) || args.recipient
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
    if (!parsed || parsed.type !== 'resend_request') continue
    const sender = typeof msg.sender === 'string' ? msg.sender : ''
    try {
      const deliveredTo = await rebuildAndDeliver({
        client,
        storage,
        txid: parsed.txid,
        listPeerPayAction,
        refetch,
        recipient: sender
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
