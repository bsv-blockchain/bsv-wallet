/**
 * XR-043 — an extreme token decimals value (from a session QR, an issuer
 * registry entry, or any other caller) must never reach `String(...)
 * .padStart` or an unbounded regex quantifier: `formatTokenAmount(500,
 * Number.MAX_SAFE_INTEGER)` threw `RangeError: Invalid string length` at
 * HEAD. No test file existed for this module before this row.
 */
import {
  formatTokenAmount,
  formatTokenAmountWithUnit,
  parseTokenAmount,
  shortAssetId,
  tokenAmountInputText,
  tokenAmountMask,
  tokenAmountParts
} from '../../ui/tokenFormat'

describe('formatTokenAmount — decimals bound (XR-043)', () => {
  it('refuses an extreme decimals value rather than throwing', () => {
    expect(() => formatTokenAmount(500n, Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(formatTokenAmount(500n, Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it.each([19, -1, NaN, Infinity, 2.5])('refuses decimals=%p', decimals => {
    expect(formatTokenAmount(500n, decimals)).toBeNull()
  })

  it.each([0, 1, 2, 8, 18])('still formats normally at decimals=%p (round-trips through parseTokenAmount)', d => {
    const formatted = formatTokenAmount(123n, d)
    expect(formatted).not.toBeNull()
    // tokenAmountInputText strips grouping, exactly what a typed field holds.
    const typed = tokenAmountInputText(123n, d)
    expect(parseTokenAmount(typed, d)).toBe(123n)
  })

  it('formatTokenAmountWithUnit and tokenAmountParts propagate the same refusal', () => {
    const asset = { decimals: Number.MAX_SAFE_INTEGER, ticker: 'USDX' }
    expect(tokenAmountParts(500n, asset)).toBeNull()
    expect(formatTokenAmountWithUnit(500n, asset)).toBeNull()
  })

  it('tokenAmountInputText prints nothing rather than throwing', () => {
    expect(() => tokenAmountInputText(500n, Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(tokenAmountInputText(500n, Number.MAX_SAFE_INTEGER)).toBe('')
  })
})

describe('parseTokenAmount — decimals bound (XR-043)', () => {
  it('refuses an extreme decimals value rather than throwing', () => {
    expect(() => parseTokenAmount('1.23', Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(parseTokenAmount('1.23', Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it.each([19, -1, NaN, Infinity])('refuses decimals=%p', decimals => {
    expect(parseTokenAmount('1', decimals)).toBeNull()
  })
})

describe('tokenAmountMask — decimals bound (XR-043)', () => {
  it('never throws building the RegExp, even for an extreme decimals value', () => {
    expect(() => tokenAmountMask(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })

  it('clamps to the bound rather than accepting unlimited decimal places', () => {
    const mask = tokenAmountMask(Number.MAX_SAFE_INTEGER)
    // 18 places matches, 19 does not — the clamp is exactly MAX_TOKEN_DECIMALS.
    expect(mask.test('1.' + '1'.repeat(18))).toBe(true)
    expect(mask.test('1.' + '1'.repeat(19))).toBe(false)
  })

  it('still masks normally for an in-range value', () => {
    expect(tokenAmountMask(2).test('12.34')).toBe(true)
    expect(tokenAmountMask(2).test('12.345')).toBe(false)
  })
})

/**
 * Plan 07 Task 18 / Review Focus 5: token amounts are exact `bigint` uint64
 * (0162:143) on every hop, and the display is the last hop. Nothing in here
 * may pass through a JS number: 2^64-1 is past 2^53, where a number rounds.
 */
describe('exact uint64 amounts (plan 07 Task 18)', () => {
  const MAX = 18446744073709551615n

  it('formats 2^64-1 at dec 2 exactly', () => {
    expect(formatTokenAmount(MAX, 2)).toBe('184,467,440,737,095,516.15')
    expect(tokenAmountInputText(MAX, 2)).toBe('184467440737095516.15')
  })

  it('formats 2^64-1 at dec 0 and dec 18 exactly', () => {
    expect(formatTokenAmount(MAX, 0)).toBe('18,446,744,073,709,551,615')
    expect(formatTokenAmount(MAX, 18)).toBe('18.446744073709551615')
  })

  it('formats a sum above 2^64 exactly: balances are unbounded', () => {
    expect(formatTokenAmount(MAX * 3n, 2)).toBe('553,402,322,211,286,548.45')
  })

  it('keeps fixed decimals, signs a negative and adds a plus only when asked', () => {
    expect(formatTokenAmount(0n, 2)).toBe('0.00')
    expect(formatTokenAmount(-2500n, 2)).toBe('−25.00')
    expect(formatTokenAmount(4000n, 2, { showPlus: true })).toBe('+40.00')
  })

  it('refuses a non-bigint rather than formatting a rounded number', () => {
    expect(formatTokenAmount(124000 as unknown as bigint, 2)).toBeNull()
  })

  it('parses the largest amount and refuses one above it', () => {
    expect(parseTokenAmount('184467440737095516.15', 2)).toBe(MAX)
    expect(parseTokenAmount('184467440737095516.16', 2)).toBeNull()
    expect(parseTokenAmount('1.234', 2)).toBeNull()
    expect(parseTokenAmount('0', 2)).toBeNull()
    expect(parseTokenAmount('0.00', 2)).toBeNull()
    expect(parseTokenAmount('-1', 2)).toBeNull()
  })

  it('round-trips the largest amount through the input text', () => {
    expect(parseTokenAmount(tokenAmountInputText(MAX, 2), 2)).toBe(MAX)
    expect(parseTokenAmount(tokenAmountInputText(MAX, 0), 0)).toBe(MAX)
  })

  it('names the parts of a figure exactly', () => {
    expect(tokenAmountParts(MAX, { decimals: 2, ticker: 'USDX' })).toEqual({
      value: '184,467,440,737,095,516.15',
      unit: 'USDX'
    })
    expect(formatTokenAmountWithUnit(MAX, { decimals: 2, ticker: 'USDX' })).toBe('184,467,440,737,095,516.15 USDX')
  })
})

// Untouched by this row, kept here since this is the module's first test file.
describe('shortAssetId', () => {
  it('truncates a long assetId to a short, human-scannable form', () => {
    expect(shortAssetId('a'.repeat(64) + '.0')).toBe('aaaaaaaa…aaaa.0')
  })

  it('leaves a short value unchanged', () => {
    expect(shortAssetId('short')).toBe('short')
  })
})
