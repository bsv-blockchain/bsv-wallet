import { PublicKey } from '@bsv/sdk'

/**
 * BRC-125 PeerPay URI (https://bsv.brc.dev/payments/0125).
 *
 *   peerpay-URI = "peerpay:" identity-key [ "?" query ]
 *   sats-param  = "sats=" 1*DIGIT
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
  messageBoxUrl?: string
}

export interface PeerPayValidationResult {
  isPeerPay: boolean
  identityKey?: string
  sats?: number
  /** Present only when the link carried a usable https `url` extension. */
  messageBoxUrl?: string
  errors: {
    identityKey?: string
    sats?: string
  }
}

const PEERPAY_SCHEME = 'peerpay:'
const COMPRESSED_PUBLIC_KEY_REGEX = /^0[23][0-9a-fA-F]{64}$/
/** https, a host, then an optional path/query/fragment with no whitespace. */
const MESSAGE_BOX_URL_REGEX = /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i

export function parsePeerPayURI(uri: string): PeerPayParams | null {
  const result = validatePeerPayURI(uri)
  if (!result.isPeerPay || !result.identityKey || result.errors.identityKey || result.errors.sats) return null
  return {
    identityKey: result.identityKey,
    sats: result.sats,
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
  let messageBoxUrl: string | undefined
  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    if (params.has('sats')) {
      const satsStr = params.get('sats') ?? ''
      if (/^(0|[1-9][0-9]*)$/.test(satsStr)) {
        const parsed = Number(satsStr)
        if (Number.isSafeInteger(parsed)) {
          if (parsed > 0) sats = parsed
        } else {
          errors.sats = 'PeerPay link contains an invalid sats amount'
        }
      } else {
        errors.sats = 'PeerPay link contains an invalid sats amount'
      }
    }
    const url = (params.get('url') ?? '').trim().replace(/\/+$/, '')
    if (url && MESSAGE_BOX_URL_REGEX.test(url)) messageBoxUrl = url
  }

  return { isPeerPay: true, identityKey, sats, ...(messageBoxUrl ? { messageBoxUrl } : {}), errors }
}

/** The human-readable problem with a peerpay link, or null when there is none. */
export function peerPayValidationMessage(result: PeerPayValidationResult | null): string | null {
  if (!result || !result.isPeerPay) return null
  const messages = [result.errors.identityKey, result.errors.sats].filter(Boolean)
  return messages.length ? messages.join('. ') : null
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
