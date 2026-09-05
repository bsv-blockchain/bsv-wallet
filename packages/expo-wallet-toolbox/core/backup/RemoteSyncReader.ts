/**
 * Restore side of the backup log.
 *
 * `WalletStorageSyncReader` is a two-method interface, and that is the entire restore
 * contract — so replaying an encrypted log into a fresh database needs no changes to the
 * toolbox at all. `WalletStorageManager.syncFromReader` drives this exactly as it would
 * drive a live remote storage provider.
 */
import type { CompletedProtoWallet } from '@bsv/sdk'
import type {
  RequestSyncChunkArgs,
  SyncChunk
} from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import type { TableSettings } from '@bsv/wallet-toolbox-mobile/out/src/storage/schema/tables'
import type { BackupClient, LogEntry } from './client'
import { decodeChunk, emptyChunk } from './codec'
import type { BackupChain } from './constants'

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
   * Return the next chunk in sequence.
   *
   * `args` is ignored deliberately: a live reader would honour `since` and `offsets`, but a
   * log is an ordered recording of chunks that were already produced against those very
   * arguments. Replaying them in order reproduces the original stream exactly, and second
   * -guessing it would risk skipping records.
   */
  async getSyncChunk (_args: RequestSyncChunkArgs): Promise<SyncChunk> {
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

    if (this.next >= this.entries.length) {
      return emptyChunk(this.deviceId, this.settings.storageIdentityKey, '')
    }

    const entry = this.entries[this.next]
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
    const chunk = await decodeChunk(this.wallet, Array.from(ciphertext), this.chain)
    // Advance only after successful download AND decryption. Retrying this
    // reader after either fails must retry the same entry rather than lose it.
    this.next++
    const following = this.entries[this.next]
    if (following && entry.size > 0 && entry.size <= PREFETCH_MAX_BYTES &&
        following.size > 0 && following.size <= PREFETCH_MAX_BYTES) {
      this.prefetched = {
        seq: following.seq,
        // Store failures as values until consumed, so a stopped replay never
        // leaves an unhandled rejection from a speculative download.
        result: this.client.blob(this.deviceId, this.generation, following.seq).then(
          bytes => ({ bytes }), error => ({ error })
        )
      }
    }
    return chunk
  }

  /** Number of chunks in this generation, once the index has been read. */
  get length (): number {
    return this.entries?.length ?? 0
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
