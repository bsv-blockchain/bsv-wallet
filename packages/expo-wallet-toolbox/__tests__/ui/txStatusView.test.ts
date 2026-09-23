import { txStatusView } from '../../ui/txStatus'

describe('txStatusView', () => {
  it('says Sent/Received once broadcast, before and after the block proof', () => {
    for (const status of ['unproven', 'completed']) {
      expect(txStatusView(status, undefined, true)).toEqual({ key: 'tx_status_received', tone: 'settled' })
      expect(txStatusView(status, undefined, false)).toEqual({ key: 'tx_status_sent', tone: 'settled' })
    }
  })

  it('says Sent while still broadcasting, with the in-flight tone', () => {
    expect(txStatusView('sending', undefined, false)).toEqual({ key: 'tx_status_sent', tone: 'inflight' })
  })
})
