import { PublicKey } from '@bsv/sdk'

/**
 * BRC-125 PeerPay URI (https://bsv.brc.dev/payments/0125).
 *
 *   peerpay-URI  = "peerpay:" identity-key [ "?" query ]
 *   sats-param   = "sats=" 1*DIGIT
 *   asset-param  = "asset=" 64HEXDIG "." 1*DIGIT      ; the asset's genesis outpoint
 *   amount-param = "amount=" 1*DIGIT                   ; BASE UNITS of that asset
 *
 * `sats` is the BSV selector. `asset` names a token by its genesis outpoint —
 * the one identifier every issuer's asset already has — and `amount` is a
 * figure in that token's own base units, so it only means anything beside an
 * `asset`. Both are optional: `asset` alone is an open token request, where
 * the payer chooses the figure. A link mixing `sats` with either is refused
 * rather than read in one money or the other (maintainer decision, 2026-09-15).
 *
 * Plus one extension parameter this app emits and reads: `url`, the payee's
 * message-box host, so a payer can skip the overlay lookup. Per BRC-125 an extension that does not parse
 * is ignored, not fatal — a typo in the hint must not block a payment
 * whose key is fine. Only https is accepted because the payer will
 * authenticate against whatever host this names.
 */
export interface PeerPayParams {
  identityKey: string
  sats?: number
  /** The token's genesis outpoint, `txid.vout`, lowercased. */
  asset?: string
  /** Base units of `asset`. Never present without it. */
  amount?: number
  messageBoxUrl?: string
}

export interface PeerPayValidationResult {
  isPeerPay: boolean
  identityKey?: string
  sats?: number
  asset?: string
  amount?: number
  /** Present only when the link carried a usable https `url` extension. */
  messageBoxUrl?: string
  errors: {
    identityKey?: string
    sats?: string
    asset?: string
    amount?: string
  }
}

/** Any error at all — the one test every consumer of a validation result makes. */
export function peerPayHasErrors(result: PeerPayValidationResult): boolean {
  return Object.values(result.errors).some(Boolean)
}

const PEERPAY_SCHEME = 'peerpay:'
const COMPRESSED_PUBLIC_KEY_REGEX = /^0[23][0-9a-fA-F]{64}$/
/** A genesis outpoint: 32-byte txid in hex, a dot, a decimal output index. */
const ASSET_OUTPOINT_REGEX = /^[0-9a-fA-F]{64}\.(0|[1-9][0-9]*)$/
/** A whole non-negative figure with no sign, point or leading zero. */
const WHOLE_FIGURE_REGEX = /^(0|[1-9][0-9]*)$/
/**
 * https, a host, then an optional path/query/fragment with no whitespace. The
 * authority chunk excludes `@` and `\` so a `mb.trusted.example@evil.example`
 * userinfo cannot present a readable prefix that is not the real host.
 */
const MESSAGE_BOX_URL_REGEX = /^https:\/\/[^\s/?#@\\]+(?:[/?#]\S*)?$/i

export function parsePeerPayURI(uri: string): PeerPayParams | null {
  const result = validatePeerPayURI(uri)
  if (!result.isPeerPay || !result.identityKey || peerPayHasErrors(result)) return null
  return {
    identityKey: result.identityKey,
    ...(result.sats !== undefined ? { sats: result.sats } : {}),
    ...(result.asset !== undefined ? { asset: result.asset } : {}),
    ...(result.amount !== undefined ? { amount: result.amount } : {}),
    ...(result.messageBoxUrl ? { messageBoxUrl: result.messageBoxUrl } : {})
  }
}

export function validatePeerPayURI(uri: string): PeerPayValidationResult {
  const trimmed = uri.trim()
  if (!trimmed.toLowerCase().startsWith(PEERPAY_SCHEME)) {
    return { isPeerPay: false, errors: { identityKey: 'Not a peerpay link' } }
  }

  let withoutScheme = trimmed.slice(PEERPAY_SCHEME.length)
  if (withoutScheme.startsWith('//')) withoutScheme = withoutScheme.slice(2)
  const queryIndex = withoutScheme.indexOf('?')
  const keyPart = queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex)
  const queryPart = queryIndex === -1 ? '' : withoutScheme.slice(queryIndex + 1)
  const errors: PeerPayValidationResult['errors'] = {}

  let identityKey: string | undefined
  if (isValidIdentityKey(keyPart)) {
    identityKey = keyPart.toLowerCase()
  } else {
    errors.identityKey = 'PeerPay link contains an invalid identity key'
  }

  let sats: number | undefined
  let asset: string | undefined
  let amount: number | undefined
  let messageBoxUrl: string | undefined
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    if (params.has('sats')) {
      const figure = wholeFigure(params.get('sats') ?? '')
      if (figure === null) errors.sats = 'PeerPay link contains an invalid sats amount'
      else if (figure > 0) sats = figure
    }
    if (params.has('asset')) {
      const raw = (params.get('asset') ?? '').trim()
      if (ASSET_OUTPOINT_REGEX.test(raw)) asset = raw.toLowerCase()
      else errors.asset = 'PeerPay link names an invalid asset'
    }
    if (params.has('amount')) {
      const figure = wholeFigure(params.get('amount') ?? '')
      if (figure === null) errors.amount = 'PeerPay link contains an invalid amount'
      else if (!params.has('asset')) errors.amount = 'PeerPay link names an amount without an asset'
      else if (figure > 0) amount = figure
    }
    // Two selectors for two different monies: refused, never read as either.
    if (params.has('sats') && (params.has('asset') || params.has('amount'))) {
      errors.sats = 'PeerPay link mixes sats with a token request'
    }
    const url = (params.get('url') ?? '').trim().replace(/\/+$/, '')
    if (url && MESSAGE_BOX_URL_REGEX.test(url)) messageBoxUrl = url
  }

  return {
    isPeerPay: true,
    identityKey,
    sats,
    ...(asset !== undefined ? { asset } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(messageBoxUrl ? { messageBoxUrl } : {}),
    errors
  }
}

/** The human-readable problem with a peerpay link, or null when there is none. */
export function peerPayValidationMessage(result: PeerPayValidationResult | null): string | null {
  if (!result || !result.isPeerPay) return null
  const { identityKey, sats, asset, amount } = result.errors
  const messages = [identityKey, sats, asset, amount].filter(Boolean)
  return messages.length ? messages.join('. ') : null
}

/** A whole safe integer from a query value, or null for anything else. */
function wholeFigure(text: string): number | null {
  if (!WHOLE_FIGURE_REGEX.test(text)) return null
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * A 33-byte compressed secp256k1 key in hex, either case, on the curve. Round-trips through
 * PublicKey because the SDK reduces an out-of-range x mod p instead of throwing — parse success
 * alone would accept a key nobody holds.
 */
export function isCompressedPublicKey(text: string): boolean {
  if (!COMPRESSED_PUBLIC_KEY_REGEX.test(text)) return false
  try {
    return PublicKey.fromString(text).toString().toLowerCase() === text.toLowerCase()
  } catch {
    return false
  }
}

function isValidIdentityKey(identityKey: string) {
  return COMPRESSED_PUBLIC_KEY_REGEX.test(identityKey) && isCompressedPublicKey(identityKey)
}
