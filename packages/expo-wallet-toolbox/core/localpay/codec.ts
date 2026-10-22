import { SymmetricKey } from '@bsv/sdk'

/**
 * 6: the token block is a BRC-207 carrier (IC §7.3) — `assetId`, the opaque
 * certificates, and `profileData`, the UTF-8 JSON of the §7.1 receipt's
 * `profileData` object. The issuer overlay url/key, the per-txid linkage and
 * the σI admissions of v5 are gone: the payee uses its own configured overlay
 * and builds the §7.1 receipt from these fields. A v5 or older frame is
 * refused outright; there is no back-compat.
 */
export const FRAME_VERSION = 6

export class CodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecError'
  }
}

export type FrameKind = 'bsv' | 'token'

/** BRC-207 custom-instructions ceiling for the attested profile (IC §7.1): 16 MiB. */
export const MAX_PROFILE_DATA_BYTES = 16_777_216

/** Asset ids are `<64 lowercase hex>_0` (IC §0, Mandala policy). */
const ASSET_ID_RE = /^[0-9a-f]{64}_0$/

export interface TokenPayment {
  /** `<64 lowercase hex>_0` — the underscore id form, never the dot outpoint form. */
  assetId: string
  /** Opaque serialized VerifiableCertificates. */
  certificates: Uint8Array[]
  /**
   * UTF-8 JSON text of the §7.1 receipt's `profileData` object, carried
   * verbatim. The codec checks only that it is a JSON object within
   * `MAX_PROFILE_DATA_BYTES`; the payee's module verifies the evidence.
   */
  profileData: string
}

export interface PaymentFrame {
  version: number
  kind: FrameKind
  /** 66-char hex, compressed pubkey */
  senderIdentityKey: string
  /**
   * Which output of `transaction` pays the payee.
   *
   * There is deliberately no `amount` beside it. `internalizeAction` credits
   * the output, so a satoshi count on the frame could only ever agree with the
   * transaction or lie about it — and `verifyFramePayment` has to parse the
   * transaction anyway, to prove the output is one the payee can spend. That
   * proof is what makes the figure it reads back worth showing as a receipt.
   */
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /**
   * Present iff kind === 'token'. Carried opaquely: the codec validates
   * shapes and lengths (and that `profileData` is a JSON object), never the
   * certificates or the evidence inside `profileData`.
   */
  token?: TokenPayment
  /**
   * The sender's note, same app-specific extension as the message-box rail's
   * `PaymentToken.note` (handle.ts). Empty and absent are wire-identical — an
   * empty string round-trips as no `note` key at all — so there is exactly
   * one way to say "no note".
   */
  note?: string
  /**
   * AtomicBEEF, on both transports. The design originally specified a bare
   * rawtx on the QR path to shrink the symbol, but ancestry is what lets the
   * payee internalize offline, and the fountain removed the symbol ceiling —
   * so one encoding serves both.
   */
  transaction: Uint8Array
}

// ── varint (LEB128, unsigned) ──

