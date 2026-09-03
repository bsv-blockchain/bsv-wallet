import { formatAmountInInputUnit } from '../../core/amountFormatHelpers'

const digits = (s: string) => s.replace(/\D/g, '')

describe('formatAmountInInputUnit', () => {
  it('BSV mode: grouped satoshis, no unit word', () => {
    const s = formatAmountInInputUnit(1000, 'BSV', 0)
    expect(digits(s)).toBe('1000')
    expect(s).not.toMatch(/[A-Za-z$]/)
  })

  it('BSV mode: stays in satoshis past 1 BSV — the input beside it says satoshis', () => {
    const s = formatAmountInInputUnit(150_000_000, 'BSV', 0)
    expect(digits(s)).toBe('150000000')
    expect(s).not.toMatch(/BSV/i)
  })

  it('USD mode: two decimals, no symbol', () => {
    const s = formatAmountInInputUnit(50_000, 'USD', 100_000) // 0.5 USD
    expect(s).toMatch(/^0[.,]50$/)
  })

  it('USD mode with no rate: empty, so the caller renders nothing', () => {
    expect(formatAmountInInputUnit(50_000, 'USD', 0)).toBe('')
  })

  it('non-finite input: empty', () => {
    expect(formatAmountInInputUnit(Number.NaN, 'BSV', 0)).toBe('')
  })
})
