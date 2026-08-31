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
})

describe('makeCreditClassifier', () => {
  const beefErr = new Error('The tx parameter must be valid AtomicBEEF')

  it('awaits getOnline so a resolved-false Promise is offline, not treated as online', async () => {
    const getOnline = jest.fn(async () => false)
    expect(!getOnline()).toBe(false)
    const classify = await makeCreditClassifier({ getOnline, takeLastMissHeight: () => undefined })
    expect(classify(beefErr)).toBe('environmental')
  })

  it('takes lastMissHeight once for the pass and reuses it for every payment', async () => {
    const take = jest.fn().mockReturnValue(900000)
    const classify = await makeCreditClassifier({
      getOnline: async () => true,
      takeLastMissHeight: take
    })
    expect(take).toHaveBeenCalledTimes(1)
    expect(classify(beefErr)).toBe('environmental')
    expect(classify(beefErr)).toBe('environmental')
    expect(take).toHaveBeenCalledTimes(1)
  })
})
