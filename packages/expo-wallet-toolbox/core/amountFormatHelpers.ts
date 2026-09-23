import { getNumberLocale } from './numberFormat'

/**
 * The locale every figure on this screen is printed through.
 *
 * A function, not a module constant: the separators are a user preference now
 * (see `core/numberFormat.ts`), so a figure formatted at module-load time
 * would be stuck with whatever the device implied at launch.
 */
const locale = (): string => getNumberLocale()

const SATS_PER_BSV = 100_000_000
const CENT_THRESHOLD = 0.01

/**
 * Above this many currency units, a fiat figure is abbreviated and its minor
 * units are dropped. Below it the cents are kept exactly: those are the
 * balances a holder reconciles against a bank app, and `$1,234.56` rounded to
 * `$1.2k` is no longer the same number to them.
 */
const FIAT_ABBREVIATE_ABOVE = 100_000

/**
 * `1500 -> "1.5k"`, `1_000_000 -> "1M"`, `2_400_000_000 -> "2.4B"`.
 *
 * At most one decimal place and never a trailing `.0`, because the point of
 * the short form is to be read at a glance. Values under 1000 are returned
 * grouped and unabbreviated — there is nothing to save.
 */
const ABBREVIATION_STEPS: { limit: number; divisor: number; suffix: string }[] = [
  { limit: 1_000_000_000, divisor: 1_000_000_000, suffix: 'B' },
  { limit: 1_000_000, divisor: 1_000_000, suffix: 'M' },
  { limit: 1_000, divisor: 1_000, suffix: 'k' }
]

/**
 * The magnitude `value` should be shown at. `suffix` is `''` when the value is
 * small enough to print in full. Shared by the satoshi and fiat paths so the
 * two can never disagree about where a 'k' becomes an 'M'.
 */
const scaleForAbbreviation = (value: number): { scaled: number; suffix: string } => {
  const abs = Math.abs(value)
  for (const { limit, divisor, suffix } of ABBREVIATION_STEPS) {
    // One decimal, trimmed: 1.0k reads as noise, 1.5k does not.
    if (abs >= limit) return { scaled: Math.round((abs / divisor) * 10) / 10, suffix }
  }
  return { scaled: abs, suffix: '' }
}

const abbreviateNumber = (value: number): string => {
  const { scaled, suffix } = scaleForAbbreviation(value)
  if (!suffix) return formatSatoshisLocale(Math.abs(value))
  return `${Number.isInteger(scaled) ? String(scaled) : formatDecimalLocale(scaled, 1)}${suffix}`
}

/** A number at fixed decimals in the active locale's separators. */
const formatDecimalLocale = (value: number, digits: number): string => {
  try {
    return new Intl.NumberFormat(locale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: true
    }).format(value)
  } catch {
    return value.toFixed(digits)
  }
}

export type UsdToFiat = Record<string, number>

export type AmountFormatOptions = {
  showPlus?: boolean
  abbreviate?: boolean
  showFiatAsInteger?: boolean
  usdToFiat?: UsdToFiat
}

export const isFiatCurrency = (currency: string): boolean => Boolean(currency) && currency !== 'BSV'

/**
 * Satoshis per 1 unit of `currency`. USD is the WhatsOnChain rate; other fiat
 * is that rate divided by the USD→fiat cross (1 USD = `usdToFiat[code]` units).
 */
export const satoshisPerFiatUnit = (
  currency: string,
  satoshisPerUSD: number,
  usdToFiat: UsdToFiat = {}
): number => {
  if (currency === 'USD') return satoshisPerUSD
  const fx = usdToFiat[currency]
  if (!(satoshisPerUSD > 0) || !(fx > 0)) return 0
  return satoshisPerUSD / fx
}

export const fiatFractionDigits = (currency: string): number => {
  try {
    const digits = new Intl.NumberFormat(locale(), {
      style: 'currency',
      currency
    }).resolvedOptions().maximumFractionDigits
    return typeof digits === 'number' ? digits : 2
  } catch {
    return 2
  }
}

/**
 * The symbol this wallet prints for a currency, whatever the locale would.
 *
 * `currencyDisplay: 'narrowSymbol'` is not enough: a locale narrows only as
 * far as it can still disambiguate, so an `en-NL` device renders USD as
 * "US$" — which is a correct answer to a question nobody asked. The wallet
 * shows one currency at a time and says which in Settings, so the short
 * symbol is never ambiguous here.
 *
 * Currencies absent from this table keep whatever the locale produces, which
 * for a code like CHF is already the code itself.
 */
