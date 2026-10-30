/** Public API of the browser bridge core (spec 6.9). Transports and hosts import from here. */
export { BrowserBridgeProvider } from './BrowserBridgeProvider'
export {
  DEFAULT_BASE_VERSION,
  getBindingRegistry,
  getBridgeSnapshot,
  getPermissionPolicy,
  getTransport,
  initBridgeRuntime,
  isBridgeHostAttached,
  onBindingClosed,
  listConnectedSites,
  notifyPromptRaised,
  onConnectedSitesChange,
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

// The inbox transport API (spec 6.15 item 1): what a cross-process transport (project 2) drives.
export { createInboxProcessor, inboxDigest, resolveInboxResult, type InboxProcessor, type InboxStore } from './inbox'
export { createMemoryInboxStore } from './memoryInboxStore'
export { dispatch, type Dispatcher, type Outcome } from './dispatcher'
// The session teardown registry lives with the wallet context; transports reset their state from it.
export { registerSessionTeardown, type TeardownReason } from '../context/sessionTeardown'

// The pure protocol modules the Safari extension bundles. No app imports (bundleSafe.test.ts).
export * from './protocol/constants'
export * from './protocol/limits'
export * from './protocol/base64url'
export * from './protocol/json'
export * from './protocol/methods'
export * from './protocol/connectionError'
export * from './protocol/envelopes'
export * from './protocol/descriptor'
export * from './protocol/origin'

// The pure loopback HTTP semantics for the Android kit (spec: Android design 6.2, 6.6).
export * as loopback from './loopback'
