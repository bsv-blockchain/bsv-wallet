export const CANARY = 'core'

export { recoverMnemonicWallet, generateMnemonicWallet, validateMnemonic } from './mnemonicWallet'
export {
  getRegisteredDbs,
  registerDb,
  selectLatestDb,
  parseDbFilename,
  parseTimestampFromFilename
} from './walletDbRegistry'
export { configureNewHeaderPolling } from './walletMonitor'
export { TaskSendOffline } from './monitor/TaskSendOffline'
export { TaskCreditInbox } from './monitor/TaskCreditInbox'
export { TaskDrainOutbox, drainUnsentEntries } from './monitor/TaskDrainOutbox'
export { getOnline, subscribeOnline } from './net/online'
export * from './logging'
export * from './diskSpace'
export type { AppChain, WalletChain } from './config'
export {
  toWalletChain,
  DEFAULT_WAB_URL,
  DEFAULT_STORAGE_URL,
  DEFAULT_MESSAGEBOX_URL,
  DEFAULT_BACKUP_URL,
  DEFAULT_CHAIN,
  ADMIN_ORIGINATOR
} from './config'

// Theme tokens and providers
export { ThemeProvider, useTheme } from './theme/ThemeContext'
export { spacing, radii, typography, lightColors, darkColors, hitTargets } from './theme/tokens'
export { easings, springs, durations } from './theme/motion'
export { useThemeStyles } from './theme/useThemeStyles'

// Amount formatting helpers
export {
  formatAmount,
  formatAmountParts,
  formatAmountInInputUnit,
  formatSatoshisAsFiat,
  formatSatoshisAsBsv,
  formatSatoshisAsBsvDecimal,
  parseDisplayToSatoshis,
  getUnitLabel,
  formatSatoshis
} from './amountFormatHelpers'

// Internationalization
export { LanguageProvider } from './i18n/translations'
export { default as i18n } from './i18n/translations'

// Local peer-to-peer payment transport protocol
export * from './localpay/codec'
export * from './localpay/session'
export * from './localpay/build'
export * from './localpay/pending'
export * from './localpay/pendingAborts'
export * from './localpay/sessionPolicy'
export * from './localpay/verify'
export * from './localpay/qr'
export * from './localpay/nearbyPermissions'
// The transport interface and its two error classes are part of the public
// surface now that the screen holds LocalPaymentTransport[] (spec §6) and
// callers need to tell an AckError (radio failure → fountain) from a decline.
export { AckError, QrHandoffRequired, type Ack, type LocalPaymentTransport, type ReceivedFrame } from './localpay/types'
export { selectTransport } from './localpay/transport/select'
export * from './peerpay/outbox'
export * from './peerpay/control'
export * from './peerpay/handleResendRequests'
export * from './peerpay/resendBeef'
export * from './backup/status'
export * from './monitor/unfailRetry'
export * from './peerpay/offlineNacks'
export * from './peerpay/inboxAttempts'

// Offline-payment queueing
export * from './offline/hold'
export * from './offline/order'
export * from './offline/plan'
export * from './offline/payerHold'

// Local SQLite storage layer
export { StorageExpoSQLite } from './storage/StorageExpoSQLite'
export type { StorageExpoSQLiteOptions } from './storage/StorageExpoSQLite'
export { createTables, ensureOfflineActionsColumns } from './storage/schema/createTables'
export { initializeLocalStorage, isLocalStorage, getStorageDisplayName } from './storage/LocalStorageAdapter'
export type { LocalStorageConfig } from './storage/LocalStorageAdapter'
export { findOfflineActions, updateOfflineAction } from './storage/methods/offlineActions'
export type { OfflineActionRow, OfflineActionStatus, BindValue } from './storage/methods/offlineActions'
export { readWalletBalance } from './storage/methods/walletBalanceSql'
export { processOfflineActions } from './storage/methods/processOfflineActions'
export * from './storage/skipQueuedAncestors'

