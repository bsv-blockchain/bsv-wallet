/**
 * Header consensus, not transaction/script validation. Difficulty and median3
 * ordering follow BSV Node src/pow.cpp / src/validation.cpp:
 * https://github.com/bitcoin-sv/bitcoin-sv/blob/master/src/pow.cpp
 * TTN bootstrap rules follow Teranode services/blockchain/Difficulty.go and
 * network parameters follow bsv-blockchain/go-chaincfg/params.go.
 * Main/test anchors are post-CW144. Earlier headers are only used when their
 * complete linkage commits to a trusted checkpoint, never as new extensions.
 */
import { Hash, Utils } from '@bsv/sdk'
import type { HeaderCheckpoint } from './checkpoints'
import type { WalletChain } from '../networks'

const TWO_256 = 1n << 256n
const MASK_256 = TWO_256 - 1n
const MAIN_LIMIT = (1n << 224n) - 1n
const SPACING = 600
export const HEADER_CONTEXT_COUNT = 147

export interface WorkHeader {
  height: number
  time: number
  bits: number
  work: bigint
}

export interface ParsedHeader {
  version: number
  previousHash: string
  merkleRoot: string
  time: number
  bits: number
  nonce: number
  hash: string
}

type HistoryHeader = WorkHeader & { hash: string }

function parameters(chain: WalletChain) {
  switch (chain) {
    case 'main':
      return { limit: MAIN_LIMIT, minDifficulty: false, daaHeight: 504031, versions: [227931, 363725, 388381] }
    case 'test':
      return { limit: MAIN_LIMIT, minDifficulty: true, daaHeight: 1188697, versions: [21111, 330776, 581885] }
    case 'ttn':
      return { limit: MAIN_LIMIT, minDifficulty: true, daaHeight: 0, versions: [0, 0, 0] }
    case 'regtest':
      return { limit: (1n << 255n) - 1n, minDifficulty: true, daaHeight: 0, versions: [100000000, 1251, 1351] }
    default:
      throw new Error(`Unsupported header consensus network: ${String(chain)}`)
  }
}

/** Bitcoin SetCompact's sign/zero/overflow checks, before any shifting. */
export function bitsToTarget(bits: number): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) throw new Error('Invalid compact target')
  const size = bits >>> 24
  const word = bits & 0x007fffff
  if (!word || (bits & 0x00800000) !== 0 || size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32))
    throw new Error('Invalid compact target')
  const value = size <= 3 ? BigInt(word) >> BigInt(8 * (3 - size)) : BigInt(word) << BigInt(8 * (size - 3))
  if (value === 0n || value > MASK_256) throw new Error('Invalid compact target')
  return value
}

/** Bitcoin GetCompact, with its sign-bit carry and integer truncation. */
export function targetToBits(target: bigint): number {
  if (target <= 0n || target > MASK_256) throw new Error('Invalid target')
  let size = Math.ceil(target.toString(16).length / 2)
  let word = Number(size <= 3 ? target << BigInt(8 * (3 - size)) : target >> BigInt(8 * (size - 3)))
  if ((word & 0x00800000) !== 0) {
    word >>>= 8
    size++
  }
  return ((size << 24) | word) >>> 0
}

export function headerWork(bits: number): bigint {
  return TWO_256 / (bitsToTarget(bits) + 1n)
}

function suitable(history: readonly WorkHeader[], at: number): WorkHeader {
  if (at < 2 || !history[at]) throw new Error('Header difficulty context unavailable')
  // Preserve the node's exact sorting network, including equal timestamps.
  const blocks = [history[at - 2], history[at - 1], history[at]]
  if (blocks[0].time > blocks[2].time) [blocks[0], blocks[2]] = [blocks[2], blocks[0]]
  if (blocks[0].time > blocks[1].time) [blocks[0], blocks[1]] = [blocks[1], blocks[0]]
  if (blocks[1].time > blocks[2].time) [blocks[1], blocks[2]] = [blocks[2], blocks[1]]
  return blocks[1]
}

/** Expected bits from already authenticated history; no peer difficulty/work claims. */
export function nextWorkRequired(chain: WalletChain, history: readonly WorkHeader[], nextTime: number): number {
  const params = parameters(chain)
  const previous = history[history.length - 1]
  if (!previous) throw new Error('Header difficulty context unavailable')
  if (chain === 'regtest') return previous.bits
  if (params.minDifficulty && nextTime > previous.time + 2 * SPACING) return 0x1d00ffff
  // TTN activates DAA at genesis; its actual node keeps the start difficulty
  // until there are enough headers (previous height148 is the first DAA case).
  if (chain === 'ttn' && previous.height < 148) return 0x1d00ffff
  if (previous.height < params.daaHeight)
    throw new Error('Historical fork difficulty context is not supported by this checkpoint')
  const last = suitable(history, history.length - 1)
  const first = suitable(history, history.length - 1 - 144)
  const span = Math.max(72 * SPACING, Math.min(288 * SPACING, last.time - first.time))
  let work = ((last.work - first.work) * BigInt(SPACING)) & MASK_256
  work /= BigInt(span)
  if (work <= 0n) throw new Error('Invalid header work context')
  // Node ComputeTarget uses uint256 two's-complement negation, not a rounded
  // floating point inverse or (2^256/work)-1.
  const target = (TWO_256 - work) / work
  return targetToBits(target > params.limit ? params.limit : target)
}

