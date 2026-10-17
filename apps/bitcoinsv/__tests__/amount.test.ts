import { cleanAmount } from '../src/pay/amount'
import { formatBsvAmount } from '../src/ui/moneyFormat'

describe('the amount field', () => {
  it('keeps one decimal point', () => {
    expect(cleanAmount('1.2.3', 8)).toBe('1.23')
    expect(cleanAmount('1..5', 8)).toBe('1.5')
  })
  it('keeps no more decimals than the coin has', () => {
    expect(cleanAmount('0.123456789', 8)).toBe('0.12345678')
    expect(cleanAmount('12.345', 2)).toBe('12.34')
    expect(cleanAmount('12.5', 0)).toBe('12')
  })
  it('keeps at most 7 whole digits', () => {
    expect(cleanAmount('123456789', 8)).toBe('1234567')
  })
  it('tidies what is typed or pasted', () => {
    expect(cleanAmount('.5', 8)).toBe('0.5')
    expect(cleanAmount('007', 8)).toBe('7')
    expect(cleanAmount('0', 8)).toBe('0')
    expect(cleanAmount('0.', 8)).toBe('0.')
    expect(cleanAmount('1,234.50 BSV', 8)).toBe('1234.50')
    expect(cleanAmount('', 8)).toBe('')
  })
})

describe('BSV money figures', () => {
  it('shows a balance to the satoshi, never fewer than two decimals', () => {
    expect(formatBsvAmount(0.00999977)).toBe('0.00999977')
    expect(formatBsvAmount(0.00000001)).toBe('0.00000001')
    expect(formatBsvAmount(2)).toBe('2.00')
    expect(formatBsvAmount(1.5)).toBe('1.50')
    expect(formatBsvAmount(12345.12345678)).toBe('12,345.12345678')
  })
})
