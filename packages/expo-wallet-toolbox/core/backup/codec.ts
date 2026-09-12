/**
 * Encrypted chunk codec.
 *
 * Sync chunks are dominated by raw transaction bytes — TableProvenTx.rawTx,
 * TableProvenTxReq.rawTx/inputBEEF, TableTransaction.rawTx/inputBEEF, merklePath — all
 * typed `number[]`. A naive JSON.stringify renders each byte as up to four characters.
 *
 * The toolbox's own binary-aware serialiser is used, but on its own it does NOT help here:
 * `binaryJsonReplacer` base64-encodes `Uint8Array` only, and the toolbox's own tables use
 * `number[]`, so those fields would pass straight through as decimal arrays. Hence the
 * packing pass below, which converts byte-valued arrays to `Uint8Array` first so the
 * serialiser can compact them, and converts them back on the way in.
 *
 * The server stores opaque bytes and never parses a payload, so this format is a purely
 * client-internal choice with no interop constraint.
 */
import type { CompletedProtoWallet } from '@bsv/sdk'
import { Utils } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import {
  parseJsonRpc,
  stringifyJsonRpc
} from '@bsv/wallet-toolbox-mobile/out/src/storage/remoting/BinaryJson'
import { BACKUP_PROTOCOL, backupKeyId, type BackupChain } from './constants'

/**
 * Minimum length before a numeric array is worth packing as bytes.
 *
 * Below this the base64 envelope costs more than it saves, and short numeric arrays are
 * usually ids rather than payloads.
 */
const PACK_MIN_LENGTH = 32

/**
 * Repack byte-valued numeric arrays as Uint8Array so the binary serialiser can base64 them.
 *
 * `binaryJsonReplacer` only base64-encodes `Uint8Array`, but every binary field on the
 * toolbox's tables — rawTx, inputBEEF, merklePath — is typed `number[]`, so without this
 * they serialise as decimal arrays at roughly four characters per byte. Packing first turns
 * that into base64 at about 1.37, which is a threefold saving on a payload that is mostly
 * transaction bytes and is pushed repeatedly over mobile data.
 *
 * The transform is lossless in both directions because `unpackBytes` converts every
 * Uint8Array back to `number[]`. An array that merely looked byte-like — small integer ids,
 * say — round-trips to exactly the values it started with.
 */
function packBytes (value: unknown): unknown {
  if (Array.isArray(value)) {
    const isByteArray =
      value.length >= PACK_MIN_LENGTH &&
      value.every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
    if (isByteArray) return new Uint8Array(value as number[])
    return value.map(packBytes)
  }
  if (value != null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = packBytes(v)
    return out
  }
  return value
}

/**
 * Cheap lower bound on a chunk's encoded size, in bytes.
 *
 * Walks the chunk applying packBytes' own byte-array rule and sums what those arrays cost
 * once base64-encoded, plus every string's own length — with the blob columns compressed at
 * rest, the remaining way a single record goes oversize is a string (a pre-scrub
 * proven_tx_reqs.history carrying megabytes of EF hex in error notes). Everything else —
 * keys, timestamps, numbers — is ignored, so the answer is an UNDERESTIMATE: a chunk this
 * says is too big definitely is.
 *
 * Exists to be run BEFORE encodeChunk. Encrypting and then BRC-31-signing an oversized
 * payload blocked the JS thread for ~50s per attempt on device; the point is to never do
 * that work, not merely to avoid the failed upload at the end of it.
 */
export function estimateEncodedBytes (chunk: SyncChunk): number {
  let bytes = 0
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      // JSON adds quotes and escapes, so the raw length stays a lower bound.
      bytes += value.length
      return
    }
    if (Array.isArray(value)) {
      const isByteArray =
        value.length >= PACK_MIN_LENGTH &&
        value.every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
      // base64 is 4 characters per 3 bytes.
      if (isByteArray) bytes += Math.ceil(value.length / 3) * 4
      else value.forEach(walk)
      return
    }
    if (value != null && typeof value === 'object' && !(value instanceof Date)) {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v)
    }
  }
  walk(chunk)
  return bytes
}

/** The table columns the toolbox types as Date. BinaryJson has no Date support:
 * encode writes them as ISO strings, so decode must revive them — the merge
 * entities call `.getTime()`/date arithmetic on them directly
 * (EntityProvenTxReq.mergeExisting was the first to crash on a string). */
const DATE_KEYS = new Set(['created_at', 'updated_at'])

/** Inverse of packBytes: every Uint8Array becomes the `number[]` the toolbox
 * expects, and date columns come back as Date instances. */
function unpackBytes (value: unknown, key?: string): unknown {
  if (value instanceof Uint8Array) return Array.from(value)
  if (typeof value === 'string' && key != null && DATE_KEYS.has(key)) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d
  }
  if (Array.isArray(value)) return value.map(v => unpackBytes(v))
  if (value != null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = unpackBytes(v, k)
    return out
  }
  return value
}

