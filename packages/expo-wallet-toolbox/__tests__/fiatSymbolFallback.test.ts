import { formatAmount } from '../core/amountFormatHelpers'

// 1 USD = 100,000 sats, so 345,000 sats = $3.45.
const SATS_PER_USD = 100_000

describe('fiat symbol when Intl currency formatting is unavailable', () => {
  const real = Intl.NumberFormat.prototype.formatToParts
  beforeEach(() => {
    // What Hermes does on builds without formatToParts.
    Intl.NumberFormat.prototype.formatToParts = () => {
      throw new TypeError('formatToParts is not a function')
    }
  })
  afterEach(() => {
    Intl.NumberFormat.prototype.formatToParts = real
  })

  it('still writes $ and £, never the ISO code', () => {
    expect(formatAmount(345_000, 'USD', SATS_PER_USD)).toBe('$3.45')
    expect(formatAmount(345_000, 'GBP', SATS_PER_USD, { usdToFiat: { GBP: 1 } })).toBe('£3.45')
    expect(formatAmount(-345_000, 'USD', SATS_PER_USD)).toBe('-$3.45')
  })

  it('falls back to the code only for a currency with no symbol of ours', () => {
    expect(formatAmount(345_000, 'CHF', SATS_PER_USD, { usdToFiat: { CHF: 1 } })).toBe('CHF 3.45')
  })
})

describe('fiat symbol with full Intl support', () => {
  it('writes $ and £', () => {
    expect(formatAmount(345_000, 'USD', SATS_PER_USD)).toBe('$3.45')
    expect(formatAmount(345_000, 'GBP', SATS_PER_USD, { usdToFiat: { GBP: 1 } })).toBe('£3.45')
  })
})
