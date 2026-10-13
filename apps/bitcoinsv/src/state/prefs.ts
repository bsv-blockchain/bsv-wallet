// This app's own presentation preferences (the prototype keeps them in its
// persisted store's `prefs`): privacy mode, first-run steps, the avatar's
// colour. App-local AsyncStorage, never wallet data: this installation's
// storage is private to it (see __tests__/isolation.test.js).
import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { NO_FEEDBACK, type FeedbackState } from '../feedback/rules'

export interface Prefs {
  /** finished (or skipped) the Welcome screens */
  onboarded: boolean
  privacy: boolean
  tourDone: boolean
  setupHidden: boolean
  syncCardDismissed: boolean
  /** the background behind the avatar's animal */
  avatarBg: string | null
  /** the avatar's animal (the dragon until one is picked) */
  avatarPortrait: string | null
  /** an uploaded image instead of an animal */
  avatarUri: string | null
  /** a handle chosen at wallet creation that the registry hasn't confirmed yet */
  pendingHandle: string | null
  /** the display name that goes with it */
  pendingDisplayName: string | null
  /** Settings → Payment alerts: a toast when money arrives */
  paymentAlerts: boolean
  /** Settings → Sounds: the core's payment tones */
  sounds: boolean
  /** asked once, before the system's own notification prompt */
  notifyAsked: boolean
  /** Settings → Dark mode: the phone's setting until it's switched */
  theme: 'system' | 'light' | 'dark'
  /** Settings → Vault button (dev and preview builds, where Vault exists) */
  showVault: boolean
  /**
   * Which wallet (the core's profile index) the pending handle above is for:
   * it's claimed only while that wallet is open. -1: the wallet being made.
   */
  pendingHandleProfile: number
  /** each wallet's avatar and handle, by profile index, for the switcher (src/state/walletLooks.ts) */
  looks: Record<string, WalletLook>
  /** the look a wallet being made takes once it opens */
  stagedLook: WalletLook | null
  /**
   * This phone's recovery phrase has been backed up (by any of its wallets).
   * One phrase covers every wallet (decision 3), while the core records the
   * backup per wallet: a wallet made later is backed up all the same.
   */
  phraseBackedUp: boolean
  /** "Back up your keys" is due: money arrived in a wallet that isn't backed up */
  backupNudge: boolean
  /** it's been asked for once already (it only ever comes once) */
  backupNudged: boolean
  /** the last few exports for accounting (src/settings/ExportSheet.tsx), newest first */
  recentExports: { at: string; wallet: string; period: string; from: string; to: string; type: string; format: string; count: number }[]
  /** the print design last picked, for the recovery phrase and for key slices (src/print/DesignSheet.tsx) */
  printDesigns: { seed?: string; slice?: string }
  /** the backup briefing has been read through once: its buttons no longer make you wait */
  briefingRead: boolean
  /**
   * How Home looked when the wallet was last open, so the next launch can draw
   * it at once while the wallet opens (behind Face ID): how many coin rows and
   * payment rows it had. Counts only, never amounts or who was paid.
   */
  homeShape: HomeShape | null
  /** "Enjoying Bitcoin SV Wallet?": when it last asked, and what counts toward asking (src/feedback) */
  feedback: FeedbackState
  /** a contact's name before you first renamed them, by identity key: what Reset goes back to */
  contactOriginalNames: Record<string, string>
}

export interface HomeShape {
  coins: number
  rows: number
}

export interface WalletLook {
  avatarBg: string | null
  avatarPortrait: string | null
  avatarUri: string | null
  /** "name@domain", once known */
  handle?: string | null
  displayName?: string | null
  /**
   * Its first steps (the prototype keeps them per wallet): the tour taken and
   * the checklist hidden. Unset on a wallet remembered from before they were
   * kept per wallet: it goes on as it was.
   */
  tourDone?: boolean
  setupHidden?: boolean
}

const KEY = 'bitcoinsv.prefs.v1'
const DEFAULTS: Prefs = { onboarded: false, privacy: false, tourDone: false, setupHidden: false, syncCardDismissed: false, avatarBg: null, avatarPortrait: null, avatarUri: null, pendingHandle: null, pendingDisplayName: null, paymentAlerts: true, sounds: true, notifyAsked: false, theme: 'system', showVault: false, pendingHandleProfile: 0, looks: {}, stagedLook: null, phraseBackedUp: false, backupNudge: false, backupNudged: false, recentExports: [], printDesigns: {}, briefingRead: false, homeShape: null, feedback: NO_FEEDBACK, contactOriginalNames: {} }

let state: Prefs = DEFAULTS
let loaded = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

const load = AsyncStorage.getItem(KEY)
  .then(raw => {
    if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) }
  })
  .catch(() => {})
  .finally(() => {
    loaded = true
    emit()
  })

/** Outside React: the preferences as they stand now. */
export const getPrefs = (): Prefs => state

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  state = { ...state, [key]: value }
  emit()
  void load.then(() => AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {}))
}

export function usePrefs(): Prefs & { loaded: boolean } {
  const snapshot = useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
  return { ...snapshot, loaded }
}