/**
 * Serialise and encrypt a sync chunk.
 *
 * `counterparty: 'self'` is the entire zero-knowledge property. With 'self' the symmetric
 * key comes from the wallet's own key material and nobody else can derive it; naming the
 * server as counterparty instead would let the server decrypt via ECDH. One enum value
 * decides it.
 *
 * The chain enters twice, deliberately. The keyID folds it into the encryption key, so a
 * blob written on one network cannot decrypt on another at all. The plaintext also carries
 * a `chain` label, which decodeChunk asserts — belt and braces so that even a future
 * derivation mistake that collapsed the keys back together could not cross-restore.
 */
export async function encodeChunk (
  wallet: CompletedProtoWallet,
  chunk: SyncChunk,
  chain: BackupChain
): Promise<number[]> {
  // Keep the established sync-chunk wire format. Completion markers need a
  // separately negotiated/versioned log epoch before they can be appended;
  // changing every ordinary ciphertext here would make existing backups and
  // older clients mutually unreadable.
  const json = stringifyJsonRpc({ chain, chunk: packBytes(chunk) }, true)
  const { ciphertext } = await wallet.encrypt({
    plaintext: Utils.toArray(json, 'utf8'),
    protocolID: BACKUP_PROTOCOL,
    keyID: backupKeyId(chain),
    counterparty: 'self'
  })
  return ciphertext
}

/**
 * The authenticated end of one consistent backup window.
 *
 * The marker commits to the log entry immediately before it. The append-only
 * hash chain therefore commits transitively to the whole complete prefix, and
 * the device/generation fields prevent a valid marker from being transplanted
 * to a different log.
 */
export interface SnapshotCompleteMarker {
  deviceId: string
  generation: number
  dataHeadSeq: number
  dataHeadSha256?: string
}

export type DecodedBackupRecord =
  | { type: 'sync-chunk', chunk: SyncChunk }
  | { type: 'snapshot-complete', marker: SnapshotCompleteMarker }

type BackupRecordType = DecodedBackupRecord['type']

/**
 * Frame encrypted records so the opaque server's existing `size` metadata can
 * distinguish candidate completion records without learning their contents:
 * sync chunks always have even byte length and completion markers odd length.
 * A one-byte footer records whether a zero padding byte was added.
 */
function frameCiphertext (ciphertext: number[], type: BackupRecordType): number[] {
  const wantedParity = type === 'snapshot-complete' ? 1 : 0
  const padding = ((ciphertext.length + 1) & 1) === wantedParity ? 0 : 1
  return padding === 0 ? [...ciphertext, 0] : [...ciphertext, 0, 1]
}

function unframeCiphertext (record: readonly number[]): { ciphertext: number[], type: BackupRecordType } {
  if (record.length < 2) throw new Error('backup record has invalid framing')
  const padding = record[record.length - 1]
  if (padding !== 0 && padding !== 1) throw new Error('backup record has invalid padding')
  if (padding === 1 && record[record.length - 2] !== 0) throw new Error('backup record has invalid padding')
  const ciphertext = Array.from(record.slice(0, record.length - 1 - padding))
  if (ciphertext.length === 0) throw new Error('backup record has no ciphertext')
  return {
    ciphertext,
    type: (record.length & 1) === 1 ? 'snapshot-complete' : 'sync-chunk'
  }
}

function validMarker (value: unknown): value is SnapshotCompleteMarker {
  if (value == null || typeof value !== 'object') return false
  const marker = value as Partial<SnapshotCompleteMarker>
  return (
    typeof marker.deviceId === 'string' && /^[a-f0-9]{32}$/.test(marker.deviceId) &&
    Number.isSafeInteger(marker.generation) && (marker.generation ?? 0) > 0 &&
    Number.isSafeInteger(marker.dataHeadSeq) && (marker.dataHeadSeq ?? -1) >= 0 &&
    (marker.dataHeadSeq === 0
      ? marker.dataHeadSha256 == null
      : typeof marker.dataHeadSha256 === 'string' && /^[a-f0-9]{64}$/.test(marker.dataHeadSha256))
  )
}

/** Encrypt an authenticated snapshot-complete record for the current log head. */
export async function encodeSnapshotComplete (
  wallet: CompletedProtoWallet,
  marker: SnapshotCompleteMarker,
  chain: BackupChain
): Promise<number[]> {
  if (!validMarker(marker)) throw new Error('invalid backup snapshot-complete marker')
  const json = stringifyJsonRpc({ format: 1, chain, type: 'snapshot-complete', marker }, true)
  const { ciphertext } = await wallet.encrypt({
    plaintext: Utils.toArray(json, 'utf8'),
    protocolID: BACKUP_PROTOCOL,
    keyID: backupKeyId(chain),
    counterparty: 'self'
  })
  return frameCiphertext(ciphertext, 'snapshot-complete')
}

/** Odd framed lengths identify encrypted completion-marker candidates in an index. */
export function isSnapshotCompleteRecordSize (size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && (size & 1) === 1
}

