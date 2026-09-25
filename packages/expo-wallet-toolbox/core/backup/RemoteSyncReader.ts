/**
 * Restore side of the backup log.
 *
 * `WalletStorageSyncReader` is a two-method interface, and that is the entire restore
 * contract — so replaying an encrypted log into a fresh database needs no changes to the
 * toolbox at all. `WalletStorageManager.syncFromReader` drives this exactly as it would
 * drive a live remote storage provider.
 */
import { Hash, Utils, type CompletedProtoWallet } from '@bsv/sdk'
import type { TableSettings } from '@bsv/wallet-toolbox-mobile'
import type { BackupClient, LogEntry } from './client'
import { decodeEntry, emptyChunk, type AppDataSnapshot, type DecodedEntry } from './codec'
import { MAX_INDEX_ENTRIES, type BackupChain } from './constants'
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
  /** Decoded once, keyed by seq, so verifiedComplete's own look-ahead at the newest entry
   * never re-fetches or re-decrypts it when replay later reaches that same entry. */
  private decodedCache: { seq: number, decoded: DecodedEntry } | null = null
  private verifiedCompletePromise: Promise<boolean> | null = null
  /** The most recent (i.e. furthest along in replay order) appData snapshot seen on any
   * entry so far — see the `appData` getter below. */
  private lastAppData: AppDataSnapshot | undefined

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
        // A malicious/compromised backup host could otherwise keep paging forever — nothing
        // else in this loop depends on the server ever running out of entries to offer.
        if (entries.length > MAX_INDEX_ENTRIES) {
          throw new BackupChainError(`backup index has grown past ${MAX_INDEX_ENTRIES} entries without completing`)
        }
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
    // The index is itself server-supplied, but it is fetched from a separate endpoint than
    // the blob body — a malicious or compromised service can serve the wrong (though still
    // authentic, same-wallet) ciphertext at a given sequence while its own index entry for
    // that sequence still carries the digest/size of what that sequence actually holds.
    // Decryption alone cannot catch this: the AEAD envelope authenticates only
    // {chain, chunk, seal} (see codec.ts), never the position a chunk was appended at.
    // Checking the downloaded bytes against the index's own claim for THIS entry, before
    // ever decrypting them, rejects a substituted or reordered blob outright instead of
    // silently replaying it mislabeled.
    if (ciphertext.length !== entry.size) {
      throw new BackupChainError(
        `backup blob at sequence ${entry.seq} is ${ciphertext.length} bytes but the index recorded ${entry.size}`
      )
    }
    const digest = Utils.toHex(Hash.sha256(Array.from(ciphertext)))
    if (digest !== entry.sha256) {
      throw new BackupChainError(`backup blob at sequence ${entry.seq} does not match the index's recorded digest`)
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
   * Every entry is an ordinary chunk (see codec.ts's DecodedEntry) — a seal, when present,
   * rides alongside a chunk rather than replacing it, so nothing here needs to be swallowed.
   */
  async getSyncChunk (_args: RequestSyncChunkArgs): Promise<SyncChunk> {
    await this.ensureIndex()
    const entries = this.entries!

    if (this.next >= entries.length) {
      return emptyChunk(this.deviceId, this.settings.storageIdentityKey, '')
    }

    const entry = entries[this.next]
    const decoded = await this.fetchAndDecode(entry)
    // Every appData-carrying chunk is a full snapshot as of its own push (see
    // backup/appData.ts's captureAppDataSnapshot), so the LAST one seen while replaying in
    // order is authoritative — never merged with an earlier one within this same device's
    // own log (unlike restoreOnImport's cross-device merge). An entry that predates this
    // feature, or one written while there was genuinely nothing app-owned to add, carries no
    // `appData` at all and must not erase a still-current snapshot from an earlier entry.
    if (decoded.appData !== undefined) this.lastAppData = decoded.appData
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

    return decoded.chunk
  }

  /** Number of chunks in this generation, once the index has been read. */
  get length (): number {
    return this.entries?.length ?? 0
  }

  /**
   * The most recent appData snapshot seen across every entry replayed through getSyncChunk
   * so far (XR-011). Read by restore.ts once this device's log is fully drained, so it
   * reflects the newest chunk that carried the field — undefined for a log written entirely
   * before this feature shipped, or one with genuinely nothing app-owned to carry.
   */
  get appData (): AppDataSnapshot | undefined {
    return this.lastAppData
  }

  /**
   * Whether this generation's log, as it stands right now, is provably complete — i.e. this
   * device itself once confirmed the generation's initial snapshot was whole, independent of
   * anything the server's index metadata alone reports (see codec.ts's DecodedEntry and
   * push.ts's own seal docs).
   *
   * True only when the NEWEST entry carries a seal for THIS generation whose
   * `initialChunkCount` is no greater than the number of entries in the log — i.e. every
   * chunk of the initial snapshot the seal refers to is present. Cheap by design: only that
   * one entry is decrypted here, never the whole log — replay (getSyncChunk) still decodes
   * every entry as it goes and is what actually enforces the chain end to end.
   *
   * Because every chunk appended after the initial window closes carries the SAME seal (see
   * push.ts's pushOnce), this stays true as further deltas land, rather than flipping back to
   * false the moment a new chunk becomes the newest entry — a generation is not "un-verified"
   * by continuing to receive backups.
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
      // A last entry that fails to download or decrypt cannot be trusted as sealed —
      // treat the generation as unverified rather than throwing out of a check that
      // pickTarget uses purely to rank candidates.
      return false
    }
    this.decodedCache = { seq: last.seq, decoded }
    const seal = decoded.seal
    if (seal == null) return false
    return seal.generation === this.generation && seal.initialChunkCount <= entries.length
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
