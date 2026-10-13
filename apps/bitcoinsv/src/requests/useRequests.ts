// This wallet's payment requests (src/requests/requests.ts): the list, kept in
// its own storage, and what can be done with them: ask someone, cancel or
// remind (yours), decline or mark paid (theirs). RequestsBridge, mounted once,
// fetches new ones over MessageBox, says when one arrives, and marks yours paid
// when the money comes in.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { makePeerPayClient, NO_MESSAGE_BOX } from '@bsv/expo-wallet-toolbox/core/pay/rails/handle'
import { useMessageBoxConfig } from '@bsv/expo-wallet-toolbox/ui'
import { DISPLAY_NAME_KV_KEY, HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { useActivity } from '../activity/useActivity'
import { useContacts } from '../contacts/useContacts'
import { cleanPeerPayNote, parsePeerPayURI } from '@bsv/expo-wallet-toolbox/core/parsePeerPayURI'
import { notifyMoney } from '../notify/MoneyToast'
import { bsvFigure } from '../activity/format'
import {
  applyIncoming,
  loadRequests,
  matchPaid,
  messageBoxTransport,
  newRequestId,
  saveRequests,
  selfNamed,
  whoLabel,
  type KeyValue,
  type PaymentRequest,
  type RequestTransport
} from './requests'

let owner: unknown = null
let list: PaymentRequest[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

async function open(kv: KeyValue) {
  if (owner === kv) return
  owner = kv
  list = []
  emit()
  const loaded = await loadRequests(kv)
  if (owner === kv) {
    list = loaded
    emit()
  }
}

async function update(kv: KeyValue, change: (l: PaymentRequest[]) => PaymentRequest[]) {
  if (owner !== kv) return
  list = change(list)
  emit()
  await saveRequests(kv, list).catch(() => {})
}

export const amountText = (r: Pick<PaymentRequest, 'units' | 'asset'>) =>
  r.asset ? `${(r.units / 10 ** r.asset.decimals).toString()} ${r.asset.ticker}` : `${bsvFigure(r.units)} BSV`

/** The transport for the open wallet, or null when it has no message box. */
function useTransport(): RequestTransport | null {
  const { t } = useTranslation()
  const { managers, adminOriginator } = useWallet()
  const { messageBoxUrl } = useMessageBoxConfig(t)
  const wallet = managers.permissionsManager
  return useMemo(() => {
    const box = messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX ? messageBoxUrl : undefined
    const client = wallet && box ? makePeerPayClient({ wallet: wallet as never, messageBoxUrl: box, originator: adminOriginator }) : null
    return client ? messageBoxTransport(client as never) : null
  }, [wallet, messageBoxUrl, adminOriginator])
}

export function useRequests() {
  const { storage, switchingProfile } = useWallet()
  const kv = (switchingProfile ? null : storage) as KeyValue | null
  const transport = useTransport()
  useEffect(() => {
    if (kv) void open(kv)
  }, [kv])
  const requests = useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => list
  )

  /** Ask someone for an amount: it reaches their wallet, and waits in yours. */
  const ask = useCallback(
    async (args: { to: string; name?: string; units: number; asset?: PaymentRequest['asset']; note?: string; link: string }) => {
      if (!kv || !transport) throw new Error('Requests need a message box')
      const [handle, myName] = await Promise.all([kv.getKeyValue(HANDLE_KV_KEY).catch(() => undefined), kv.getKeyValue(DISPLAY_NAME_KV_KEY).catch(() => undefined)])
      const r: PaymentRequest = {
        id: newRequestId(),
        direction: 'out',
        counterparty: args.to,
        name: args.name,
        units: args.units,
        asset: args.asset,
        note: args.note?.trim() || undefined,
        link: args.link,
        createdAt: new Date().toISOString(),
        status: 'pending'
      }
      await transport.send(args.to, {
        type: 'payment-request',
        id: r.id,
        units: r.units,
        asset: r.asset,
        note: r.note,
        link: r.link,
        fromName: myName ?? (handle ? `@${handle.split('@')[0]}` : undefined),
        createdAt: r.createdAt
      })
      await update(kv, l => [r, ...l])
      return r
    },
    [kv, transport]
  )

  const settle = useCallback(
    async (id: string, status: 'cancelled' | 'declined' | 'paid', tell: boolean) => {
      if (!kv) return
      const r = list.find(x => x.id === id)
      if (!r || r.status !== 'pending') return
      // yours at once; the other wallet hears in the background (a few seconds)
      await update(kv, l => l.map(x => (x.id === id ? { ...x, status, settledAt: new Date().toISOString() } : x)))
      if (tell && transport) {
        const type = status === 'cancelled' ? 'request-cancelled' : status === 'declined' ? 'request-declined' : 'request-paid'
        void transport.send(r.counterparty, { type, id }).catch(() => {})
      }
    },
    [kv, transport]
  )

  /** No amount: your pay link, straight to their wallet. */
  const sendLink = useCallback(
    async (args: { to: string; link: string; note?: string }) => {
      if (!kv || !transport) throw new Error('Requests need a message box')
      const myName = await kv.getKeyValue(DISPLAY_NAME_KV_KEY).catch(() => undefined)
      await transport.send(args.to, { type: 'pay-link', id: newRequestId(), link: args.link, note: args.note?.trim() || undefined, fromName: myName })
    },
    [kv, transport]
  )

  /** Yours: ask again, the same request. */
  const remind = useCallback(
    async (id: string) => {
      const r = list.find(x => x.id === id)
      if (!r) return
      if (!transport) throw new Error('Requests need a message box')
      await transport.send(r.counterparty, {
        type: 'payment-request',
        id: r.id,
        units: r.units,
        asset: r.asset,
        note: r.note,
        link: r.link,
        createdAt: r.createdAt
      })
    },
    [transport]
  )

  return {
    requests,
    ready: !!kv && !!transport,
    ask,
    sendLink,
    remind,
    cancel: (id: string) => settle(id, 'cancelled', true),
    decline: (id: string) => settle(id, 'declined', true),
    /** theirs, once you've paid it */
    paid: (id: string) => settle(id, 'paid', true)
  }
}

const POLL_MS = 30_000

/**
 * Look at the message box now, not at the next poll: a push said something
 * arrived (src/notify/pushRouting.ts). Before the bridge is mounted (a cold
 * start from a tap), its first check on mounting is that look.
 */
const lookers = new Set<() => void>()
export const checkRequestsNow = () => lookers.forEach(look => look())
/** A check that hasn't answered by now is given up on, so it can't hold up the next. */
const CHECK_MS = 20_000

const inTime = <T,>(p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), CHECK_MS))])

