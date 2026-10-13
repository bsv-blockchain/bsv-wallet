// Real-time payment alerts. The shared core credits incoming payments in the
// background (TaskCreditInbox), plays its tone and says "Payment received"
// through the host's toast. Here that one message becomes the prototype's
// money toast: who paid, and how much, from the newest incoming row in
// Activity. Settings' Payment alerts and Sounds switch them off.
import { useEffect, useRef } from 'react'
import { sounds } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import i18n from '@bsv/expo-wallet-toolbox/core/i18n/translations'
import { useActivity, type ActivityItem } from '../activity/useActivity'
import { txAmount } from '../activity/TxRow'
import { getPrefs, setPref, usePrefs } from '../state/prefs'
import { useHomeData } from '../state/useHomeData'
import { notifyMoney } from './MoneyToast'

type ToastType = 'success' | 'error' | 'info' | 'warning'

/** How long a new row and the core's "Payment received" count as the same payment. */
const SAME_PAYMENT_MS = 30_000

let arrivedAt = 0
const arrivals = new Set<() => void>()

/** The toast the core's wallet provider is given (its `onToast`). */
export function walletToast(message: string, opts?: { type?: ToastType }) {
  if (message === i18n.t('payment_arrived')) {
    if (!getPrefs().paymentAlerts) return
    arrivedAt = Date.now()
    arrivals.forEach(fn => fn())
    return
  }
  showToast(message, opts as never)
}

function firstName(title: string) {
  return title.startsWith('@') ? title : title.split(' ')[0]
}

/** The money toast for an incoming payment's row. */
export function toastFor(tx: ActivityItem) {
  const named = tx.contactKey ? `${firstName(tx.title)} paid you` : 'You got paid'
  notifyMoney({
    title: named,
    description: tx.note ? `“${tx.note}” · Arrived just now` : 'Arrived just now',
    amount: txAmount(tx),
    incoming: true,
    counterparty: tx.counterparty,
    activityId: tx.id
  })
}

function announce(tx: ActivityItem, backedUp: boolean) {
  toastFor(tx)
  // the first money in a wallet that isn't backed up: "Back up your keys", once
  if (!backedUp && !getPrefs().backupNudged) {
    setPref('backupNudged', true)
    setPref('backupNudge', true)
  }
}

/** Mounted once inside the wallet provider. */
export function PaymentAlertsBridge() {
  const prefs = usePrefs()
  const { items, reload } = useActivity({ limit: 10 })
  const { backedUp } = useHomeData()
  const known = useRef<Set<string> | null>(null)
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The newest incoming row seen before the core said a payment arrived: its
   * signal comes once the whole credit pass is done, often after the row shows. */
  const unannounced = useRef<{ tx: ActivityItem; seenAt: number } | null>(null)
  const backedUpRef = useRef(backedUp)
  useEffect(() => {
    backedUpRef.current = backedUp
  }, [backedUp])

  useEffect(() => {
    sounds.setEnabled(prefs.sounds)
  }, [prefs.sounds])

  // a payment landed: say who paid if its row is already in, otherwise read
  // Activity again, and if the row doesn't show up in a few seconds, say so
  // without the details
  useEffect(() => {
    const onArrived = () => {
      const seen = unannounced.current
      unannounced.current = null
      if (seen && Date.now() - seen.seenAt < SAME_PAYMENT_MS) {
        announce(seen.tx, backedUpRef.current)
        return
      }
      reload()
      if (fallback.current) clearTimeout(fallback.current)
      fallback.current = setTimeout(() => {
        fallback.current = null
        notifyMoney({ title: 'You got paid', description: 'It’s in your activity now', incoming: true })
      }, 4000)
    }
    arrivals.add(onArrived)
    return () => {
      arrivals.delete(onArrived)
      if (fallback.current) clearTimeout(fallback.current)
    }
  }, [reload])

  useEffect(() => {
    if (!items) return
    const incoming = items.filter(i => i.incoming && i.status.tone !== 'failed')
    if (!known.current) {
      known.current = new Set(incoming.map(i => i.id))
      return
    }
    const fresh = incoming.filter(i => !known.current!.has(i.id))
    fresh.forEach(i => known.current!.add(i.id))
    if (!fresh.length) return
    if (Date.now() - arrivedAt > SAME_PAYMENT_MS) {
      // the core hasn't said so yet: hold the newest until it does
      unannounced.current = { tx: fresh[0], seenAt: Date.now() }
      return
    }
    if (fallback.current) {
      clearTimeout(fallback.current)
      fallback.current = null
    }
    announce(fresh[0], backedUp)
  }, [items, backedUp])

  return null
}
