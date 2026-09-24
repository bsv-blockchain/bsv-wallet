/**
 * The restore step of the "import an existing wallet" flow.
 *
 * A recovery phrase alone cannot rebuild a wallet: change outputs carry a random
 * derivation suffix and BRC-29 receipts carry sender-chosen derivation data, none of it
 * on-chain. The encrypted backup log holds that metadata, so an import has to replay it
 * BEFORE the wallet is handed to the user.
 *
 * Two ordering rules are load-bearing, and both are why this runs where it does
 * (WalletContext's buildWallet, straight after `migrate` and before the monitor exists):
 *
 *  1. **Before this device's first push.** `pushOnce` writes under this device's own
 *     device id, and `restoreFromBackup`'s default target is the most recently updated
 *     device in the manifest. Let the monitor push once and the newest entry becomes this
 *     device's own near-empty log — restore would then replay nothing and report success.
 *     Belt and braces: this module resolves the target itself and passes it explicitly, so
 *     the default is never consulted even if the ordering slips.
 *  2. **Into a fresh database.** `restoreFromBackup` documents its storage argument as a
 *     fresh, migrated provider. Replay merges by record identity, so re-running it after a
 *     failed attempt converges rather than duplicating — but it is not a repair tool for a
 *     wallet that has already been transacting.
 *
 * Errors propagate. A partial or forked log must stop the import: a wallet that looks
 * healthy while missing the outputs it needs to spend is worse than one that plainly
 * failed to restore.
 */
import type { StorageExpoSQLite } from '../storage/StorageExpoSQLite'
import { BackupClient } from './client'
import type { BackupChain } from './constants'
import { deriveBackupWallet } from './derive'
import { listBackups, pickTarget, restoreFromBackup } from './restore'

export interface RestoreOnImportDeps {
  /** A fresh, migrated storage provider to replay into. */
  storage: StorageExpoSQLite
  /** The wallet's m/0'/0' key — derives both the backup identity and the decryption key. */
  primaryKey: number[]
  /** The network being imported. Selects which per-network backup account to consult. */
  chain: BackupChain
  /** The wallet's real identity key, for the local user record. Never sent. */
  identityKey: string
  /** Backup server origin. Empty or absent means the feature is off for this build. */
  baseUrl?: string
  /** Injected transport, for tests. Takes precedence over `baseUrl`. */
  client?: BackupClient
  /** Chunks replayed so far, and how many this generation holds. */
  onProgress?: (chunks: number, total: number) => void
  /**
   * After a successful replay, check that restored coins are still spendable.
   * Awaited before this function resolves. Absent on a no-backup / unconfigured
   * import, which has nothing to validate.
   */
  validateRestoredCoins?: () => Promise<void>
}

export interface RestoreOnImportResult {
  restored: boolean
  chunks: number
  deviceId?: string
  generation?: number
  /** Why nothing was replayed. Absent when `restored` is true. */
  reason?: 'not-configured' | 'no-backup'
  /**
   * True when the replayed generation carried its own completion marker — see
   * restore.ts's RestoreResult and P1-backup-incomplete-generation. Absent when nothing
   * was replayed.
   */
  verified?: boolean
}

export async function restoreOnImport (deps: RestoreOnImportDeps): Promise<RestoreOnImportResult> {
  const client = deps.client ?? (hasUrl(deps.baseUrl) ? new BackupClient(deps.baseUrl!, deps.primaryKey, deps.chain) : null)
  if (client == null) {
    return { restored: false, chunks: 0, reason: 'not-configured' }
  }

  const devices = await listBackups({ primaryKey: deps.primaryKey, chain: deps.chain, client })
  if (devices.length === 0) {
    // Nothing was ever pushed under this seed. An ordinary outcome — a phrase from a
    // wallet that predates backups, or one that never went online — so the import
    // continues with an empty history rather than failing.
    return { restored: false, chunks: 0, reason: 'no-backup' }
  }

  // Resolved HERE, via the same verified-first ranking restore.ts's pickTarget applies, and
  // passed through explicitly below — never left to restoreFromBackup's own default, which
  // this device's own first push would win as soon as the monitor starts (see this
  // module's docstring). Mirrors restore.ts's pickTarget deliberately: an older but sealed
  // generation is preferred over a newer one still mid-rotation.
  const wallet = deriveBackupWallet(deps.primaryKey, deps.chain)
  const settings = await deps.storage.makeAvailable()
  const target = await pickTarget(devices, client, wallet, deps.chain, settings)

  const result = await restoreFromBackup({
    storage: deps.storage,
    primaryKey: deps.primaryKey,
    chain: deps.chain,
    identityKey: deps.identityKey,
    client,
    manifest: devices,
    deviceId: target.deviceId,
    generation: target.generation,
    onProgress: deps.onProgress
  })

  if (deps.validateRestoredCoins) {
    await deps.validateRestoredCoins()
  }

  return {
    restored: true,
    chunks: result.chunks,
    deviceId: result.deviceId,
    generation: result.generation,
    verified: result.verified
  }
}

const hasUrl = (u?: string): boolean => u != null && u !== ''
