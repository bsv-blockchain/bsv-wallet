/**
 * parseDisplayToSatoshis hardcoded '.' as the fiat decimal separator, so a
 * comma-decimal locale (e.g. de-DE) typing '3,50' would have it silently
 * truncated at the comma by parseFloat (reviews/misc-p2.md misc-p2-12).
 *
 * The device locale is resolved once at module load in numberFormat.ts, so
 * it is mocked here rather than passed as a parameter.
 */
let mockLocale = 'en-US'
jest.mock('../../core/numberFormat', () => ({
  getNumberLocale: () => mockLocale
}))

import { decimalSeparator, parseDisplayToSatoshis } from '../../core/amountFormatHelpers'

const SATS_PER_BSV = 100_000_000
const SATS_PER_USD = SATS_PER_BSV / 16

beforeEach(() => {
  mockLocale = 'en-US'
})

describe('decimalSeparator', () => {
  it('is "." for a dot-decimal locale', () => {
    mockLocale = 'en-US'
    expect(decimalSeparator()).toBe('.')
  })

  it('is "," for a comma-decimal locale', () => {
    mockLocale = 'de-DE'
    expect(decimalSeparator()).toBe(',')
  })
})

describe('parseDisplayToSatoshis under a comma-decimal locale', () => {
  it('"3,50" under de-DE parses to the same satoshis as "3.50" under en-US', () => {
    mockLocale = 'en-US'
    const dotSats = parseDisplayToSatoshis('3.50', 'EUR', SATS_PER_USD, { EUR: 0.85 })

    mockLocale = 'de-DE'
    const commaSats = parseDisplayToSatoshis('3,50', 'EUR', SATS_PER_USD, { EUR: 0.85 })

    expect(commaSats).toBe(dotSats)
    expect(commaSats).toBeGreaterThan(0)
  })

  it('BSV integer mode is untouched by locale', () => {
    mockLocale = 'de-DE'
    expect(parseDisplayToSatoshis('12345', 'BSV', SATS_PER_USD)).toBe(12345)
  })
})
