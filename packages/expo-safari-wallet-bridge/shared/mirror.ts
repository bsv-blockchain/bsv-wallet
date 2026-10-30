/**
 * The mirror (spec 6.5): the app's state as one sealed file the extension reads while the app is
 * not running. Types and the connected-site hash only; the writer is `src/mirror.ts` (Task 17).
 */
import { Hash, Utils } from '@bsv/sdk'
import type { BridgeReadiness } from '@bsv/expo-wallet-toolbox/core/bridge/runtime'

export interface MirrorSnapshot {
  schema: 1
  baseVersion: string
  network: string
  accountContext: string
  walletRevision: string
  readiness: BridgeReadiness
  closeSeq: number
}

export interface Mirror {
  v: 1
  writerBootId: string
  writtenAt: number
  snapshot: MirrorSnapshot
  /** 33-byte compressed identity key as hex; null unless `readiness` is `ready`. */
  identityKey: string | null
  /** The policy flag `seekPermissionsForIdentityKeyRevelation` (verified set). */
  identityKeyPrompts: boolean
  /** Sorted `connectedHash` list of browser-attested connected sites. */
  connected: string[]
}

/** Hex SHA-256 of `"bsv-bridge/connected/v1|" + origin` (canonical origin string). */
export function connectedHash(origin: string): string {
  return Utils.toHex(Hash.sha256(Utils.toArray('bsv-bridge/connected/v1|' + origin, 'utf8')))
}
