/**
 * Startup reads that need nothing from React, begun before the app renders.
 *
 * LocalStorageProvider's secrets migration and WalletContext's configuration
 * (the profiles, then the stored config) used to start in effects, after the
 * whole first screen had rendered and committed; the wallet build waits on both.
 * An app calls prewarmStartup() from its entry file, once the crypto seams are
 * installed, and the reads run while the app renders. Each is taken once: the
 * provider that would have started it awaits the one in flight instead. Taken,
 * or never begun (an app that doesn't prewarm), the provider does the work
 * itself, as before; a later run (after logout) always does.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { loadProfiles } from '../profiles/profileStore'
import { migrateLegacySecrets, type MigrationResult } from '../services/secrets'

export interface StartupConfig {
  /** loadProfiles(), done: the active profile is in memory */
  profiles: Promise<unknown>
  /** the stored 'finalConfig', read once the profiles are */
  config: Promise<string | null>
}

let secrets: Promise<MigrationResult> | null = null
let config: StartupConfig | null = null

export function prewarmStartup(): void {
  if (!secrets) {
    secrets = migrateLegacySecrets()
    // taken later (or never): an unhandled rejection meanwhile is noise
    secrets.catch(() => {})
  }
  if (!config) {
    const profiles = loadProfiles()
    const stored = profiles.then(() => AsyncStorage.getItem('finalConfig'))
    profiles.catch(() => {})
    stored.catch(() => {})
    config = { profiles, config: stored }
  }
}

/** The secrets migration begun at startup, if there's one not yet taken. */
export function takeStartupSecrets(): Promise<MigrationResult> | null {
  const taken = secrets
  secrets = null
  return taken
}

/** The configuration reads begun at startup, if not yet taken. */
export function takeStartupConfig(): StartupConfig | null {
  const taken = config
  config = null
  return taken
}
