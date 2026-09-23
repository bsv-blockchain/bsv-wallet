import { activityKind, txStatusView } from '../../ui/txStatus'

describe('activityKind', () => {
  it('reads a vault move as Transferred in either direction', () => {
    expect(activityKind(false, ['vault', 'vault-deposit'])).toBe('transferred')
    expect(activityKind(true, ['vault', 'vault-withdraw'])).toBe('transferred')
  })

  it('reads incoming as Received, whatever made it', () => {
    expect(activityKind(true, ['some-app-label'])).toBe('received')
    expect(activityKind(true, undefined)).toBe('received')
  })

  it('reads outgoing as Sent from a Pay rail, Spent otherwise', () => {
    for (const label of ['peerpay', 'localpay', 'legacy', 'mandala']) {
      expect(activityKind(false, [label])).toBe('sent')
    }
    expect(activityKind(false, ['some-app-label'])).toBe('spent')
    expect(activityKind(false, undefined)).toBe('spent')
  })
})

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

  it('says Transferred for a vault move in either direction', () => {
    expect(txStatusView('completed', undefined, false, ['vault', 'vault-deposit']).key).toBe('tx_status_transferred')
    expect(txStatusView('completed', undefined, true, ['vault', 'vault-withdraw']).key).toBe('tx_status_transferred')
  })
})
