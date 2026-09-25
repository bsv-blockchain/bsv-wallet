import { detailActionKeysFor } from '../../ui/screens/detailActionKeys'

describe('XR-095: detailActionKeysFor', () => {
  it('never offers the raw abort action on a parked nearby payment — only cancel-parked', () => {
    const keys = detailActionKeysFor({ txid: 'tx1', reference: 'ref-1', status: 'nosend', offlineStatus: 'parked' })
    expect(keys).toContain('cancel-parked')
    expect(keys).not.toContain('abort')
  })

  it('still offers abort on an ordinary local nosend row with no offline entry', () => {
    const keys = detailActionKeysFor({ txid: 'tx1', reference: 'ref-1', status: 'nosend' })
    expect(keys).toContain('abort')
    expect(keys).not.toContain('cancel-parked')
  })

  it('offers neither refresh nor explorer on a parked row', () => {
    const keys = detailActionKeysFor({ txid: 'tx1', reference: 'ref-1', status: 'nosend', offlineStatus: 'parked' })
    expect(keys).not.toContain('refresh')
    expect(keys).not.toContain('explorer')
  })
})
