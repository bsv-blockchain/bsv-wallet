/**
 * A validated window of block headers, on disk, plus an in-memory merkle-root
 * index.
 *
 * WHY THIS EXISTS: `Beef.verify` needs exactly one thing — a merkle root for a
 * block height (@bsv/sdk Beef.js:702-707). Everything else about offline
 * payments follows from being able to answer that with no network.
 *
 * SHAPE: `<chain>.bin` holds contiguous 80-byte headers starting at
 * `anchor.height + 1`; `<chain>.json` holds the metadata; `<chain>-extra.json`
 * holds roots resolved below the window while online. On open, one pass over
 * the .bin builds a packed Uint8Array of 32-byte roots — ~1.7 MB for a year,
 * versus ~3.4 MB if they were kept as hex strings — so a lookup is an array
 * slice and a hex encode rather than file I/O.
 *
 * VALIDATION checks checkpoint-authenticated difficulty history, network
 * expected bits, proof of work, MTP, future time and version in one pass.
 * Reorg candidates must exceed the existing locally computed accumulated work.
 * The toolbox own-target-only helper is insufficient for consensus validation.
 */
import { Utils } from '@bsv/sdk'
import { utils as chaintracksUtils } from '@bsv/wallet-toolbox-mobile'
import type { HeaderCheckpoint } from './checkpoints'
import type { HeaderFs } from './fs'
import { HeaderConsensus, parseHeader } from './headerConsensus'
import type { WalletChain } from '../networks'

const HEADER_BYTES = 80
const ROOT_BYTES = 32

interface StoredMeta {
  chain: string
  anchorHeight: number
  anchorHash: string
  count: number
  tipHash: string
}

export class HeaderStore {
  /** Headers validated per JS-thread slice before `append` yields. ~140ms on the device that produced 2.8s stalls. */
  static readonly DEFAULT_YIELD_EVERY = 100
  yieldEvery = HeaderStore.DEFAULT_YIELD_EVERY

  private roots: Uint8Array
  private extra: Record<string, string>
  private consensus: HeaderConsensus | undefined
  private recoveryRequired = false
  private reopenRequired = false
  private constructor(
    private readonly fs: HeaderFs,
    readonly chain: string,
    readonly anchor: HeaderCheckpoint,
    private headerCount: number,
    private currentTipHash: string,
    roots: Uint8Array,
    extra: Record<string, string>
  ) {
    this.roots = roots
    this.extra = extra
  }

  private get binPath(): string {
    return `${this.chain}.bin`
  }
  private get contextPath(): string {
    return `${this.chain}-context.bin`
  }
  get needsContext(): boolean {
    return this.consensus == null
  }
  get contextStartHeight(): number {
    return HeaderConsensus.contextStart(this.anchor)
  }
  get contextCount(): number {
    return this.anchor.height - this.contextStartHeight + 1
  }
  get chainWork(): bigint {
    return this.consensus?.chainWork ?? 0n
  }
  hashForHeight(height: number): string | undefined {
    if (this.reopenRequired) return undefined
    return height === this.anchor.height ? this.anchor.hash : this.consensus?.hashForHeight(height)
  }

  /** The bootstrap is peer-supplied bytes, authenticated by the pinned terminal hash. */
  async initializeContext(bytes: Uint8Array): Promise<void> {
    await this.recoverReplacement()
    if (this.headerCount !== 0) throw new Error('Cannot replace live header consensus context')
    const consensus = HeaderConsensus.fromContext(this.chain as WalletChain, this.anchor, bytes)
    await this.fs.writeBytes(this.contextPath, bytes)
    this.consensus = consensus
  }

  private get metaPath(): string {
    return `${this.chain}.json`
  }
  private get extraPath(): string {
    return `${this.chain}-extra.json`
  }

  /** First height held by the window. */
  get baseHeight(): number {
    return this.anchor.height + 1
  }
  get count(): number {
    return this.headerCount
  }
  /** Highest validated height, or the anchor height when the window is empty. */
  get tipHeight(): number {
    return this.anchor.height + this.headerCount
  }
  /** Hash of the highest validated header, or the anchor hash when empty. */
  get tipHash(): string {
    return this.currentTipHash
  }

