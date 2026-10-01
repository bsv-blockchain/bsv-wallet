/**
 * Wallet profiles: one mnemonic, many wallets.
 *
 * Profile n is the wallet whose primary key is m/0'/n' (see mnemonicWallet.ts
 * profilePaths). Each one has its own identity, database, backup account and
 * network; the seed, recovery shares and app-wide settings are shared.
 *
 * This store is the one place that says which profile is active and which
 * network each runs on. It lives in AsyncStorage rather than a wallet database
 * because it has to be read BEFORE any database opens — it is what picks the
 * database. Memory is authoritative and synchronous (screens and key builders
 * read it during render); every write is persisted best-effort.
 *
 * Per-profile device state (balance cache, avatar, ARC/MessageBox overrides,
 * auto-approve, connections, seen-token markers) keeps its existing AsyncStorage
 * key through `profileScopedKey`: profile 0 uses the bare key, profile n appends
 * `__p<n>`. The index is known before any build, which an identity key is not.
 */
import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_CHAIN, type AppChain } from '../config'

export const PROFILES_STORAGE_KEY = 'wallet_profiles_v1'

/** Matches every key `profileScopedKey` produces for a profile other than 0. */
export const PROFILE_KEY_SUFFIX_RE = /__p\d+$/

/** A sanity bound, not a product limit: no index past this is ever stored. */
export const MAX_PROFILES = 100

export interface ProfileRecord {
  index: number
  network: AppChain
  /** Recorded after this profile's first successful build on this device. Public. */
  identityKey?: string
  /** Replay this profile's remote backup on its next build (set by discovery / add). */
  needsRestore?: boolean
}

export interface ProfilesState {
  active: number
  profiles: ProfileRecord[]
}

const CHAINS: readonly AppChain[] = ['main', 'test', 'teratest']

export function defaultProfilesState(): ProfilesState {
  return { active: 0, profiles: [{ index: 0, network: DEFAULT_CHAIN }] }
}

/**
 * Tolerant parse: anything unreadable becomes the default, and whatever is
 * readable is normalised into a dense list 0..count-1 so an index always names
 * exactly one record.
 */
export function parseProfilesState(raw: string | null): ProfilesState {
  if (!raw) return defaultProfilesState()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultProfilesState()
  }
  const obj = parsed as Partial<ProfilesState> | null
  if (!obj || !Array.isArray(obj.profiles)) return defaultProfilesState()

  const byIndex = new Map<number, ProfileRecord>()
  for (const entry of obj.profiles as unknown[]) {
    const r = entry as Partial<ProfileRecord> | null
    if (!r || !Number.isInteger(r.index) || (r.index as number) < 0 || (r.index as number) >= MAX_PROFILES) continue
    if (byIndex.has(r.index as number)) continue
    byIndex.set(r.index as number, {
      index: r.index as number,
      network: CHAINS.includes(r.network as AppChain) ? (r.network as AppChain) : DEFAULT_CHAIN,
      ...(typeof r.identityKey === 'string' ? { identityKey: r.identityKey } : {}),
      ...(r.needsRestore === true ? { needsRestore: true } : {})
    })
  }
  // Dense from 0: a gap would leave an index the switcher cannot name.
  const profiles: ProfileRecord[] = []
  for (let i = 0; byIndex.has(i); i++) profiles.push(byIndex.get(i)!)
  if (profiles.length === 0) return defaultProfilesState()

  const active =
    Number.isInteger(obj.active) && (obj.active as number) < profiles.length && (obj.active as number) >= 0
      ? (obj.active as number)
      : 0
  return { active, profiles }
}

let state: ProfilesState = defaultProfilesState()
const listeners = new Set<() => void>()

function publish(next: ProfilesState): void {
  state = next
  listeners.forEach(l => l())
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    console.warn('[profiles] persist failed', err)
  }
}

/** Read the stored state into memory. Call before the first wallet build. */
export async function loadProfiles(): Promise<ProfilesState> {
  let raw: string | null = null
  try {
    raw = await AsyncStorage.getItem(PROFILES_STORAGE_KEY)
  } catch (err) {
    console.warn('[profiles] load failed', err)
  }
  publish(parseProfilesState(raw))
  return state
}

export function getProfilesState(): ProfilesState {
  return state
}

export function getActiveProfileIndex(): number {
  return state.active
}

export function getActiveProfile(): ProfileRecord {
  return state.profiles[state.active] ?? state.profiles[0]
}

export async function setActiveProfile(n: number): Promise<void> {
  if (!state.profiles[n]) throw new Error(`Unknown profile index: ${n}`)
  if (state.active === n) return
  publish({ ...state, active: n })
  await persist()
}

/** Append the next profile (index = current count). Does not activate it. */
export async function appendProfile(
  network: AppChain = DEFAULT_CHAIN,
  opts: { needsRestore?: boolean } = {}
): Promise<ProfileRecord> {
  const index = state.profiles.length
  if (index >= MAX_PROFILES) throw new Error('Too many profiles')
  const record: ProfileRecord = { index, network, ...(opts.needsRestore ? { needsRestore: true } : {}) }
  publish({ ...state, profiles: [...state.profiles, record] })
  await persist()
  return record
}

export async function updateProfile(n: number, patch: Partial<Omit<ProfileRecord, 'index'>>): Promise<void> {
  const current = state.profiles[n]
  if (!current) return
  const next: ProfileRecord = { ...current, ...patch, index: n }
  if (!next.needsRestore) delete next.needsRestore
  if (
    next.network === current.network &&
    next.identityKey === current.identityKey &&
    !!next.needsRestore === !!current.needsRestore
  ) {
    return
  }
  const profiles = state.profiles.slice()
  profiles[n] = next
  publish({ ...state, profiles })
  await persist()
}

/** Back to a single profile 0 and no stored record (Delete Wallet). */
export async function resetProfiles(): Promise<void> {
  publish(defaultProfilesState())
  try {
    await AsyncStorage.removeItem(PROFILES_STORAGE_KEY)
  } catch (err) {
    console.warn('[profiles] reset failed', err)
  }
}

export function subscribeProfiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useProfiles(): ProfilesState {
  return useSyncExternalStore(subscribeProfiles, getProfilesState, getProfilesState)
}

export function useActiveProfileIndex(): number {
  return useSyncExternalStore(subscribeProfiles, getActiveProfileIndex, getActiveProfileIndex)
}

/**
 * The AsyncStorage / SecureStore key for per-profile state. Profile 0 keeps the
 * bare key; profile n appends `__p<n>` (SecureStore allows only [A-Za-z0-9._-]).
 */
export function profileScopedKey(base: string, index: number = state.active): string {
  return index === 0 ? base : `${base}__p${index}`
}

/** Test-only: forget memory and listeners. */
export function __resetProfilesForTests(): void {
  state = defaultProfilesState()
  listeners.clear()
}
