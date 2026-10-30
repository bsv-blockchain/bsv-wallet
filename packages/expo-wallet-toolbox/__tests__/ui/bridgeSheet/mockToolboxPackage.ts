/**
 * Stands in for the package self-import (`@bsv/expo-wallet-toolbox`) that `PermissionSheet` and its cards use, with
 * the REAL context objects and formatters loaded by relative path. The package barrel pulls in the whole wallet and
 * is too heavy to load in a unit test; the contexts must be the real ones so a poisoned default is the default the
 * sheet would really fall back to.
 */
export function toolboxPackageStandIn(): Record<string, unknown> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const theme = require('../../../core/theme/ThemeContext')
  const tokens = require('../../../core/theme/tokens')
  const motion = require('../../../core/theme/motion')
  const wallet = require('../../../core/context/WalletContext')
  const amounts = require('../../../core/amountFormatHelpers')
  return {
    ThemeContext: theme.ThemeContext,
    useTheme: theme.useTheme,
    spacing: tokens.spacing,
    radii: tokens.radii,
    typography: tokens.typography,
    hitTargets: tokens.hitTargets,
    easings: motion.easings,
    springs: motion.springs,
    durations: motion.durations,
    WalletContext: wallet.WalletContext,
    useWallet: wallet.useWallet,
    ExchangeRateContext: require('../../../core/context/ExchangeRateContext').ExchangeRateContext,
    UserContext: require('../../../core/context/UserContext').UserContext,
    formatAmount: amounts.formatAmount,
    formatAmountParts: amounts.formatAmountParts,
    haptics: { tap: () => {}, success: () => {}, warning: () => {}, error: () => {} }
  }
}
