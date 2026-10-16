import { ProtoWallet, PublicKey, Random, type WalletInterface } from '@bsv/sdk'
import { decodeSession, type Session } from '../localpay/session'

export const POS_PROTOCOL: [2, string] = [2, 'bsv pos authorization']
export const POS_PREFIX = 'bsvpos1:'
export type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>
export interface Signed<T> {
  payload: T
  identityKey: string
  signature: number[]
}
export interface Invite {
  kind: 'invite'
  merchant: string
  name: string
  service: string
  chain: string
  id: string
  expires: number
}
export interface MerchantRequest {
  kind: 'payment'
  merchant: string
  name: string
  cashier: string
  invoice: string
  chain: string
  expires: number
  session: string
  subtotal?: number
  tip?: number
}
export interface Rpc {
  version: 1
  method: string
  nonce: string
  time: number
  body: Record<string, unknown>
}
export interface Receipt {
  invoice: string
  txid: string
  amount: number
  status: 'accepted'
}
export function randomId(): string {
  return Array.from(Random(16), b => b.toString(16).padStart(2, '0')).join('')
}
export function key(value: unknown): string {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/i.test(value)) throw new Error('Invalid identity')
  PublicKey.fromString(value)
  return value.toLowerCase()
}
export function serviceUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid service address')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTPS merchant service address')
  return url.toString().replace(/\/$/, '')
}
/** Sorted JSON fields and consistent Unicode separators across Go and JS. */
export function bytes(payload: unknown): number[] {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map(k => [k, ordered((v as Record<string, unknown>)[k])])
          )
        : v
  const text = JSON.stringify(ordered(payload))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return Array.from(new TextEncoder().encode(text))
}
export async function sign<T>(wallet: Signer, payload: T, originator?: string): Promise<Signed<T>> {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  const { signature } = await wallet.createSignature(
    { protocolID: POS_PROTOCOL, keyID: 'v1', counterparty: 'anyone', data: bytes(payload) },
    originator
  )
  return { payload, identityKey: key(publicKey), signature }
}
export async function verify<T>(value: Signed<T>, expected?: string): Promise<T> {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.signature) ||
    value.signature.length > 80 ||
    !value.signature.every(b => Number.isInteger(b) && b >= 0 && b <= 255)
  )
    throw new Error('Invalid merchant authorization')
  const identity = key(value.identityKey)
  if (expected && identity !== key(expected)) throw new Error('Merchant identity does not match')
  const result = await new ProtoWallet('anyone').verifySignature({
    protocolID: POS_PROTOCOL,
    keyID: 'v1',
    counterparty: identity,
    data: bytes(value.payload),
    signature: value.signature
  })
  if (!result.valid) throw new Error('Invalid merchant signature')
  return value.payload
}
export function encodePos(value: Signed<Invite | MerchantRequest>): string {
  return (
    POS_PREFIX +
    globalThis
      .btoa(unescape(encodeURIComponent(JSON.stringify(value))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  )
}
export async function decodePos(text: string): Promise<Signed<Invite | MerchantRequest>> {
  if (!text.startsWith(POS_PREFIX) || text.length > 12000) throw new Error('Invalid point-of-sale code')
  const raw = text.slice(POS_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  const value = JSON.parse(
    decodeURIComponent(escape(globalThis.atob(raw + '='.repeat((4 - (raw.length % 4)) % 4))))
  ) as Signed<Invite | MerchantRequest>
  const p = await verify(value)
  if (
    !p ||
    !['invite', 'payment'].includes(p.kind) ||
    key(p.merchant) !== key(value.identityKey) ||
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    p.name.length > 80 ||
    !Number.isSafeInteger(p.expires) ||
    p.expires <= Date.now() ||
    !['main', 'test', 'teratest'].includes(p.chain)
  )
    throw new Error('Expired or invalid merchant code')
  if (p.kind === 'invite') {
    serviceUrl(p.service)
    if (typeof p.id !== 'string' || !/^[a-f0-9]{32}$/.test(p.id)) throw new Error('Invalid enrollment code')
  } else {
    key(p.cashier)
    if (typeof p.invoice !== 'string' || !/^[a-f0-9]{32}$/.test(p.invoice)) throw new Error('Invalid invoice')
    const session = decodeSession(p.session)
    if (key(session.identityKey) !== key(p.merchant) || !session.amount || session.asset)
      throw new Error('Merchant request has an invalid destination')
    if (p.subtotal !== undefined || p.tip !== undefined) {
      const tip = p.tip ?? 0
      if (
        !Number.isSafeInteger(p.subtotal) ||
        p.subtotal! < 1 ||
        !Number.isSafeInteger(tip) ||
        tip < 0 ||
        tip > session.amount ||
        p.subtotal !== session.amount - tip
      )
        throw new Error('Merchant request has an invalid tip breakdown')
    }
  }
  return value
}
export async function decodePaymentRequest(text: string): Promise<Session> {
  if (!text.startsWith(POS_PREFIX)) return decodeSession(text)
  const { payload } = await decodePos(text)
  if (payload.kind !== 'payment') throw new Error('This code enrolls a cashier; it is not a payment request')
  return {
    ...decodeSession(payload.session),
    merchantName: payload.name,
    merchantChain: payload.chain,
    merchantExpires: payload.expires,
    merchantSubtotal: payload.subtotal,
    merchantTip: payload.tip
  }
}
