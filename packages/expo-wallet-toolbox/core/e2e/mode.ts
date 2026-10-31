/**
 * End-to-end harness switch.
 *
 * Off unless the host passes `e2e` to `configureToolbox`. Production builds
 * never do. The flag lives here, a leaf, so profile storage and the key
 * policy can read it without importing the rest of the toolbox.
 *
 * When it is on, `main` is not a chain this process will open. The public
 * test vector used by the suite must not be able to reach mainnet.
 */
import type { AppChain } from '../config'

let broadcasterUrl: string | undefined

export function setE2eMode(url: string | undefined): void {
  broadcasterUrl = url
}

export function isE2eBuild(): boolean {
  return broadcasterUrl !== undefined
}

/** The mock broadcaster origin, or undefined when this is not an E2E build. */
export function getE2eBroadcasterUrl(): string | undefined {
  return broadcasterUrl
}

/**
 * The chain a build is allowed to open.
 *
 * An E2E build that was asked for mainnet gets testnet instead. Every other
 * chain, and every chain in a normal build, is returned unchanged.
 */
export function e2eSafeChain(chain: AppChain): AppChain {
  if (broadcasterUrl !== undefined && chain === 'main') return 'test'
  return chain
}

/** Test-only. */
export function resetE2eMode(): void {
  broadcasterUrl = undefined
}
