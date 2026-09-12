import { PublicKey, type WalletProtocol } from '@bsv/sdk'
import { parseExternalOrigin, type ExternalOrigin } from './externalOrigin'

const KB = 1024
const MB = 1024 * KB

/** Pairing QR codes are normally valid for two minutes. A short upper bound
 * prevents a signed QR from becoming a practically permanent bearer token
 * while leaving ample room for clock skew and custom deployments. */
export const MAX_PAIRING_EXPIRY_HORIZON_SECONDS = 15 * 60
export const MAX_PAIRING_TOPIC_BYTES = 128
export const MAX_PAIRING_ORIGIN_BYTES = 2048
export const MAX_PAIRING_PROTOCOL_BYTES = 512
export const MAX_PAIRING_SIGNATURE_CHARS = 128
export const MAX_RELAY_URL_BYTES = 2048
export const MAX_RELAY_RESPONSE_BYTES = 4 * KB

/** The largest encrypted RPC body accepted by the mobile bridge. The normal
 * wallet-relay traffic is orders of magnitude smaller; 5 MiB still admits a
 * one-megabyte AtomicBEEF represented as a JSON number array. */
export const MAX_RPC_PLAINTEXT_BYTES = 5 * MB
// @bsv/sdk authenticated encryption adds 48 bytes today. Keep a small explicit
// allowance so a future compatible envelope does not fail at the boundary.
export const MAX_RPC_CIPHERTEXT_BYTES = MAX_RPC_PLAINTEXT_BYTES + 256
export const MAX_RPC_CIPHERTEXT_CHARS = Math.ceil(MAX_RPC_CIPHERTEXT_BYTES * 4 / 3)
export const MAX_RPC_WIRE_CHARS = MAX_RPC_CIPHERTEXT_CHARS + 1024
export const MAX_IN_FLIGHT_RPC = 4

export interface ConnectParams {
  topic: string
  backendIdentityKey: string
  protocolID: string
  origin: string
  expiry?: string
  sig?: string
}

export interface ValidatedConnectParams {
  params: Required<ConnectParams>
  external: ExternalOrigin
  protocolID: WalletProtocol
  expiry: number
}

export const PAIRING_SIGNATURE_DOMAIN = 'bsv-wallet-pairing-v1'

/** Exact transcript signed by the desktop pairing peer. Every field that
 * chooses the transport endpoint or its BRC-42 key namespace is included. */
export function buildPairingSignatureMessage(
  params: Pick<Required<ConnectParams>, 'topic' | 'backendIdentityKey' | 'protocolID' | 'origin' | 'expiry'>
): string {
  return [
    PAIRING_SIGNATURE_DOMAIN,
    params.topic,
    params.backendIdentityKey,
    params.protocolID,
    params.origin,
    params.expiry
  ].join('|')
}

function requireBoundedString(value: unknown, name: string, maxBytes: number, minBytes = 1): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  // UTF-8 is never shorter than the UTF-16 code-unit count. This rejects a
  // giant value before TextEncoder would allocate another giant buffer.
  if (value.length > maxBytes) throw new Error(`${name} is too long`)
  const bytes = new TextEncoder().encode(value).length
  if (bytes < minBytes || bytes > maxBytes) throw new Error(`${name} has an invalid length`)
  return value
}

