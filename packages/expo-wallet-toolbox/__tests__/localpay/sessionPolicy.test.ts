import { exitSendQrChoice, nextPhaseAfterUnsealFailure } from '../../core/localpay/sessionPolicy'

describe('sessionPolicy', () => {
  it('keeps the live session after an unseal failure', () => {
    expect(nextPhaseAfterUnsealFailure()).toBe('receive_wait')
  })

  it('aborts only when the payer is sure the code was never scanned', () => {
    expect(exitSendQrChoice('no')).toBe('abort')
    expect(exitSendQrChoice('yes')).toBe('hold')
    expect(exitSendQrChoice('unsure')).toBe('hold')
  })
})
