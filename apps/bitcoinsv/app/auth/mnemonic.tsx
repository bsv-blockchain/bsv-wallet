// The shared core's screens send people to the existing app's recovery phrase
// screen: ?flow=backup to back up (here, the backup in Settings), or with no
// wallet, to make one (here, Welcome by way of Home).
import { Redirect, useLocalSearchParams } from 'expo-router'

export default function Mnemonic() {
  const { flow } = useLocalSearchParams<{ flow?: string }>()
  return <Redirect href={flow === 'backup' ? '/settings?backup=1' : '/'} />
}
