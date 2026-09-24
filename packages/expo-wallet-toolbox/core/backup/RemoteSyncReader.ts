/**
 * Restore side of the backup log.
 *
 * `WalletStorageSyncReader` is a two-method interface, and that is the entire restore
 * contract — so replaying an encrypted log into a fresh database needs no changes to the
 * toolbox at all. `WalletStorageManager.syncFromReader` drives this exactly as it would
 * drive a live remote storage provider.
 */
import type { CompletedProtoWallet } from '@bsv/sdk'
import type { TableSettings } from '@bsv/wallet-toolbox-mobile'
import type { BackupClient, LogEntry } from './client'
import { decodeEntry, emptyChunk, type DecodedEntry } from './codec'
import type { BackupChain } from './constants'
import type { RequestSyncChunkArgs, SyncChunk } from '../toolboxTypes'

export class BackupChainError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'BackupChainError'
  }
}

// The server caps each index page at 500 entries. Reading only its first page
// can otherwise look like a successful restore of a truncated wallet.
const INDEX_PAGE_SIZE = 500
// At most one small ciphertext is fetched ahead while SQLite replays the
// current chunk. Large chunks remain sequential to bound mobile memory use.
const PREFETCH_MAX_BYTES = 1024 * 1024

type BlobResult = { bytes: Uint8Array, error?: never } | { bytes?: never, error: unknown }

export class RemoteSyncReader {
  private entries: LogEntry[] | null = null
  private next = 0
  private prefetched: { seq: number, result: Promise<BlobResult> } | null = null
  /**
   * Marker entries swallowed so far. A marker is backup-log bookkeeping (see codec.ts's
   * DecodedEntry), never a SyncChunk, so it must never reach the caller and must not be
   * counted as one of the generation's real chunks — `length` subtracts this.
   */
  private markerCount = 0
  /** Decoded once, keyed by seq, so verifiedComplete's own look-ahead at the newest entry
   * never re-fetches or re-decrypts it when replay later reaches that same entry. */
  private decodedCache: { seq: number, decoded: DecodedEntry } | null = null
  private verifiedCompletePromise: Promise<boolean> | null = null

  constructor (
    private readonly client: BackupClient,
    private readonly wallet: CompletedProtoWallet,
    private readonly chain: BackupChain,
    private readonly deviceId: string,
    private readonly generation: number,
    private readonly settings: TableSettings,
    private readonly expectedHeadSeq?: number
  ) {}

  /** Settings for the storage being restored into. */
  async makeAvailable (): Promise<TableSettings> {
    return this.settings
  }

  /**
   * Fetch and verify the index, once. Shared by getSyncChunk (which needs every entry to
   * replay) and verifiedComplete (which only needs to know how many entries exist and what
   * the last one is).
   */
  private async ensureIndex (): Promise<LogEntry[]> {
    if (this.entries == null) {
      const entries: LogEntry[] = []
      let page = await this.client.index(this.deviceId, this.generation)
      for (;;) {
        const pageStart = entries.length
        entries.push(...page)
        this.verifyChain(entries, pageStart)
        const missingHead = this.expectedHeadSeq != null && entries.length < this.expectedHeadSeq
        if (page.length === 0) {
          if (missingHead) throw new BackupChainError('backup index ended before its advertised head')
          break
        }
        if (page.length < INDEX_PAGE_SIZE && !missingHead) break
        page = await this.client.index(this.deviceId, this.generation, entries.length + 1)
      }
      // Publish only a fully verified index. A failed read/validation must not
      // let a retry skip verification or mistake a partial index for completion.
      this.entries = entries
    }
    return this.entries
  }

  private async fetchAndDecode (entry: LogEntry): Promise<DecodedEntry> {
    if (this.decodedCache?.seq === entry.seq) return this.decodedCache.decoded
    let ciphertext: Uint8Array
    if (this.prefetched?.seq === entry.seq) {
      const pending = this.prefetched
      this.prefetched = null
      const result = await pending.result
      if ('error' in result) throw result.error
      ciphertext = result.bytes
    } else {
      ciphertext = await this.client.blob(this.deviceId, this.generation, entry.seq)
    }
    return await decodeEntry(this.wallet, Array.from(ciphertext), this.chain)
  }

