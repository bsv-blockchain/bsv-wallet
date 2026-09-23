/**
 * Demo mode — a wallet full of obviously-fake money, for showing the app.
 *
 * DEV-ONLY, and structured so that it is not merely inert in production but
 * absent from it: every call site requires this barrel from inside a `__DEV__`
 * branch, and `__DEV__` is inlined to `false` at release bundle time, so the
 * whole folder folds out. Same pattern as `utils/AgentationGate.tsx`.
 *
 * Nothing in here touches SQLite, the keychain, an overlay or the network.
 */
export { DEMO_ASSETS, DEMO_CHF, DEMO_COUNTERPARTIES, DEMO_USD, demoAssetById } from './demoAssets'
export {
  demoReceiveBsv,
  demoReceiveToken,
  demoSendBsv,
  demoSendToken,
  demoTokenActivity,
  demoTokenBaseUnits,
  resetDemoLedger,
  subscribeDemoLedger,
  type DemoAction
} from './demoLedger'
export { isDemoModeEnabled, setDemoModeEnabled, subscribeDemoMode } from './demoMode'
export { createDemoMandalaRuntime } from './demoMandalaRuntime'
export { demoListActions, demoWalletBalance, type DemoListActionsResult } from './demoWallet'
export { useDemoLedgerVersion, useDemoMandalaRuntime, useDemoMode } from './useDemo'
