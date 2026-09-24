/**
 * Restore orchestration.
 *
 * Given nothing but a recovered seed (or the primary key from printed shares), rebuild the
 * wallet database from the encrypted log.
 */
import type { CompletedProtoWallet } from '@bsv/sdk'
import type { TableSettings } from '@bsv/wallet-toolbox-mobile'
import type { StorageExpoSQLite } from '../storage/StorageExpoSQLite'
import { BackupClient, type DeviceSummary } from './client'
import type { BackupChain } from './constants'
import { deriveBackupWallet } from './derive'
import { RemoteSyncReader } from './RemoteSyncReader'

export interface RestoreDeps {
  /** A fresh, migrated storage provider to replay into. */
  storage: StorageExpoSQLite
  /** The wallet's m/0'/0' key, from the mnemonic or from recovery shares. */
  primaryKey: number[]
  /** The network being restored. Selects the per-network pseudonym and decryption key. */
  chain: BackupChain
  /** The wallet's real identity key, for the local user record. */
  identityKey: string
  /** Supply exactly one. */
  baseUrl?: string
  client?: BackupClient
  /** Defaults to the most recently updated device in the manifest. */
  deviceId?: string
  /** A manifest already read by the import flow; avoids a duplicate request. */
  manifest?: DeviceSummary[]
  /** Defaults to the newest generation for that device. */
  generation?: number
  /**
   * Called after each replayed chunk, with how many have landed and how many the
   * generation holds. `total` is 0 until the index has been read, i.e. before the
   * first chunk arrives.
   */
  onProgress?: (chunks: number, total: number) => void
}

export interface RestoreResult {
  chunks: number
  deviceId: string
  generation: number
  /**
   * True when the replayed generation's newest entry carries a seal proving, to this
   * device, that its initial snapshot is fully present — see codec.ts's DecodedEntry and
   * push.ts's pushOnce. False means either an explicit device/generation override was
   * chosen with no seal, or no candidate anywhere in the manifest was sealed and today's
   * newest-only fallback was used instead. See P1-backup-incomplete-generation.
   */
  verified: boolean
}

/** What the user can choose between when more than one device has a backup. */
export async function listBackups (deps: {
  primaryKey: number[]
  chain: BackupChain
  baseUrl?: string
  client?: BackupClient
}): Promise<DeviceSummary[]> {
  return await resolveClient(deps).manifest()
}

/**
 * Replay the best generation the manifest reports for the chosen device.
 *
 * A generation is intended by the writer (see push.ts rotate/shouldRotate) to be a
 * coherent, self-contained snapshot, so the newest one alone should be sufficient and is
 * the shortest replay — but the manifest's own metadata carries no notion of "complete", so
 * pickTarget prefers whichever candidate is proven complete by its own seal (see
 * RemoteSyncReader.verifiedComplete) over blindly trusting recency. `verified` on the
 * result says which way this restore was chosen; the chunk-count check below still runs
 * either way as the last line of defence.
 */
export async function restoreFromBackup (deps: RestoreDeps): Promise<RestoreResult> {
  const client = resolveClient(deps)
  const wallet = deriveBackupWallet(deps.primaryKey, deps.chain)

  const devices = deps.manifest ?? await client.manifest()
  if (devices.length === 0) {
    throw new Error('No backup found for this wallet')
  }

  const settings = await deps.storage.makeAvailable()
  const chosen = await pickTarget(devices, client, wallet, deps.chain, settings, deps.deviceId, deps.generation)

  // processSyncChunk's preconditions, which a fresh, just-migrated database does
  // not meet: it does verifyTruthy(findUserByIdentityKey(identityKey)) and then
  // verifyOne(findSyncStates({storageIdentityKey: fromStorageIdentityKey, userId})).
  // On a new device the restore runs BEFORE addWalletStorageProvider/getAuth ever
  // create the user row, so without seeding both rows here every replay dies with
  // the toolbox's bare "A truthy value is required." Both helpers are idempotent
  // (find-or-insert), so a retry converges.
  const { user } = await deps.storage.findOrInsertUser(deps.identityKey)
  await deps.storage.findOrInsertSyncStateAuth(
    { userId: user.userId, identityKey: deps.identityKey },
    chosen.deviceId,
    'backup-restore'
  )

  // Reuses the exact reader pickTarget already probed (it may already have read this
  // generation's index and decoded its newest entry while ranking candidates), rather than
  // re-fetching the same index a second time.
  const reader = chosen.reader

  let chunks = 0
  for (;;) {
    const chunk = await reader.getSyncChunk({
      identityKey: deps.identityKey,
      fromStorageIdentityKey: chosen.deviceId,
      toStorageIdentityKey: settings.storageIdentityKey,
      maxRoughSize: 0,
      maxItems: 0,
      offsets: []
    })

    const result = await deps.storage.processSyncChunk({
      identityKey: deps.identityKey,
      fromStorageIdentityKey: chosen.deviceId,
      toStorageIdentityKey: settings.storageIdentityKey,
      maxRoughSize: 0,
      maxItems: 0,
      offsets: []
    }, chunk)

    if (result.done) {
      if (chunks < reader.length) throw new Error('Backup replay completed before all indexed chunks were applied')
      break
    }
    chunks++
    deps.onProgress?.(chunks, reader.length)

    // The reader is finite; this guards against a processSyncChunk that never reports done.
    if (chunks > reader.length) throw new Error('Backup replay did not acknowledge completion')
  }

  await reconcileRestoredProofs(deps.storage)
  return { chunks, deviceId: chosen.deviceId, generation: chosen.generation, verified: chosen.verified }
}