const PREFERRED_SYMBOL: Record<string, string> = {
  USD: '$',
  AUD: '$',
  CAD: '$',
  NZD: '$',
  BRL: 'R$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  INR: '₹',
  RUB: '₽',
  PLN: 'zł',
  IDR: 'Rp'
}

/**
 * Format through Intl, then swap the currency token for our own symbol.
 *
 * Rebuilt from `formatToParts` rather than string-replaced so the locale keeps
 * deciding WHERE the symbol sits and whether a space follows it — only the
 * glyph is ours.
 */
const formatCurrencyParts = (
  value: number,
  loc: string,
  currency: string,
  options: Intl.NumberFormatOptions
): string => {
  const preferred = PREFERRED_SYMBOL[currency]
  const parts = new Intl.NumberFormat(loc, options).formatToParts(value)
  return parts.map(p => (p.type === 'currency' && preferred ? preferred : p.value)).join('')
}

// Format number as currency with fallback for platforms where Intl is not fully supported
const formatCurrency = (
  value: number,
  locale: string,
  currency: string,
  minDigits: number,
  maxDigits?: number,
  showPlus = false
): string => {
  const abs = Math.abs(value)
  let formatted: string
  try {
    const options: Intl.NumberFormatOptions = {
      currency,
      style: 'currency',
      // The separator preference is expressed as a locale, and a locale also
      // carries that language's NAME for the currency — fr-FR renders USD as
      // "$US". The UI's language is chosen elsewhere, so pin the short symbol
      // and let the locale govern only the digits, which is all the
      // preference was ever about.
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: minDigits
    }

    if (maxDigits !== undefined) {
      options.maximumFractionDigits = maxDigits
    }

    formatted = formatCurrencyParts(abs, locale, currency, options)
  } catch {
    formatted = `${currency} ${abs.toFixed(minDigits)}`
  }
  // Same sign convention as the satoshi formatter, so a column of mixed
  // currencies reads one way: minus for money out, plus for money in when the
  // caller asks for it. Accounting parentheses were dropped because the row's
  // direction cue lives in the sign, and "(...)" is not one.
  return `${fiatSign(value, showPlus)}${formatted}`
}

const fiatSign = (value: number, showPlus: boolean): string => (value < 0 ? '-' : showPlus && value > 0 ? '+' : '')
/**
 * Format a satoshi amount as a locale-aware integer string with grouping separators.
 * E.g. 1234567 -> "1,234,567" (en-US) or "1.234.567" (de-DE)
 */
const formatSatoshisLocale = (satoshis: number): string => {
  try {
    return new Intl.NumberFormat(locale(), {
      maximumFractionDigits: 0,
      useGrouping: true
    }).format(satoshis)
  } catch {
    return Math.abs(satoshis).toLocaleString()
  }
}

/**
 * Format a BSV decimal amount with locale-aware separators.
 * Shows up to 8 decimal places, trimming trailing zeros.
 */
const formatBsvLocale = (bsvValue: number): string => {
  try {
    return new Intl.NumberFormat(locale(), {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8,
      useGrouping: true
    }).format(bsvValue)
  } catch {
    // Fallback: trim trailing zeros from toFixed(8)
    return parseFloat(bsvValue.toFixed(8)).toString()
  }
}

/**
 * Format a satoshi amount as fiat using satoshis-per-unit of that currency.
 * Values below one minor unit (1 cent, 1 yen, …) display as "< {smallest}",
 * with the sign on the figure ("< -$0.01"). Otherwise rounds up to the
 * currency's minor unit.
 */
export const formatSatoshisAsFiat = (
  satoshis: number,
  satoshisPerUnit: number,
  showFiatAsInteger = false,
  currency = 'USD',
  showPlus = false,
  abbreviate = false
): string => {
  if (!Number.isInteger(Number(satoshis)) || !satoshisPerUnit || satoshisPerUnit <= 0) {
    return '...'
  }

  const raw = satoshis / satoshisPerUnit
  if (isNaN(raw)) return '...'

  const v = Math.abs(raw)
  const digits = showFiatAsInteger ? 0 : fiatFractionDigits(currency)
  const factor = 10 ** digits
  const threshold = digits === 0 ? 1 : 1 / factor

  if (v > 0 && v < threshold && !showFiatAsInteger) {
    const smallest = formatCurrency(threshold, locale(), currency, digits, digits)
    return `< ${fiatSign(raw, showPlus)}${smallest}`
  }

  const sign = raw < 0 ? -1 : 1

  /**
   * Only large figures shorten. A balance a holder reconciles against a bank
   * app keeps its exact minor units, because `$1,234.56` shown as `$1.2k` is
   * not the same number to the person reading it — it is a different number
   * that happens to be close. Past `FIAT_ABBREVIATE_ABOVE` the cents have
   * stopped being the point and the width has started to be.
   */
  if (abbreviate && v >= FIAT_ABBREVIATE_ABOVE) {
    const { scaled, suffix } = scaleForAbbreviation(v)
    const shortDigits = Number.isInteger(scaled) ? 0 : 1
    const body = formatCurrency(sign * scaled, locale(), currency, shortDigits, shortDigits, showPlus)
    return `${body}${suffix}`
  }

  const rounded = (sign * Math.ceil(Math.abs(raw) * factor)) / factor

  const minDigits = showFiatAsInteger ? 0 : digits
  const maxDigits = showFiatAsInteger ? 0 : digits

  return formatCurrency(rounded, locale(), currency, minDigits, maxDigits, showPlus)
}

