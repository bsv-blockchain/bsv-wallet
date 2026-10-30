/**
 * The 28 BRC-100 methods the bridge carries, with the two properties the dispatcher needs
 * (spec 6.6): whether the call changes wallet state (so backup is nudged on every outcome) and
 * whether it is a probe (answered without consent, a wallet call or a wait).
 *
 * Typed against the SDK's `WalletInterface`, so adding a method there fails type-checking until
 * it is classified here.
 */
import type { WalletInterface } from '@bsv/sdk'

export type WalletMethodName = keyof WalletInterface

export interface BridgeMethodInfo {
  mutating: boolean
  probe: boolean
}

const read: BridgeMethodInfo = Object.freeze({ mutating: false, probe: false })
const write: BridgeMethodInfo = Object.freeze({ mutating: true, probe: false })
const probe: BridgeMethodInfo = Object.freeze({ mutating: false, probe: true })

export const BRIDGE_METHODS: Readonly<Record<WalletMethodName, BridgeMethodInfo>> = Object.freeze({
  getPublicKey: read,
  revealCounterpartyKeyLinkage: read,
  revealSpecificKeyLinkage: read,
  encrypt: read,
  decrypt: read,
  createHmac: read,
  verifyHmac: read,
  createSignature: read,
  verifySignature: read,
  createAction: write,
  signAction: write,
  abortAction: write,
  listActions: read,
  internalizeAction: write,
  listOutputs: read,
  relinquishOutput: write,
  acquireCertificate: write,
  listCertificates: read,
  proveCertificate: read,
  relinquishCertificate: write,
  discoverByIdentityKey: read,
  discoverByAttributes: read,
  isAuthenticated: probe,
  waitForAuthentication: read,
  getHeight: read,
  getHeaderForHeight: read,
  getNetwork: read,
  getVersion: probe
})

export function isBridgeMethod(name: unknown): name is WalletMethodName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(BRIDGE_METHODS, name)
}
