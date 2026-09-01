import { classifyCreditError, makeCreditClassifier } from '../../core/pay/creditErrors'

describe('classifyCreditError', () => {
  it('classifies a failed-status internalize as double_spend', () => {
    expect(classifyCreditError(new Error('target transaction of internalizeAction has invalid status failed.'))).toBe(
      'double_spend'
    )
  })
  it('classifies AtomicBEEF while headers missed as environmental', () => {
    expect(classifyCreditError(new Error('The tx parameter must be valid AtomicBEEF'), { lastMissHeight: 900000 })).toBe(
      'environmental'
    )
  })
  it('classifies a missing derivation as structural', () => {
    expect(classifyCreditError(new Error("Cannot read property 'derivationPrefix' of undefined"))).toBe('structural')
  })

  it('classifies AtomicBEEF while online with no lastMissHeight as structural', () => {
    expect(classifyCreditError(new Error('The tx parameter must be valid AtomicBEEF'))).toBe('structural')
  })

  it('classifies AtomicBEEF while offline as environmental', () => {
    expect(classifyCreditError(new Error('The tx parameter must be valid AtomicBEEF'), { offline: true })).toBe(
      'environmental'
    )
  })

  it('classifies a network failure as environmental even while online', () => {
    expect(classifyCreditError(new Error('Network request failed'))).toBe('environmental')
  })

  it('classifies a timeout as environmental', () => {
    expect(classifyCreditError(new Error('request timed out'))).toBe('environmental')
  })

  it('classifies a chaintracks miss as environmental', () => {
    expect(classifyCreditError(new Error('chaintracks has no header for height'))).toBe('environmental')
  })

  it.each([
    'database is locked',
    'database table is locked',
    'database-locked',
    'failed to retrieve messages',
    'Payment not found on refresh'
  ])(
    'classifies %s as environmental',
    msg => {
      expect(classifyCreditError(new Error(msg))).toBe('environmental')
    }
  )
})

describe('makeCreditClassifier', () => {
  const beefErr = new Error('The tx parameter must be valid AtomicBEEF')

  it('awaits getOnline so a resolved-false Promise is offline, not treated as online', async () => {
    const getOnline = jest.fn(async () => false)
    expect(!getOnline()).toBe(false)
    const classify = await makeCreditClassifier({ getOnline, peekLastMissHeight: () => undefined })
    expect(classify(beefErr)).toBe('environmental')
  })

  it('reads lastMissHeight at failure time so a miss during the pass is environmental', async () => {
    let miss: number | undefined
    const classify = await makeCreditClassifier({
      getOnline: async () => true,
      peekLastMissHeight: () => miss
    })
    const beefErr = new Error('The tx parameter must be valid AtomicBEEF')
    expect(classify(beefErr)).toBe('structural')
    miss = 900000
    expect(classify(beefErr)).toBe('environmental')
  })

  it('does not consume the miss marker', async () => {
    const peek = jest.fn().mockReturnValue(7)
    const classify = await makeCreditClassifier({ getOnline: async () => true, peekLastMissHeight: peek })
    classify(new Error('The tx parameter must be valid AtomicBEEF'))
    classify(new Error('The tx parameter must be valid AtomicBEEF'))
    expect(peek).toHaveBeenCalledTimes(2)
  })
})
