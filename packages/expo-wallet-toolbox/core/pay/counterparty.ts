/**
 * Who was on the other side of a wallet action, recovered from what the rails
 * actually persist. Each rail records its counterparty differently and only
 * some of them record one at all, so the activity list needs one place that
 * turns labels, senderIdentityKey and txid into a single answer it can name
 * and draw a sigil for.
 */
import { Hash, Utils } from '@bsv/sdk'
import { patp } from './patp'

/** A compressed secp256k1 public key in hex: what peer rails write as a label. */
export const PUBKEY_LABEL = /^(02|03)[0-9a-fA-F]{64}$/

/**
 * The public key of private key 1. The address sweep has no real sender
 * identity, so it fills senderIdentityKey with this well-known key; treating it
 * as a counterparty would give every swept payment the same face.
 */
export const SENTINEL_SENDER_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

/** An outbound address send labels the action 'to:' + addressLabel payload. */
export const TO_ADDRESS_LABEL_PREFIX = 'to:'

/** An inbound address sweep labels the action 'from:' + addressLabel payload for the payer's zeroth-input P2PKH address. */
export const FROM_ADDRESS_LABEL_PREFIX = 'from:'

type AddressLabelPrefix = typeof TO_ADDRESS_LABEL_PREFIX | typeof FROM_ADDRESS_LABEL_PREFIX

/** Version byte plus hash160: the 21 bytes a P2PKH address encodes. */
const ADDRESS_LABEL_PAYLOAD = /^[0-9a-f]{42}$/i

export type Counterparty = { kind: 'identityKey' | 'address' | 'txid'; value: string }

export type CounterpartySource = { labels?: string[]; senderIdentityKey?: string | null; txid?: string }

/**
 * The label the address rail writes for an address. The wallet folds every
 * label to lower case before storing it (@bsv/sdk's validateLabel), and base58
 * is case-sensitive, so the address's own spelling would come back unreadable.
 * Hex is case-insensitive and the version byte keeps the network, so the label
 * decodes back to exactly the address that was written.
 */
export function addressLabel(prefix: AddressLabelPrefix, address: string): string {
  const { prefix: version, data } = Utils.fromBase58Check(address)
  return prefix + Utils.toHex([...(version as number[]), ...(data as number[])])
}

/**
 * The address behind a to:/from: label. A payload this package did not write
 * (anything but 21 hex bytes) is passed through verbatim rather than dropped:
 * it still names something, and the seed falls back to hashing the string.
 */
function addressFromLabel(label: string): string | undefined {
  for (const prefix of [TO_ADDRESS_LABEL_PREFIX, FROM_ADDRESS_LABEL_PREFIX]) {
    if (!label.startsWith(prefix)) continue
    const payload = label.slice(prefix.length)
    if (payload.length === 0) return undefined
    if (!ADDRESS_LABEL_PAYLOAD.test(payload)) return payload
    const bytes = Utils.toArray(payload, 'hex')
    return Utils.toBase58Check(bytes.slice(1), bytes.slice(0, 1))
  }
  return undefined
}

/**
 * Most specific identification first: a pubkey label (outbound peer payment),
 * then the recorded sender (inbound peer payment), then an address label
 * (either direction of the address rail), then the txid so that every action
 * still gets a stable, if anonymous, face.
 */
export function counterpartyOf(a: CounterpartySource): Counterparty | null {
  const labels = a.labels ?? []
  const keyLabel = labels.find(label => PUBKEY_LABEL.test(label))
  if (keyLabel !== undefined) return { kind: 'identityKey', value: keyLabel }
  const sender = a.senderIdentityKey
  if (typeof sender === 'string' && sender.length > 0 && sender !== SENTINEL_SENDER_KEY) {
    return { kind: 'identityKey', value: sender }
  }
  for (const label of labels) {
    const address = addressFromLabel(label)
    if (address !== undefined) return { kind: 'address', value: address }
  }
  if (typeof a.txid === 'string' && a.txid.length > 0) return { kind: 'txid', value: a.txid }
  return null
}

/** '02abcdef…beef' style: enough of both ends to tell two keys apart at a glance. */
export function abbreviateKey(s: string): string {
  return s.length <= 13 ? s : s.slice(0, 8) + '…' + s.slice(-4)
}

/** Whole bytes only: an odd digit count has no byte form and is not a key or txid. */
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/

/** @bsv/sdk types its base58 parts as `number[] | string`; only the array form is ever returned without `enc`. */
function asBytes(part: number[] | string): number[] {
  return typeof part === 'string' ? Utils.toArray(part, 'hex') : part
}

/**
 * The bytes a counterparty is made of, which every derived property (the
 * shape seed, the hue) reads windows from. A key or txid is its own hex; an
 * address is the version byte followed by the hash160 it encodes, so anything
 * derived from its tail is a property of the key behind it rather than of its
 * base58 spelling, and the mainnet and testnet forms of one key share a face.
 * A value that will not parse still gets 32 deterministic bytes from a hash of
 * the raw string: a stray label must never take down an activity row.
 */
export function counterpartyBytes(cp: Counterparty): number[] {
  try {
    if (cp.kind === 'address') {
      const { prefix, data } = Utils.fromBase58Check(cp.value)
      return [...asBytes(prefix), ...asBytes(data)]
    }
    // Utils.toArray also rejects bad hex, but this is the contract this module
    // relies on, so it is stated here rather than borrowed from SDK internals.
    if (!HEX_BYTES.test(cp.value)) throw new Error('counterpartyBytes: not hex')
    return Utils.toArray(cp.value, 'hex')
  } catch {
    return Hash.sha256(Utils.toArray(cp.value, 'utf8'))
  }
}

/** Big-endian u32 of `bytes[start .. start+4)`. The caller guarantees the window exists. */
function u32At(bytes: number[], start: number): number {
  const [b0, b1, b2, b3] = bytes.slice(start, start + 4)
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0
}

/**
 * A 32-bit seed for the counterparty's sigil shape: the last four bytes. Keys,
 * txids and hash160s are uniformly distributed already, so no further mixing
 * is needed before `patp`. Fewer than four bytes (a short but valid hex
 * string) are hashed first so there is always a tail to read.
 */
export function counterpartySeed(cp: Counterparty): number {
  const bytes = counterpartyBytes(cp)
  const src = bytes.length >= 4 ? bytes : Hash.sha256(bytes)
  return u32At(src, src.length - 4)
}

/**
 * A hue in degrees, 0..359, for the counterparty's sigil tile: the four bytes
 * immediately before the seed bytes, modulo 360. Reading a different window
 * from the seed is the point: two counterparties that happen to share a
 * shape still get different colours, and vice versa, so the tile carries
 * more information than either alone. Fewer than eight bytes are hashed
 * first so there is always a window to read.
 */
export function counterpartyHue(cp: Counterparty): number {
  const bytes = counterpartyBytes(cp)
  const src = bytes.length >= 8 ? bytes : Hash.sha256(bytes)
  return u32At(src, src.length - 8) % 360
}

/** The Urbit @p name sigil-js draws for this counterparty. */
export function sigilPointOf(cp: Counterparty): string {
  return patp(counterpartySeed(cp))
}
