/**
 * BRC-185 Android loopback launch proof (spec 7.5): the MACs under the per-launch secret `k` and the
 * launch URI codec. Pure and synchronous; depends only on `@bsv/sdk` HMAC and the protocol codecs, so it
 * bundles into the page-side stand-in client as well as the wallet.
 *
 * Every output is HMAC-SHA-256 under `k` with its own label, so no MAC can serve as an oracle for another.
 * `k`, the epoch and every output here are secret-like: callers must never log them.
 */
import { Hash } from '@bsv/sdk'
import { b64uDecode, b64uEncode } from '../protocol/base64url'
import { canonicalize } from '../protocol/json'

const encoder = new TextEncoder()

const LABEL_HELLO = 'BRC-185 android hello v1\n'
const LABEL_DESCRIBE_ACK = 'BRC-185 android describe ack v1\n'
const LABEL_LAUNCH = 'BRC-185 android launch v1\n'
const LABEL_ACK = 'BRC-185 android ack v1\n'
const LABEL_BINDING = 'BRC-185 android binding v1\n'

/** The wallet's identity for one origin (spec 6.9). */
export interface LaunchWallet {
  instanceId: string
  continuityKey: string
}

export interface LaunchMessage {
  wallet: LaunchWallet
  epoch: string
  origin: string
  challenge: string
  host: string
  nonce: string
}

function mac(k: Uint8Array, label: string, payload: unknown): string {
  const data = Array.from(encoder.encode(label + canonicalize(payload)))
  return b64uEncode(Uint8Array.from(Hash.sha256hmac(Array.from(k), data)))
}

function walletPart(w: LaunchWallet): LaunchWallet {
  return { instanceId: w.instanceId, continuityKey: w.continuityKey }
}

function message(m: LaunchMessage): Record<string, unknown> {
  return {
    v: 1,
    wallet: walletPart(m.wallet),
    epoch: m.epoch,
    origin: m.origin,
    challenge: m.challenge,
    host: m.host,
    nonce: m.nonce
  }
}

export function helloMac(k: Uint8Array, p: { origin: string; challenge: string; host: string }): string {
  return mac(k, LABEL_HELLO, { v: 1, origin: p.origin, challenge: p.challenge, host: p.host })
}

export function describeAck(
  k: Uint8Array,
  p: { wallet: LaunchWallet; origin: string; challenge: string; host: string; nonce: string }
): string {
  return mac(k, LABEL_DESCRIBE_ACK, {
    v: 1,
    wallet: walletPart(p.wallet),
    origin: p.origin,
    challenge: p.challenge,
    host: p.host,
    nonce: p.nonce
  })
}

/** Body member `android.launchProof` of the connect request. */
export function launchProof(k: Uint8Array, m: LaunchMessage): string {
  return mac(k, LABEL_LAUNCH, message(m))
}

/** Response header `BRC-185-Android-Ack` of a successful connect. */
export function connectAck(k: Uint8Array, m: LaunchMessage): string {
  return mac(k, LABEL_ACK, message(m))
}

/** Never sent: both sides derive it and the page presents it as `BRC-185-Android-Binding`. */
export function bindingSecret(k: Uint8Array, m: LaunchMessage): string {
  return mac(k, LABEL_BINDING, message(m))
}

/**
 * Constant-time comparison of two base64url strings. A length difference returns false immediately
 * (lengths of MAC outputs are public); equal-length strings are compared without early exit.
 */
export function timingSafeEqualB64u(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const MAX_URI_BYTES = 512
const EPOCH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const B64U_RE = /^[A-Za-z0-9_-]+$/

function canonicalBytes(s: string, length: number): Uint8Array | undefined {
  if (!B64U_RE.test(s)) return undefined
  try {
    const bytes = b64uDecode(s)
    return bytes.length === length ? bytes : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse the plain URI the trampoline receives, `<scheme>://launch?v=1&e=&k=&n=`. Returns undefined for
 * anything off-shape: wrong scheme or host, a fragment, a percent escape, an unknown or duplicate
 * parameter, `v` other than `1`, an epoch that is not a lowercase UUIDv4, `k` not 32 and `n` not 16
 * canonical base64url bytes, or more than 512 bytes.
 */
export function parseLaunchUri(uri: string, scheme: string): { epoch: string; k: Uint8Array; n: string } | undefined {
  if (typeof uri !== 'string' || encoder.encode(uri).length > MAX_URI_BYTES) return undefined
  const prefix = `${scheme}://launch?`
  if (!uri.startsWith(prefix)) return undefined
  const query = uri.slice(prefix.length)
  if (query.includes('#') || query.includes('%')) return undefined
  const seen = new Map<string, string>()
  for (const part of query.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return undefined
    const name = part.slice(0, eq)
    if (name !== 'v' && name !== 'e' && name !== 'k' && name !== 'n') return undefined
    if (seen.has(name)) return undefined
    seen.set(name, part.slice(eq + 1))
  }
  if (seen.size !== 4 || seen.get('v') !== '1') return undefined
  const epoch = seen.get('e')!
  if (!EPOCH_RE.test(epoch)) return undefined
  const kBytes = canonicalBytes(seen.get('k')!, 32)
  const n = seen.get('n')!
  if (!kBytes || !canonicalBytes(n, 16)) return undefined
  return { epoch, k: kBytes, n }
}

/** The plain URI the trampoline receives. Parameter order is fixed. */
export function buildLaunchUri(o: { scheme: string; epoch: string; k: Uint8Array; n: string }): string {
  if (!EPOCH_RE.test(o.epoch)) throw new Error('launch epoch must be a lowercase UUIDv4')
  if (o.k.length !== 32) throw new Error('launch secret must be 32 bytes')
  if (!canonicalBytes(o.n, 16)) throw new Error('launch nonce must be 16 canonical base64url bytes')
  return `${o.scheme}://launch?v=1&e=${o.epoch}&k=${b64uEncode(o.k)}&n=${o.n}`
}

/** Page side: the `intent://` link Chrome rewrites into {@link buildLaunchUri}'s form. */
export function buildIntentLink(opts: {
  scheme: string
  packageId: string
  epoch: string
  k: Uint8Array
  n: string
  fallbackUrl?: string
}): string {
  const plain = buildLaunchUri({ scheme: opts.scheme, epoch: opts.epoch, k: opts.k, n: opts.n })
  const rest = plain.slice(`${opts.scheme}://`.length)
  const fallback = opts.fallbackUrl ? `S.browser_fallback_url=${encodeURIComponent(opts.fallbackUrl)};` : ''
  return `intent://${rest}#Intent;scheme=${opts.scheme};package=${opts.packageId};${fallback}end`
}
