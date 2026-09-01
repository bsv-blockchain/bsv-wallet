import { Beef } from '@bsv/sdk'
import {
  ackControlMessages,
  isDuplicateMessageError,
  listControlMessages,
  parseControlMessage
} from './control'
import { getOutboxEntries, type OutboxEntry } from './outbox'
import { instructionsFromOutput, rebuildPeerPayToken } from './rebuildToken'

/** The message box outbound payments are delivered into. Same name as handle.ts. */
const PAYMENT_INBOX = 'payment_inbox'

/** Stored unanswered `resend_request`s so Home can show a banner without re-listing. */
export const UNANSWERED_RESENDS_KEY = 'peerpay_unanswered_resends'

const PUBKEY_LABEL = /^(02|03)[0-9a-fA-F]{64}$/

/**
 * Rail labels an outbound payment can carry. Both are resendable: each writes
 * the payee's identity key as a label and BRC-29 derivation data as the
 * output's customInstructions. Not exported — `localpay/pending` already
 * exports a (differently-valued) PEERPAY_LABEL through the same barrel.
 */
const RESENDABLE_LABELS = ['peerpay', 'localpay']

interface StorageLike {
  getKeyValue: (key: string) => Promise<string | undefined>
  setKeyValue: (key: string, value: string) => Promise<void>
  /** Optional, and only used to recover derivation data listActions did not
   * hand back — see `outputsFromStorage`. */
  findTransactions?: (args: {
    partial: { txid: string }
    noRawTx?: boolean
  }) => Promise<{ transactionId?: number }[]>
  findOutputs?: (args: {
    partial: { transactionId: number }
    noScript?: boolean
  }) => Promise<{ vout?: number; satoshis?: number | null; customInstructions?: string | null; basketId?: number | null }[]>
}

/**
 * The action's outputs read straight from this device's own tables.
 *
 * `listActions` is the normal source, but it is a long way from the data: the
 * permissions manager sits in front of it, the query is a capped window over
 * two labels, and `includeOutputs` is the caller's to remember. When it comes
 * back without derivation data the payment looks unrebuildable even though
 * every byte needed is in `outputs.customInstructions` locally. This is the
 * short way to the same facts.
 *
 * `basketId` stands in for the basket name: what `paymentOutput` needs to know
 * is only whether an output landed in a basket of ours (change) or in none
 * (the payee's).
 */
async function outputsFromStorage(storage: StorageLike, txid: string): Promise<PeerPayActionLike['outputs']> {
  try {
    const tx = (await storage.findTransactions?.({ partial: { txid }, noRawTx: true }))?.[0]
    if (typeof tx?.transactionId !== 'number') return undefined
    const rows = await storage.findOutputs?.({ partial: { transactionId: tx.transactionId }, noScript: true })
    if (!rows?.length) return undefined
    return rows.map(o => ({
      customInstructions: o.customInstructions ?? undefined,
      satoshis: typeof o.satoshis === 'number' ? o.satoshis : 0,
      outputIndex: o.vout,
      basket: o.basketId ? 'own' : undefined
    }))
  } catch {
    return undefined
  }
}

function hasDerivationData(outputs: PeerPayActionLike['outputs']): boolean {
  return !!outputs?.some(o => instructionsFromOutput(o.customInstructions))
}

/**
 * `customInstructions` as stored is not necessarily what was written.
 *
 * WalletPermissionsManager encrypts wallet metadata on the way into storage
 * (`maybeEncryptMetadata`) and decrypts it again on the way out of listActions.
 * Read the column directly and what comes back is base64 ciphertext, which
 * parses as no JSON at all — so a rebuild that reached past listActions to the
 * table would conclude the payment carries no derivation data.
 *
 * Anything that already parses is left untouched: metadata written before
 * encryption was turned on is plaintext, and so is every value on a wallet
 * that never had it on.
 */
async function decodeInstructions(
  value: string | object | undefined,
  decrypt?: (value: string) => Promise<string>
): Promise<string | object | undefined> {
  if (instructionsFromOutput(value)) return value
  if (typeof value !== 'string' || !decrypt) return value
  try {
    const plain = await decrypt(value)
    return instructionsFromOutput(plain) ? plain : value
  } catch {
    return value
  }
}

async function decodeOutputs(
  outputs: PeerPayActionLike['outputs'],
  decrypt?: (value: string) => Promise<string>
): Promise<PeerPayActionLike['outputs']> {
  if (!outputs || !decrypt) return outputs
  return await Promise.all(
    outputs.map(async o => ({ ...o, customInstructions: await decodeInstructions(o.customInstructions, decrypt) }))
  )
}

