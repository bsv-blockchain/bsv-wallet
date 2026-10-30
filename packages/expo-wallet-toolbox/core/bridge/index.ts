/** Public API of the browser bridge core (spec 6.9). Transports and hosts import from here. */
export { BrowserBridgeProvider } from './BrowserBridgeProvider'
export {
  DEFAULT_BASE_VERSION,
  getBridgeSnapshot,
  getPermissionPolicy,
  listConnectedSites,
  notifyPromptRaised,
  onSnapshotChange,
  registerTransport,
  revokeSite,
  setPermissionPolicy,
  type AttentionReason,
  type BridgeReadiness,
  type BridgeSnapshot,
  type TransportHandle,
  type TransportRegistration
} from './runtime'
export type { Binding, CloseEvent } from './bindings'
export type { ConnectionError } from './protocol/connectionError'
export { setConsentSheetSource, type ConsentSheetSource } from './consentSheetSource'
