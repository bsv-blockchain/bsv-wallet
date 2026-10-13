// Payment requests to people (decision 9's optional extension, the prototype's
// "Request" on a contact and ShareRequestSheet): a request is the pay link the
// app already makes (an amount in the link), delivered to the other person's
// Bitcoin SV Wallet through MessageBox, in its own message box, and kept in
// both wallets' activity until it's paid, declined or cancelled.
//
// What's here is the whole of it on the app's side. The transport is an
// interface: MessageBox today (the existing service, a new message box name),
// anything else later. What the server side could add on top (a push for a
// new request, a hosted bitcoinsv.com request page) plugs in without changing
// this.
import type { PeerMessage } from '@bsv/message-box-client'
import { cleanPeerPayNote, parsePeerPayURI } from '@bsv/expo-wallet-toolbox/core/parsePeerPayURI'

/** The message box requests travel in. */
export const REQUEST_BOX = 'payment_requests'

export type RequestStatus = 'pending' | 'paid' | 'declined' | 'cancelled'

export interface PaymentRequest {
  /** the same on both sides: the sender makes it */
  id: string
  direction: 'out' | 'in'
  /** the other person's identity key */
  counterparty: string
  /** what they're called (a contact's name, or what they sent) */
  name?: string
  /** satoshis, or the token's base units */
  units: number
  asset?: { assetId: string; ticker: string; decimals: number }
  note?: string
  /** the pay link that settles it */
  link: string
  createdAt: string
  status: RequestStatus
  /** when it changed from pending */
  settledAt?: string
  /** yours: when they said they'd paid it (a claim; only the payment itself marks it paid) */
  claimedPaidAt?: string
}

/** What travels between the two wallets. */
export type RequestMessage =
  | {
      type: 'payment-request'
      id: string
      units: number
      asset?: PaymentRequest['asset']
      note?: string
      link: string
      fromName?: string
      createdAt: string
    }
  | { type: 'request-cancelled'; id: string }
  | { type: 'request-declined'; id: string }
  | { type: 'request-paid'; id: string }
  /** no amount: "here's how to pay me", shown once and not kept */
  | { type: 'pay-link'; id: string; link: string; note?: string; fromName?: string }

/** How requests reach the other wallet. */
export interface RequestTransport {
  send(recipient: string, message: RequestMessage): Promise<void>
  /** what's waiting for this wallet */
  receive(): Promise<{ messageId: string; sender: string; message: RequestMessage }[]>
  /** what's been read, so it isn't read again */
  acknowledge(messageIds: string[]): Promise<void>
}

/** The structural slice of the MessageBox client this uses. */
interface BoxClient {
  sendMessage(args: { recipient: string; messageBox: string; body: string | object }): Promise<unknown>
  listMessages(args: { messageBox: string }): Promise<PeerMessage[]>
  acknowledgeMessage(args: { messageIds: string[] }): Promise<unknown>
}

const isRequestMessage = (v: unknown): v is RequestMessage =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as { id?: unknown }).id === 'string' &&
  ['payment-request', 'request-cancelled', 'request-declined', 'request-paid', 'pay-link'].includes((v as { type?: string }).type ?? '')

/** MessageBox, the existing service: requests in their own box. */
export function messageBoxTransport(client: BoxClient): RequestTransport {
  return {
    async send(recipient, message) {
      await client.sendMessage({ recipient, messageBox: REQUEST_BOX, body: message })
    },
    async receive() {
      const msgs = await client.listMessages({ messageBox: REQUEST_BOX })
      const out: { messageId: string; sender: string; message: RequestMessage }[] = []
      for (const m of msgs) {
        let body: unknown = m.body
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body)
          } catch {
            body = null
          }
        }
        if (isRequestMessage(body)) out.push({ messageId: m.messageId, sender: m.sender, message: body })
      }
      return out
    },
    async acknowledge(messageIds) {
      if (messageIds.length) await client.acknowledgeMessage({ messageIds })
    }
  }
}

/** Requests are this wallet's own: kept in its storage, never shared between wallets. */
export const REQUESTS_KV_KEY = 'bitcoinsv.requests.v1'

export interface KeyValue {
  getKeyValue(k: string): Promise<string | undefined>
  setKeyValue(k: string, v: string): Promise<void>
}