function putVarint(out: number[], n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new CodecError(`varint out of range: ${n}`)
  let v = n
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

function getVarint(b: Uint8Array, pos: { i: number }): number {
  let result = 0
  let shift = 1
  for (;;) {
    if (pos.i >= b.length) throw new CodecError('truncated varint')
    const byte = b[pos.i++]
    result += (byte & 0x7f) * shift
    if ((byte & 0x80) === 0) break
    shift *= 128
    if (shift > 2 ** 53) throw new CodecError('varint too large')
  }
  return result
}

function putBytes(out: number[], bytes: Uint8Array): void {
  putVarint(out, bytes.length)
  for (const byte of bytes) out.push(byte)
}

function getBytes(b: Uint8Array, pos: { i: number }, max?: { bytes: number; what: string }): Uint8Array {
  const len = getVarint(b, pos)
  // A hostile length prefix is refused before anything is sliced.
  if (max !== undefined && len > max.bytes) throw new CodecError(`${max.what} too large`)
  if (pos.i + len > b.length) throw new CodecError('truncated byte field')
  const slice = b.slice(pos.i, pos.i + len)
  pos.i += len
  return slice
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function putStr(out: number[], s: string): void {
  putBytes(out, enc.encode(s))
}

function getStr(b: Uint8Array, pos: { i: number }): string {
  return dec.decode(getBytes(b, pos))
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new CodecError('odd-length hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new CodecError('invalid hex')
    out[i] = byte
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

function checkAssetId(assetId: unknown): void {
  if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) throw new CodecError('bad token assetId')
}

/** profileData must be a JSON OBJECT (not an array, null or a scalar). */
function checkProfileData(text: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CodecError('token profileData is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CodecError('token profileData is not a JSON object')
  }
}

/**
 * Strict UTF-8 decode, independent of whether the platform TextDecoder
 * honours `fatal`: a lenient decode would silently rewrite invalid bytes to
 * U+FFFD, so the carrier the payee hands on would differ from what was sent.
 * Valid UTF-8 is exactly the bytes that re-encode to themselves.
 */
function decodeUtf8Strict(bytes: Uint8Array, what: string): string {
  const text = dec.decode(bytes)
  const again = enc.encode(text)
  if (again.length !== bytes.length) throw new CodecError(`${what} is not valid UTF-8`)
  for (let i = 0; i < again.length; i++) {
    if (again[i] !== bytes[i]) throw new CodecError(`${what} is not valid UTF-8`)
  }
  return text
}

// ── frame ──

const KIND_BYTE: Record<FrameKind, number> = { bsv: 0x01, token: 0x02 }

export function encodeFrame(f: PaymentFrame): Uint8Array {
  if (f.senderIdentityKey.length !== 66) {
    throw new CodecError(`senderIdentityKey must be 66 hex chars, got ${f.senderIdentityKey.length}`)
  }
  if ((f.kind === 'token') !== (f.token !== undefined)) {
    throw new CodecError(`kind ${f.kind} and token block presence disagree`)
  }
  const out: number[] = [f.version & 0xff, KIND_BYTE[f.kind] ?? 0]
  if (out[1] === 0) throw new CodecError(`unsupported frame kind ${String(f.kind)}`)
  for (const byte of hexToBytes(f.senderIdentityKey.toLowerCase())) out.push(byte)
  putVarint(out, f.outputIndex)
  putStr(out, f.derivationPrefix)
  putStr(out, f.derivationSuffix)
  if (f.token) {
    const t = f.token
    // Checked at encode as well as decode: fail where there is still a payer
    // to tell, rather than ship a frame every payee will refuse.
    checkAssetId(t.assetId)
    if (typeof t.profileData !== 'string') throw new CodecError('token profileData must be a string')
    const profileBytes = enc.encode(t.profileData)
    if (profileBytes.length > MAX_PROFILE_DATA_BYTES) throw new CodecError('token profileData too large')
    checkProfileData(t.profileData)
    putStr(out, t.assetId)
    putVarint(out, t.certificates.length)
    for (const cert of t.certificates) putBytes(out, cert)
    putBytes(out, profileBytes)
  }
  putStr(out, f.note ?? '')
  putBytes(out, f.transaction)
  return new Uint8Array(out)
}

export function decodeFrame(b: Uint8Array): PaymentFrame {
  if (b.length < 35) throw new CodecError('frame too short')
  const version = b[0]
  if (version !== FRAME_VERSION) throw new CodecError(`unsupported frame version ${version}`)
  const kindByte = b[1]
  const kind: FrameKind | undefined = kindByte === 0x01 ? 'bsv' : kindByte === 0x02 ? 'token' : undefined
  if (kind === undefined) throw new CodecError(`unsupported frame kind ${kindByte}`)
  const pos = { i: 2 }
  const senderIdentityKey = bytesToHex(b.slice(pos.i, pos.i + 33))
  pos.i += 33
  const outputIndex = getVarint(b, pos)
  const derivationPrefix = getStr(b, pos)
  const derivationSuffix = getStr(b, pos)
  let token: TokenPayment | undefined
  if (kind === 'token') {
    const assetId = getStr(b, pos)
    checkAssetId(assetId)
    const certificates: Uint8Array[] = []
    // Each certificate consumes bytes and bounds-checks first, so a hostile
    // count cannot make this loop spin: it throws the moment the buffer runs out.
    const certCount = getVarint(b, pos)
    for (let c = 0; c < certCount; c++) certificates.push(getBytes(b, pos))
    const profileData = decodeUtf8Strict(
      getBytes(b, pos, { bytes: MAX_PROFILE_DATA_BYTES, what: 'token profileData' }),
      'token profileData'
    )
    checkProfileData(profileData)
    token = { assetId, certificates, profileData }
  }
  const note = getStr(b, pos)
  const transaction = getBytes(b, pos)
  if (pos.i !== b.length) throw new CodecError('trailing bytes after frame')
  return {
    version,
    kind,
    senderIdentityKey,
    outputIndex,
    derivationPrefix,
    derivationSuffix,
    ...(token === undefined ? {} : { token }),
    ...(note ? { note } : {}),
    transaction
  }
}

// ── Sealed envelope ──
//
// Every frame that leaves the device is sealed with the session PSK — radios
// and QR alike. On the radios this is redundant with TLS-PSK/Nearby link
// encryption and costs 49 bytes; the point is ONE wire shape, so the QR rung
// (line-of-sight readable) can never be the unsealed exception. AES-256-GCM
// via @bsv/sdk SymmetricKey: |32B IV|ciphertext|16B tag|, behind one version
// byte so an old decoder reads `1`, says `unsupported frame version 1`, and
// refuses cleanly.
//
// Only line of sight is closed: whoever photographed the PAIRING QR holds
// this PSK. That threat was noted-not-mitigated in the 07-27 design and is
// unchanged here.

export const SEAL_VERSION = 1

function pskKey(psk: Uint8Array): SymmetricKey {
  if (psk.length !== 32) throw new CodecError(`psk must be 32 bytes, got ${psk.length}`)
  return new SymmetricKey(Array.from(psk))
}

export function sealFrame(f: PaymentFrame, psk: Uint8Array): Uint8Array {
  const ct = pskKey(psk).encrypt(Array.from(encodeFrame(f))) as number[]
  return new Uint8Array([SEAL_VERSION, ...ct])
}

export function unsealFrame(b: Uint8Array, psk: Uint8Array): PaymentFrame {
  if (b.length < 1 + 32 + 16) throw new CodecError('sealed frame too short')
  if (b[0] !== SEAL_VERSION) throw new CodecError(`unsupported seal version ${b[0]}`)
  let plain: number[]
  try {
    plain = pskKey(psk).decrypt(Array.from(b.slice(1))) as number[]
  } catch {
    // GCM tag mismatch (wrong PSK or tampering) throws a platform error;
    // callers of this codec catch exactly one failure type.
    throw new CodecError('sealed frame failed authentication')
  }
  return decodeFrame(new Uint8Array(plain))
}

// ── Frame envelope ──
//
// `bsvpayf1:` is NOT a QR wire format. Every payment code this app renders is a
// stream of `@bsv/air-gap` parts sized to FRAME_BLOCK_BYTES, and the scanner
// accepts nothing else — a second accepted shape is exactly what lets two
// implementations drift apart.
//
// What the envelope is for is storage: the payer persists one in
// `offline_actions.framePayload` so a delivered-but-unbroadcast payment can be
// re-shown later, and the renderer reads the bytes back out of it. base64url so
// the stored value is plain single-byte ASCII, behind a prefix that
// distinguishes it from a session QR (`bsvpay1:`). The envelope's payload is a
// SEALED frame: re-showing a stored payment yields ciphertext only the live
// session's PSK opens.

export const FRAME_QR_PREFIX = 'bsvpayf1:'

/**
 * Source-block size for the animated payment code, in bytes.
 *
 * There is no single-symbol path to fall back to, so this one number decides
 * symbol density for every payment. `estimatePartCharLength(1024)` is 1,404
 * characters, and a part is single-byte ASCII throughout, so it occupies 1,404
 * bytes of a byte-mode QR: inside the 2,331-byte capacity of a version-40
 * symbol at error-correction level M, with ~40% headroom for a scanner that is
 * not looking at the screen straight on. `react-native-qrcode-svg` rethrows out
 * of render past capacity and takes the app down through the error boundary, so
 * that headroom is not cosmetic.
 *
 * A frame this size or smaller is a single source block — one part carries the
 * whole message — so the renderer holds `seq` at 0 and runs no timer, and an
 * ordinary payment is a still QR. (Part strings are NOT equal across `seq`:
 * `seq` sits in the part header. What makes it still is holding it, not the
 * block count on its own.)
 *
 * `PaymentFrame.transaction` is AtomicBEEF — every input's source transaction
 * plus its BUMP — so frame size tracks input count, not output count. The only
 * remaining ceiling is air-gap's own MAX_MESSAGE_BYTES, which the send path
 * checks before it builds an encoder.
 */
export const FRAME_BLOCK_BYTES = 1024

function toB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  let binary: string
  try {
    binary = globalThis.atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  } catch {
    // atob throws a platform error, not a CodecError. Normalise it so callers
    // see one failure type — they must still catch broadly, since a hostile QR
    // can reach code paths this wrapper does not cover.
    throw new CodecError('malformed base64url payload')
  }
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

/** Wraps a SEALED frame for storage and later re-display. Rendered as air-gap parts, never as one symbol. */
export function frameToQr(f: PaymentFrame, psk: Uint8Array): string {
  return FRAME_QR_PREFIX + toB64url(sealFrame(f, psk))
}

/**
 * Same envelope as `frameToQr`, but takes bytes already run through
 * `sealFrame`. Callers that must know the sealed length before they can
 * render it (the QR-size sanity check) would otherwise call `sealFrame`
 * once to measure and `frameToQr` again to render — sealing the same frame
 * twice. Seal once, size-check the bytes, then wrap the same bytes here.
 */
export function sealedToQr(sealed: Uint8Array): string {
  return FRAME_QR_PREFIX + toB64url(sealed)
}

/**
 * The raw frame bytes behind a bsvpayf1: envelope.
 *
 * The encoder re-encodes exactly these bytes, and the re-show path reads them
 * from a persisted framePayload — a column, so a row can be truncated, foreign
 * or null. Every failure is a CodecError, including a non-string, because the
 * screens that call this catch one type and must not be crashed by a bad row.
 *
 * Deliberately does not decode the frame: nothing reads a stored envelope back
 * as a `PaymentFrame`, and a decoder for it would be a second accepted format.
 */
export function frameBytesFromQr(text: string): Uint8Array {
  if (typeof text !== 'string') throw new CodecError('expected a frame envelope string')
  if (!text.startsWith(FRAME_QR_PREFIX)) throw new CodecError('not a nearby-payment frame envelope')
  return fromB64url(text.slice(FRAME_QR_PREFIX.length))
}
