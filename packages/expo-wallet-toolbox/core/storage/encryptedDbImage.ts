/**
 * Encrypted wallet database export format ("Export Wallet Data" with
 * `encrypt: true`).
 *
 * Envelope encryption: a fresh random 32-byte file key encrypts the database
 * image, and the wallet itself encrypts (wraps) that file key with BRC-2
 * `wallet.encrypt` under counterparty `self`. Only the wallet that exported a
 * file can open it again — the same rule import already enforces on the
 * plaintext image (its storageIdentityKey must match).
 *
 * The body is a STREAM-style chunked AES-256-GCM: every chunk is sealed on
 * its own with nonce `prefix(7) || u32 BE chunk index || last-flag(1)`, so
 * chunks can be encrypted, written and decrypted one at a time (memory stays
 * at one chunk, never the whole database), and any reordered, dropped,
 * duplicated or truncated chunk fails authentication. The header fields
 * (version, chunk size, nonce prefix) ride inside the wallet-encrypted blob
 * next to the file key, so they are authenticated by it rather than through
 * AAD.
 *
 * Wire layout:
 *
 *   magic "BSVWDBE1" (8) | u16 BE wrappedLen | wrapped (wrappedLen) | chunk*
 *   chunk = ciphertext (chunkSize, the last one 0..chunkSize) | GCM tag (16)
 *
 *   wrapped = wallet.encrypt( version(1) | u32 BE chunkSize | prefix(7) | fileKey(32) )
 *
 * AES runs in native code: react-native-quick-crypto's OpenSSL backend that
 * the host app installs as `globalThis.__bsvNativeCrypto` (Node's own crypto
 * under Jest). Without one, encryption refuses rather than crawl through a
 * pure-JS AES over a whole database.
 */
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'

export const ENCRYPTED_DB_MAGIC = [0x42, 0x53, 0x56, 0x57, 0x44, 0x42, 0x45, 0x31] // "BSVWDBE1"
export const ENCRYPTED_DB_EXTENSION = '.db.enc'
export const DB_EXPORT_PROTOCOL: WalletProtocol = [2, 'wallet db export']
export const DB_EXPORT_KEY_ID = '1'

const FORMAT_VERSION = 1
const DEFAULT_CHUNK_SIZE = 1024 * 1024
/** A decrypt never allocates more than this per chunk, whatever the header claims. */
const MAX_CHUNK_SIZE = 16 * 1024 * 1024
const TAG_LEN = 16
const KEY_LEN = 32
const PREFIX_LEN = 7
const HEADER_PLAIN_LEN = 1 + 4 + PREFIX_LEN + KEY_LEN
/** BRC-2 adds a 32-byte IV and a 16-byte tag; anything far outside that is not ours. */
const MAX_WRAPPED_LEN = 1024

export type EncryptedDbErrorCode = 'no-native-crypto' | 'not-encrypted' | 'wrong-wallet' | 'unsupported' | 'corrupt'

/** All the wallet this needs: a ProtoWallet or the permissions manager both fit. */
export type DbExportWallet = Pick<WalletInterface, 'encrypt' | 'decrypt'>

export class EncryptedDbError extends Error {
  constructor(
    readonly code: EncryptedDbErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'EncryptedDbError'
  }
}

/** Sequential reader over the input; `read` returns fewer bytes only at EOF. */
export interface ByteSource {
  readonly size: number
  read(length: number): Uint8Array
}

export interface ByteSink {
  write(bytes: Uint8Array): void
}

export interface EncryptedDbOptions {
  /** Origin the wallet call is made as — the admin originator, so it never prompts. */
  originator?: string
  /** Called after each chunk with the fraction done (0..1). */
  onProgress?: (fraction: number) => void
  /** Test seam; defaults to 1 MiB. */
  chunkSize?: number
}

interface GcmCipher {
  update(data: Uint8Array): ArrayBuffer | Uint8Array
  final(): ArrayBuffer | Uint8Array
  getAuthTag(): ArrayBuffer | Uint8Array
}
interface GcmDecipher {
  setAuthTag(tag: Uint8Array): void
  update(data: Uint8Array): ArrayBuffer | Uint8Array
  final(): ArrayBuffer | Uint8Array
}
interface NativeCrypto {
  createCipheriv(alg: 'aes-256-gcm', key: Uint8Array, iv: Uint8Array): GcmCipher
  createDecipheriv(alg: 'aes-256-gcm', key: Uint8Array, iv: Uint8Array): GcmDecipher
  randomBytes(n: number): ArrayBuffer | Uint8Array
}

/** Backends already seen to refuse a wrong GCM tag. */
const authenticating = new WeakSet<NativeCrypto>()