  /**
   * Return the next chunk in sequence.
   *
   * `args` is ignored deliberately: a live reader would honour `since` and `offsets`, but a
   * log is an ordered recording of chunks that were already produced against those very
   * arguments. Replaying them in order reproduces the original stream exactly, and second
   * -guessing it would risk skipping records.
   *
   * A completion marker (see codec.ts) is swallowed here rather than handed to the caller:
   * it is backup-log bookkeeping, not a SyncChunk, and encoding it as an ordinary empty
   * chunk instead would make `processSyncChunk` treat it as the done sentinel and truncate
   * or fail a replay that has real chunks still to come after it (push.ts's own module
   * docstring on sealGeneration explains why).
   */
  async getSyncChunk (_args: RequestSyncChunkArgs): Promise<SyncChunk> {
    await this.ensureIndex()
    const entries = this.entries!

    for (;;) {
      if (this.next >= entries.length) {
        return emptyChunk(this.deviceId, this.settings.storageIdentityKey, '')
      }

      const entry = entries[this.next]
      const decoded = await this.fetchAndDecode(entry)
      // Advance only after successful download AND decryption. Retrying this
      // reader after either fails must retry the same entry rather than lose it.
      this.next++
      const following = entries[this.next]
      if (following && entry.size > 0 && entry.size <= PREFETCH_MAX_BYTES &&
          following.size > 0 && following.size <= PREFETCH_MAX_BYTES &&
          this.decodedCache?.seq !== following.seq) {
        this.prefetched = {
          seq: following.seq,
          // Store failures as values until consumed, so a stopped replay never
          // leaves an unhandled rejection from a speculative download.
          result: this.client.blob(this.deviceId, this.generation, following.seq).then(
            bytes => ({ bytes }), error => ({ error })
          )
        }
      }

      if (decoded.kind === 'marker') {
        this.markerCount++
        continue
      }
      return decoded.chunk
    }
  }

  /**
   * Number of REAL chunks in this generation, once the index has been read — completion
   * markers are excluded, matching what getSyncChunk actually yields.
   *
   * Accurate only for entries already classified: a marker not yet reached by getSyncChunk
   * (or by verifiedComplete, for the newest entry) is still counted here as if it were a
   * chunk, since classifying it requires decrypting it. It settles to the true count once
   * replay has passed it.
   */
  get length (): number {
    return (this.entries?.length ?? 0) - this.markerCount
  }

  /**
   * Whether this generation's log, as it stands right now, carries its own completion
   * marker — i.e. this device itself once confirmed the generation's initial snapshot was
   * whole, independent of anything the server's index metadata alone reports (see
   * codec.ts's DecodedEntry and push.ts's sealGeneration).
   *
   * True only when the NEWEST entry decodes as a marker whose `chunkCount` matches the
   * number of entries before it. Cheap by design: only that one entry is decrypted here,
   * never the whole log — replay (getSyncChunk) still decodes every entry as it goes and is
   * what actually enforces the chain end to end.
   *
   * A generation that kept accumulating ordinary delta chunks after its one-shot seal (see
   * push.ts's needsSeal) will report false here again, even though the marker still exists
   * earlier in the log — this reflects "provably complete right now", not "was ever
   * sealed". restore.ts's pickTarget falls back to an older, still-marked generation in
   * that case rather than trusting this one's tail.
   */
  async verifiedComplete (): Promise<boolean> {
    if (this.verifiedCompletePromise == null) {
      this.verifiedCompletePromise = this.computeVerifiedComplete()
    }
    return await this.verifiedCompletePromise
  }

  private async computeVerifiedComplete (): Promise<boolean> {
    const entries = await this.ensureIndex()
    if (entries.length === 0) return false

    const last = entries[entries.length - 1]
    let decoded: DecodedEntry
    try {
      decoded = await this.fetchAndDecode(last)
    } catch {
      // A last entry that fails to download or decrypt cannot be trusted as a marker —
      // treat the generation as unverified rather than throwing out of a check that
      // pickTarget uses purely to rank candidates.
      return false
    }
    this.decodedCache = { seq: last.seq, decoded }
    if (decoded.kind !== 'marker') return false
    return decoded.marker.generation === this.generation && decoded.marker.chunkCount === entries.length - 1
  }

  /**
   * Reject a log with a gap or a fork before any of it is replayed.
   *
   * A restore that silently stops halfway is worse than one that fails: the wallet would
   * look healthy while missing the outputs it needs to spend.
   */
  private verifyChain (entries: LogEntry[], start = 0): void {
    for (let i = start; i < entries.length; i++) {
      const expectedSeq = i + 1
      if (entries[i].seq !== expectedSeq) {
        throw new BackupChainError(
          `backup chain has a gap: expected sequence ${expectedSeq}, found ${entries[i].seq}`
        )
      }
      if (i > 0 && entries[i].prevSha256 !== entries[i - 1].sha256) {
        throw new BackupChainError(
          `backup chain is forked at sequence ${entries[i].seq}: previous hash does not match`
        )
      }
    }
  }
}