/**
 * Format a satoshi amount in BSV mode with smart threshold:
 * - < 100,000,000 sats (< 1 BSV): display as satoshis with grouping (e.g., "50,000 satoshis")
 * - >= 100,000,000 sats (>= 1 BSV): display as BSV with decimals (e.g., "1.5 BSV")
 *
 * All formatting is locale-aware.
 */
export const formatSatoshisAsBsv = (satoshis: number, showPlus = false, abbreviate = false): string => {
  const numValue = Number(satoshis)
  if (!Number.isInteger(numValue)) return '---'

  const sign = numValue < 0 ? '-' : showPlus ? '+' : ''
  const absValue = Math.abs(numValue)

  if (absValue >= SATS_PER_BSV) {
    // Display as BSV
    const bsvValue = absValue / SATS_PER_BSV
    // A whole-BSV figure abbreviates on the same ladder once it passes 1000,
    // so "1,000 BSV" reads "1k BSV" rather than growing a digit per decade.
    const body = abbreviate && bsvValue >= 1000 ? abbreviateNumber(bsvValue) : formatBsvLocale(bsvValue)
    return `${sign}${body} BSV`
  } else {
    // Display as satoshis. `abbreviate` shortens BOTH the figure and the label
    // — it used to shorten only the label, which left "1,000,000 sats" as the
    // supposedly-abbreviated form.
    const label = abbreviate ? 'sats' : 'satoshis'
    const body = abbreviate ? abbreviateNumber(absValue) : formatSatoshisLocale(absValue)
    return `${sign}${body} ${label}`
  }
}

/**
 * Smart format function: formats a satoshi amount based on the currency setting.
 * - fiat codes: convert using WhatsOnChain USD and optional USD→fiat crosses
 * - 'BSV' (default): smart threshold (satoshis for < 1 BSV, BSV for >= 1 BSV)
 */
export const formatAmount = (
  satoshis: number,
  currency: string = 'BSV',
  satoshisPerUSD: number = 0,
  options: AmountFormatOptions = {}
): string => {
  const { showPlus = false, abbreviate = false, showFiatAsInteger = false, usdToFiat = {} } = options

  if (isFiatCurrency(currency)) {
    const per = satoshisPerFiatUnit(currency, satoshisPerUSD, usdToFiat)
    return formatSatoshisAsFiat(satoshis, per, showFiatAsInteger, currency, showPlus, abbreviate)
  }

  return formatSatoshisAsBsv(satoshis, showPlus, abbreviate)
}

/**
 * Format satoshis as a plain BSV decimal, with no unit appended.
 * E.g. 729948 -> "0.00729948". For the context line under a balance, where the
 * unit is written out separately.
 */
export const formatSatoshisAsBsvDecimal = (satoshis: number): string =>
  formatBsvLocale(Math.abs(Number(satoshis)) / SATS_PER_BSV)

/**
 * Split a formatted amount into its figure and its unit, so the two can be set
 * at different sizes — the figure is the thing being read, the unit is a label
 * hanging off it. In USD mode the symbol is part of the figure, so `unit` is
 * empty rather than fabricated.
 */
export const formatAmountParts = (
  satoshis: number,
  currency: string = 'BSV',
  satoshisPerUSD: number = 0,
  options: AmountFormatOptions = {}
): { value: string; unit: string } => {
  const text = formatAmount(satoshis, currency, satoshisPerUSD, options)
  if (isFiatCurrency(currency)) return { value: text, unit: '' }
  const split = text.lastIndexOf(' ')
  if (split < 0) return { value: text, unit: '' }
  return { value: text.slice(0, split), unit: text.slice(split + 1) }
}

