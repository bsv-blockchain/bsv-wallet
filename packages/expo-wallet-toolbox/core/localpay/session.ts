import { Random } from '@bsv/sdk'
import { MAX_UINT64, parseDecimalAmount } from '@bsv/mandala'
import { CodecError } from './codec'

/**
 * 2: a token request's figure `a` is a canonical decimal string of base units
 * (1..2^64-1, IC §0), and the asset block no longer carries the issuer's
 * overlay url/key — the payer uses its own configured overlay (IC §7.3). A v1
 * session is refused outright; there is no back-compat.
 */
export const SESSION_VERSION = 2

/**
 * The capability word `c` in the session QR.
 *
 * LOW BYTE — rungs the payee is LISTENING ON right now. The payer's ladder
 * (transport/select.ts) reads only these bits: a set rung is a promise that a
 * listener for it is live behind this QR.
 */
export const CAP_AWDL = 0x01
export const CAP_NEARBY = 0x02
/** Payee is advertising bsvpay-ble/1 — now advertised by this app, and the profile Blitz adopts. */
export const CAP_BLE = 0x04
/**
 * Payee is ALSO scanning for a payer that advertises this session's service
 * UUID (bsvpay-ble/1 reversed role, spec 2026-09-03). Never minted without
 * CAP_BLE: a scanner with no advertiser behind it would strand a payer whose
 * own central role is trusted. Set by iOS payees only — Android as central is
 * the role that fails against iOS.
 */
export const CAP_BLE_SCAN = 0x08
// 0x10..0x80 reserved for future rungs (L2CAP, NFC, Wi-Fi Aware).

/**
 * HIGH BITS — device hints. Never read for transport selection; they feed one
 * line of copy on the payer's confirm screen (why this pair is on the QR
 * floor) and are available to future rungs.
 *
 * A CLEAR bit means "false OR unknown". Only ONLINE gets a companion KNOWN
 * bit, because reachability is the one probe that can time out inside the
 * minting budget; every other hint is a synchronous, prompt-free read.
 */
export const HINT_ONLINE = 0x0100 // internet reachable
export const HINT_ONLINE_KNOWN = 0x0200 // HINT_ONLINE is meaningful (the probe answered within budget)
export const HINT_NET = 0x0400 // any connectivity
export const HINT_WIFI = 0x0800 // Android: Wi-Fi radio on. iOS: associated with a Wi-Fi network (no radio API)
export const HINT_BT = 0x1000 // Bluetooth authorized and powered on
export const HINT_NFC = 0x2000 // NFC reader available
/** Selects the rung byte; `~RUNG_MASK` selects the hints. */
export const RUNG_MASK = 0x00ff

export type SessionOs = 'ios' | 'android'

/**
 * Bound on `SessionAsset.decimals` (XR-043), mirrored at every other boundary
 * that ever reads a token's decimals — `ui/tokenFormat.ts`'s formatters and
 * `core/mandala/createRuntime.ts`'s asset-metadata resolution. Nothing
 * token-shaped this wallet knows of uses more than a handful; an unbounded
 * value here is how an extreme decimals figure from a session QR reaches
 * `String(...).padStart` deep in the confirmation UI and blows up the render.
 */
export const MAX_TOKEN_DECIMALS = 18

/**
 * The asset a token request names (`<64 lowercase hex>_0`, IC §0). When
 * present on a Session, the binding figure is `units` (BASE UNITS of this
 * asset) and `amount` is absent. label/ticker/decimals are payee-supplied
 * display hints only. The issuer overlay is NOT carried: the payer settles
 * against its own configured overlay (IC §7.3), so a QR cannot steer it.
 */
export interface SessionAsset {
  id: string
  label?: string
  ticker?: string
  decimals?: number
}

const ASSET_ID_RE = /^[0-9a-f]{64}_0$/

