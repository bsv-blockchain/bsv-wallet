/**
 * Restore discovery: after a seed is imported, find the other profiles it backed up.
 *
 * The mnemonic says nothing about how many profiles were ever used, but each one
 * pushed its history to its own remote-backup account (the pseudonym derives from
 * that profile's primary key). So probe profile 1, 2, … in turn: a profile with a
 * backup on any network exists; the first index with none on every network ends
 * the search. Found profiles are only registered here — each replays its backup
 * the first time the user switches to it, so an import never stalls on them.
 *
 * Known gap: a profile that never backed anything up (unused, or backup turned
 * off) stops the search, hiding any profile after it. Adding a profile again
 * restores whatever exists at the next index.
 */
import type { AppChain } from '../config'
import { BACKUP_CHAINS, type BackupChain } from '../backup/constants'
import { listBackups } from '../backup/restore'
import { deriveProfileKeys, hdFromMnemonic } from '../mnemonicWallet'

/** Whether `primaryKey` has a remote backup on `chain`. May throw on a network error. */
export type ProfileProbe = (primaryKey: number[], chain: BackupChain) => Promise<boolean>

export interface DiscoverProfilesDeps {
  mnemonic: string
  probe: ProfileProbe
  /** Record profile `index` as existing on `network`. Called in index order. */
  register: (index: number, network: AppChain) => Promise<void>
  /** First index to probe. Default 1 — profile 0 is the wallet being imported. */
  startIndex?: number
  /** Hard stop on the number of profiles probed. Default 50. */
  maxProfiles?: number
}

/** Probe profiles from `startIndex` until the first one with no backup; returns how many were registered. */
export async function discoverProfiles(deps: DiscoverProfilesDeps): Promise<number> {
  const start = deps.startIndex ?? 1
  const max = deps.maxProfiles ?? 50
  // One PBKDF2 for the whole search; every profile derives from the same root.
  const hd = hdFromMnemonic(deps.mnemonic)
  let registered = 0
  for (let n = start; n < start + max; n++) {
    const { primaryKey } = deriveProfileKeys(hd, n)
    const found: BackupChain[] = []
    try {
      for (const chain of BACKUP_CHAINS) {
        if (await deps.probe(primaryKey, chain)) found.push(chain)
      }
    } catch (err) {
      // An outage is not evidence the profile is absent: stop without guessing,
      // keeping what was already found. Add profile recovers the rest later.
      console.warn(`[profiles] discovery stopped at profile ${n}:`, err)
      break
    }
    if (found.length === 0) break
    await deps.register(n, found.includes('main') ? 'main' : found[0])
    registered++
  }
  return registered
}

/** The production probe: a non-empty backup manifest on the backup server. */
export function backupProbe(baseUrl: string): ProfileProbe {
  return async (primaryKey, chain) => (await listBackups({ primaryKey, chain, baseUrl })).length > 0
}
