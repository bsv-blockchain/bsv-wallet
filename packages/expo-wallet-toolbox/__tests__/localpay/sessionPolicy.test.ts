import { nextPhaseAfterUnsealFailure } from '../../core/localpay/sessionPolicy'

describe('sessionPolicy', () => {
  it('keeps the live session after an unseal failure', () => {
    expect(nextPhaseAfterUnsealFailure()).toBe('receive_wait')
  })
})
