import { sqlBindValue } from '../../core/storage/sqlUpdateValue'

describe('sqlBindValue', () => {
  it('clears outputs.spentBy when the caller passes undefined', () => {
    expect(sqlBindValue('outputs', 'spentBy', undefined)).toEqual({ omit: false, value: null })
  })
  it('still skips undefined on other columns', () => {
    expect(sqlBindValue('outputs', 'spendable', undefined)).toEqual({ omit: true })
    expect(sqlBindValue('transactions', 'status', undefined)).toEqual({ omit: true })
  })
})