export type PeerPayActionLike = {
  txid?: string
  labels?: string[]
  // `outputIndex` and `basket` are what let the rebuild tell the payment apart
  // from this wallet's own change, which carries derivation data of its own.
  outputs?: {
    customInstructions?: string | object
    satoshis?: number
    outputIndex?: number
    basket?: string
  }[]
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
    // The entry already names the payment output, so there is no change to tell
    // it apart from — an unbasketed single output is exactly that statement.
    outputs: [
      {
        customInstructions: entry.token.customInstructions,
        satoshis: entry.token.amount,
        ...(typeof entry.token.outputIndex === 'number' ? { outputIndex: entry.token.outputIndex } : {})
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
          // Both rails, because both are resendable: a nearby payment carries
          // the same BRC-29 derivation data and the payee's identity key.
          // labelQueryMode defaults to 'any', so this is peerpay OR localpay.
          {
            labels: RESENDABLE_LABELS,
            includeOutputs: true,
            includeLabels: true,
            limit: 1000
          },
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
/**
 * Why a resend could not happen.
 *
 * A single boolean was indistinguishable from a crash at the call site, so
 * every failure reached the user as "Unknown error" — the dead end this
 * feature exists to remove, reproduced inside it. `no_record` and
 * `no_recipient` are the honest answers for a payment made before its rail
 * recorded the payee's key and derivation data: nothing on this device can
 * rebuild it, and retrying will never change that.
 */
export type ResendFailure = 'no_record' | 'no_recipient' | 'no_transaction'
export type ResendOutcome = { ok: true } | { ok: false; reason: ResendFailure }

export async function resendPaymentDetails(args: {
  client: { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> }
  storage: StorageLike
  txid: string
  listPeerPayAction: (txid: string) => Promise<PeerPayActionLike | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
  /** Unwraps metadata the permissions manager encrypted on its way to storage. */
  decryptMetadata?: (value: string) => Promise<string>
}): Promise<ResendOutcome> {
  return await rebuildAndDeliver(args)
}

async function rebuildAndDeliver(args: {
  client: { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> }
  storage: StorageLike
  txid: string
  listPeerPayAction: (txid: string) => Promise<PeerPayActionLike | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
  /** Unwraps metadata the permissions manager encrypted on its way to storage. */
  decryptMetadata?: (value: string) => Promise<string>
}): Promise<ResendOutcome> {
  const entries = await getOutboxEntries(args.storage)
  const entry = entries.find(e => outboxTxid(e) === args.txid)
  const listed = entry ? undefined : await args.listPeerPayAction(args.txid)
  const action = entry ? actionFromOutbox(entry, args.txid) : listed
  // No outbox row and no labelled action: this payment predates the rail
  // recording who it was for, so it cannot be rebuilt from this device.
  if (!action) return { ok: false, reason: 'no_record' }
  const recipient = entry?.recipient || recipientFromLabels(listed?.labels)
  if (!recipient) return { ok: false, reason: 'no_recipient' }

  // Without derivation data there is no token to build, and the rebuild would
  // bail before it ever reached for the transaction — reporting "couldn't get
  // this payment's data" about data it never went looking for.
  let withOutputs = action
  if (!hasDerivationData(action.outputs)) {
    withOutputs = { ...action, outputs: await decodeOutputs(action.outputs, args.decryptMetadata) }
    let outputs: PeerPayActionLike['outputs']
    if (!hasDerivationData(withOutputs.outputs)) {
      outputs = await decodeOutputs(await outputsFromStorage(args.storage, args.txid), args.decryptMetadata)
      if (outputs) withOutputs = { ...action, outputs }
    }
    if (!hasDerivationData(withOutputs.outputs)) {
      // Say what was actually seen. "No derivation data" is true of an action
      // with no outputs, of outputs whose customInstructions never made it to
      // storage, and of ones holding something that is not the expected JSON —
      // three different faults that need three different fixes.
      console.warn(
        `[resend] no output with BRC-29 derivation data for ${args.txid};` +
          ` listActions gave ${action.outputs?.length ?? 0} output(s), storage gave ${outputs?.length ?? 0};` +
          ` customInstructions seen: ${JSON.stringify(
            [...(action.outputs ?? []), ...(outputs ?? [])].map(o =>
              typeof o.customInstructions === 'string' ? o.customInstructions.slice(0, 120) : o.customInstructions
            )
          )}`
      )
    }
  }

  const rebuilt = await rebuildPeerPayToken({
    action: withOutputs,
    recipient,
    refetch: args.refetch
  })
  // The recipient and derivation data resolved, so what is missing is the
  // transaction itself — no proof from the network and no local copy.
  if (!rebuilt) return { ok: false, reason: 'no_transaction' }
  if (entry?.token.note) rebuilt.token.note = entry.token.note

  try {
    await args.client.sendMessage({
      recipient: rebuilt.recipient,
      messageBox: PAYMENT_INBOX,
      body: JSON.stringify(rebuilt.token)
    })
  } catch (e) {
    // The box already holds this exact token: the recipient has what the
    // resend was trying to give them, so this is the wanted end state.
    if (!isDuplicateMessageError(e)) throw e
  }
  return { ok: true }
}

export async function handleResendRequests(args: {
  client: ResendClient
  storage: StorageLike
  listPeerPayAction: (txid: string) => Promise<PeerPayActionLike | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
  decryptMetadata?: (value: string) => Promise<string>
}): Promise<{ resent: number; pending: PendingResend[] }> {
  const { client, storage, listPeerPayAction, refetch, decryptMetadata } = args
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
        refetch,
        decryptMetadata
      })
      if (!deliveredTo.ok) {
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
