// The wallets on this phone, as the switcher shows them (src/home/WalletSwitcher
// .tsx) and Activity's search finds them: the shared core's profiles, each
// named by its @handle (or "Wallet 2" before it has one), with its look.
import { useMemo } from 'react'
import { liveProfiles, useActiveProfileIndex, useProfiles } from '@bsv/expo-wallet-toolbox'
import { usePrefs } from '../state/prefs'

export const bareHandle = (handle: string) => `@${handle.split('@')[0]}`

export interface WalletEntry {
  index: number
  name: string
  /** the full handle, when it has one */
  handle: string | null
  active: boolean
  look: { avatarBg?: string | null; avatarPortrait?: string | null; avatarUri?: string | null } | undefined
}

export function useWalletList(): WalletEntry[] {
  const prefs = usePrefs()
  const all = useProfiles()
  const active = useActiveProfileIndex()
  return useMemo(() => liveProfiles(all).map(p => {
    const look = prefs.looks[p.index]
    const handle = look?.handle ?? (p.index === prefs.pendingHandleProfile ? prefs.pendingHandle : null) ?? null
    return {
      index: p.index,
      name: handle ? bareHandle(handle) : `Wallet ${p.index + 1}`,
      handle,
      active: p.index === active,
      look:
        p.index === active ? { avatarBg: prefs.avatarBg, avatarPortrait: prefs.avatarPortrait, avatarUri: prefs.avatarUri } : look
    }
  }), [all, active, prefs])
}
