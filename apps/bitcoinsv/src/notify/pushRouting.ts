// Pushes the app routes itself, around the shared core's push adapter. The
// core treats every push as "look at the payment inbox now" and opens
// Activity (core/push/events.ts). A push about a payment request (or a pay
// link) is for the requests message box (src/requests, REQUEST_BOX): it looks
// there now, and a tap opens Activity on Requested. Everything still reaches
// the core, which switches to the wallet the push is for when it isn't the
// open one, so the tap lands in the right wallet.
//
// The payload, as BSVA's MessageBox server sends it (docs/backend-integration.md):
//   data.messageBox  'payment_inbox' (payments) | 'payment_requests' (requests, pay links)
//   data.recipient   the identity key of the wallet it's for
//   data.originator  the sender's identity key
//   data.messageId   the MessageBox message id
import type { PushAdapter, PushOpenedEvent } from '@bsv/expo-wallet-toolbox'
import { REQUEST_BOX } from '../requests/requests'
import { checkRequestsNow } from '../requests/useRequests'

/** Activity's filter to open on, set by a tapped request push and read once (app/transactions.tsx). */
let openOn: 'requested' | null = null
export const takeActivityFilter = () => {
  const f = openOn
  openOn = null
  return f
}

const forRequests = (e: PushOpenedEvent | null | undefined) => e?.data?.messageBox === REQUEST_BOX

export function withAppRouting(adapter: PushAdapter): PushAdapter {
  const tapped = (e: PushOpenedEvent | null) => {
    if (!forRequests(e)) return
    openOn = 'requested'
    checkRequestsNow()
  }
  return {
    ...adapter,
    platform: adapter.platform,
    getPermission: () => adapter.getPermission(),
    requestPermission: () => adapter.requestPermission(),
    getToken: () => adapter.getToken(),
    onTokenRefresh: cb => adapter.onTokenRefresh(cb),
    openSettings: () => adapter.openSettings(),
    onNotificationOpened: cb =>
      adapter.onNotificationOpened(e => {
        tapped(e)
        cb(e)
      }),
    getInitialNotification: async () => {
      const e = await adapter.getInitialNotification()
      tapped(e)
      return e
    },
    onForegroundMessage: cb =>
      adapter.onForegroundMessage(e => {
        // a request while the app is open: looked for now, said by its own toast
        if (forRequests(e)) checkRequestsNow()
        cb(e)
      })
  }
}
