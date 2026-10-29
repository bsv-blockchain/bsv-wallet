/**
 * BRC-185 provider descriptor and its signed describe/connect proofs (spec 6.10).
 *
 * Pure: depends only on `@bsv/sdk` utils and `@noble/curves`, so it can be bundled into the
 * Safari extension unchanged.
 */
import { Utils } from '@bsv/sdk'
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64uDecode, b64uEncode } from './base64url'
import { canonicalize, hasLoneSurrogate, parseStrictJson } from './json'
import { CHALLENGE_BYTES, MAX_PROOF_RESPONSE_BYTES } from './limits'

export class DescriptorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DescriptorError'
  }
}

export class ProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProofError'
  }
}

export interface DescriptorEndpoint {
  id: string
  type: string
  address: string
}

export interface Descriptor {
  version: 1
  instanceId: string
  name: string
  instanceLabel: string
  icon?: string
  vendor: string
  continuityKey: string
  endpoints: DescriptorEndpoint[]
}

export interface DescribeResponse {
  descriptor: Descriptor
  challenge: string
  signature: string
}

export interface ConnectResponse extends DescribeResponse {
  epoch: string
}

export interface ProofSigner {
  sign(preimage: Uint8Array): Promise<Uint8Array>
}

const DESCRIBE_PREFIX = 'BRC-185 descriptor v1\n'
const CONNECT_PREFIX = 'BRC-185 connect v1\n'

const encoder = new TextEncoder()
const utf8 = (s: string): Uint8Array => encoder.encode(s)
const utf8Length = (s: string): number => encoder.encode(s).length

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const VENDOR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const ENDPOINT_ID = /^[A-Za-z0-9._-]{1,64}$/
const KNOWN_TYPES = new Set(['http-wire', 'http-json', 'https-json', 'window', 'xdm', 'react-native'])
const HTTP_TYPES = new Set(['http-wire', 'http-json'])
const PORT = '(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?'
const LOOPBACK_HTTP_ORIGIN = new RegExp(`^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])${PORT}$`)
const HTTPS_ORIGIN = new RegExp(
  `^https://(?:[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)(?:\\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*${PORT}$`
)
const ICON_HTTPS = /^https:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::[0-9]{1,5})?\/[\x21-\x7e]*$/
// Text a user will see must stay inert: no control characters, no bidi overrides or isolates, no
// line/paragraph separators, no BOM or zero-width marks that could disguise one site as another.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/

