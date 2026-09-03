export const CANARY_UI = 'ui'

// Shared UI primitives (components/ui)
export { showAlert, AlertHost } from './components/ui/AlertCard'
export type { AlertButton, AlertOptions } from './components/ui/AlertCard'
export { showChoiceSheet, choiceSheetOrder } from './components/ui/ChoiceSheet'
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
// planned Task 24 move because UniversalSend/NearbyFlow below
// depend on it directly; see Task 21 report for the full rationale.
export { default as QRScanner } from './components/QRScanner'

// Pay + local-payment UI (components/pay), the P2P payment surfaces (Task 21)
export { default as AddressReceive } from './components/pay/AddressReceive'
export { default as AvailableBalance } from './components/pay/AvailableBalance'
export { default as HandleReceive } from './components/pay/HandleReceive'
export { useMessageBoxConfig, MessageBoxBar, ConfigPanel } from './components/pay/MessageBoxConfig'
export { default as NearbyFlow, type NearbyFlowProps } from './components/pay/NearbyFlow'
export { NearbyAdvisoryModal } from './components/pay/NearbyAdvisoryModal'
export { default as OfflineNotice, offlineActionDetails, type OfflineNoticeProps } from './components/pay/OfflineNotice'
export { default as PayCellRow, type PayCellRowProps } from './components/pay/PayCellRow'
export { PayField, PayAmountField, ConsequenceNote, PayCta, RecipientSummary } from './components/pay/PayForm'
export { default as PaymentQrDisplay } from './components/pay/PaymentQrDisplay'
export { default as PaymentSuccessOverlay, type ReceivedOverlayProps } from './components/pay/PaymentSuccessOverlay'
export { default as RecipientField } from './components/pay/RecipientField'
export { default as ResultBanner } from './components/pay/ResultBanner'
export { default as UniversalSend, type UniversalSendProps } from './components/pay/UniversalSend'
export {
  peerPayValidationMessage,
  classifyIdentitySearchError,
  useRecipientInput,
  type RecipientTarget,
  type RecipientInlineError,
  type UseRecipientInputOptions
} from './components/pay/useRecipientInput'

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
export { WalletCheckScreen, isReviewActionsError, promptCheckWallet } from './screens/WalletCheckScreen'
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

// Vault UI (components/vault) + vault screens (Task 23 — extracted from
// app/vault.tsx, app/vault-recover.tsx, app/vault-transfer.tsx). Also home
// to VaultCeremonySheet, mounted at the app-shell level (app/_layout.tsx)
// alongside PermissionSheet/ToastHost above.
export { EnrollWizard } from './components/vault/EnrollWizard'
export { PassphraseField, type PassphraseFieldProps } from './components/vault/PassphraseField'
export { PhraseBackupSheet } from './components/vault/PhraseBackupSheet'
export { BackupReminderSheet } from './components/wallet/BackupReminderSheet'
export { BiometricAdvisoryModal } from './components/wallet/BiometricAdvisoryModal'
export { ImportFromBackupPrompt } from './components/wallet/ImportFromBackupPrompt'
export { VaultCeremonySheet } from './components/vault/VaultCeremonySheet'
export { useVaultBalance } from './hooks/useVaultBalance'
export { VaultScreen } from './screens/VaultScreen'
export { VaultRecoverScreen } from './screens/VaultRecoverScreen'
export { VaultTransferScreen } from './screens/VaultTransferScreen'

// Connections, pair, trust, and logs screens (Task 24 — extracted from
// app/connections.tsx, app/pair.tsx, app/trust.tsx, app/logs.tsx).
// validateTrust.ts/isImageUrl.ts moved alongside TrustScreen as its only
// dependency in app-root utils/ (deterministicColor.ts/deterministicImage.ts
// stayed put — nothing moving in this task references them). QRScanner was
// already pulled forward in Task 21; see the components section above.
export { ConnectionsScreen } from './screens/ConnectionsScreen'
export { PairScreen } from './screens/PairScreen'
export { TrustScreen } from './screens/TrustScreen'
export { LogsScreen } from './screens/LogsScreen'
export { default as validateTrust } from './validateTrust'
export { default as isImageUrl } from './isImageUrl'
