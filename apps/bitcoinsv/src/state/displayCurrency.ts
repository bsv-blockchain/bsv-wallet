// Settings → Display currency (the prototype's lib/data/display-currencies.ts):
// the currency totals and conversions are shown in. The choice is the shared
// core's own wallet setting (settings.currency), and the rates are the core's
// (WhatsOnChain's USD, crossed with Frankfurter for the rest), so nothing here
// is a frozen demo rate. BitcoinSV itself can be chosen too: then totals are
// shown in BSV.
import { useCallback, useContext } from 'react'
import { ExchangeRateContext, useWallet } from '@bsv/expo-wallet-toolbox'

export interface DisplayCurrency {
  code: string
  name: string
  symbol: string
  /** the symbol after the figure ("12,00 zł"), or before ("£12.00") */
  after?: boolean
  /** minor units; none for currencies without cents in everyday use */
  decimals: number
  /** the flag-icons country (src/ui/Flag.tsx); BitcoinSV shows its own mark */
  flag?: string
}

export const DISPLAY_CURRENCIES: DisplayCurrency[] = [
  { code: 'BSV', name: 'BitcoinSV', symbol: 'BSV', decimals: 2 },
  { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2, flag: 'us' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2, flag: 'au' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimals: 2, flag: 'br' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', decimals: 2, flag: 'ca' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF ', decimals: 2, flag: 'ch' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: 'CN¥', decimals: 2, flag: 'cn' },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2, flag: 'eu' },
  { code: 'GBP', name: 'British Pound', symbol: '£', decimals: 2, flag: 'gb' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', decimals: 0, flag: 'id' },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimals: 2, flag: 'in' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0, flag: 'jp' },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', decimals: 2, flag: 'nz' },
  { code: 'PLN', name: 'Polish Złoty', symbol: ' zł', after: true, decimals: 2, flag: 'pl' },
  { code: 'RUB', name: 'Russian Ruble', symbol: ' ₽', after: true, decimals: 2, flag: 'ru' }
]

const SATS_PER_BSV = 100_000_000
const BSV = DISPLAY_CURRENCIES[0]
const USD = DISPLAY_CURRENCIES[1]
const byCode = new Map(DISPLAY_CURRENCIES.map(c => [c.code, c]))

/** What the money components draw fiat figures in; kept by useDisplayCurrency. */
let current: DisplayCurrency = USD
export const currentDisplayCurrency = () => current

export function useDisplayCurrency() {
  const { settings, updateSettings, selectedNetwork } = useWallet()
  const { satoshisPerUSD, usdToFiat } = useContext(ExchangeRateContext)
  // testnet coins are worth nothing: their totals are in BSV, never a price
  const chosen = selectedNetwork === 'test' ? BSV : (byCode.get(settings?.currency ?? '') ?? USD)
  current = chosen
  const set = useCallback(
    (code: string) => (settings ? updateSettings({ ...settings, currency: code }) : Promise.resolve()),
    [settings, updateSettings]
  )
  /** satoshis in the display currency; null until there's a rate */
  const fromSats = useCallback(
    (sats: number): number | null => {
      if (chosen.code === 'BSV') return sats / SATS_PER_BSV
      if (!satoshisPerUSD) return null
      const per = chosen.code === 'USD' ? 1 : usdToFiat[chosen.code]
      return per ? (sats / satoshisPerUSD) * per : null
    },
    [chosen.code, satoshisPerUSD, usdToFiat]
  )
  /**
   * satoshis in US dollars, whatever the display currency: what BSV totals
   * flip to when BitcoinSV is the display currency. Null without a rate, and
   * on testnet, whose coins have no price.
   */
  const dollarsOf = useCallback(
    (sats: number): number | null => (selectedNetwork === 'test' || !satoshisPerUSD ? null : sats / satoshisPerUSD),
    [selectedNetwork, satoshisPerUSD]
  )
  return { currency: chosen, set, fromSats, dollarsOf }
}
