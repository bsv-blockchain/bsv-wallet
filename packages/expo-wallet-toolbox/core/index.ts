export const CANARY = 'core'

export { recoverMnemonicWallet } from './mnemonicWallet'
export { getRegisteredDbs, registerDb, selectLatestDb, parseDbFilename } from './walletDbRegistry'
export { configureNewHeaderPolling } from './walletMonitor'
export { TaskSendOffline } from './monitor/TaskSendOffline'
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

// Internationalization
export { LanguageProvider } from './i18n/translations'
export { default as i18n } from './i18n/translations'

// Local peer-to-peer payment transport protocol
export * from './localpay/codec'
export * from './localpay/session'
export * from './localpay/build'
export * from './localpay/pending'
export * from './localpay/verify'
export * from './localpay/qr'
export * from './localpay/nearbyPermissions'
export type { Ack } from './localpay/types'
export { selectTransport } from './localpay/transport/select'
export * from './peerpay/outbox'

// Offline-payment queueing
export * from './offline/hold'
export * from './offline/order'
export * from './offline/plan'
export * from './offline/payerHold'

// Local SQLite storage layer
export { StorageExpoSQLite } from './storage/StorageExpoSQLite'
export type { StorageExpoSQLiteOptions } from './storage/StorageExpoSQLite'
export { createTables } from './storage/schema/createTables'
export { initializeLocalStorage, isLocalStorage, getStorageDisplayName } from './storage/LocalStorageAdapter'
export type { LocalStorageConfig } from './storage/LocalStorageAdapter'
export { findOfflineActions } from './storage/methods/offlineActions'
export type { OfflineActionRow } from './storage/methods/offlineActions'
export { readWalletBalance } from './storage/methods/walletBalanceSql'

// Local secrets storage
export { default as LocalStorageProvider, useLocalStorage, LocalStorageContext, type LocalStorageContextType } from './context/LocalStorageProvider'

// User context and native handlers
export { UserContextProvider, UserContext } from './context/UserContext'
export type { NativeHandlers } from './context/UserContext'

// Exchange rate context and service
export { ExchangeRateContextProvider, ExchangeRateContext } from './context/ExchangeRateContext'
export { getExchangeRate } from './services/exchangeRate'

// Pay rails
export * from './pay/rails'
export * from './pay/rails/address'
export * from './pay/rails/handle'
// nearby.ts is a pure re-export barrel over localpay/* (already exported above)
// and @bsv/air-gap; only its genuinely new names are re-exported here by hand —
// a blanket `export *` would collide (TS2308) with the localpay/offline exports
// above, since most of nearby.ts's surface is itself a re-export of those.
export {
  AIR_GAP_PREFIX,
  AirGapDecoder,
  AirGapEncoder,
  MAX_MESSAGE_BYTES,
  estimatePartCharLength,
  isAirGapPart,
  awdlTransport,
  nearbyTransport,
  localSupportsAwdl,
  localSupportsNearby,
  isDeclineReason,
  type TransportKind,
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
  MAX_WATCH_DAYS,
  type WatchedAddress,
  pruneWatchlist,
  watchAddress,
  getWatchlist,
  touchWatched,
  unwatchAddress
} from './pay/watchlist'
export * from './parsePeerPayURI'