export function parseWalletProtocol(raw: unknown): { raw: string; value: WalletProtocol } {
  const encoded = requireBoundedString(raw, 'protocolID', MAX_PAIRING_PROTOCOL_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    throw new Error('protocolID is not valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isInteger(parsed[0]) ||
      parsed[0] < 0 || parsed[0] > 2 || typeof parsed[1] !== 'string') {
    throw new Error('protocolID must be a valid [security level, protocol name] tuple')
  }
  const name = parsed[1]
  if (name.length < 5 || name.length > 400 || name !== name.trim().toLowerCase() ||
      !/^[a-z0-9 ]+$/.test(name) || name.includes('  ') || name.endsWith(' protocol')) {
    throw new Error('protocolID contains an invalid protocol name')
  }
  const value = [parsed[0], name] as WalletProtocol
  if (JSON.stringify(value) !== encoded) throw new Error('protocolID must use canonical JSON encoding')
  return { raw: encoded, value }
}

export function validateBackendIdentityKey(raw: unknown): string {
  const key = requireBoundedString(raw, 'backendIdentityKey', 66, 66)
  if (!/^(02|03)[0-9a-f]{64}$/.test(key)) {
    throw new Error('Backend identity key must be a canonical compressed secp256k1 public key')
  }
  try {
    if (PublicKey.fromString(key).toString() !== key) throw new Error('non-canonical key')
  } catch {
    throw new Error('Backend identity key is not a valid secp256k1 point')
  }
  return key
}

export function validateMobileIdentityKey(raw: unknown): string {
  try {
    return validateBackendIdentityKey(raw)
  } catch {
    throw new Error('Mobile identity key must be a canonical compressed secp256k1 public key')
  }
}

export function validatePairingTopic(raw: unknown): string {
  const topic = requireBoundedString(raw, 'topic', MAX_PAIRING_TOPIC_BYTES)
  // The signature payload uses `|` separators and the topic is used in URL
  // path/query components. Restrict it to an unambiguous, percent-free token.
  if (!/^[A-Za-z0-9_-]+$/.test(topic)) throw new Error('Pairing topic contains invalid characters')
  return topic
}

export function validateCanonicalExternalOrigin(raw: unknown): ExternalOrigin {
  const origin = requireBoundedString(raw, 'origin', MAX_PAIRING_ORIGIN_BYTES)
  const external = parseExternalOrigin(origin)
  if (external.origin !== origin) throw new Error('Origin must use its canonical HTTPS form')
  return external
}

function validateSignature(raw: unknown): string {
  const sig = requireBoundedString(raw, 'sig', MAX_PAIRING_SIGNATURE_CHARS)
  if (!/^[A-Za-z0-9_-]+$/.test(sig) || sig.length % 4 === 1) {
    throw new Error('Pairing signature is not canonical base64url')
  }
  // A DER ECDSA signature is normally 70-72 bytes. These wider bounds reject
  // empty/truncated and oversized values before the SDK's base64 decoder.
  const decodedBytes = Math.floor(sig.length * 3 / 4)
  if (decodedBytes < 8 || decodedBytes > 80) throw new Error('Pairing signature has an invalid length')
  return sig
}

function validateExpiry(raw: unknown, nowMs: number): { raw: string; value: number } {
  const expiryRaw = requireBoundedString(raw, 'expiry', 11)
  if (!/^[1-9][0-9]{0,10}$/.test(expiryRaw)) throw new Error('Pairing expiry must be canonical Unix seconds')
  const expiry = Number(expiryRaw)
  const nowSeconds = Math.floor(nowMs / 1000)
  if (!Number.isSafeInteger(expiry) || expiry <= nowSeconds) throw new Error('QR code has expired')
  if (expiry > nowSeconds + MAX_PAIRING_EXPIRY_HORIZON_SECONDS) {
    throw new Error('QR code expiry is too far in the future')
  }
  return { raw: expiryRaw, value: expiry }
}

export function validateConnectParams(raw: ConnectParams, nowMs = Date.now()): ValidatedConnectParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Pairing parameters are invalid')
  }
  const topic = validatePairingTopic(raw.topic)
  const backendIdentityKey = validateBackendIdentityKey(raw.backendIdentityKey)
  const protocol = parseWalletProtocol(raw.protocolID)
  const external = validateCanonicalExternalOrigin(raw.origin)
  const origin = external.origin
  const expiry = validateExpiry(raw.expiry, nowMs)
  const sig = validateSignature(raw.sig)
  return {
    params: { topic, backendIdentityKey, protocolID: protocol.raw, origin, expiry: expiry.raw, sig },
    external,
    protocolID: protocol.value,
    expiry: expiry.value
  }
}

