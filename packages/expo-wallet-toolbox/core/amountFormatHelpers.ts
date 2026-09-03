// Safe locale detection for React Native
const getLocaleDefault = (): string => {
  try {
    // Try to get locale using Intl API if available
    return Intl.NumberFormat().resolvedOptions().locale?.split('-u-')[0] || 'en-US'
  } catch {
    // Fallback to en-US if Intl is not fully supported
    return 'en-US'
  }
}

const localeDefault = getLocaleDefault()

const SATS_PER_BSV = 100_000_000
const CENT_THRESHOLD = 0.01

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
    const digits = new Intl.NumberFormat(localeDefault, {
      style: 'currency',
      currency
    }).resolvedOptions().maximumFractionDigits
    return typeof digits === 'number' ? digits : 2
  } catch {
    return 2
  }
}

// Format number as currency with fallback for platforms where Intl is not fully supported
const formatCurrency = (
  value: number,
  locale: string,
  currency: string,
  minDigits: number,
  maxDigits?: number
): string => {
  const abs = Math.abs(value)
  let formatted: string
  try {
    const options: Intl.NumberFormatOptions = {
      currency,
      style: 'currency',
      minimumFractionDigits: minDigits
    }

    if (maxDigits !== undefined) {
      options.maximumFractionDigits = maxDigits
    }

    const formatter = new Intl.NumberFormat(locale, options)
    formatted = formatter.format(abs)
  } catch {
    formatted = `${currency} ${abs.toFixed(minDigits)}`
  }
  return value < 0 ? `(${formatted})` : formatted
}

/**
 * Format a satoshi amount as a locale-aware integer string with grouping separators.
 * E.g. 1234567 -> "1,234,567" (en-US) or "1.234.567" (de-DE)
 */
const formatSatoshisLocale = (satoshis: number): string => {
  try {
    return new Intl.NumberFormat(localeDefault, {
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
    return new Intl.NumberFormat(localeDefault, {
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
 * Format a sub-cent USD value as cents (¢).
 * Dynamically adjusts decimal precision based on magnitude.
 */
const formatCents = (cents: number): string => {
  const absCents = Math.abs(cents)
  let maxDigits = 2
  if (absCents < 0.01) maxDigits = 4
  else if (absCents < 0.1) maxDigits = 3

  try {
    const formatted = new Intl.NumberFormat(localeDefault, {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDigits,
      useGrouping: true
    }).format(cents)
    return `${formatted}¢`
  } catch {
    return `${parseFloat(cents.toFixed(maxDigits))}¢`
  }
}

/**
 * Format a satoshi amount as fiat using satoshis-per-unit of that currency.
 * Values below one minor unit (1 cent, 1 yen, …) display as "< {smallest}".
 * Otherwise rounds up to the currency's minor unit.
 */
export const formatSatoshisAsFiat = (
  satoshis: number,
  satoshisPerUnit: number,
  showFiatAsInteger = false,
  currency = 'USD'
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
    const smallest = formatCurrency(threshold, localeDefault, currency, digits, digits)
    return raw < 0 ? `< (${smallest})` : `< ${smallest}`
  }

  const sign = raw < 0 ? -1 : 1
  const rounded = (sign * Math.ceil(Math.abs(raw) * factor)) / factor

  const minDigits = showFiatAsInteger ? 0 : digits
  const maxDigits = showFiatAsInteger ? 0 : digits

  return formatCurrency(rounded, localeDefault, currency, minDigits, maxDigits)
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
    return `${sign}${formatBsvLocale(bsvValue)} BSV`
  } else {
    // Display as satoshis
    const label = abbreviate ? 'sats' : 'satoshis'
    return `${sign}${formatSatoshisLocale(absValue)} ${label}`
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
    return formatSatoshisAsFiat(satoshis, per, showFiatAsInteger, currency)
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
      return new Intl.NumberFormat(localeDefault, {
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
