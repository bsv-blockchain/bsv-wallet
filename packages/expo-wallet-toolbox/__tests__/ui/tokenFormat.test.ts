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
    expect(() => formatTokenAmount(500, Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(formatTokenAmount(500, Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it.each([19, -1, NaN, Infinity, 2.5])('refuses decimals=%p', decimals => {
    expect(formatTokenAmount(500, decimals)).toBeNull()
  })

  it.each([0, 1, 2, 8, 18])('still formats normally at decimals=%p (round-trips through parseTokenAmount)', d => {
    const formatted = formatTokenAmount(123, d)
    expect(formatted).not.toBeNull()
    // tokenAmountInputText strips grouping, exactly what a typed field holds.
    const typed = tokenAmountInputText(123, d)
    expect(parseTokenAmount(typed, d)).toBe(123)
  })

  it('formatTokenAmountWithUnit and tokenAmountParts propagate the same refusal', () => {
    const asset = { decimals: Number.MAX_SAFE_INTEGER, ticker: 'USDX' }
    expect(tokenAmountParts(500, asset)).toBeNull()
    expect(formatTokenAmountWithUnit(500, asset)).toBeNull()
  })

  it('tokenAmountInputText prints nothing rather than throwing', () => {
    expect(() => tokenAmountInputText(500, Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(tokenAmountInputText(500, Number.MAX_SAFE_INTEGER)).toBe('')
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

// Untouched by this row, kept here since this is the module's first test file.
describe('shortAssetId', () => {
  it('truncates a long assetId to a short, human-scannable form', () => {
    expect(shortAssetId('a'.repeat(64) + '.0')).toBe('aaaaaaaa…aaaa.0')
  })

  it('leaves a short value unchanged', () => {
    expect(shortAssetId('short')).toBe('short')
  })
})