/**
 * Decrypt and parse a sync chunk. Throws if the ciphertext was not written by this key,
 * or if the decrypted payload's chain label disagrees with the chain being restored.
 */
export async function decodeChunk (
  wallet: CompletedProtoWallet,
  ciphertext: number[],
  chain: BackupChain
): Promise<SyncChunk> {
  const { plaintext } = await wallet.decrypt({
    ciphertext,
    protocolID: BACKUP_PROTOCOL,
    keyID: backupKeyId(chain),
    counterparty: 'self'
  })
  const envelope = parseJsonRpc(Utils.toUTF8(plaintext), true) as { chain?: unknown, chunk?: unknown }
  if (envelope?.chain !== chain) {
    throw new Error(
      `backup blob is labeled for chain '${String(envelope?.chain)}' but '${chain}' was expected — refusing to restore across networks`
    )
  }
  return unpackBytes(envelope.chunk) as SyncChunk
}

/** Decrypt, authenticate and strictly parse either backup record kind. */
export async function decodeBackupRecord (
  wallet: CompletedProtoWallet,
  recordBytes: number[],
  chain: BackupChain
): Promise<DecodedBackupRecord> {
  let framed: { ciphertext: number[], type: BackupRecordType }
  let plaintext: number[]
  try {
    framed = unframeCiphertext(recordBytes)
    ;({ plaintext } = await wallet.decrypt({
      ciphertext: framed.ciphertext,
      protocolID: BACKUP_PROTOCOL,
      keyID: backupKeyId(chain),
      counterparty: 'self'
    }))
  } catch {
    // Compatibility read for the established unframed sync-chunk record. The
    // authenticated decrypt decides whether the bytes are really legacy; an
    // opaque last byte that resembles a footer is never trusted by itself.
    const legacy = await wallet.decrypt({
      ciphertext: recordBytes,
      protocolID: BACKUP_PROTOCOL,
      keyID: backupKeyId(chain),
      counterparty: 'self'
    })
    const envelope = parseJsonRpc(Utils.toUTF8(legacy.plaintext), true) as { chain?: unknown, chunk?: unknown }
    if (envelope?.chain !== chain) {
      throw new Error(
        `backup blob is labeled for chain '${String(envelope?.chain)}' but '${chain}' was expected — refusing to restore across networks`
      )
    }
    if (envelope.chunk == null || typeof envelope.chunk !== 'object') throw new Error('backup sync chunk is invalid')
    return { type: 'sync-chunk', chunk: unpackBytes(envelope.chunk) as SyncChunk }
  }
  const envelope = parseJsonRpc(Utils.toUTF8(plaintext), true) as {
    format?: unknown
    chain?: unknown
    type?: unknown
    chunk?: unknown
    marker?: unknown
  }
  if (envelope?.chain !== chain) {
    throw new Error(
      `backup blob is labeled for chain '${String(envelope?.chain)}' but '${chain}' was expected — refusing to restore across networks`
    )
  }
  if (envelope.format !== 1 || envelope.type !== framed.type) {
    throw new Error('backup record type or format is invalid')
  }
  if (envelope.type === 'snapshot-complete') {
    if (!validMarker(envelope.marker)) throw new Error('backup snapshot-complete marker is invalid')
    return { type: 'snapshot-complete', marker: envelope.marker }
  }
  if (envelope.type !== 'sync-chunk' || envelope.chunk == null || typeof envelope.chunk !== 'object') {
    throw new Error('backup sync chunk is invalid')
  }
  return { type: 'sync-chunk', chunk: unpackBytes(envelope.chunk) as SyncChunk }
}

/** The twelve entity arrays a SyncChunk carries, in the protocol's dependency order. */
export const CHUNK_ENTITIES = [
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'txLabels',
  'outputTags',
  'transactions',
  'txLabelMaps',
  'commissions',
  'outputs',
  'outputTagMaps',
  'certificates',
  'certificateFields'
] as const

/**
 * True when a chunk carries no records at all.
 *
 * The toolbox treats an all-empty chunk as the completion sentinel, so this doubles as
 * "nothing left to push" and "restore is finished".
 */
export function isEmptyChunk (chunk: SyncChunk): boolean {
  const c = chunk as unknown as Record<string, unknown[] | undefined>
  return CHUNK_ENTITIES.every(name => (c[name]?.length ?? 0) === 0)
}

/**
 * An all-empty chunk with every entity array present.
 *
 * All twelve must exist as arrays: the toolbox's consumer loops forever on an `undefined`
 * entity array rather than treating it as empty.
 */
export function emptyChunk (from: string, to: string, userIdentityKey: string): SyncChunk {
  const chunk: Record<string, unknown> = {
    fromStorageIdentityKey: from,
    toStorageIdentityKey: to,
    userIdentityKey
  }
  for (const name of CHUNK_ENTITIES) chunk[name] = []
  return chunk as unknown as SyncChunk
}