// Local secrets storage
export {
  default as LocalStorageProvider,
  useLocalStorage,
  LocalStorageContext,
  type LocalStorageContextType
} from './context/LocalStorageProvider'

// User context and native handlers
export { UserContextProvider, UserContext } from './context/UserContext'
export type { NativeHandlers } from './context/UserContext'

// Exchange rate context and service
export { ExchangeRateContextProvider, ExchangeRateContext } from './context/ExchangeRateContext'
export { getExchangeRate } from './services/exchangeRate'

// Pay rails
export * from './pay/rails'
export * from './pay/beefRepair'
export * from './pay/creditErrors'
export * from './pay/creditInbox'
export * from './pay/userError'
export * from './pay/rails/address'
export * from './pay/rails/handle'
// nearby.ts is a pure re-export barrel over localpay/* (already exported above)
// and @bsv/air-gap; only its genuinely new names are re-exported here by hand —
// a blanket `export *` would collide (TS2308) with the localpay/offline exports
// above, since most of nearby.ts's surface is itself a re-export of those.
// CAP_BLE is listed although `export * from './localpay/session'` already
// carries it: an explicit re-export takes precedence over a star export, so
// this is legal, and it keeps the block a faithful mirror of nearby.ts.
export {
  AIR_GAP_PREFIX,
  AirGapDecoder,
  AirGapEncoder,
  MAX_MESSAGE_BYTES,
  estimatePartCharLength,
  isAirGapPart,
  awdlTransport,
  nearbyTransport,
  bleTransport,
  localSupportsAwdl,
  localSupportsNearby,
  localSupportsBle,
  describeFloor,
  requestBlePermissions,
  probeDeviceCaps,
  capsFromProbe,
  readBluetoothState,
  prepareBle,
  raceReceivers,
  CAP_BLE,
  isDeclineReason,
  type TransportKind,
  type FloorReason,
  type DeviceProbe,
  type BluetoothState,
  type RaceWinner,
  type RadioKind,
  type ConfirmDelivery,
  type DeclineReason
} from './pay/rails/nearby'
export * from './pay/sweeper'
export * from './pay/proofNudge'
// watchlist.ts's own KVStorage is omitted: it is structurally identical to the
// KVStorage already exported from './localpay/pending' above, and re-exporting
// both would collide (TS2308) on the name.
export {
  WATCHLIST_KEY,
  MAX_WATCHED,
  WATCH_TTL_MS,
  WATCH_UNSWEPT_TTL_MS,
  MAX_WATCH_DAYS,
  type WatchedAddress,
  pruneWatchlist,
  watchAddress,
  getWatchlist,
  touchWatched,
  unwatchAddress
} from './pay/watchlist'
export * from './parsePeerPayURI'

// Blockchain header sync / checkpointing
export * from './headers/checkpoints'
export * from './headers/fs'
export * from './headers/headerStore'
export * from './headers/OfflineFirstChaintracks'
export * from './headers/prewarm'
export * from './headers/syncHeaders'

// Wallet-relevant constants (auto-approve thresholds, ARC broadcast URLs)
export * from './constants'

// Wallet service configuration, ARC broadcast providers, argument-size cap
//
// './deviceTier' is deliberately NOT re-exported here: capWalletArgs.ts loads
// it with a lazy `require(...)` (not a static import) specifically so that
// expo-device — a native module unavailable in Jest and any non-native host —
// is never pulled in at module-load time. A barrel `export *` would undo that
// by making every consumer of the package eagerly load it, which is exactly
// what broke the packageResolution canary during this move. It stays an
// internal implementation file, reached only via relative import from
// services/capWalletArgs.ts and services/walletArgLimits.ts (the latter as a
// type-only import, which is erased at compile time).
export * from './services/walletServiceConfig'
export * from './services/arcadeBroadcastProvider'
export * from './services/walletArgLimits'
export * from './services/capWalletArgs'