export function parseHeader(bytes: Uint8Array): ParsedHeader {
  if (bytes.length !== 80) throw new Error('Header must contain exactly 80 bytes')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const hex = (from: number, to: number) => Utils.toHex(Array.from(bytes.slice(from, to).reverse()))
  return {
    version: view.getUint32(0, true),
    previousHash: hex(4, 36),
    merkleRoot: hex(36, 68),
    time: view.getUint32(68, true),
    bits: view.getUint32(72, true),
    nonce: view.getUint32(76, true),
    hash: Utils.toHex(Hash.hash256(Array.from(bytes)).reverse())
  }
}

function proofOfWork(header: ParsedHeader, chain: WalletChain): void {
  const target = bitsToTarget(header.bits)
  if (target > parameters(chain).limit || BigInt(`0x${header.hash}`) > target)
    throw new Error('Header proof of work failed')
}

export class HeaderConsensus {
  private constructor(
    readonly chain: WalletChain,
    readonly anchor: HeaderCheckpoint,
    private history: HistoryHeader[],
    private readonly now: () => number
  ) {}

  static contextStart(anchor: HeaderCheckpoint): number {
    return Math.max(0, anchor.height - HEADER_CONTEXT_COUNT + 1)
  }

  /** Authenticate ancestors backwards by their terminal pinned checkpoint hash. */
  static fromContext(
    chain: WalletChain,
    anchor: HeaderCheckpoint,
    bytes: Uint8Array,
    now: () => number = () => Math.floor(Date.now() / 1000)
  ): HeaderConsensus {
    const params = parameters(chain)
    if ((chain === 'main' || chain === 'test') && anchor.height < params.daaHeight) {
      throw new Error('A post-DAA trusted checkpoint is required for forward header validation')
    }
    const from = HeaderConsensus.contextStart(anchor)
    if (bytes.length !== (anchor.height - from + 1) * 80)
      throw new Error('Header bootstrap context has the wrong length')
    const history: HistoryHeader[] = []
    let work = 0n
    for (let offset = 0; offset < bytes.length; offset += 80) {
      const header = parseHeader(bytes.subarray(offset, offset + 80))
      proofOfWork(header, chain)
      if (history.length && header.previousHash !== history[history.length - 1].hash)
        throw new Error('Header context linkage failed')
      work += headerWork(header.bits)
      history.push({ height: from + history.length, time: header.time, bits: header.bits, hash: header.hash, work })
    }
    if (history[history.length - 1]?.hash !== anchor.hash)
      throw new Error('Header context does not commit to the trusted checkpoint')
    return new HeaderConsensus(chain, anchor, history, now)
  }

  get tipHeight(): number {
    return this.history[this.history.length - 1].height
  }
  get tipHash(): string {
    return this.history[this.history.length - 1].hash
  }
  get chainWork(): bigint {
    return this.history[this.history.length - 1].work
  }

  hashForHeight(height: number): string | undefined {
    return this.history[height - this.history[0].height]?.hash
  }

  forkAt(height: number): HeaderConsensus {
    if (height < this.anchor.height || height > this.tipHeight || !Number.isInteger(height))
      throw new Error('Header fork is outside authenticated history')
    return new HeaderConsensus(
      this.chain,
      this.anchor,
      this.history.slice(0, height - this.history[0].height + 1),
      this.now
    )
  }

  /** All checks finish before the history is mutated. */
  append(bytes: Uint8Array, height: number): ParsedHeader {
    if (height !== this.tipHeight + 1) throw new Error(`Unexpected header height ${height}`)
    const header = parseHeader(bytes)
    if (header.previousHash !== this.tipHash)
      throw new Error(`header at height ${height} names previous hash ${header.previousHash}, expected ${this.tipHash}`)
    const expected = nextWorkRequired(this.chain, this.history, header.time)
    if (header.bits !== expected)
      throw new Error(`Header difficulty mismatch at height ${height}: ${header.bits} expected ${expected}`)
    const times = this.history
      .slice(-11)
      .map(h => h.time)
      .sort((a, b) => a - b)
    if (header.time <= times[Math.floor(times.length / 2)])
      throw new Error(`Header time is not after median time past at height ${height}`)
    if (header.time > this.now() + 2 * 60 * 60)
      throw new Error(`Header time is too far in the future at height ${height}`)
    const version = header.version | 0
    const heights = parameters(this.chain).versions
    if (heights.some((activation, i) => height >= activation && version < i + 2))
      throw new Error(`Obsolete header version at height ${height}`)
    proofOfWork(header, this.chain)
    const work = this.chainWork + headerWork(header.bits)
    if (work > MASK_256) throw new Error('Header chain work overflow')
    this.history.push({ height, time: header.time, bits: header.bits, work, hash: header.hash })
    return header
  }
}