export async function loadRequests(kv: KeyValue): Promise<PaymentRequest[]> {
  try {
    const raw = await kv.getKeyValue(REQUESTS_KV_KEY)
    const list = raw ? (JSON.parse(raw) as PaymentRequest[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function saveRequests(kv: KeyValue, list: PaymentRequest[]): Promise<void> {
  // the newest few hundred are plenty
  await kv.setKeyValue(REQUESTS_KV_KEY, JSON.stringify(list.slice(0, 300)))
}

/**
 * Who's on the other side: a contact's name, or their key, shortened. The name
 * a request carries is what they call themselves, never shown as who they are
 * (see `selfNamed`).
 */
export const whoLabel = (r: Pick<PaymentRequest, 'counterparty'>, contactName?: string) =>
  contactName ?? `${r.counterparty.slice(0, 6)}…${r.counterparty.slice(-4)}`

/** For someone not in your contacts: the name they gave, said as theirs. */
export const selfNamed = (r: Pick<PaymentRequest, 'name'>, contactName?: string) =>
  !contactName && r.name ? `Calls themselves “${r.name}”` : undefined

export const newRequestId = () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

/** The longest name a request may carry (it's what they call themselves: shown as theirs, not checked). */
const NAME_MAX = 40
const LINK_MAX = 2048

/**
 * A request as it arrives, checked: a whole positive amount, a real date (or
 * now), a token named properly, and a pay link that pays the sender exactly
 * what it asks. Anything else is dropped: a request is someone else's words,
 * and its link is what Pay would follow.
 */
export function checkIncomingRequest(
  sender: string,
  m: Extract<RequestMessage, { type: 'payment-request' }>,
  now: string
): PaymentRequest | null {
  if (typeof m.units !== 'number' || !Number.isSafeInteger(m.units) || m.units <= 0) return null
  if (typeof m.link !== 'string' || m.link.length > LINK_MAX) return null
  let asset: PaymentRequest['asset']
  if (m.asset !== undefined) {
    const a = m.asset as Partial<NonNullable<PaymentRequest['asset']>>
    if (
      !a ||
      typeof a.assetId !== 'string' ||
      typeof a.ticker !== 'string' ||
      !/^[A-Za-z0-9.$_-]{1,12}$/.test(a.ticker) ||
      !Number.isInteger(a.decimals) ||
      (a.decimals as number) < 0 ||
      (a.decimals as number) > 18
    )
      return null
    asset = { assetId: a.assetId.toLowerCase(), ticker: a.ticker, decimals: a.decimals as number }
  }
  // the link must pay the sender, the amount asked, in the money asked
  const link = parsePeerPayURI(m.link)
  if (!link || link.identityKey.toLowerCase() !== sender.toLowerCase()) return null
  if (asset ? link.asset !== asset.assetId || link.amount !== m.units : link.sats !== m.units || link.asset !== undefined) return null
  const at = typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)) ? new Date(m.createdAt).toISOString() : now
  const name = cleanPeerPayNote(typeof m.fromName === 'string' ? m.fromName : undefined)
  return {
    id: m.id,
    direction: 'in',
    counterparty: sender.toLowerCase(),
    ...(name ? { name: Array.from(name).slice(0, NAME_MAX).join('') } : {}),
    units: m.units,
    ...(asset ? { asset } : {}),
    ...(cleanPeerPayNote(typeof m.note === 'string' ? m.note : undefined) ? { note: cleanPeerPayNote(m.note) } : {}),
    link: m.link,
    // never later than now: a future date would sort it above everything
    createdAt: at > now ? now : at,
    status: 'pending'
  }
}

/** Messages in, applied to what this wallet has. Returns the new list and the requests that just arrived. */
export function applyIncoming(
  list: PaymentRequest[],
  incoming: { sender: string; message: RequestMessage }[],
  now = new Date().toISOString()
): { list: PaymentRequest[]; arrived: PaymentRequest[] } {
  let next = [...list]
  const arrived: PaymentRequest[] = []
  for (const { sender, message: m } of incoming) {
    if (m.type === 'pay-link') continue
    const i = next.findIndex(r => r.id === m.id && r.counterparty === sender.toLowerCase())
    if (m.type === 'payment-request') {
      // asked again (a reminder): said again, while it's still theirs to pay
      if (i >= 0) {
        if (next[i].direction === 'in' && next[i].status === 'pending') arrived.push(next[i])
        continue
      }
      const r = checkIncomingRequest(sender, m, now)
      if (!r) continue
      next = [r, ...next]
      arrived.push(r)
    } else if (i >= 0 && next[i].status === 'pending') {
      // a cancel only comes from who asked; a decline or "paid" only from who was asked
      const fromRightSide = m.type === 'request-cancelled' ? next[i].direction === 'in' : next[i].direction === 'out'
      if (!fromRightSide) continue
      // "paid" is their word for it: only the payment coming in marks it paid (matchPaid)
      if (m.type === 'request-paid') next[i] = { ...next[i], claimedPaidAt: now }
      else next[i] = { ...next[i], status: m.type === 'request-cancelled' ? 'cancelled' : 'declined', settledAt: now }
    }
  }
  return { list: next, arrived }
}

/**
 * A request this wallet sent is paid when a payment from that person comes in
 * for at least the amount, after it was asked for. Pure: the activity rows are
 * passed in.
 */
export function matchPaid(
  list: PaymentRequest[],
  /** `units`: satoshis; `figure`: a token's amount as shown, read in the request's own decimals */
  payments: { counterparty?: string; incoming: boolean; units: number; figure?: string; assetId?: string; createdAt?: string }[],
  now = new Date().toISOString()
): PaymentRequest[] {
  const used = new Set<number>()
  return list.map(r => {
    if (r.direction !== 'out' || r.status !== 'pending') return r
    const j = payments.findIndex(
      (p, k) =>
        !used.has(k) &&
        p.incoming &&
        p.counterparty?.toLowerCase() === r.counterparty.toLowerCase() &&
        (p.assetId?.toLowerCase() ?? null) === (r.asset?.assetId ?? null) &&
        (r.asset ? Math.round((parseFloat((p.figure ?? '0').replace(/[^0-9.]/g, '')) || 0) * 10 ** r.asset.decimals) : p.units) >= r.units &&
        (!p.createdAt || p.createdAt >= r.createdAt)
    )
    if (j < 0) return r
    used.add(j)
    return { ...r, status: 'paid', settledAt: now }
  })
}
