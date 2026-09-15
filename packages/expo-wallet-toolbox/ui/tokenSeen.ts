/**
 * "Has the user already been told?" — two small persisted sets.
 *
 *  · `mandala_seen_assets` clears an asset row's "New — tap to see who issues
 *    it" subtitle once the sheet has actually been opened. Disclosure that
 *    re-announces itself after it has been read is noise.
 *  · `mandala_seen_evictions` makes the withdrawal alert fire exactly once per
 *    transaction. An alert about money leaving is the most interruptive thing
 *    this feature does; raising it again on every foreground would train the
 *    user to dismiss it unread.
 *
 * AsyncStorage rather than the wallet database on purpose: this is a fact about
 * what a person has seen on this device, not a fact about money, and it must
 * never be able to block, delay or fail a payment path. Every read fails to the
 * empty set, which errs toward telling the user again.
 */
import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export const SEEN_ASSETS_KEY = 'mandala_seen_assets'
export const SEEN_EVICTIONS_KEY = 'mandala_seen_evictions'

export async function readSeen(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export async function markSeen(key: string, id: string): Promise<void> {
  try {
    const current = await readSeen(key)
    if (current.includes(id)) return
    await AsyncStorage.setItem(key, JSON.stringify([...current, id]))
  } catch {
    // Cosmetic state. A write failure means one repeated subtitle or one
    // repeated alert, never a wrong balance.
  }
}

export interface SeenSet {
  seen: string[]
  isSeen: (id: string) => boolean
  see: (id: string) => void
}

export function useSeenSet(key: string): SeenSet {
  const [seen, setSeen] = useState<string[]>([])

  useEffect(() => {
    let live = true
    void readSeen(key).then(ids => {
      if (live) setSeen(ids)
    })
    return () => {
      live = false
    }
  }, [key])

  const see = useCallback(
    (id: string) => {
      setSeen(prev => (prev.includes(id) ? prev : [...prev, id]))
      void markSeen(key, id)
    },
    [key]
  )

  const isSeen = useCallback((id: string) => seen.includes(id), [seen])

  return { seen, isSeen, see }
}
