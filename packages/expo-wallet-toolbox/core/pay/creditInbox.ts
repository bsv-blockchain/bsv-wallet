/**
 * One credit pass over the PeerPay inbox.
 *
 * HandleReceive (focused 5s poll) and TaskCreditInbox (background) both call
 * `creditInboxOnce`. The mutex lives here so a Retry cannot start a second
 * internalize while a poll or the monitor task is already in the box.
 */
import { Beef } from '@bsv/sdk'
import { type IncomingPayment, type PeerPayClient } from '@bsv/message-box-client'
import {
  isPaymentTokenShape,
  listDamagedInboxMessages,
  type DamagedInboxMessage
} from './damagedInbox'
import {
  autoAcceptInbox,
  needsAttention,
  type InboxAttempt
} from './rails/handle'
import type { CreditFailureKind } from './creditErrors'
import { sendControlMessage } from '../peerpay/control'
import { loadInboxAttempts, saveInboxAttempts } from '../peerpay/inboxAttempts'

/** Same default the receive screen used when the note was left blank. */
export const INBOX_DESCRIPTION = 'Identity Payment'

/** Placeholder token so unparseable inbox rows can share the IncomingPayment row UI. */
export const DAMAGED_TOKEN_PLACEHOLDER: IncomingPayment['token'] = {
  customInstructions: { derivationPrefix: '', derivationSuffix: '' },
  transaction: [],
  amount: 0
}

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
}

type ListMessagesClient = {
  listMessages?(args: {
    messageBox: string
    host?: string
    acceptPayments?: boolean
  }): Promise<{ messageId: string; sender: string; body: unknown }[]>
}

export type CreditInboxClient = Pick<PeerPayClient, 'listIncomingPayments'> &
  ListMessagesClient &
  Partial<Pick<PeerPayClient, 'sendMessage'>>

export interface CreditInboxResult {
  accepted: number
  attempts: Record<string, InboxAttempt>
  damaged: DamagedInboxMessage[]
  payments: IncomingPayment[]
  displayPayments: IncomingPayment[]
  attentionCount: number
  pending: boolean
}

let inFlight: Promise<CreditInboxResult> | null = null

export function isCreditInboxBusy(): boolean {
  return inFlight !== null
}

export function resetCreditInboxForTests(): void {
  inFlight = null
}

/** Outbox-matching txid when the token parses; otherwise the inbox message id. */
function paymentTxid(payment: IncomingPayment): string {
  try {
    const txid = Beef.fromBinary(Array.from(payment.token.transaction ?? [])).atomicTxid
    if (txid) return txid
  } catch {
    // Unparseable AtomicBEEF: the inbox id still identifies the row.
  }
  return String(payment.messageId)
}

async function listRawInbox(
  client: ListMessagesClient,
  messageBoxUrl: string
): Promise<{ messageId: string; sender: string; body: unknown }[]> {
  try {
    return (
      (await client.listMessages?.({
        messageBox: 'payment_inbox',
        host: messageBoxUrl,
        acceptPayments: false
      })) ?? []
    )
  } catch {
    return []
  }
}

function attentionCountFor(
  displayPayments: IncomingPayment[],
  damaged: DamagedInboxMessage[],
  attempts: Record<string, InboxAttempt>
): number {
  const ids = new Set(damaged.map(d => d.messageId))
  for (const p of displayPayments) {
    const id = String(p.messageId)
    if (ids.has(id) || needsAttention(attempts[id]) || attempts[id]?.kind === 'environmental') {
      ids.add(id)
    }
  }
  return ids.size
}

async function runCreditInbox(args: {
  client: CreditInboxClient
  messageBoxUrl: string
  storage?: StorageLike
  force?: string[]
  classify?: (e: unknown) => CreditFailureKind
  accept: (payment: IncomingPayment) => Promise<void>
}): Promise<CreditInboxResult> {
  const { client, messageBoxUrl, storage, force, classify, accept } = args
  const list = await client.listIncomingPayments(messageBoxUrl)
  const raw = await listRawInbox(client, messageBoxUrl)
  const fromDiff = listDamagedInboxMessages({ raw, parsed: list })
  const byId = new Map(fromDiff.map(d => [d.messageId, d]))
  for (const p of list) {
    const id = String(p.messageId)
    if (!isPaymentTokenShape(p.token) && !byId.has(id)) {
      byId.set(id, { messageId: id, sender: p.sender ?? '', reason: 'bad_shape' })
    }
  }
  const damaged = [...byId.values()]
  const damagedIdSet = new Set(damaged.map(d => d.messageId))
  const extras: IncomingPayment[] = damaged
    .filter(d => !list.some(p => String(p.messageId) === d.messageId))
    .map(d => ({
      messageId: d.messageId,
      sender: d.sender,
      token: DAMAGED_TOKEN_PLACEHOLDER
    }))
  const displayPayments = [...list, ...extras]
  const creditable = list.filter(p => !damagedIdSet.has(String(p.messageId)))
  const prior = storage ? await loadInboxAttempts(storage) : {}
  const outcome = await autoAcceptInbox({
    payments: creditable,
    attempts: prior,
    force,
    classify,
    onGiveUp: async (payment, kind) => {
      if (!payment.sender) return
      await sendControlMessage(client as Pick<PeerPayClient, 'sendMessage'>, {
        recipient: payment.sender,
        message: {
          type: 'resend_request',
          txid: paymentTxid(payment),
          reason: kind === 'double_spend' ? 'double_spent' : 'uncreditible',
          messageId: String(payment.messageId)
        }
      })
    },
    accept
  })
  if (storage) await saveInboxAttempts(storage, outcome.attempts)
  const attentionCount = attentionCountFor(displayPayments, damaged, outcome.attempts)
  const pending = Object.values(outcome.attempts).some(a => !needsAttention(a))
  return {
    accepted: outcome.accepted,
    attempts: outcome.attempts,
    damaged,
    payments: list,
    displayPayments,
    attentionCount,
    pending
  }
}

/**
 * List, diff damaged, auto-accept, persist attempts.
 *
 * A second caller without `force` joins the in-flight pass. A Retry with
 * `force` waits for that pass, then runs its own.
 */
export async function creditInboxOnce(args: {
  client: CreditInboxClient
  messageBoxUrl: string
  storage?: StorageLike
  force?: string[]
  classify?: (e: unknown) => CreditFailureKind
  accept: (payment: IncomingPayment) => Promise<void>
}): Promise<CreditInboxResult> {
  const force = args.force ?? []
  if (inFlight && force.length === 0) return inFlight
  if (inFlight) await inFlight.catch(() => {})
  const run = runCreditInbox(args)
  inFlight = run
  try {
    return await run
  } finally {
    if (inFlight === run) inFlight = null
  }
}