/**
 * Every integrity property of this format rests on `final()` throwing for a
 * wrong tag — which react-native-quick-crypto 0.7.17 did not do until this
 * repo patched it (patches/react-native-quick-crypto+0.7.17.patch). A host
 * app without that patch would accept a tampered file, so check once per
 * backend and refuse rather than trust it.
 */
function assertAuthenticates(backend: NativeCrypto): void {
  if (authenticating.has(backend)) return
  const key = toBuf(toU8(backend.randomBytes(KEY_LEN)))
  const iv = toBuf(toU8(backend.randomBytes(12)))
  const cipher = backend.createCipheriv('aes-256-gcm', key, iv)
  const body = toU8(cipher.update(toBuf(new Uint8Array(16))))
  cipher.final()
  const tag = Uint8Array.from(toU8(cipher.getAuthTag()))
  tag[0] ^= 1
  const decipher = backend.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(toBuf(tag))
  let refused = false
  try {
    decipher.update(toBuf(body))
    decipher.final()
  } catch {
    refused = true
  }
  if (!refused) {
    throw new EncryptedDbError('no-native-crypto', 'The crypto backend does not authenticate AES-GCM')
  }
  authenticating.add(backend)
}

function nativeCrypto(): NativeCrypto {
  const g = globalThis as {
    __bsvNativeCrypto?: NativeCrypto
    process?: { getBuiltinModule?: (id: string) => unknown }
  }
  const backend = g.__bsvNativeCrypto ?? (g.process?.getBuiltinModule?.('node:crypto') as NativeCrypto | undefined)
  if (!backend?.createCipheriv) {
    throw new EncryptedDbError(
      'no-native-crypto',
      'Encrypted export needs the native crypto backend (react-native-quick-crypto installed as globalThis.__bsvNativeCrypto)'
    )
  }
  assertAuthenticates(backend)
  return backend
}

/** quick-crypto hands back ArrayBuffers and wants Buffers in; Node wants Buffers too. */
function toU8(x: ArrayBuffer | Uint8Array): Uint8Array {
  return x instanceof Uint8Array ? x : new Uint8Array(x)
}
function toBuf(x: Uint8Array): Uint8Array {
  const B = (globalThis as { Buffer?: { from(b: ArrayBufferLike, o: number, l: number): Uint8Array } }).Buffer
  return B ? B.from(x.buffer, x.byteOffset, x.byteLength) : x
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function chunkNonce(prefix: Uint8Array, index: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12)
  n.set(prefix, 0)
  new DataView(n.buffer).setUint32(PREFIX_LEN, index, false)
  n[11] = last ? 1 : 0
  return n
}

/** Let the UI thread render between chunks: every crypto/file call here is synchronous JSI. */
const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** True when `head` (the first bytes of a file) starts with this format's magic. */
export function isEncryptedDbImage(head: Uint8Array): boolean {
  if (head.length < ENCRYPTED_DB_MAGIC.length) return false
  return ENCRYPTED_DB_MAGIC.every((b, i) => head[i] === b)
}

/** Stream `src` (a plaintext SQLite image) into `sink` as an encrypted export. */
export async function encryptDbImage(
  wallet: DbExportWallet,
  src: ByteSource,
  sink: ByteSink,
  opts: EncryptedDbOptions = {}
): Promise<void> {
  const crypto = nativeCrypto()
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  const fileKey = toU8(crypto.randomBytes(KEY_LEN))
  const prefix = toU8(crypto.randomBytes(PREFIX_LEN))

  const headerPlain = new Uint8Array(HEADER_PLAIN_LEN)
  const hv = new DataView(headerPlain.buffer)
  headerPlain[0] = FORMAT_VERSION
  hv.setUint32(1, chunkSize, false)
  headerPlain.set(prefix, 5)
  headerPlain.set(fileKey, 5 + PREFIX_LEN)

  const { ciphertext: wrapped } = await wallet.encrypt(
    {
      plaintext: Array.from(headerPlain),
      protocolID: DB_EXPORT_PROTOCOL,
      keyID: DB_EXPORT_KEY_ID,
      counterparty: 'self',
      seekPermission: false
    },
    opts.originator
  )
  headerPlain.fill(0)
  if (wrapped.length > MAX_WRAPPED_LEN) throw new EncryptedDbError('unsupported', 'Wrapped key unexpectedly large')

  const lead = new Uint8Array(ENCRYPTED_DB_MAGIC.length + 2)
  lead.set(ENCRYPTED_DB_MAGIC, 0)
  new DataView(lead.buffer).setUint16(ENCRYPTED_DB_MAGIC.length, wrapped.length, false)
  sink.write(lead)
  sink.write(Uint8Array.from(wrapped))

  // An empty input still gets one (empty, final) chunk, so a decrypt can tell
  // "nothing" apart from "cut off after the header".
  const total = src.size
  const chunks = Math.max(1, Math.ceil(total / chunkSize))
  const key = toBuf(fileKey)
  try {
    for (let i = 0; i < chunks; i++) {
      const last = i === chunks - 1
      const plain = src.read(last ? total - i * chunkSize : chunkSize)
      if (plain.length !== (last ? total - i * chunkSize : chunkSize)) {
        throw new EncryptedDbError('corrupt', 'Database changed size while it was being exported')
      }
      const cipher = crypto.createCipheriv('aes-256-gcm', key, toBuf(chunkNonce(prefix, i, last)))
      const body = toU8(cipher.update(toBuf(plain)))
      const tail = toU8(cipher.final())
      sink.write(tail.length ? concat([body, tail]) : body)
      sink.write(toU8(cipher.getAuthTag()))
      opts.onProgress?.((i + 1) / chunks)
      if (!last) await yieldToUi()
    }
  } finally {
    fileKey.fill(0)
  }
}

