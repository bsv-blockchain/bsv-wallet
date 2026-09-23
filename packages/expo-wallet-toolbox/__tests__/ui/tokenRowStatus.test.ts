import { tokenRowStatusView } from '../../ui/tokenStatus'

describe('tokenRowStatusView', () => {
  it('speaks the BSV row words for the ordinary states', () => {
    expect(tokenRowStatusView('settled', true)).toEqual({ key: 'tx_status_received', tone: 'settled' })
    expect(tokenRowStatusView('settled', false)).toEqual({ key: 'tx_status_sent', tone: 'settled' })
    expect(tokenRowStatusView('settling', false)).toEqual({ key: 'tx_status_pending', tone: 'settled' })
  })

  it('keeps its own word and colour only where the holder may need to act', () => {
    expect(tokenRowStatusView('refused', false)).toEqual({ key: 'token_status_refused', tone: 'failed' })
    expect(tokenRowStatusView('reversed', true)).toEqual({ key: 'token_status_reversed', tone: 'failed' })
    expect(tokenRowStatusView('stuck', false)).toEqual({ key: 'token_status_stuck', tone: 'attention' })
  })
})