export interface Session {
  /** Verified host display metadata; never encoded into the base pairing QR. */
  merchantName?: string
  merchantChain?: string
  merchantExpires?: number
  merchantSubtotal?: number
  merchantTip?: number
  version: number
  caps: number
  sessionId: Uint8Array
  psk: Uint8Array
  identityKey: string
  /**
   * The satoshis the payee is asking for, or undefined for an OPEN request
   * where the payer chooses.
   *
   * Optional is a money-safety-relevant distinction, not a cosmetic one. When
   * present it is a binding term of the request: the payee's settle path
   * refuses any frame carrying a different figure, which is what stops a payer
   * sending 1 satoshi against a 100,000 request while the payee's screen reads
   * "Received 100,000". When absent there is no figure to bind, so that check
   * cannot run and MUST NOT be faked — the derivation nonces are what prove the
   * frame belongs to this request, and they apply either way.
   */
  amount?: number
  /**
   * TOKEN SESSIONS ONLY: the base units the payee is asking for, exact
   * (1..2^64-1). Same binding/open semantics as `amount`; never present
   * beside it. On the wire it is a canonical decimal string, never a JSON
   * number, so a figure above 2^53 survives the QR exactly.
   */
  units?: bigint
  asset?: SessionAsset
  derivationPrefix: string
  derivationSuffix: string
  /**
   * OS of the minting device. METADATA ONLY — copy and diagnostics. Transport
   * selection reads caps, which say what the device can DO; reading this
   * instead would break the moment either platform grows a second transport.
   */
  os?: SessionOs
}

export function mintSession(args: {
  identityKey: string
  /** Satoshis, BSV requests only. Omit for an open request — the payer enters the amount. */
  amount?: number
  /** Base units, token requests (`asset` present) only. Omit for an open token request. */
  units?: bigint
  asset?: SessionAsset
  derivationPrefix: string
  derivationSuffix: string
  supportsAwdl: boolean
  supportsNearby?: boolean
  /** True only while a bsvpay-ble/1 listener is actually advertising for this session. */
  supportsBle?: boolean
  /** True only while a reversed-role scan listener is live for this session. Ignored unless supportsBle. */
  supportsBleScan?: boolean
  /**
   * HINT_* bits from deviceCaps.capsFromProbe. Masked to `~RUNG_MASK` here, so
   * a hint word can never advertise a listener that was not started.
   */
  hints?: number
  os?: SessionOs
}): Session {
  if (args.identityKey.length !== 66) throw new CodecError('identityKey must be 66 hex chars')
  // Validated at the mint too, not only at decode: an invalid figure minted
  // here would render on the payee's own screen and be echoed to the payer as
  // an authentic request before any decoder ever saw it.
  if (args.amount !== undefined && args.units !== undefined) {
    throw new CodecError('a session carries amount (satoshis) or units (token), never both')
  }
  if (args.amount !== undefined && !isRequestableAmount(args.amount)) {
    throw new CodecError('bad amount')
  }
  // A satoshi figure on a token request would encode as a JSON number beside
  // `t` and every decoder would refuse it; units without an asset name no
  // asset. Both are refused here, where there is still a payee to tell.
  if (args.asset !== undefined && args.amount !== undefined) {
    throw new CodecError('a token request carries units, not a satoshi amount')
  }
  if (args.units !== undefined && args.asset === undefined) {
    throw new CodecError('units require an asset')
  }
  if (args.units !== undefined && !isRequestableUnits(args.units)) {
    throw new CodecError('bad token amount')
  }
  if (args.asset !== undefined && (typeof args.asset.id !== 'string' || !ASSET_ID_RE.test(args.asset.id))) {
    throw new CodecError('bad assetId')
  }
  // XR-043: same bound `decodeSession` enforces below, checked here too for
  // the same reason `amount` is — an out-of-range figure minted on THIS
  // device would render (and crash) on its own screen before any decoder
  // ever saw it.
  if (
    args.asset?.decimals !== undefined &&
    (!Number.isInteger(args.asset.decimals) || args.asset.decimals < 0 || args.asset.decimals > MAX_TOKEN_DECIMALS)
  ) {
    throw new CodecError('bad asset decimals')
  }
  return {
    version: SESSION_VERSION,
    caps:
      (args.supportsAwdl ? CAP_AWDL : 0) |
      (args.supportsNearby ? CAP_NEARBY : 0) |
      (args.supportsBle ? CAP_BLE : 0) |
      (args.supportsBle && args.supportsBleScan ? CAP_BLE_SCAN : 0) |
      ((args.hints ?? 0) & ~RUNG_MASK),
    sessionId: new Uint8Array(Random(16)),
    psk: new Uint8Array(Random(32)),
    identityKey: args.identityKey,
    ...(args.amount === undefined ? {} : { amount: args.amount }),
    ...(args.units === undefined ? {} : { units: args.units }),
    ...(args.asset === undefined ? {} : { asset: assetOf(args.asset) }),
    derivationPrefix: args.derivationPrefix,
    derivationSuffix: args.derivationSuffix,
    ...(args.os === undefined ? {} : { os: args.os })
  }
}

