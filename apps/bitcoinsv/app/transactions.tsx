// The shared core opens /transactions when a payment notification is tapped
// (WalletContext's push handlers); here that's Activity, on Requested when
// the push was about a request (src/notify/pushRouting.ts).
import { Redirect } from 'expo-router'
import { takeActivityFilter } from '../src/notify/pushRouting'

export default function Transactions() {
  const filter = takeActivityFilter()
  return <Redirect href={filter ? { pathname: '/activity', params: { filter } } : '/activity'} />
}
