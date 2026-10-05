import { PrivateKey, PublicKey, Utils } from '@bsv/sdk'

/** BRC-29's protocol name. Apps sign under it to receive and move payments,
 * and this wallet's own payment keys (BSV address receipts, change) live
 * under it too, so a grant here is a grant over money. */
const BRC29_PROTOCOL_NAME = '3241645161d8'

/** The BRC-42 'anyone' counterparty (1·G), in canonical form. */
const ANYONE_PUBLIC_KEY = new PrivateKey(1).toPublicKey().toString()

type Counterparty = { kind: 'anyone' } | { kind: 'self' } | { kind: 'party'; key: string }

/** The protocol grant's counterparty as the permissions manager reports it:
 * 'self' when the app named none, 'anyone' as the literal or as 1·G in any
 * encoding, otherwise another party's key. */
function classifyCounterparty(counterparty: unknown): Counterparty {
  if (counterparty === undefined || counterparty === null || counterparty === '' || counterparty === 'self') {
    return { kind: 'self' }
  }
  if (counterparty === 'anyone') return { kind: 'anyone' }
  const raw = String(counterparty)
  try {
    const key = PublicKey.fromString(raw).toString()
    return key === ANYONE_PUBLIC_KEY ? { kind: 'anyone' } : { kind: 'party', key }
  } catch {
    return { kind: 'party', key: raw }
  }
}

function abbreviate(key: string): string {
  return key.length <= 13 ? key : key.slice(0, 8) + '…' + key.slice(-4)
}

/** One space-separated part of a key ID as text: the decoded value when the
 * part is canonical base64 of printable ASCII (BRC-29 key IDs are usually
 * base64 prefix + ' ' + base64 suffix), otherwise the part as given. */
function readablePart(part: string): string {
  try {
    const bytes = Utils.toArray(part, 'base64')
    if (bytes.length === 0 || Utils.toBase64(bytes) !== part) return part
    if (!bytes.every(b => b >= 0x20 && b <= 0x7e)) return part
    return Utils.toUTF8(bytes)
  } catch {
    return part
  }
}

/** A key ID as a person can read it, so an app's fixed key ID ("xana-earnings
 * 1") is visibly not one of the wallet's own. */
export function readableKeyID(keyID: string): string {
  return keyID.split(' ').map(readablePart).join(' ')
}

export interface ProtocolPrompt {
  /** Sheet title, before any "Renewal" suffix. */
  title: string
  /** What approving lets the app do, completing "<app> …". Undefined means
   * the caller's own text (or its generic fallback) is used. */
  description?: string
  /** Name to show for the protocol in place of its raw ID. */
  protocolLabel: string
  /** Who the keys are shared with, when that is worth naming. */
  counterpartyLabel?: string
  /** The key ID asked for, readable, when the request carries it. */
  keyIDLabel?: string
  /** The approval covers this one call and is never reused
   * (core/services/signingPermissionPolicy.ts's ASK_EVERY_TIME_PROTOCOLS). */
  askEveryTime?: boolean
}

/**
 * Plain-language copy for a protocol permission request. Most protocol names
 * are an app's own words and are shown as they are. BRC-29's is an opaque
 * hex ID, and approving it lets the app sign with a key that can hold money,
 * so it gets its own title and a description that says which money. The
 * address rail's own key IDs never reach a prompt (vault guard's
 * isAddressRailKeyID refuses them), so the copy describes the app's key.
 */
export function describeProtocolPrompt(protocolName: string, counterparty?: unknown, keyID?: unknown): ProtocolPrompt {
  if (protocolName.toLowerCase().trim() !== BRC29_PROTOCOL_NAME) {
    return { title: 'Protocol Access', protocolLabel: protocolName }
  }
  const party = classifyCounterparty(counterparty)
  const protocolLabel = 'Payments (BRC-29)'
  const keyIDLabel = typeof keyID === 'string' ? readableKeyID(keyID) : undefined
  switch (party.kind) {
    case 'anyone':
      return {
        title: 'Payment Key Signature',
        description:
          'wants a signature from one of your payment keys. Coins paid to this key could be spent with this signature.',
        protocolLabel,
        askEveryTime: true,
        counterpartyLabel: 'Anyone',
        keyIDLabel
      }
    case 'self':
      return {
        title: 'Payment Key Signature',
        description:
          "wants a signature from one of your wallet's own payment keys. Your change could be spent with this signature.",
        protocolLabel,
        askEveryTime: true,
        counterpartyLabel: 'Only you',
        keyIDLabel
      }
    case 'party':
      return {
        title: 'Payment Key Signature',
        description:
          'wants a signature from a payment key you share with another party. Coins paid to this key could be spent with this signature.',
        protocolLabel,
        askEveryTime: true,
        counterpartyLabel: abbreviate(party.key),
        keyIDLabel
      }
  }
}