/**
 * Satoshis: a whole, positive, exactly-representable count.
 *
 * A bare typeof check admits 0, negatives, NaN and fractions — and a fractional
 * amount renders as a blank figure directly above a live Send button.
 */
export function isRequestableAmount(a: unknown): a is number {
  return typeof a === 'number' && Number.isSafeInteger(a) && a > 0
}

/**
 * Token base units: a bigint in the per-output domain 1..2^64-1 (0162:143).
 * Never a JS number — a figure above 2^53 is not representable as one.
 */
export function isRequestableUnits(u: unknown): u is bigint {
  return typeof u === 'bigint' && u >= 1n && u <= MAX_UINT64
}

/** Only the four known fields, so a caller's extra keys never reach the wire or the Session. */
function assetOf(a: SessionAsset): SessionAsset {
  return {
    id: a.id,
    ...(a.label === undefined ? {} : { label: a.label }),
    ...(a.ticker === undefined ? {} : { ticker: a.ticker }),
    ...(a.decimals === undefined ? {} : { decimals: a.decimals })
  }
}

// Base64url, no padding — QR alphanumeric-safe and dependency-free.
function toB64url(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: unknown): Uint8Array {
  if (typeof s !== 'string') throw new CodecError('expected base64url string')
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = globalThis.atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

export function encodeSession(s: Session): string {
  // `a` is omitted entirely for an open request rather than written as null.
  // JSON.stringify already drops an undefined value, so this is explicit only
  // to make the wire shape obvious: absent key === payer chooses.
  //
  // A token request writes `a` as a canonical decimal string (IC §0); a BSV
  // request keeps the JSON number. The figure is chosen by `asset`, never by
  // which field happens to be set, so a malformed Session cannot put a JSON
  // number beside `t` or a string on a BSV request.
  let a: number | string | undefined
  if (s.asset !== undefined) {
    if (s.amount !== undefined) throw new CodecError('a token request carries units, not a satoshi amount')
    if (s.units !== undefined) {
      if (!isRequestableUnits(s.units)) throw new CodecError('bad token amount')
      a = s.units.toString()
    }
  } else {
    if (s.units !== undefined) throw new CodecError('units require an asset')
    a = s.amount
  }
  const body = JSON.stringify({
    v: s.version,
    c: s.caps,
    s: toB64url(s.sessionId),
    k: toB64url(s.psk),
    i: s.identityKey,
    ...(s.os === undefined ? {} : { o: s.os === 'ios' ? 'i' : 'a' }),
    ...(a === undefined ? {} : { a }),
    ...(s.asset === undefined
      ? {}
      : {
          t: {
            i: s.asset.id,
            ...(s.asset.label === undefined ? {} : { n: s.asset.label }),
            ...(s.asset.ticker === undefined ? {} : { s: s.asset.ticker }),
            ...(s.asset.decimals === undefined ? {} : { d: s.asset.decimals })
          }
        }),
    p: s.derivationPrefix,
    x: s.derivationSuffix
  })
  return 'bsvpay1:' + toB64url(new TextEncoder().encode(body))
}

export function decodeSession(text: string): Session {
  if (!text.startsWith('bsvpay1:')) throw new CodecError('not a bsvpay session QR')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromB64url(text.slice('bsvpay1:'.length))))
  } catch (e) {
    if (e instanceof CodecError) throw e
    throw new CodecError('malformed session payload')
  }
  const { v, c, s, k, i, a, p, x, o, t } = parsed as Record<string, unknown>
  if (v !== SESSION_VERSION) throw new CodecError(`unsupported session version ${String(v)}`)
  if (typeof i !== 'string' || i.length !== 66) throw new CodecError('bad identityKey')
  // An ABSENT `a` is an OPEN request: the payer chooses.
  //
  // Absent means absent. An explicit `null` is refused, not read as open:
  // encodeSession omits the key entirely for an open request, so no peer this
  // codec talks to ever emits null, and accepting it would widen the "payer
  // picks the number" path to a shape nothing legitimately produces. Every
  // other value is a figure the payee is asserting, and a bad one must be
  // refused rather than quietly reinterpreted as "any amount" — that would turn
  // a corrupt 0 into an open request with a live Send button under it.
  //
  // Which figure `a` is depends on `t`: a token request's `a` is base units as
  // a canonical decimal string (a JSON number is refused — above 2^53 it has
  // already lost precision in JSON.parse); a BSV request's `a` is satoshis as
  // a JSON number.
  const open = a === undefined
  let units: bigint | undefined
  if (t !== undefined) {
    if (!open) {
      const parsedUnits = typeof a === 'string' ? parseDecimalAmount(a) : null
      if (parsedUnits === null || !isRequestableUnits(parsedUnits)) throw new CodecError('bad token amount')
      units = parsedUnits
    }
  } else if (!open && !isRequestableAmount(a)) {
    throw new CodecError('bad amount')
  }
  if (typeof s !== 'string') throw new CodecError('bad sessionId encoding')
  if (typeof k !== 'string') throw new CodecError('bad psk encoding')
  if (typeof p !== 'string') throw new CodecError('bad derivationPrefix encoding')
  if (typeof x !== 'string') throw new CodecError('bad derivationSuffix encoding')
  if (c !== undefined && c !== null && typeof c !== 'number') throw new CodecError('bad caps')
  const sessionId = fromB64url(s)
  const psk = fromB64url(k)
  if (sessionId.length !== 16) throw new CodecError('bad sessionId length')
  if (psk.length !== 32) throw new CodecError('bad psk length')
  // Tolerant on purpose: 'o' is advisory, from possibly-newer builds.
  const os: SessionOs | undefined = o === 'i' ? 'ios' : o === 'a' ? 'android' : undefined
  let asset: SessionAsset | undefined
  if (t !== undefined) {
    if (typeof t !== 'object' || t === null) throw new CodecError('bad asset block')
    // Unknown keys (a v1 builder's `u`/`k`, a newer peer's hints) are ignored.
    const { i: ai, n, s: tick, d } = t as Record<string, unknown>
    if (typeof ai !== 'string' || !ASSET_ID_RE.test(ai)) throw new CodecError('bad assetId')
    if (n !== undefined && typeof n !== 'string') throw new CodecError('bad asset label')
    if (tick !== undefined && typeof tick !== 'string') throw new CodecError('bad asset ticker')
    if (d !== undefined && (typeof d !== 'number' || !Number.isSafeInteger(d) || d < 0 || d > MAX_TOKEN_DECIMALS))
      throw new CodecError('bad asset decimals')
    asset = {
      id: ai,
      ...(n === undefined ? {} : { label: n }),
      ...(tick === undefined ? {} : { ticker: tick }),
      ...(d === undefined ? {} : { decimals: d })
    }
  }
  return {
    version: v as number,
    caps: typeof c === 'number' ? c : 0,
    sessionId,
    psk,
    identityKey: i,
    ...(open ? {} : asset === undefined ? { amount: a as number } : { units }),
    ...(asset === undefined ? {} : { asset }),
    derivationPrefix: p,
    derivationSuffix: x,
    ...(os === undefined ? {} : { os })
  }
}

// RFC 4648 base32, lowercase, no padding. 16 bytes → 26 chars.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function instanceName(sessionId: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of sessionId) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return `bsvpay-${out}`
}
