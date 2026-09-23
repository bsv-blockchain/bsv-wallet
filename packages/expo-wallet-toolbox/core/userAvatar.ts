/**
 * The picture this wallet's own user wears.
 *
 * One stored choice, read by every surface that draws "you" — the home
 * button, the profile hero — so picking an icon once changes all of them.
 *
 * Kept out of `WalletSettings`: that type belongs to
 * `@bsv/wallet-toolbox-mobile` and is not ours to extend. AsyncStorage
 * instead, loaded once at startup, exactly like `core/numberFormat.ts`.
 *
 * Stored as `family/name` rather than a component so nothing here depends on
 * the icon package, and an unknown value from a newer build degrades to the
 * default disc instead of crashing.
 */
import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export type AvatarIconFamily = 'ionicons' | 'material-community'

export interface AvatarIcon {
  family: AvatarIconFamily
  name: string
}

const STORAGE_KEY = 'wallet_user_avatar_icon'

const listeners = new Set<() => void>()
let icon: AvatarIcon | null = null

/** The chosen icon, or `null` for the default profile disc. */
export function getUserAvatarIcon(): AvatarIcon | null {
  return icon
}

export function setUserAvatarIcon(next: AvatarIcon | null): void {
  if (icon?.family === next?.family && icon?.name === next?.name) return
  icon = next
  listeners.forEach(l => l())
  // Fire-and-forget: the choice is already live in memory, and a failed write
  // costs the next launch's avatar, never the one on screen now.
  if (next) void AsyncStorage.setItem(STORAGE_KEY, `${next.family}/${next.name}`).catch(() => {})
  else void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {})
}

export function subscribeUserAvatar(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function parse(stored: string | null): AvatarIcon | null {
  if (!stored) return null
  const at = stored.indexOf('/')
  if (at < 0) return null
  const family = stored.slice(0, at)
  const name = stored.slice(at + 1)
  if (!name) return null
  if (family !== 'ionicons' && family !== 'material-community') return null
  return { family, name }
}

/** Restore the stored choice. Call once at startup; safe to call twice. */
export async function loadUserAvatarIcon(): Promise<void> {
  try {
    const next = parse(await AsyncStorage.getItem(STORAGE_KEY))
    if (next && (next.family !== icon?.family || next.name !== icon?.name)) {
      icon = next
      listeners.forEach(l => l())
    }
  } catch {
    // Keep the default disc; an unreadable preference is not worth surfacing.
  }
}

/** Re-renders the caller whenever the choice changes. */
export function useUserAvatarIcon(): AvatarIcon | null {
  return useSyncExternalStore(subscribeUserAvatar, getUserAvatarIcon, () => null)
}
