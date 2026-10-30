import { b64uEncode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import { buildLaunchUri, helloMac } from '@bsv/expo-wallet-toolbox/core/bridge/loopback/launchProof'
import type { BridgeSnapshot } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'

export const SCHEME = 'bsv-wallet-bridge'

export function epochOf(i: number): string {
  return `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
}

export function kOf(i: number): Uint8Array {
  return new Uint8Array(32).fill(i + 1)
}

export function nOf(i: number): string {
  return b64uEncode(new Uint8Array(16).fill(i + 1))
}

export function uriOf(i: number): string {
  return buildLaunchUri({ scheme: SCHEME, epoch: epochOf(i), k: kOf(i), n: nOf(i) })
}

export function helloFor(i: number, origin = 'https://example.com', host = '127.0.0.1:3321'): string {
  return helloMac(kOf(i), { origin, challenge: b64uEncode(new Uint8Array(32).fill(7)), host })
}

export const CHALLENGE = b64uEncode(new Uint8Array(32).fill(7))

export function snapshot(patch: Partial<BridgeSnapshot> = {}): BridgeSnapshot {
  return {
    schema: 1,
    baseVersion: '1',
    network: 'main',
    accountContext: 'a',
    walletRevision: '1',
    readiness: 'ready',
    closeSeq: 0,
    hostAttached: true,
    ...patch
  }
}

export const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>(r => setImmediate(r))
}
