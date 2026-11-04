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
  constructor(message: string) {
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

type BlobResult = { bytes: Uint8Array; error?: never } | { bytes?: never; error: unknown }

export class RemoteSyncReader {
  private entries: LogEntry[] | null = null
  private next = 0
  private prefetched: { seq: number; result: Promise<BlobResult> } | null = null
  /** One decoded entry retained across authentication and replay, bounded independently of log size. */
  private decodedCache: { seq: number; decoded: DecodedEntry } | null = null
  private verifiedCompletePromise: Promise<boolean> | null = null
  private authenticationPromise: Promise<boolean> | null = null
  private authenticatedLog = false
  /** The most recent (i.e. furthest along in replay order) appData snapshot seen on any
   * entry so far — see the `appData` getter below. */
  private lastAppData: AppDataSnapshot | undefined

  constructor(
    private readonly client: BackupClient,
    private readonly wallet: CompletedProtoWallet,
    private readonly chain: BackupChain,
    private readonly deviceId: string,
    private readonly generation: number,
    private readonly settings: TableSettings,
    private readonly expectedHeadSeq?: number,
    private readonly onActivity?: () => void
  ) {}

  /** Settings for the storage being restored into. */
  async makeAvailable(): Promise<TableSettings> {
    return this.settings
  }

  /**
   * Fetch and check server-index consistency, once. Authenticated membership is
   * checked separately against the encrypted positions before replay.
   */
  private async ensureIndex(): Promise<LogEntry[]> {
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

  private async fetchAndDecode(entry: LogEntry): Promise<DecodedEntry> {
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
    // These checks detect corrupted transport bytes. The encrypted v2 position
    // below is the authority for log membership, not this server-owned index.
    if (ciphertext.length !== entry.size) {
      throw new BackupChainError(
        `backup blob at sequence ${entry.seq} is ${ciphertext.length} bytes but the index recorded ${entry.size}`
      )
    }
    const digest = Utils.toHex(Hash.sha256(Array.from(ciphertext)))
    if (digest !== entry.sha256) {
      throw new BackupChainError(`backup blob at sequence ${entry.seq} does not match the index's recorded digest`)
    }
    const decoded = await decodeEntry(this.wallet, Array.from(ciphertext), this.chain)
    const position = decoded.position
    if (
      position &&
      (position.deviceId !== this.deviceId ||
        position.generation !== this.generation ||
        position.seq !== entry.seq ||
        position.prevSha256 !== (entry.prevSha256 ?? undefined))
    ) {
      throw new BackupChainError(`authenticated backup position does not match sequence ${entry.seq}`)
    }
    return decoded
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
  async getSyncChunk(_args: RequestSyncChunkArgs): Promise<SyncChunk> {
    await this.authenticateLog()
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
    // Legacy snapshots are reorderable by the service and must not overwrite
    // live pending payments, outbox entries, contacts or issued dates.
    if (this.authenticatedLog && decoded.appData !== undefined) this.lastAppData = decoded.appData
    // Advance only after successful download AND decryption. Retrying this
    // reader after either fails must retry the same entry rather than lose it.
    this.next++
    const following = entries[this.next]
    if (
      following &&
      entry.size > 0 &&
      entry.size <= PREFETCH_MAX_BYTES &&
      following.size > 0 &&
      following.size <= PREFETCH_MAX_BYTES &&
      this.decodedCache?.seq !== following.seq
    ) {
      this.prefetched = {
        seq: following.seq,
        // Store failures as values until consumed, so a stopped replay never
        // leaves an unhandled rejection from a speculative download.
        result: this.client.blob(this.deviceId, this.generation, following.seq).then(
          bytes => ({ bytes }),
          error => ({ error })
        )
      }
    }

    return decoded.chunk
  }

  /** Number of chunks in this generation, once the index has been read. */
  get length(): number {
    return this.entries?.length ?? 0
  }

  /**
   * The most recent appData snapshot seen across every entry replayed through getSyncChunk
   * so far (XR-011). Read by restore.ts once this device's log is fully drained, so it
   * reflects the newest chunk that carried the field — undefined for a log written entirely
   * before this feature shipped, or one with genuinely nothing app-owned to carry.
   */
  get appData(): AppDataSnapshot | undefined {
    return this.lastAppData
  }

  /**
   * True only after all v2 positions and the ordered initial-snapshot head
   * commitment verify. A complete authentic old log can still be replayed by a
   * server: freshness requires an independent trusted head anchor.
   */
  async verifiedComplete(): Promise<boolean> {
    if (this.verifiedCompletePromise == null) {
      this.verifiedCompletePromise = this.computeVerifiedComplete()
    }
    return await this.verifiedCompletePromise
  }

  private async computeVerifiedComplete(): Promise<boolean> {
    try {
      if (!(await this.authenticateLog())) return false
      return this.decodedCache?.decoded.seal != null
    } catch {
      // Ranking may skip a corrupt candidate. Its cached authentication failure
      // is still rethrown before replay if the legacy fallback selects it.
      return false
    }
  }

  private authenticateLog(): Promise<boolean> {
    if (this.authenticationPromise == null) {
      this.authenticationPromise = this.checkAuthenticatedLog().catch(error => {
        // Transient download failures must remain retryable at the same position.
        this.authenticationPromise = null
        throw error
      })
    }
    return this.authenticationPromise
  }

  private async checkAuthenticatedLog(): Promise<boolean> {
    const entries = await this.ensureIndex()
    if (entries.length === 0) return false
    const first = entries[0]
    const decoded = await this.fetchAndDecode(first)
    this.decodedCache = { seq: first.seq, decoded }
    // Keep legacy entity recovery available, explicitly unverified. Its count-
    // only seals prove neither ordered membership nor snapshot completeness.
    if (!decoded.position) return false

    // Preflight every authenticated position before returning ANY recovery
    // state. Keep only one decoded entry cached so large backups stay bounded.
    for (const entry of entries) {
      const current = await this.fetchAndDecode(entry)
      if (!current.position) throw new BackupChainError('backup generation mixes legacy and authenticated positions')
      if (entry.seq === entries.length) this.decodedCache = { seq: entry.seq, decoded: current }
      const seal = current.seal
      if (seal && entries[seal.initialChunkCount - 1]?.sha256 !== seal.initialHeadSha256) {
        throw new BackupChainError('authenticated initial snapshot head does not match the backup log')
      }
      // Authentication can take longer than the rebuild's inactivity deadline.
      // Report work without exposing any recovery data before the whole log verifies.
      this.onActivity?.()
    }
    this.authenticatedLog = true
    return true
  }

  /**
   * Reject a log with a gap or a fork before any of it is replayed.
   *
   * A restore that silently stops halfway is worse than one that fails: the wallet would
   * look healthy while missing the outputs it needs to spend.
   */
  private verifyChain(entries: LogEntry[], start = 0): void {
    for (let i = start; i < entries.length; i++) {
      const expectedSeq = i + 1
      if (entries[i].seq !== expectedSeq) {
        throw new BackupChainError(`backup chain has a gap: expected sequence ${expectedSeq}, found ${entries[i].seq}`)
      }
      if (i > 0 && entries[i].prevSha256 !== entries[i - 1].sha256) {
        throw new BackupChainError(`backup chain is forked at sequence ${entries[i].seq}: previous hash does not match`)
      }
    }
  }
}
