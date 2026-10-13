// The shared core's screens send people to the existing app's wallet settings
// (/wallet-config?section=backup); here that's Settings, with the backup open.
import { Redirect, useLocalSearchParams } from 'expo-router'

export default function WalletConfig() {
  const { section } = useLocalSearchParams<{ section?: string }>()
  return <Redirect href={section === 'backup' ? '/settings?backup=1' : '/settings'} />
}
