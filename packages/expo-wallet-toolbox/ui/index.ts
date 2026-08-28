export const CANARY_UI = 'ui'

// Shared UI primitives (components/ui)
export { showAlert, AlertHost } from './components/ui/AlertCard'
export type { AlertButton, AlertOptions } from './components/ui/AlertCard'
export { default as AppLogo } from './components/ui/AppLogo'
export { BlurChrome } from './components/ui/BlurChrome'
export { default as Celebration } from './components/ui/Celebration'
export { default as CustomSafeArea } from './components/ui/CustomSafeArea'
export { ErrorBoundary } from './components/ui/ErrorBoundary'
export { GroupedList, GroupedSection } from './components/ui/GroupedList'
export { IconButton } from './components/ui/IconButton'
export { ListRow } from './components/ui/ListRow'
export { default as PermissionSheet } from './components/ui/PermissionSheet'
export { default as PressableScale } from './components/ui/PressableScale'
export { default as PresenceRow } from './components/ui/PresenceRow'
export type { PresenceState } from './components/ui/PresenceRow'
export { default as ScreenGradient } from './components/ui/ScreenGradient'
export { default as Sheet } from './components/ui/Sheet'
export { showToast, ToastHost } from './components/ui/Toast'
export type { ToastType } from './components/ui/Toast'

// Security UI (components/security)
export { default as WalletLockNotice } from './components/security/WalletLockNotice'

// Wallet UI (components/wallet) — AmountDisplay pre-moved here (Task 19) as a
// hard dependency of PermissionSheet; the rest moved in Task 20.
export { default as AmountDisplay } from './components/wallet/AmountDisplay'
export { default as ActivityRow, formatRowTime, type ActivityAction } from './components/wallet/ActivityRow'
export { AmountInput, SatsAmountInput, SEND_MAX_VALUE } from './components/wallet/AmountInput'
export { default as Balance } from './components/wallet/Balance'

// Wallet home screen (Task 20 — extracted from app/index.tsx)
export { WalletHomeScreen } from './screens/WalletHomeScreen'

// Wallet-screen support utilities, moved alongside the screen (Task 20)
export * from './txStatus'
export { exportTransactionsAsCsv } from './exportTransactions'

// Identity resolution and spendable-balance helpers, promoted here (Task 21)
// as hard dependencies of the pay UI below — same flat-at-root treatment as
// txStatus.ts/exportTransactions.ts (Task 20).
export * from './resolveIdentity'
export { useSpendableBalance } from './hooks/useSpendableBalance'

// QR scanner (components/QRScanner) — pulled forward from its originally
// planned Task 24 move because AddressSend/HandleSend/NearbyFlow below
// depend on it directly; see Task 21 report for the full rationale.
export { default as QRScanner } from './components/QRScanner'

// Pay + local-payment UI (components/pay), the P2P payment surfaces (Task 21)
export { default as AddressReceive } from './components/pay/AddressReceive'
export { default as AddressSend } from './components/pay/AddressSend'
export { default as AvailableBalance } from './components/pay/AvailableBalance'
export { default as HandleReceive } from './components/pay/HandleReceive'
export { default as HandleSend, type HandleSendProps } from './components/pay/HandleSend'
export { useMessageBoxConfig, MessageBoxBar, ConfigPanel } from './components/pay/MessageBoxConfig'
export { default as NearbyFlow, type NearbyFlowProps } from './components/pay/NearbyFlow'
export { default as OfflineNotice, type OfflineNoticeProps } from './components/pay/OfflineNotice'
export { default as PayCellRow, type PayCellRowProps } from './components/pay/PayCellRow'
export { PayField, PayAmountField, ConsequenceNote, PayCta, RecipientSummary } from './components/pay/PayForm'
export { default as PaymentQrDisplay } from './components/pay/PaymentQrDisplay'
export { default as PaymentSuccessOverlay, type ReceivedOverlayProps } from './components/pay/PaymentSuccessOverlay'
export { default as RecipientField } from './components/pay/RecipientField'
export { default as ResultBanner } from './components/pay/ResultBanner'
export { peerPayValidationMessage, useIdentitySearch } from './components/pay/useIdentitySearch'

// Pay screen (Task 21 — extracted from app/pay.tsx) and the online-status hook
// it, and several pay cells above, depend on.
export { PayScreen } from './screens/PayScreen'
export { useOnline } from './hooks/useOnline'

// Settings + wallet-config screens (Task 22 — extracted from app/settings.tsx
// and app/wallet-config.tsx), plus the recovery/backup utilities they, the
// share-scanning route (app/auth/scan-shares.tsx) and scripts/generate-pdf.ts
// depend on. backupShares.ts moved in alongside printRecoveryShares.ts
// (rather than staying a `@/utils` import reaching outside the package) so
// printRecoveryShares.ts never imports across the package boundary.
export { SettingsScreen } from './screens/SettingsScreen'
export { WalletConfigScreen } from './screens/WalletConfigScreen'
export { exportAllWalletDatabases } from './exportDatabases'
export { importWalletDatabase, type ImportResult } from './importDatabases'
export { printRecoveryShares, type PrintSharesSources, type PrintSharesResult } from './printRecoveryShares'
export {
  parseShare,
  validateShareCompatibility,
  recoverSecretFromShares,
  generatePrintHTML,
  type ParsedShare,
  type RecoveredSecret
} from './backupShares'
