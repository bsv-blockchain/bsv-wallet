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

// Physical-device report 2026-09-25: a failed Nearby payment (noSend) needs
// Cancel only while it provably never left the device, and a way to deliver
// the same payment over the message box instead.
describe('detailActionKeysFor: Cancel and Request confirmation from recipient', () => {
  it.each(['queued', 'posting', 'sent', 'acknowledged', 'rejected', 'import_hold'])(
    'offers no plain Cancel once the payment was recorded as %s (the payee may hold it)',
    offlineStatus => {
      const keys = detailActionKeysFor({ txid: 'tx1', reference: 'ref-1', status: 'nosend', offlineStatus })
      expect(keys).not.toContain('abort')
    }
  )

  it.each(['peerpay', 'localpay', 'mandala'])('offers Request confirmation for an outgoing %s payment', label => {
    const keys = detailActionKeysFor({
      txid: 'tx1',
      reference: 'ref-1',
      status: 'nosend',
      isOutgoing: true,
      labels: [label, '02'.padEnd(66, 'a')]
    })
    expect(keys).toContain('request-confirmation')
    expect(keys).toContain('abort')
  })

  it('offers Request confirmation on a parked payment too, beside its own cancel', () => {
    const keys = detailActionKeysFor({
      txid: 'tx1',
      reference: 'ref-1',
      status: 'nosend',
      offlineStatus: 'parked',
      isOutgoing: true,
      labels: ['peerpay']
    })
    expect(keys).toEqual(expect.arrayContaining(['cancel-parked', 'request-confirmation']))
  })

  it('never offers it for an incoming payment, an unlabelled one, or one with no txid', () => {
    expect(detailActionKeysFor({ txid: 'tx1', status: 'completed', isOutgoing: false, labels: ['peerpay'] })).not.toContain(
      'request-confirmation'
    )
    expect(detailActionKeysFor({ txid: 'tx1', status: 'completed', isOutgoing: true, labels: ['other'] })).not.toContain(
      'request-confirmation'
    )
    expect(detailActionKeysFor({ status: 'unsigned', isOutgoing: true, labels: ['peerpay'] })).not.toContain(
      'request-confirmation'
    )
  })
})
