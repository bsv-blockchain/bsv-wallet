export const CANARY = 'core'

export { recoverMnemonicWallet } from './mnemonicWallet'
export { getRegisteredDbs, registerDb, selectLatestDb, parseDbFilename } from './walletDbRegistry'
export { configureNewHeaderPolling } from './walletMonitor'
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
