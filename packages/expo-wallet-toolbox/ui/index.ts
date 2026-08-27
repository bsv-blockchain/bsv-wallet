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
// hard dependency of PermissionSheet; the rest of components/wallet lands in
// a later task.
export { default as AmountDisplay } from './components/wallet/AmountDisplay'
