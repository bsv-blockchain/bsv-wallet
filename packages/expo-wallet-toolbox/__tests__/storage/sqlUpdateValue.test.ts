import { sqlBindValue } from '../../core/storage/sqlUpdateValue'

describe('sqlBindValue', () => {
  it('clears outputs.spentBy when the caller passes undefined', () => {
    expect(sqlBindValue('outputs', 'spentBy', undefined)).toEqual({ omit: false, value: null })
  })
  // relinquishOutput writes { basketId: undefined }, and a synced relinquish
  // arrives through EntityOutput.mergeExisting's toApi() the same way; both
  // mean "no basket", so skipping the column left the output in its basket.
  it('clears outputs.basketId when the caller passes undefined', () => {
    expect(sqlBindValue('outputs', 'basketId', undefined)).toEqual({ omit: false, value: null })
  })
  it('still skips undefined on other columns', () => {
    expect(sqlBindValue('outputs', 'spendable', undefined)).toEqual({ omit: true })
    expect(sqlBindValue('transactions', 'status', undefined)).toEqual({ omit: true })
    expect(sqlBindValue('output_baskets', 'basketId', undefined)).toEqual({ omit: true })
  })
})
