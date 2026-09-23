import { txStatusView } from '../../ui/txStatus'

describe('txStatusView', () => {
  it('says Sent/Received once broadcast, before and after the block proof', () => {
    for (const status of ['unproven', 'completed']) {
      expect(txStatusView(status, undefined, true)).toEqual({ key: 'tx_status_received', tone: 'settled' })
      expect(txStatusView(status, undefined, false, ['peerpay'])).toEqual({ key: 'tx_status_sent', tone: 'settled' })
    }
  })

  it('says Sent while still broadcasting, with the in-flight tone', () => {
    expect(txStatusView('sending', undefined, false, ['peerpay'])).toEqual({ key: 'tx_status_sent', tone: 'inflight' })
  })

  it('says Sent for an outgoing Pay action, Spent for anything else', () => {
    for (const label of ['peerpay', 'localpay', 'legacy', 'mandala']) {
      expect(txStatusView('completed', undefined, false, [label]).key).toBe('tx_status_sent')
    }
    // A connected app's action, or an identity certificate: no payment label.
    expect(txStatusView('completed', undefined, false, ['some-app-label']).key).toBe('tx_status_spent')
    expect(txStatusView('unproven', undefined, false, undefined).key).toBe('tx_status_spent')
  })

  it('keeps Received for incoming, whatever made it', () => {
    expect(txStatusView('completed', undefined, true, ['some-app-label']).key).toBe('tx_status_received')
  })
})
