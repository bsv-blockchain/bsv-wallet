import { formatAmount } from '../core/amountFormatHelpers'

const SATS_PER_USD = 100_000

describe('exact vs compact amounts', () => {
  it('abbreviate alone keeps the exact figure and only shortens the label', () => {
    expect(formatAmount(1_234_567, 'BSV', 0, { abbreviate: true })).toBe('1,234,567 sats')
    expect(formatAmount(2_500 * 100_000_000, 'BSV', 0, { abbreviate: true })).toBe('2,500 BSV')
    expect(formatAmount(25_000_055 * 1_000, 'USD', SATS_PER_USD, { abbreviate: true })).toBe('$250,000.55')
  })

  it('compact shortens large figures', () => {
    expect(formatAmount(1_234_567, 'BSV', 0, { abbreviate: true, compact: true })).toBe('1.2M sats')
    expect(formatAmount(2_500 * 100_000_000, 'BSV', 0, { abbreviate: true, compact: true })).toBe('2.5k BSV')
    expect(formatAmount(25_000_055 * 1_000, 'USD', SATS_PER_USD, { compact: true })).toBe('$250k')
  })

  it('rounds up into the next step instead of printing 1000k', () => {
    expect(formatAmount(999_950, 'BSV', 0, { abbreviate: true, compact: true })).toBe('1M sats')
    expect(formatAmount(999_950 * SATS_PER_USD, 'USD', SATS_PER_USD, { compact: true })).toBe('$1M')
    expect(formatAmount(999_960_000 * 1_000, 'USD', SATS_PER_USD, { compact: true })).toBe('$10M')
  })
})
