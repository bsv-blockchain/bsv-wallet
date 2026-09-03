import {
  formatAmount,
  formatAmountInInputUnit,
  formatAmountParts,
  getUnitLabel,
  parseDisplayToSatoshis
} from '../../core/amountFormatHelpers'

const SATS_PER_BSV = 100_000_000
// $16 / BSV → 6,250,000 sats per USD
const SATS_PER_USD = SATS_PER_BSV / 16

describe('formatAmount fiat currencies', () => {
  it('USD still formats 1 BSV at $16/BSV as a dollar amount', () => {
    const s = formatAmount(SATS_PER_BSV, 'USD', SATS_PER_USD)
    expect(s).toMatch(/16[.,]00/)
    expect(s).not.toMatch(/BSV/)
  })

  it('EUR formats 1 BSV using USD rate × EUR per USD', () => {
    // 1 BSV = $16; 1 USD = 0.85 EUR → 1 BSV = €13.60
    const s = formatAmount(SATS_PER_BSV, 'EUR', SATS_PER_USD, { usdToFiat: { EUR: 0.85 } })
    expect(s).toMatch(/13[.,]60/)
    expect(s).not.toMatch(/BSV/)
    expect(s).not.toMatch(/\$/)
  })

  it('JPY formats with no fractional digits', () => {
    // 1 BSV = $16; 1 USD = 150 JPY → 1 BSV = ¥2,400
    const s = formatAmount(SATS_PER_BSV, 'JPY', SATS_PER_USD, { usdToFiat: { JPY: 150 } })
    expect(s.replace(/[^\d]/g, '')).toBe('2400')
    expect(s).not.toMatch(/\.\d/)
    expect(s).not.toMatch(/BSV/)
  })

  it('unknown fiat with no rate returns a placeholder, not BSV', () => {
    const s = formatAmount(SATS_PER_BSV, 'EUR', SATS_PER_USD, { usdToFiat: {} })
    expect(s).toBe('...')
  })
})

describe('formatAmountParts fiat', () => {
  it('puts the currency symbol in the value and leaves unit empty', () => {
    const { value, unit } = formatAmountParts(SATS_PER_BSV, 'EUR', SATS_PER_USD, {
      usdToFiat: { EUR: 0.85 }
    })
    expect(value).toMatch(/13[.,]60/)
    expect(unit).toBe('')
  })
})

describe('formatAmountInInputUnit fiat', () => {
  it('EUR: two decimals, no currency symbol', () => {
    const s = formatAmountInInputUnit(SATS_PER_BSV, 'EUR', SATS_PER_USD, { EUR: 0.85 })
    expect(s).toMatch(/^13[.,]60$/)
  })

  it('JPY: whole yen, no symbol', () => {
    const s = formatAmountInInputUnit(SATS_PER_BSV, 'JPY', SATS_PER_USD, { JPY: 150 })
    expect(s.replace(/[^\d]/g, '')).toBe('2400')
    expect(s).not.toMatch(/\.\d/)
  })

  it('EUR with no rate: empty, so the caller renders nothing', () => {
    expect(formatAmountInInputUnit(SATS_PER_BSV, 'EUR', SATS_PER_USD, {})).toBe('')
  })
})

describe('parseDisplayToSatoshis fiat', () => {
  it('EUR amount at $16/BSV and 0.85 EUR/USD round-trips to 1 BSV', () => {
    const sats = parseDisplayToSatoshis('13.60', 'EUR', SATS_PER_USD, { EUR: 0.85 })
    expect(sats).toBe(SATS_PER_BSV)
  })

  it('JPY amount round-trips to 1 BSV', () => {
    const sats = parseDisplayToSatoshis('2400', 'JPY', SATS_PER_USD, { JPY: 150 })
    expect(sats).toBe(SATS_PER_BSV)
  })
})

describe('getUnitLabel fiat', () => {
  it('returns the currency code for EUR', () => {
    expect(getUnitLabel('EUR')).toBe('EUR')
  })

  it('returns the currency code for JPY', () => {
    expect(getUnitLabel('JPY')).toBe('JPY')
  })
})
