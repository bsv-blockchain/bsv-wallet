export type NearbyPhase = 'receive_wait' | 'failed'

export function nextPhaseAfterUnsealFailure(): NearbyPhase {
  return 'receive_wait'
}
