import type React from 'react'
import { ThemeContext } from '../../core/theme/ThemeContext'
import { WalletContext } from '../../core/context/WalletContext'
import { ExchangeRateContext } from '../../core/context/ExchangeRateContext'
import { UserContext } from '../../core/context/UserContext'

/**
 * The React contexts `PermissionSheet` (and the cards it renders) read. The Android bridge sheet runs on a second
 * React root of the same React host (spec 7.4), and a second root does not see the first root's providers, so each
 * context listed here is copied across by `ContextRelay`. A context the sheet reads that is not listed here would
 * silently fall back to its default value on the second root: `relayedContexts.test.tsx` scans the sheet's import
 * closure and fails until the new context is added.
 *
 * Language is intentionally not listed: i18n is a module singleton and `useTranslation` reads it without a provider.
 */
export const RELAYED_CONTEXTS: ReadonlyArray<{ name: string; context: React.Context<any> }> = [
  { name: 'ThemeContext', context: ThemeContext },
  { name: 'WalletContext', context: WalletContext },
  { name: 'ExchangeRateContext', context: ExchangeRateContext },
  { name: 'UserContext', context: UserContext }
]