/** Mounted once inside the wallet provider. */
export function RequestsBridge() {
  const { storage, switchingProfile } = useWallet()
  const kv = (switchingProfile ? null : storage) as KeyValue | null
  const transport = useTransport()
  const { items } = useActivity({ limit: 30 })
  const busy = useRef(false)
  // the requests themselves, so a list that loads after the payments is matched too
  const requests = useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => list
  )
  // names from contacts only: what a message calls its sender is theirs to say
  const contacts = useContacts()
  const names = useRef(contacts.byKey)
  useEffect(() => {
    names.current = contacts.byKey
  }, [contacts.byKey])
  const contactName = (key: string) => names.current.get(key.toLowerCase())?.name

  useEffect(() => {
    if (kv) void open(kv)
  }, [kv])

  // what's waiting: applied, kept, then marked read
  useEffect(() => {
    if (!kv || !transport) return
    let live = true
    const check = async () => {
      if (busy.current || AppState.currentState !== 'active') return
      busy.current = true
      try {
        const msgs = await inTime(transport.receive())
        if (!live || !msgs.length) return
        const { arrived } = applyIncoming(list, msgs)
        await update(kv, l => applyIncoming(l, msgs).list)
        await inTime(transport.acknowledge(msgs.map(m => m.messageId))).catch(() => {})
        for (const { sender, message: m } of msgs) {
          if (m.type !== 'pay-link' || typeof m.link !== 'string') continue
          // a pay link that pays someone other than who sent it isn't shown
          const link = parsePeerPayURI(m.link)
          if (!link || link.identityKey !== sender.toLowerCase()) continue
          const note = cleanPeerPayNote(typeof m.note === 'string' ? m.note : undefined)
          const fromName = cleanPeerPayNote(typeof m.fromName === 'string' ? m.fromName : undefined)?.slice(0, 40)
          notifyMoney({
            title: `${whoLabel({ counterparty: sender }, contactName(sender))} sent their pay link`,
            description: [selfNamed({ name: fromName }, contactName(sender)), note ? `“${note}”` : null].filter(Boolean).join(' · ') || 'Tap to pay them',
            counterparty: { kind: 'identityKey', value: sender },
            payLink: m.link
          })
        }
        for (const r of arrived)
          notifyMoney({
            title: `${whoLabel(r, contactName(r.counterparty))} requests ${amountText(r)}`,
            description: [selfNamed(r, contactName(r.counterparty)), r.note ? `“${r.note}”` : null].filter(Boolean).join(' · ') || 'Tap to pay or decline it',
            counterparty: { kind: 'identityKey', value: r.counterparty },
            requestId: r.id
          })
      } catch {
        // the next pass tries again
      } finally {
        busy.current = false
      }
    }
    void check()
    const look = () => void check()
    lookers.add(look)
    const timer = setInterval(() => void check(), POLL_MS)
    const sub = AppState.addEventListener('change', s => s === 'active' && void check())
    return () => {
      live = false
      lookers.delete(look)
      clearInterval(timer)
      sub.remove()
    }
  }, [kv, transport])

  // yours, paid: a payment in from them for the amount
  useEffect(() => {
    if (!kv || !items || !requests.some(r => r.direction === 'out' && r.status === 'pending')) return
    const payments = items.map(i => ({
      counterparty: i.counterparty?.kind === 'identityKey' ? i.counterparty.value : undefined,
      incoming: i.incoming,
      units: Math.abs(i.sats ?? 0),
      figure: i.token?.figure,
      assetId: i.token?.assetId,
      createdAt: i.createdAt
    }))
    const next = matchPaid(requests, payments)
    if (next.some((r, k) => r !== requests[k])) void update(kv, () => next)
  }, [kv, items, requests])

  return null
}
