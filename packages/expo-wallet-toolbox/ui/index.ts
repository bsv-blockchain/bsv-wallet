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