/**
 * Stream an encrypted export in `src` back into its plaintext SQLite image in
 * `sink`. Plaintext reaches the sink a chunk at a time, each one only after
 * its own tag verified; a failure part-way leaves a prefix in the sink, which
 * the caller must discard (it throws, it never returns a partial image).
 */
export async function decryptDbImage(
  wallet: DbExportWallet,
  src: ByteSource,
  sink: ByteSink,
  opts: EncryptedDbOptions = {}
): Promise<void> {
  const crypto = nativeCrypto()
  const leadLen = ENCRYPTED_DB_MAGIC.length + 2
  const lead = src.read(leadLen)
  if (lead.length < leadLen || !isEncryptedDbImage(lead)) {
    throw new EncryptedDbError('not-encrypted', 'Not an encrypted wallet database export')
  }
  const wrappedLen = new DataView(lead.buffer, lead.byteOffset).getUint16(ENCRYPTED_DB_MAGIC.length, false)
  if (wrappedLen === 0 || wrappedLen > MAX_WRAPPED_LEN) throw new EncryptedDbError('corrupt', 'Bad key header')
  const wrapped = src.read(wrappedLen)
  if (wrapped.length !== wrappedLen) throw new EncryptedDbError('corrupt', 'File is truncated')

  let headerPlain: Uint8Array
  try {
    const { plaintext } = await wallet.decrypt(
      {
        ciphertext: Array.from(wrapped),
        protocolID: DB_EXPORT_PROTOCOL,
        keyID: DB_EXPORT_KEY_ID,
        counterparty: 'self'
      },
      opts.originator
    )
    headerPlain = Uint8Array.from(plaintext)
  } catch {
    throw new EncryptedDbError('wrong-wallet', 'This export was made by a different wallet')
  }
  if (headerPlain.length !== HEADER_PLAIN_LEN || headerPlain[0] !== FORMAT_VERSION) {
    throw new EncryptedDbError('unsupported', 'Unsupported export format version')
  }
  const chunkSize = new DataView(headerPlain.buffer).getUint32(1, false)
  if (chunkSize === 0 || chunkSize > MAX_CHUNK_SIZE) throw new EncryptedDbError('corrupt', 'Bad chunk size')
  const prefix = headerPlain.slice(5, 5 + PREFIX_LEN)
  const key = toBuf(headerPlain.slice(5 + PREFIX_LEN))
  headerPlain.fill(0)

  let remaining = src.size - leadLen - wrappedLen
  const bodyTotal = remaining
  try {
    for (let i = 0; ; i++) {
      const sealedLen = Math.min(chunkSize + TAG_LEN, remaining)
      if (sealedLen < TAG_LEN) throw new EncryptedDbError('corrupt', 'File is truncated')
      const last = sealedLen === remaining
      const sealed = src.read(sealedLen)
      if (sealed.length !== sealedLen) throw new EncryptedDbError('corrupt', 'File is truncated')
      remaining -= sealedLen

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, toBuf(chunkNonce(prefix, i, last)))
      decipher.setAuthTag(toBuf(sealed.subarray(sealedLen - TAG_LEN)))
      let plain: Uint8Array
      try {
        const body = toU8(decipher.update(toBuf(sealed.subarray(0, sealedLen - TAG_LEN))))
        const tail = toU8(decipher.final())
        plain = tail.length ? concat([body, tail]) : body
      } catch {
        throw new EncryptedDbError('corrupt', 'File is damaged or was modified')
      }
      sink.write(plain)
      opts.onProgress?.(bodyTotal ? (bodyTotal - remaining) / bodyTotal : 1)
      if (last) break
      await yieldToUi()
    }
  } finally {
    key.fill(0)
  }
}