export function validateStoredConnectionFields(raw: {
  sessionId: unknown
  backendIdentityKey: unknown
  mobileIdentityKey: unknown
  protocolID: unknown
  origin: unknown
}): {
  topic: string
  backendIdentityKey: string
  mobileIdentityKey: string
  protocolIDRaw: string
  protocolID: WalletProtocol
  external: ExternalOrigin
} {
  if (raw === null || typeof raw !== 'object') throw new Error('Stored connection is invalid')
  const topic = validatePairingTopic(raw.sessionId)
  const backendIdentityKey = validateBackendIdentityKey(raw.backendIdentityKey)
  const mobileIdentityKey = validateMobileIdentityKey(raw.mobileIdentityKey)
  const protocol = parseWalletProtocol(raw.protocolID)
  const external = validateCanonicalExternalOrigin(raw.origin)
  return { topic, backendIdentityKey, mobileIdentityKey, protocolIDRaw: protocol.raw, protocolID: protocol.value, external }
}

/** SecureStore data can be corrupted or restored independently of the
 * connection database. Only canonical sequence values that can be incremented
 * safely for the next authenticated message are accepted. */
export function validateStoredConnectionSequence(raw: unknown): number {
  if (raw === null || raw === undefined) return 0
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error('Stored connection sequence is invalid')
  }
  const sequence = Number(raw)
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Stored connection sequence is invalid')
  }
  return sequence
}

export function validateRelayUrl(raw: unknown): string {
  const value = requireBoundedString(raw, 'relay URL', MAX_RELAY_URL_BYTES)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Origin server returned an invalid relay URL')
  }
  if (url.protocol !== 'wss:' || !url.hostname) throw new Error('Relay URL must use wss://')
  if (url.username || url.password) throw new Error('Relay URL must not include credentials')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Relay URL must be a bare WSS origin')
  }
  return url.origin
}

export function parseRelayResponse(raw: unknown): string {
  const text = requireBoundedString(raw, 'relay response', MAX_RELAY_RESPONSE_BYTES)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Origin server returned invalid relay JSON')
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data) ||
      typeof (data as { relay?: unknown }).relay !== 'string') {
    throw new Error('Origin server did not return a relay URL')
  }
  return validateRelayUrl((data as { relay: string }).relay)
}

export function buildRelayWebSocketUrl(relay: string, topic: string): string {
  const url = new URL('/ws', `${validateRelayUrl(relay)}/`)
  url.searchParams.set('topic', validatePairingTopic(topic))
  url.searchParams.set('role', 'mobile')
  return url.toString()
}

export interface BoundedWireEnvelope {
  topic: string
  ciphertext: string
  mobileIdentityKey?: string
}

export function parseBoundedWireEnvelope(raw: unknown, expectedTopic: string): BoundedWireEnvelope {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RPC_WIRE_CHARS) {
    throw new Error('Wallet relay message exceeds the transport limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Wallet relay message is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Wallet relay message is not an object')
  }
  const envelope = parsed as Record<string, unknown>
  for (const key of Object.keys(envelope)) {
    if (key !== 'topic' && key !== 'ciphertext' && key !== 'mobileIdentityKey') {
      throw new Error(`Wallet relay message contains unknown field ${key}`)
    }
  }
  if (envelope.topic !== expectedTopic) throw new Error('Wallet relay message has the wrong topic')
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length === 0 ||
      envelope.ciphertext.length > MAX_RPC_CIPHERTEXT_CHARS ||
      envelope.ciphertext.length % 4 === 1 ||
      Math.floor(envelope.ciphertext.length * 3 / 4) > MAX_RPC_CIPHERTEXT_BYTES ||
      !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)) {
    throw new Error('Wallet relay ciphertext is invalid or too large')
  }
  const mobileIdentityKey = envelope.mobileIdentityKey === undefined
    ? undefined
    : validateMobileIdentityKey(envelope.mobileIdentityKey)
  return { topic: expectedTopic, ciphertext: envelope.ciphertext, mobileIdentityKey }
}

export function requireBoundedPlaintext(plaintext: unknown): number[] {
  if (!Array.isArray(plaintext) || plaintext.length > MAX_RPC_PLAINTEXT_BYTES) {
    throw new Error('Wallet relay plaintext exceeds the transport limit')
  }
  return plaintext
}
