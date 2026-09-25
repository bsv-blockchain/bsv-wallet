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
import {
  parseJsonRpc,
  stringifyJsonRpc
} from '@bsv/wallet-toolbox-mobile'
import { BACKUP_PROTOCOL, backupKeyId, type BackupChain } from './constants'
import type { SyncChunk } from '../toolboxTypes'

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

/**
 * Cheap lower bound on how many extra bytes an appData snapshot adds to an encoded chunk.
 *
 * Mirrors estimateEncodedBytes' own "must run before encoding" purpose: pushOnce's oversize
 * gate checks the CHUNK alone today, but appData rides in the same envelope (see
 * encodeChunk), so a large pending/outbox queue must count too or a doomed payload could
 * still slip past the gate it exists to short-circuit. appData's strings are already
 * serialised JSON (see backup/appData.ts), so — unlike packBytes' byte-array packing — there
 * is no cheaper encoding to model here: this is a plain length sum, which is exact for
 * strings and an underestimate only in the same way estimateEncodedBytes' own walk is (JSON
 * quoting/escaping is ignored).
 */
export function estimateAppDataBytes (appData: AppDataSnapshot | undefined): number {
  if (appData == null) return 0
  let bytes = (appData.localpayPending?.length ?? 0) + (appData.peerpayOutbox?.length ?? 0)
  for (const d of appData.receiveIssuedDates ?? []) bytes += d.length
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
 * A seal's own payload: the generation it vouches for, and how many chunks made up that
 * generation's initial snapshot — the count the reader needs to see before it can call the
 * generation whole. Carried as an extra field on an ORDINARY chunk envelope (see
 * encodeChunk), never as a separate log entry: an old build's decodeChunk ignores a field it
 * has never heard of, so a chunk carrying a seal is byte-for-byte a chunk to any reader that
 * predates sealing.
 */
export interface BackupSeal {
  generation: number
  initialChunkCount: number
}

/**
 * App-owned recovery-critical state carried alongside a chunk, additively, the same way
 * `seal` is (see encodeChunk/decodeEntry below) — never a separate log entry, so an old
 * reader that predates this field decodes the envelope exactly as it always has.
 *
 * This type is deliberately generic: it is just what the envelope carries. What populates
 * and consumes it — reading/writing key_value_store, merging across devices — lives in
 * backup/appData.ts, which is the only module that needs to know these rows exist (XR-011,
 * XR-055). Every field is a plain string or string array — none of them needs `packBytes`'
 * treatment, because a payment/outbox queue's own (de)serialisers (localpay/pending.ts,
 * peerpay/outbox.ts) already write plain-JSON, byte-array-as-number[] text.
 */
export interface AppDataSnapshot {
  /** Verbatim value of key_value_store['localpay_pending'] at push time. */
  localpayPending?: string
  /** Verbatim value of key_value_store['peerpay_outbox'] at push time. */
  peerpayOutbox?: string
  /** Every YYYY-MM-DD a conventional-receive address has been issued for, deduplicated. */
  receiveIssuedDates?: string[]
}

/**
 * What a decrypted log entry turns out to be: always an ordinary chunk, optionally carrying
 * a seal and/or an appData snapshot alongside it. There is no other entry shape any writer
 * has ever appended — this type exists mainly so RemoteSyncReader can read `seal`/`appData`
 * off an entry without re-decoding it a second time.
 */
export type DecodedEntry = { kind: 'chunk', chunk: SyncChunk, seal?: BackupSeal, appData?: AppDataSnapshot }

/**
 * Serialise and encrypt a sync chunk, optionally sealing a generation in the same envelope.
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
 *
 * `seal` (and, likewise, `appData` — XR-011) is folded into the SAME `{chain, chunk}`
 * envelope as an optional extra field, rather than appended as a separate log entry. A
 * dedicated marker entry is unsafe for a reader that predates it: an all-empty chunk trips
 * the toolbox's own done sentinel, and any OTHER shape crashes an old decodeChunk outright
 * (see push.ts's own module docstring for the incident this replaced). `JSON.stringify`
 * drops an `undefined` property, so a chunk with nothing new to carry in either field
 * serialises to the exact old-format envelope, byte for byte. `appData` deliberately never
 * rides on its own, entity-less chunk either: pushOnce only calls this once it already has a
 * genuinely non-empty chunk to send, because the toolbox's own `processSyncChunk` treats
 * EVERY entity array being empty as its completion sentinel regardless of position in the
 * log (see push.ts's own docs) — an intentionally-empty-of-entities appended entry would
 * make a live restore stop early and silently drop whatever was appended after it.
 */
export async function encodeChunk (
  wallet: CompletedProtoWallet,
  chunk: SyncChunk,
  chain: BackupChain,
  seal?: BackupSeal,
  appData?: AppDataSnapshot
): Promise<number[]> {
  const json = stringifyJsonRpc({ chain, chunk: packBytes(chunk), seal, appData }, true)
  const { ciphertext } = await wallet.encrypt({
    plaintext: Utils.toArray(json, 'utf8'),
    protocolID: BACKUP_PROTOCOL,
    keyID: backupKeyId(chain),
    counterparty: 'self'
  })
  return ciphertext
}

/**
 * Decrypt a log entry, returning its chunk and — when present — the seal and/or appData
 * riding alongside it. Throws if the ciphertext was not written by this key, if the
 * decrypted payload's chain label disagrees with the chain being restored, or if a present
 * `seal`/`appData` field is malformed.
 *
 * Old-format ciphertext — written before sealing/appData existed, with no such field at all
 * — decodes unchanged: `envelope.seal`/`envelope.appData` is `undefined`, so each is omitted
 * from the result exactly as it always was.
 */
export async function decodeEntry (
  wallet: CompletedProtoWallet,
  ciphertext: number[],
  chain: BackupChain
): Promise<DecodedEntry> {
  const { plaintext } = await wallet.decrypt({
    ciphertext,
    protocolID: BACKUP_PROTOCOL,
    keyID: backupKeyId(chain),
    counterparty: 'self'
  })
  const envelope = parseJsonRpc(Utils.toUTF8(plaintext), true) as {
    chain?: unknown
    chunk?: unknown
    seal?: unknown
    appData?: unknown
  }
  if (envelope?.chain !== chain) {
    throw new Error(
      `backup blob is labeled for chain '${String(envelope?.chain)}' but '${chain}' was expected — refusing to restore across networks`
    )
  }
  let seal: BackupSeal | undefined
  if (envelope.seal != null) {
    const s = envelope.seal as { generation?: unknown, initialChunkCount?: unknown }
    if (typeof s.generation !== 'number' || typeof s.initialChunkCount !== 'number') {
      throw new Error('backup seal is malformed')
    }
    seal = { generation: s.generation, initialChunkCount: s.initialChunkCount }
  }
  const appData = decodeAppData(envelope.appData)
  return { kind: 'chunk', chunk: unpackBytes(envelope.chunk) as SyncChunk, seal, appData }
}

/** Validates a decrypted envelope's `appData` field. Throws rather than silently dropping a
 * malformed field: an app-owned recovery row that failed to decode as claimed must stop the
 * restore, not quietly disappear (same failure posture as a malformed seal, above). */
function decodeAppData (raw: unknown): AppDataSnapshot | undefined {
  if (raw == null) return undefined
  const a = raw as { localpayPending?: unknown, peerpayOutbox?: unknown, receiveIssuedDates?: unknown }
  if (a.localpayPending !== undefined && typeof a.localpayPending !== 'string') {
    throw new Error('backup appData.localpayPending is malformed')
  }
  if (a.peerpayOutbox !== undefined && typeof a.peerpayOutbox !== 'string') {
    throw new Error('backup appData.peerpayOutbox is malformed')
  }
  if (
    a.receiveIssuedDates !== undefined &&
    (!Array.isArray(a.receiveIssuedDates) || !a.receiveIssuedDates.every(d => typeof d === 'string'))
  ) {
    throw new Error('backup appData.receiveIssuedDates is malformed')
  }
  return {
    localpayPending: a.localpayPending as string | undefined,
    peerpayOutbox: a.peerpayOutbox as string | undefined,
    receiveIssuedDates: a.receiveIssuedDates as string[] | undefined
  }
}

/**
 * Decrypt and parse a sync chunk. Throws if the ciphertext was not written by this key, or
 * if the decrypted payload's chain label disagrees with the chain being restored.
 *
 * Kept as a thin wrapper over decodeEntry — RemoteSyncReader now calls decodeEntry directly
 * so it can also read a chunk's seal, but this stays exported with its original signature
 * and behaviour so existing callers (and the codec round-trip tests) are unaffected.
 */
export async function decodeChunk (
  wallet: CompletedProtoWallet,
  ciphertext: number[],
  chain: BackupChain
): Promise<SyncChunk> {
  const decoded = await decodeEntry(wallet, ciphertext, chain)
  return decoded.chunk
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