const DESCRIPTOR_KEYS = new Set([
  'version',
  'instanceId',
  'name',
  'instanceLabel',
  'icon',
  'vendor',
  'continuityKey',
  'endpoints'
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function plainText(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new DescriptorError(`${field} must be a string`)
  if (hasLoneSurrogate(v) || FORBIDDEN_TEXT.test(v)) throw new DescriptorError(`${field} must be plain text`)
  const n = utf8Length(v)
  if (n < min || n > max) throw new DescriptorError(`${field} must be ${min}-${max} bytes`)
  if (min > 0 && v.trim().length === 0) throw new DescriptorError(`${field} must not be blank`)
  return v
}

function canonicalB64u(v: unknown, bytes: number, field: string): string {
  if (typeof v !== 'string') throw new DescriptorError(`${field} must be a string`)
  let decoded: Uint8Array
  try {
    decoded = b64uDecode(v)
  } catch {
    throw new DescriptorError(`${field} must be canonical base64url`)
  }
  if (decoded.length !== bytes) throw new DescriptorError(`${field} must decode to ${bytes} bytes`)
  return v
}

function originParts(
  address: string,
  what: string,
  bare: boolean
): { protocol: string; hostname: string; port: string } {
  let u: URL
  try {
    u = new URL(address)
  } catch {
    throw new ProofError(`${what} is not a URL`)
  }
  if (bare && ((u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '')) {
    throw new ProofError(`${what} must not carry a path, query or fragment`)
  }
  return { protocol: u.protocol, hostname: u.hostname, port: u.port }
}

/**
 * Throws `ProofError` unless the descriptor advertises the responder the page actually reached: some
 * endpoint has `type === responder.type` and an `address` with the same scheme, host and port as
 * `responder.address` (parsed `URL` parts; no path allowed on the responder). A responder that
 * answers `describe` on a loopback port must be reachable at an address the descriptor names, so a
 * different process on another port cannot present a descriptor that points elsewhere. `127.0.0.1`
 * does not satisfy `localhost`: the host is compared as written.
 */
export function assertAdvertisesResponder(
  descriptor: Descriptor,
  responder: { type: 'http-json'; address: string }
): void {
  const want = originParts(responder.address, 'responder address', true)
  for (const ep of descriptor.endpoints) {
    if (ep.type !== responder.type) continue
    let got: ReturnType<typeof originParts>
    try {
      got = originParts(ep.address, 'endpoint address', false)
    } catch {
      continue
    }
    if (got.protocol === want.protocol && got.hostname === want.hostname && got.port === want.port) return
  }
  throw new ProofError('descriptor does not advertise the responder that answered')
}

/** BRC-185 section 3.1. Returns false for anything that is not one of the three allowed forms. */
export function isValidIconReference(ref: string): boolean {
  if (utf8Length(ref) < 1 || utf8Length(ref) > 256) return false
  if (ref.startsWith('https://')) return ICON_HTTPS.test(ref) && !ref.includes('#')
  if (ref.startsWith('uhrp://')) {
    const id = ref.slice('uhrp://'.length)
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(id)) return false
    try {
      const { prefix, data } = Utils.fromBase58Check(id, undefined, 2) as { prefix: number[]; data: number[] }
      return prefix.length === 2 && prefix[0] === 0xce && prefix[1] === 0x00 && data.length === 32
    } catch {
      return false
    }
  }
  if (ref.startsWith('chirp://')) {
    // BRC-167 root identifiers are opaque, case-sensitive tokens. Only the token alphabet is checked here;
    // content verification belongs to the resolver (section 3.1 keeps that outside the core).
    return /^[A-Za-z0-9_-]{1,200}$/.test(ref.slice('chirp://'.length))
  }
  return false
}

function validateEndpoint(e: unknown): DescriptorEndpoint {
  if (!isRecord(e)) throw new DescriptorError('endpoint must be an object')
  for (const k of Object.keys(e)) {
    if (k !== 'id' && k !== 'type' && k !== 'address') throw new DescriptorError(`unknown endpoint field "${k}"`)
  }
  const { id, type, address } = e
  if (typeof id !== 'string' || !ENDPOINT_ID.test(id)) throw new DescriptorError('endpoint id is invalid')
  if (typeof type !== 'string') throw new DescriptorError('endpoint type must be a string')
  if (typeof address !== 'string' || address.length === 0 || hasLoneSurrogate(address) || utf8Length(address) > 2048) {
    throw new DescriptorError('endpoint address is invalid')
  }
  if (FORBIDDEN_TEXT.test(address)) throw new DescriptorError('endpoint address has control characters')
  if (HTTP_TYPES.has(type)) {
    if (!LOOPBACK_HTTP_ORIGIN.test(address)) throw new DescriptorError('HTTP endpoint must be a loopback origin')
  } else if (type === 'https-json') {
    if (!HTTPS_ORIGIN.test(address)) throw new DescriptorError('https-json endpoint must be an https origin')
  } else if (!KNOWN_TYPES.has(type)) {
    // An extension's specification URI: absolute https, no whitespace.
    if (!/^https:\/\/[\x21-\x7e]+$/.test(type)) throw new DescriptorError('endpoint type is unknown')
  }
  return { id, type, address }
}

/**
 * Validate a descriptor (BRC-185 section 3). Unknown fields, null optionals and bad shapes throw.
 * An invalid icon is the one soft failure: it is dropped from the returned value. Callers must verify
 * signatures over the original object, never over this normalised copy.
 */
export function validateDescriptor(d: unknown): Descriptor {
  if (!isRecord(d)) throw new DescriptorError('descriptor must be an object')
  for (const k of Object.keys(d)) {
    if (!DESCRIPTOR_KEYS.has(k)) throw new DescriptorError(`unknown descriptor field "${k}"`)
  }
  if (d.version !== 1) throw new DescriptorError('descriptor version must be 1')
  if (typeof d.instanceId !== 'string' || !UUID_V4.test(d.instanceId)) {
    throw new DescriptorError('instanceId must be a lowercase UUIDv4')
  }
  const name = plainText(d.name, 'name', 1, 80)
  const instanceLabel = plainText(d.instanceLabel, 'instanceLabel', 0, 80)
  if (typeof d.vendor !== 'string' || d.vendor.length < 1 || d.vendor.length > 253 || !VENDOR.test(d.vendor)) {
    throw new DescriptorError('vendor must be a lowercase reverse-domain string')
  }
  const continuityKey = canonicalB64u(d.continuityKey, 32, 'continuityKey')
  if (!Array.isArray(d.endpoints) || d.endpoints.length < 1 || d.endpoints.length > 32) {
    throw new DescriptorError('endpoints must hold 1-32 records')
  }
  const endpoints = d.endpoints.map(validateEndpoint)
  if (new Set(endpoints.map(e => e.id)).size !== endpoints.length)
    throw new DescriptorError('endpoint ids must be unique')

  const out: Descriptor = {
    version: 1,
    instanceId: d.instanceId,
    name,
    instanceLabel,
    vendor: d.vendor,
    continuityKey,
    endpoints
  }
  if ('icon' in d) {
    if (typeof d.icon !== 'string') throw new DescriptorError('icon must be a string when present')
    if (isValidIconReference(d.icon)) out.icon = d.icon
  }
  return out
}

/** Ed25519 public key usable as a continuity key: canonical encoding, on the curve, not small order. */
export function isStrongEd25519Key(pub: Uint8Array): boolean {
  if (pub.length !== 32) return false
  try {
    const point = ed25519.Point.fromBytes(pub, false)
    return !point.isSmallOrder()
  } catch {
    return false
  }
}

function verifyEd25519(signature: Uint8Array, preimage: Uint8Array, pub: Uint8Array): boolean {
  if (signature.length !== 64 || !isStrongEd25519Key(pub)) return false
  try {
    return ed25519.verify(signature, preimage, pub, { zip215: false })
  } catch {
    return false
  }
}

export function describePreimage(input: { origin: string; challenge: string; descriptor: unknown }): Uint8Array {
  const { origin, challenge, descriptor } = input
  return utf8(DESCRIBE_PREFIX + canonicalize({ origin, challenge, descriptor }))
}

export function connectPreimage(input: {
  origin: string
  epoch: string
  challenge: string
  descriptor: unknown
}): Uint8Array {
  const { origin, epoch, challenge, descriptor } = input
  return utf8(CONNECT_PREFIX + canonicalize({ origin, epoch, challenge, descriptor }))
}

export async function signDescribe(
  signer: ProofSigner,
  input: { origin: string; challenge: string; descriptor: Descriptor }
): Promise<DescribeResponse> {
  const signature = await signer.sign(describePreimage(input))
  return { descriptor: input.descriptor, challenge: input.challenge, signature: b64uEncode(signature) }
}

export async function signConnect(
  signer: ProofSigner,
  input: { origin: string; epoch: string; challenge: string; descriptor: Descriptor }
): Promise<ConnectResponse> {
  const signature = await signer.sign(connectPreimage(input))
  return {
    epoch: input.epoch,
    descriptor: input.descriptor,
    challenge: input.challenge,
    signature: b64uEncode(signature)
  }
}

function requireChallenge(challenge: string, what: string): void {
  try {
    if (b64uDecode(challenge).length === CHALLENGE_BYTES) return
  } catch {
    /* fall through */
  }
  throw new ProofError(`${what} must be 32 bytes of canonical base64url`)
}

/** Accept the raw text of a response (strictly parsed) or an already-parsed object; bound its size. */
function readResponse(resp: unknown, keys: string[]): Record<string, unknown> {
  let obj: unknown = resp
  if (typeof resp === 'string') {
    if (utf8Length(resp) > MAX_PROOF_RESPONSE_BYTES) throw new ProofError('response is too large')
    try {
      obj = parseStrictJson(resp)
    } catch (e) {
      throw new ProofError(`response is not strict JSON: ${(e as Error).message}`)
    }
  } else {
    let size: number
    try {
      size = utf8Length(canonicalize(resp))
    } catch {
      throw new ProofError('response is not plain JSON')
    }
    if (size > MAX_PROOF_RESPONSE_BYTES) throw new ProofError('response is too large')
  }
  if (!isRecord(obj)) throw new ProofError('response must be an object')
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new ProofError(`unknown response field "${k}"`)
  for (const k of keys) if (!(k in obj)) throw new ProofError(`response is missing "${k}"`)
  return obj
}

function checkSignature(raw: Record<string, unknown>, preimage: (descriptor: unknown) => Uint8Array): Descriptor {
  let descriptor: Descriptor
  try {
    descriptor = validateDescriptor(raw.descriptor)
  } catch (e) {
    throw new ProofError((e as Error).message)
  }
  let sig: Uint8Array
  try {
    if (typeof raw.signature !== 'string') throw new Error('not a string')
    sig = b64uDecode(raw.signature)
  } catch {
    throw new ProofError('signature must be canonical base64url')
  }
  // The signature covers the exact descriptor the provider sent (including an icon we may have
  // dropped), so the preimage is built from the raw object.
  if (!verifyEd25519(sig, preimage(raw.descriptor), b64uDecode(descriptor.continuityKey))) {
    throw new ProofError('signature does not verify')
  }
  return descriptor
}

/** Verify a describe response for `origin` and the controller's own `challenge`. */
export function verifyDescribeProof(resp: unknown, ctx: { origin: string; challenge: string }): Descriptor {
  requireChallenge(ctx.challenge, 'challenge')
  const raw = readResponse(resp, ['descriptor', 'challenge', 'signature'])
  if (raw.challenge !== ctx.challenge) throw new ProofError('challenge was not echoed exactly')
  return checkSignature(raw, descriptor =>
    describePreimage({ origin: ctx.origin, challenge: ctx.challenge, descriptor })
  )
}

/** Verify a connect response, including that it proves the identity the controller selected. */
export function verifyConnectProof(
  resp: unknown,
  ctx: {
    origin: string
    epoch: string
    challenge: string
    expectedIdentity: { instanceId: string; continuityKey: string }
  }
): Descriptor {
  requireChallenge(ctx.challenge, 'challenge')
  if (!UUID_V4.test(ctx.epoch)) throw new ProofError('epoch must be a lowercase UUIDv4')
  const raw = readResponse(resp, ['epoch', 'descriptor', 'challenge', 'signature'])
  if (raw.challenge !== ctx.challenge) throw new ProofError('challenge was not echoed exactly')
  if (raw.epoch !== ctx.epoch) throw new ProofError('epoch was not echoed exactly')
  const descriptor = checkSignature(raw, d =>
    connectPreimage({ origin: ctx.origin, epoch: ctx.epoch, challenge: ctx.challenge, descriptor: d })
  )
  if (
    descriptor.instanceId !== ctx.expectedIdentity.instanceId ||
    descriptor.continuityKey !== ctx.expectedIdentity.continuityKey
  ) {
    throw new ProofError('connect proof is for a different provider identity')
  }
  return descriptor
}