/**
 * The spendable figure in the unit AmountInput is asking for RIGHT NOW, with
 * no symbol and no unit word: the input's own suffix already says "satoshis"
 * or "EUR", and repeating it beside the balance reads twice. BSV mode never
 * switches to whole BSV for this reason — the field beside it takes satoshis.
 * Empty when there is nothing honest to show (no rate in fiat mode, NaN).
 */
export const formatAmountInInputUnit = (
  satoshis: number,
  currency: string,
  satoshisPerUSD: number,
  usdToFiat: UsdToFiat = {}
): string => {
  const n = Number(satoshis)
  if (!Number.isFinite(n)) return ''
  if (isFiatCurrency(currency)) {
    const per = satoshisPerFiatUnit(currency, satoshisPerUSD, usdToFiat)
    if (!(per > 0)) return ''
    const amount = Math.abs(n) / per
    const digits = fiatFractionDigits(currency)
    try {
      return new Intl.NumberFormat(locale(), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      }).format(amount)
    } catch {
      return amount.toFixed(digits)
    }
  }
  return formatSatoshisLocale(Math.abs(Math.round(n)))
}

/**
 * Convert a user-entered display value back to integer satoshis.
 * - BSV mode: input is satoshi integers, passthrough
 * - fiat mode: input is a decimal amount in that currency
 */
export const parseDisplayToSatoshis = (
  displayValue: string,
  currency: string,
  satoshisPerUSD: number,
  usdToFiat: UsdToFiat = {}
): number => {
  const cleaned = displayValue.trim()
  if (!cleaned) return 0

  if (isFiatCurrency(currency)) {
    const amount = parseFloat(cleaned)
    if (isNaN(amount)) return 0
    const per = satoshisPerFiatUnit(currency, satoshisPerUSD, usdToFiat)
    if (!(per > 0)) return 0
    return Math.round(amount * per)
  }

  // BSV mode: input is always integer satoshis
  const sats = parseInt(cleaned, 10)
  return isNaN(sats) ? 0 : sats
}

/**
 * Get the appropriate unit label for display.
 * In BSV mode, the label depends on the amount (satoshis vs BSV).
 * If no satoshi value is provided, returns "satoshis" (the input label for BSV mode).
 */
export const getUnitLabel = (currency: string, satoshis?: number, abbreviate = false, satoshisPerUSD?: number): string => {
  if (isFiatCurrency(currency)) {
    if (currency === 'USD' && satoshis !== undefined && satoshisPerUSD && satoshisPerUSD > 0) {
      const usd = Math.abs(satoshis / satoshisPerUSD)
      if (usd > 0 && usd < CENT_THRESHOLD) return '¢'
    }
    return currency
  }

  // BSV mode: if an amount is provided, use threshold to pick label
  if (satoshis !== undefined && Math.abs(satoshis) >= SATS_PER_BSV) {
    return 'BSV'
  }

  return abbreviate ? 'sats' : 'satoshis'
}

// Keep legacy exports for backward compatibility during migration
export const formatSatoshis = formatSatoshisAsBsv

/**
 * Split a formatted figure so its minor units can be set smaller and raised,
 * the way a price tag writes them.
 *
 * `head` is everything up to and including the decimal separator, `frac` the
 * minor-unit digits, `tail` whatever trails them (a suffixed currency symbol
 * in the locales that put it there).
 *
 * Returns `frac: ''` — meaning "draw this as one run" — when there is nothing
 * to raise, and deliberately when the figure is ABBREVIATED: the `.5` of
 * `1.5k` is a magnitude, not cents, and shrinking it would read as `1` with a
 * superscript. Detected by a letter immediately after the digits, which is
 * exactly what the k/M/B suffix is.
 */
export const splitAmountFraction = (value: string): { head: string; frac: string; tail: string } => {
  const whole = { head: value, frac: '', tail: '' }
  if (!value) return whole
  let sep: string
  try {
    sep =
      new Intl.NumberFormat(locale())
        .formatToParts(1.1)
        .find(p => p.type === 'decimal')?.value ?? '.'
  } catch {
    sep = '.'
  }
  const at = value.lastIndexOf(sep)
  if (at < 0) return whole
  const rest = value.slice(at + sep.length)
  const digits = /^\d+/.exec(rest)?.[0] ?? ''
  if (!digits) return whole
  const tail = rest.slice(digits.length)
  // An abbreviation suffix (k/M/B) means those digits are magnitude, not cents.
  if (/^\p{L}/u.test(tail)) return whole
  return { head: value.slice(0, at + sep.length), frac: digits, tail }
}