/**
 * Toolbox sync merges transaction status but only history/notify for an
 * existing proof request. An unsent request followed by its completed version
 * can therefore replay beside a completed transaction and keep rebroadcasting
 * it. Reuse proofs already in storage through the normal completion method,
 * which also reconciles notification IDs and preserves completed transactions.
 * Run only after the entire log lands, before the wallet/monitor is published.
 */
async function reconcileRestoredProofs (storage: StorageExpoSQLite): Promise<void> {
  const limit = 1
  for (let offset = 0; ; offset += limit) {
    // Page over every status so completing a request cannot shift the next
    // page's offsets. A request may contain a large expanded inputBEEF, so
    // retain only one request at a time while completion reloads its proof.
    const requests = await storage.findProvenTxReqs({ partial: {}, paged: { limit, offset } })
    for (const req of requests) {
      if (req.status === 'completed' && req.notified && (req.provenTxId ?? 0) > 0) continue
      const proofs = await storage.findProvenTxs({ partial: { txid: req.txid } })
      if (proofs.length === 0) continue
      if (proofs.length !== 1) throw new Error('Restored transaction has conflicting stored proofs')
      const proof = proofs[0]
      const result = await storage.updateProvenTxReqWithNewProvenTx({
        provenTxReqId: req.provenTxReqId,
        txid: req.txid,
        status: req.status,
        attempts: req.attempts,
        history: req.history,
        height: proof.height,
        index: proof.index,
        blockHash: proof.blockHash,
        merkleRoot: proof.merkleRoot,
        merklePath: proof.merklePath
      })
      // The toolbox can report incomplete notification after a failed row
      // update. Do not advertise a completed restore in that case.
      if (result.status !== 'completed' || result.provenTxId !== proof.provenTxId || result.notified === false) {
        throw new Error('Restored transaction proof reconciliation did not complete')
      }
    }
    if (requests.length < limit) break
  }
}

/** What pickTarget resolves to: the chosen device/generation, whether it is verified
 * complete, and the reader that already probed it — reused by restoreFromBackup for the
 * actual replay rather than re-reading the same index a second time. */
export interface PickedTarget {
  deviceId: string
  generation: number
  verified: boolean
  reader: RemoteSyncReader
}

/**
 * Choose which device/generation to replay.
 *
 * With an explicit `generation`, this is a forced selection — no ranking, exactly the
 * generation asked for — but `verified` still reports whether IT happens to be sealed.
 *
 * Otherwise: every (device, generation) candidate is ranked newest-updatedAt first, and the
 * first one whose own log proves itself complete (RemoteSyncReader.verifiedComplete) wins —
 * an older but SEALED generation is safer to restore than a newer one still mid-rotation,
 * which is the whole point of P1-backup-incomplete-generation's fix. Only when NONE of the
 * manifest's candidates are sealed (a fully legacy manifest, written entirely before this
 * fix shipped) does this fall back to today's plain "most recently written device, then its
 * newest generation" heuristic, with `verified: false` so the caller can warn rather than
 * silently claim a verified restore.
 */
export async function pickTarget (
  devices: DeviceSummary[],
  client: BackupClient,
  wallet: CompletedProtoWallet,
  chain: BackupChain,
  settings: TableSettings,
  deviceId?: string,
  generation?: number
): Promise<PickedTarget> {
  const candidates = deviceId != null ? devices.filter(d => d.deviceId === deviceId) : devices
  if (candidates.length === 0) {
    throw new Error(`No backup found for device ${String(deviceId)}`)
  }

  const readerFor = (d: DeviceSummary): RemoteSyncReader =>
    new RemoteSyncReader(client, wallet, chain, d.deviceId, d.generation, settings, d.headSeq)

  if (generation != null) {
    const exact = candidates.find(d => d.generation === generation)
    if (exact == null) throw new Error(`No backup found for generation ${generation}`)
    const reader = readerFor(exact)
    const verified = await reader.verifiedComplete()
    return { deviceId: exact.deviceId, generation: exact.generation, verified, reader }
  }

  // Newest updatedAt first, across every device in the candidate set — not scoped to the
  // most recently written device alone, because the point is to prefer a sealed generation
  // even if it belongs to a slightly less recently updated device.
  const sorted = [...candidates].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

  for (const candidate of sorted) {
    const reader = readerFor(candidate)
    let verified: boolean
    try {
      verified = await reader.verifiedComplete()
    } catch {
      // Ranking must not abort the whole restore over a candidate that turns out unreadable
      // and was never going to be chosen anyway — it is simply not verified.
      verified = false
    }
    if (verified) return { deviceId: candidate.deviceId, generation: candidate.generation, verified: true, reader }
  }

  // Nothing in the manifest is marked complete: fall back to today's heuristic (most
  // recently written device, then its newest generation) so a fully legacy manifest still
  // restores exactly as before — just now saying honestly that it could not be verified.
  const newest = candidates.reduce((best, d) => (d.updatedAt > best.updatedAt ? d : best))
  const newestGeneration = candidates
    .filter(d => d.deviceId === newest.deviceId)
    .reduce((best, d) => (d.generation > best.generation ? d : best))

  return {
    deviceId: newestGeneration.deviceId,
    generation: newestGeneration.generation,
    verified: false,
    reader: readerFor(newestGeneration)
  }
}

function resolveClient (deps: { primaryKey: number[], chain: BackupChain, baseUrl?: string, client?: BackupClient }): BackupClient {
  if (deps.client != null) return deps.client
  if (deps.baseUrl == null || deps.baseUrl === '') {
    throw new Error('restore requires either a client or a baseUrl')
  }
  return new BackupClient(deps.baseUrl, deps.primaryKey, deps.chain)
}
