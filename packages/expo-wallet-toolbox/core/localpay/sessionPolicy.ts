export type NearbyPhase = 'receive_wait' | 'failed'

export function nextPhaseAfterUnsealFailure(): NearbyPhase {
  return 'receive_wait'
}

export function exitSendQrChoice(scanned: 'yes' | 'no' | 'unsure'): 'hold' | 'abort' {
  return scanned === 'no' ? 'abort' : 'hold'
}
