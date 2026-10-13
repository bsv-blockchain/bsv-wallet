import { receiptFileName, receiptHtml } from '../src/activity/receipt'

const tx = {
  id: 'aa'.repeat(32),
  txid: 'aa'.repeat(32),
  incoming: false,
  sats: -10023,
  title: 'iPhone',
  note: '<script>alert(1)</script> Coffee',
  counterparty: null,
  status: { tone: 'settled' },
  statusText: 'Sent',
  pending: false,
  createdAt: '2026-10-10T14:57:00Z',
  rawStatus: 'completed',
  labels: []
} as never

describe('a payment’s receipt', () => {
  it('says who, how much, what for and its transaction', () => {
    const html = receiptHtml(tx, { who: 'Ana', explorer: 'https://test.whatsonchain.com/tx/aa' })
    expect(html).toContain('Payment sent')
    expect(html).toContain('−0.00010023 BSV')
    expect(html).toContain('<td>To</td><td>Ana</td>')
    expect(html).toContain('aa'.repeat(32))
  })

  it('never lets a note write into the page', () => {
    expect(receiptHtml(tx)).not.toContain('<script>')
    expect(receiptHtml(tx)).toContain('&lt;script&gt;')
  })

  it('is named for its day and transaction', () => {
    expect(receiptFileName(tx)).toBe('bitcoinsv-receipt-2026-10-10-aaaaaaaa.pdf')
  })
})