  static async open(fs: HeaderFs, chain: string, anchor: HeaderCheckpoint): Promise<HeaderStore> {
    await HeaderStore.recoverReplacement(fs, chain)
    const extraRaw = await fs.readText(`${chain}-extra.json`)
    let extra: Record<string, string> = {}
    if (extraRaw) {
      try {
        const parsed = JSON.parse(extraRaw) as unknown
        if (parsed && typeof parsed === 'object') extra = parsed as Record<string, string>
      } catch {
        // A corrupt cache of roots is a cache miss, never a load failure.
      }
    }

    const metaRaw = await fs.readText(`${chain}.json`)
    let meta: StoredMeta | undefined
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw) as StoredMeta
      } catch {
        meta = undefined
      }
    }

    const empty = new HeaderStore(fs, chain, anchor, 0, anchor.hash, new Uint8Array(0), extra)
    let context = await fs.readBytes(`${chain}-context.bin`)
    if (!context && anchor.height === 0) {
      try {
        context = new Uint8Array(chaintracksUtils.genesisBuffer(chain as never))
      } catch {
        /* Unsupported network fails closed. */
      }
    }
    if (context) {
      try {
        empty.consensus = HeaderConsensus.fromContext(chain as WalletChain, anchor, context)
      } catch {
        // Old or corrupt context cannot make persisted roots authoritative.
        await fs.deleteFile(`${chain}-context.bin`)
      }
    }

    // A shipped checkpoint that moved (app update) invalidates the window: its
    // first header no longer links to anything we trust. Start over rather than
    // keep headers we can no longer justify.
    if (
      !meta ||
      meta.chain !== chain ||
      meta.anchorHeight !== anchor.height ||
      meta.anchorHash !== anchor.hash ||
      !Number.isSafeInteger(meta.count) ||
      meta.count <= 0
    ) {
      await empty.reset()
      return empty
    }

    let bin = await fs.readBytes(`${chain}.bin`)
    const expected = meta.count * HEADER_BYTES
    if (!bin || bin.length < expected) {
      await empty.reset()
      return empty
    }
    // Crash-mid-append: extra bytes past meta.count are not indexed and would
    // sit in front of the next append. Truncate to the committed prefix.
    if (bin.length > expected) {
      bin = bin.subarray(0, expected)
      await fs.writeBytes(`${chain}.bin`, bin)
    }

    if (!empty.consensus) {
      await empty.reset()
      return empty
    }
    const roots = new Uint8Array(meta.count * ROOT_BYTES)
    try {
      for (let i = 0; i < meta.count; i++) {
        if (i > 0 && i % HeaderStore.DEFAULT_YIELD_EVERY === 0) await yieldToEventLoop()
        const parsed = empty.consensus.append(
          bin.subarray(i * HEADER_BYTES, (i + 1) * HEADER_BYTES),
          anchor.height + i + 1
        )
        roots.set(new Uint8Array(Utils.toArray(parsed.merkleRoot, 'hex')), i * ROOT_BYTES)
      }
    } catch {
      // Rebuild rather than trust windows accepted by the old own-target-only
      // validator or inconsistent disk metadata. Offline verification fails closed.
      empty.consensus = undefined
      if (context) {
        try {
          empty.consensus = HeaderConsensus.fromContext(chain as WalletChain, anchor, context)
        } catch {
          /* Needs online bootstrap. */
        }
      }
      await empty.reset()
      return empty
    }
    empty.roots = roots
    empty.headerCount = meta.count
    empty.currentTipHash = empty.consensus.tipHash
    await empty.writeMeta()
    return empty
  }

  rootForHeight(height: number): string | undefined {
    if (this.reopenRequired) return undefined
    const index = height - this.baseHeight
    const inWindow = index >= 0 && index < this.headerCount
    // The window's own PoW-linked root is authoritative for its validated BODY
    // (every height except the last 6, which can still legitimately reorg): an
    // extra entry there is ignored outright, never consulted, because letting
    // it win is exactly how an unauthenticated remote answer could overwrite a
    // root this device already validated for itself off linked headers — see
    // misc-p2-02 / OfflineFirstChaintracks.isValidRootForHeight.
    if (inWindow && !this.inReorgWindow(height)) {
      return Utils.toHex(Array.from(this.roots.subarray(index * ROOT_BYTES, (index + 1) * ROOT_BYTES)))
    }
    // Outside the body — either the last-6 reorg tail, or a height the window
    // does not cover at all — a heal written to extra is the value to consult;
    // falling through to the window covers the tail case where no heal exists.
    const extra = this.extra[String(height)]
    if (extra !== undefined) return extra
    if (inWindow) {
      return Utils.toHex(Array.from(this.roots.subarray(index * ROOT_BYTES, (index + 1) * ROOT_BYTES)))
    }
    return undefined
  }

  /**
   * True when `height` sits in the window's validated BODY — inside
   * `[baseHeight, tipHeight]` but outside the last-6 reorg tail — where the
   * window's own root is authoritative and a network answer must never be
   * allowed to override it. Used by `OfflineFirstChaintracks` to decide
   * whether a mismatch may fall through to the remote at all.
   */
  isWindowBody(height: number): boolean {
    return height >= this.baseHeight && height <= this.tipHeight - 6
  }

  /**
   * Validates and appends a chunk. Returns the number of headers added.
   *
   * Throws without mutating anything if the chunk is misaligned, starts at the
   * wrong height, fails to link, or contains a header whose hash does not meet
   * its declared target.
   */
  async append(bytes: Uint8Array, firstHeight: number): Promise<number> {
    await this.recoverReplacement()
    if (bytes.length === 0) return 0
    if (bytes.length % HEADER_BYTES !== 0) {
      throw new Error(`header chunk must be a multiple of 80 bytes, got ${bytes.length}`)
    }
    if (firstHeight !== this.tipHeight + 1) {
      throw new Error(`header chunk starts at height ${firstHeight}, expected ${this.tipHeight + 1}`)
    }

    if (!this.consensus)
      throw new Error('Header difficulty context unavailable; synchronize authenticated bootstrap first')
    const candidate = this.consensus.forkAt(this.tipHeight)
    const added = bytes.length / HEADER_BYTES
    const newRoots = new Uint8Array(added * ROOT_BYTES)
    for (let i = 0; i < added; i++) {
      if (i > 0 && i % this.yieldEvery === 0) await yieldToEventLoop()
      const parsed = candidate.append(bytes.subarray(i * HEADER_BYTES, (i + 1) * HEADER_BYTES), firstHeight + i)
      newRoots.set(new Uint8Array(Utils.toArray(parsed.merkleRoot, 'hex')), i * ROOT_BYTES)
    }
    await this.fs.appendBytes(this.binPath, bytes)
    const merged = new Uint8Array(this.roots.length + newRoots.length)
    merged.set(this.roots, 0)
    merged.set(newRoots, this.roots.length)
    this.roots = merged
    this.headerCount += added
    this.currentTipHash = candidate.tipHash
    this.consensus = candidate
    await this.writeMeta()
    return added
  }

  /**
   * Drops headers after `count`. Rewinds an orphaned tip so the next canonical
   * header can link. Rebuilds the on-disk `.bin` and the in-memory root index.
   */
  async truncateToCount(count: number): Promise<void> {
    await this.recoverReplacement()
    if (count === this.headerCount) return
    if (count < 0 || count > this.headerCount) {
      throw new Error(`truncateToCount(${count}) out of range 0..${this.headerCount}`)
    }
    if (count === 0) {
      await this.reset()
      return
    }
    const keep = count * HEADER_BYTES
    const bin = await this.fs.readBytes(this.binPath)
    if (!bin || bin.length < keep) {
      await this.reset()
      return
    }
    const sliced = bin.subarray(0, keep)
    await this.fs.writeBytes(this.binPath, sliced)
    this.roots = new Uint8Array(this.roots.subarray(0, count * ROOT_BYTES))
    this.headerCount = count
    this.currentTipHash = parseHeader(sliced.subarray(keep - HEADER_BYTES, keep)).hash
    this.consensus = this.consensus?.forkAt(this.anchor.height + count)
    await this.writeMeta()
  }

  /** Adopt a fully validated competing branch only when it has strictly more work. */
  async replaceBranch(firstHeight: number, bytes: Uint8Array): Promise<number> {
    await this.recoverReplacement()
    if (!this.consensus) throw new Error('Header difficulty context unavailable')
    if (bytes.length === 0 || bytes.length % HEADER_BYTES !== 0) throw new Error('Invalid replacement header bytes')
    const forkHeight = firstHeight - 1
    const candidate = this.consensus.forkAt(forkHeight)
    const replacementRoots = new Uint8Array((bytes.length / HEADER_BYTES) * ROOT_BYTES)
    for (let offset = 0; offset < bytes.length; offset += HEADER_BYTES) {
      const i = offset / HEADER_BYTES
      if (i > 0 && i % this.yieldEvery === 0) await yieldToEventLoop()
      const parsed = candidate.append(bytes.subarray(offset, offset + HEADER_BYTES), firstHeight + i)
      replacementRoots.set(new Uint8Array(Utils.toArray(parsed.merkleRoot, 'hex')), i * ROOT_BYTES)
    }
    if (candidate.chainWork <= this.consensus.chainWork)
      throw new Error('Replacement header branch does not have greater accumulated work')
    const old = await this.fs.readBytes(this.binPath)
    const keep = (forkHeight - this.anchor.height) * HEADER_BYTES
    if (this.headerCount > 0 && (!old || old.length < this.headerCount * HEADER_BYTES))
      throw new Error('Stored header prefix unavailable')
    const combined = new Uint8Array(keep + bytes.length)
    if (keep > 0) combined.set(old!.subarray(0, keep))
    combined.set(bytes, keep)
    const roots = new Uint8Array((keep / HEADER_BYTES) * ROOT_BYTES + replacementRoots.length)
    roots.set(this.roots.subarray(0, (keep / HEADER_BYTES) * ROOT_BYTES))
    roots.set(replacementRoots, (keep / HEADER_BYTES) * ROOT_BYTES)
    // Preserve the complete old pair before overwriting either live file. The
    // marker is published last and removed only after both new files exist.
    // An orphan snapshot is harmless and is reused by the next replacement.
    const journalPath = `${this.chain}-replace.json`
    await this.fs.writeBytes(
      `${this.chain}-replace.bin`,
      old?.subarray(0, this.headerCount * HEADER_BYTES) ?? new Uint8Array(0)
    )
    this.recoveryRequired = true
    try {
      await this.fs.writeText(journalPath, JSON.stringify(this.storedMeta()))
      await this.fs.writeBytes(this.binPath, combined)
      await this.fs.writeText(
        this.metaPath,
        JSON.stringify({
          ...this.storedMeta(),
          count: combined.length / HEADER_BYTES,
          tipHash: candidate.tipHash
        })
      )
      try {
        await this.fs.deleteFile(journalPath)
      } catch (error) {
        // A filesystem may report failure after the commit delete completed.
        let marker: string | undefined
        try {
          marker = await this.fs.readText(journalPath)
        } catch {
          // Neither branch can be published in memory while the commit result
          // is unknown. A fresh open will recover or validate the disk pair.
          this.reopenRequired = true
          throw error
        }
        if (marker !== undefined) throw error
      }
    } catch (error) {
      // Keep the in-memory old chain until commit. If rollback also fails,
      // every later window mutation retries it before touching live files.
      await this.recoverReplacement()
      throw error
    }
    this.recoveryRequired = false
    this.roots = roots
    this.headerCount = combined.length / HEADER_BYTES
    this.consensus = candidate
    this.currentTipHash = candidate.tipHash
    return bytes.length / HEADER_BYTES
  }

  private async recoverReplacement(): Promise<void> {
    if (this.reopenRequired) throw new Error('Header replacement commit uncertain; reopen store')
    if (!this.recoveryRequired) return
    await HeaderStore.recoverReplacement(this.fs, this.chain)
    this.recoveryRequired = false
  }

  private static async recoverReplacement(fs: HeaderFs, chain: string): Promise<void> {
    const journalPath = `${chain}-replace.json`
    const raw = await fs.readText(journalPath)
    if (raw === undefined) return
    let meta: StoredMeta
    try {
      meta = JSON.parse(raw) as StoredMeta
    } catch {
      // Torn marker publication precedes all live-file writes. The previous
      // pair is still intact; an empty marker is also an interrupted write.
      await fs.deleteFile(journalPath)
      return
    }
    const snapshot = await fs.readBytes(`${chain}-replace.bin`)
    if (!snapshot || snapshot.length !== meta.count * HEADER_BYTES)
      throw new Error('Header replacement undo snapshot unavailable')
    await fs.writeBytes(`${chain}.bin`, snapshot)
    await fs.writeText(`${chain}.json`, raw)
    await fs.deleteFile(journalPath)
    // open() subsequently applies checkpoint/context checks and validates all
    // restored headers. Recovery metadata does not authenticate their roots.
  }

  async putExtraRoot(height: number, root: string): Promise<void> {
    if (this.inReorgWindow(height)) return
    if (this.extra[String(height)] === root) return
    this.extra = { ...this.extra, [String(height)]: root }
    await this.fs.writeText(this.extraPath, JSON.stringify(this.extra))
  }

  /**
   * Batch form of `putExtraRoot`. Merges every entry into the in-memory
   * `extra` map and writes the JSON file once, rather than once per entry —
   * `putExtraRoot` re-serializes and rewrites the whole file on every call,
   * so seeding it row-by-row from a proven_txs table is O(n) file writes for
   * n rows. Callers that resolve one miss at a time (OfflineFirstChaintracks)
   * should keep using `putExtraRoot`; callers seeding many roots at once
   * (prewarmOwnRoots) should use this instead. Returns how many entries were
   * newly added (i.e. not already present in the store with the same root).
   */
  async putExtraRoots(entries: { height: number; root: string }[]): Promise<number> {
    if (entries.length === 0) return 0
    const merged = { ...this.extra }
    let added = 0
    for (const { height, root } of entries) {
      if (this.inReorgWindow(height)) continue
      const key = String(height)
      if (merged[key] === root) continue
      merged[key] = root
      added++
    }
    if (added === 0) return 0
    this.extra = merged
    await this.fs.writeText(this.extraPath, JSON.stringify(this.extra))
    return added
  }

  /**
   * Throws away the stored window and records an empty one.
   *
   * The `.bin` is DELETED, not merely forgotten. `HeaderFs.appendBytes` appends,
   * so leaving the old bytes on disk puts them in front of whatever the next sync
   * writes: `meta.count` then counts only the new headers while `open()` rebuilds
   * the root index from the FIRST `count * 80` bytes — the discarded anchor's —
   * and every height in the window is served the wrong merkle root. The
   * `bin.length < count * HEADER_BYTES` guard cannot catch that, because the file
   * is too long rather than too short, and nothing else notices. After a single
   * checkpoint bump every upgrading install would refuse every offline payment,
   * for good. Safe in direction — a root that does not match returns false, it
   * never accepts a forgery — but silent and permanent, which is why the delete
   * has to happen here rather than being left to a future rotation.
   *
   * A delete that genuinely fails is left to throw. `open()`'s caller treats an
   * unavailable header store as "no offline verification this launch" and tries
   * again on the next one, which self-heals; serving wrong roots would not.
   *
   * `<chain>-extra.json` is deliberately kept: those entries are height ->
   * merkle root facts, true whichever checkpoint the window happens to be
   * anchored to, and re-earning them costs a full prewarm over `proven_txs`.
   *
   * Public so a sync that cannot rewind onto the remote chain (cap 144) can
   * start over from the checkpoint.
   */
  async reset(): Promise<void> {
    await this.recoverReplacement()
    await this.fs.deleteFile(this.binPath)
    this.roots = new Uint8Array(0)
    this.headerCount = 0
    this.currentTipHash = this.anchor.hash
    this.consensus = this.consensus?.forkAt(this.anchor.height)
    await this.writeMeta()
  }

  /** Last 6 stored heights can reorg; an extra root there would hide the window. */
  private inReorgWindow(height: number): boolean {
    return height <= this.tipHeight && height > this.tipHeight - 6
  }

  private async writeMeta(): Promise<void> {
    await this.fs.writeText(this.metaPath, JSON.stringify(this.storedMeta()))
  }

  private storedMeta(): StoredMeta {
    return {
      chain: this.chain,
      anchorHeight: this.anchor.height,
      anchorHash: this.anchor.hash,
      count: this.headerCount,
      tipHash: this.currentTipHash
    }
  }
}

/** One macrotask turn, so timers, touches and native callbacks get a slice. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
