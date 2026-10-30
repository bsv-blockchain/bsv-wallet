// @ts-nocheck
import { PublicKey, type WalletEncryptionArgs, type WalletInterface } from '@bsv/sdk'
import { createWalletClient } from '../wallet'

export type CryptoWallet = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt' | 'createHmac' | 'verifyHmac' | 'createSignature' | 'verifySignature'>
export const reliabilityWallet = createWalletClient
export const scope: WalletEncryptionArgs = {
  protocolID: [1, 'fast reliability'],
  keyID: 'deterministic probe',
  counterparty: 'self',
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function checkBytes(bytes: unknown, label: string): asserts bytes is number[] {
  check(Array.isArray(bytes) && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), `${label} must contain bytes`)
}

export function sameBytes(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

export function checkPublicKey(key: string) {
  check(/^(02|03)[0-9a-fA-F]{64}$/.test(key), 'Expected a compressed public key')
  check(PublicKey.fromString(key).validate(), 'Public key must be on the curve')
}

export async function expectWalletError(run: () => Promise<unknown>, codes: (string | number)[], messages: string[]) {
  try {
    await run()
  } catch (error) {
    const code = error != null && typeof error === 'object' && 'code' in error ? error.code : undefined
    const message = error instanceof Error ? error.message : ''
    if (codes.includes(code as string | number) || (code == null && messages.includes(message))) return
    throw error // Transport, authentication and permission failures are not successful negative tests.
  }
  throw new Error('Wallet accepted a request that should have been rejected')
}
