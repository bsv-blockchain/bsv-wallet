/**
 * Display currencies the wallet offers. BSV is native; USD comes from
 * WhatsOnChain; every other fiat is WhatsOnChain USD × a Frankfurter USD cross.
 *
 * Language coverage (app locales: en, es, zh, hi, fr, ar, pt, bn, ru, id, ja, pl):
 * USD/GBP/AUD/CAD/NZD (en), EUR (es/fr/pt), CNY (zh), INR (hi), CHF (fr),
 * BRL (pt), JPY (ja), PLN (pl), IDR (id), RUB (ru). ar/bn fall back to USD.
 */
export const FIAT_CURRENCIES = [
  'USD',
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'EUR',
  'GBP',
  'IDR',
  'INR',
  'JPY',
  'NZD',
  'PLN',
  'RUB'
] as const

export type FiatCurrency = (typeof FIAT_CURRENCIES)[number]

/** Last-resort USD→fiat snapshot for first-launch offline. Not for trading. */
export const FALLBACK_USD_FX: Record<string, number> = {
  AUD: 1.3976,
  BRL: 5.1214,
  CAD: 1.3869,
  CHF: 0.8121,
  CNY: 6.7175,
  EUR: 0.86238,
  GBP: 0.74107,
  IDR: 17711,
  INR: 94.78,
  JPY: 158.79,
  NZD: 1.7077,
  PLN: 3.7338,
  RUB: 86.92
}

export const DISPLAY_CURRENCIES = ['BSV', ...FIAT_CURRENCIES] as const

export const FRANKFURTER_QUOTES = FIAT_CURRENCIES.filter(code => code !== 'USD')

export const FRANKFURTER_RATES_URL = `https://api.frankfurter.dev/v2/rates?base=USD&quotes=${FRANKFURTER_QUOTES.join(',')}`

export const DISPLAY_CURRENCY_OPTIONS: { id: string; label: string; icon: 'logo-bitcoin' | 'cash-outline' }[] = [
  { id: 'BSV', label: 'BSV', icon: 'logo-bitcoin' },
  ...FIAT_CURRENCIES.map(id => ({ id, label: id, icon: 'cash-outline' as const }))
]

export const fallbackUsdToFiat = (): Record<string, number> => ({ USD: 1, ...FALLBACK_USD_FX })