// Encrypted wallet backup log
export * from './backup/RemoteSyncReader'
export * from './backup/client'
export * from './backup/codec'
export * from './backup/constants'
export * from './backup/cursor'
export * from './backup/derive'
export * from './backup/deviceId'
export * from './backup/erase'
export * from './backup/preference'
export * from './backup/push'
export * from './backup/restore'
export * from './backup/restoreOnImport'
export * from './walletRepair/runWalletCheck'
export { TaskBackupPush } from './monitor/TaskBackupPush'

// Hardware vault: YubiKey PIV custody, ceremony state machine, K1 script,
// sealing/session/derivation crypto, transfers (deposit/withdraw/sweep/
// reclaim), persistence, passphrase policy, access guard, backup attestation.
//
// 'driver.ts' and 'random.ts' both reach for a native module
// (react-native-yubikey, expo-crypto) with a `require(...)` INSIDE a
// function body (loadNative() / randomBytes()), never at module top level —
// unlike './deviceTier' (see the comment above), so re-exporting them here
// does not force either native module to load eagerly; the require only
// fires when a caller actually invokes getVaultDriver()/randomBytes().
export * from './services/vault/types'
export * from './services/vault/driver'
export * from './services/vault/session'
export * from './services/vault/random'
export * from './services/vault/sealing'
export * from './services/vault/k1'
export * from './services/vault/vaultDerivation'
export * from './services/vault/vaultPassphrase'
export * from './services/vault/vaultStore'
export * from './services/vault/mockYubiKey'
export * from './services/vault/devMock'
export * from './services/vault/guard'
export * from './services/vault/backupAttestation'
export * from './services/vault/ceremony'
export * from './services/vault/ceremonyHost'
export * from './services/vault/VaultKeyService'
export * from './services/vault/transfers'

// Connection/pairing state (QR-paired desktop sessions), the vault ceremony
// context (React face of the ceremonyHost singleton), and the shared
// device-feedback hooks (haptics + confirmation/vault tones) both contexts
// depend on. VaultContext takes an `onToast` callback rather than importing
// a ui Toast component directly — core must never import from ui.
//
// useHaptics.ts requires expo-haptics lazily (inside each haptics.* call),
// not at module top level, for the same reason 'deviceTier' and
// services/vault/driver.ts+random.ts stay lazy: a native module imported
// statically at the top of a barrel-exported file loads eagerly for every
// consumer of the package, including hosts (tests, non-native environments)
// that never trigger a haptic. useConfirmationSound.ts already requires
// expo-audio the same way.
export { default as connectionStore } from './stores/ConnectionStore'
export type { Connection } from './stores/ConnectionStore'
export * from './context/WalletConnectionContext'
export * from './context/VaultContext'
export * from './hooks/useHaptics'
export * from './hooks/useConfirmationSound'

// WalletContext — the core hub wiring together storage, headers, localpay,
// backup, vault-ceremony bridging, and monitor tasks. Only its two actually-
// consumed exports are re-exported here (WalletContextProvider, useWallet) —
// its narrow selector hooks (useWalletStatus, useWalletQueues,
// useTxStatusVersion), WalletManagersContext, and the various *Value/*Slice
// types have zero current consumers anywhere in the app, so they are left
// off the barrel for now (same "only what's actually used" convention as
// Task 3's motion.ts/useThemeStyles.tsx) — reachable via a relative import
// from inside the package if a future task needs them, and easy to add here
// once a real consumer exists. WalletContextProvider takes an optional
// onToast prop (see WalletContext.tsx's WalletContextToast type) rather than
// importing a ui Toast component directly — core must never import from ui,
// same boundary as VaultContext's onToast above.
export { WalletContextProvider, useWallet, WalletContext } from './context/WalletContext'
export { usePermissionQueue } from './hooks/usePermissionQueue'
