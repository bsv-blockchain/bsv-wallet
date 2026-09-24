import { createAutoApprovePolicy } from '../../core/services/autoApprovePolicy'

const THRESHOLD = 100_000
const COOLDOWN_MS = 10_000
const DAILY_CAP_SATS = 10 * THRESHOLD

function makePolicy(startAt: number) {
  let now = startAt
  const policy = createAutoApprovePolicy({
    now: () => now,
    threshold: () => THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    dailyCapSats: DAILY_CAP_SATS
  })
  return {
    policy,
    advance(ms: number) {
      now += ms
    },
    approve(originator: string, satoshis: number) {
      const decision = policy.shouldAutoApprove({ originator, satoshis })
      if (decision.approve) policy.record({ originator, satoshis, at: now })
      return decision
    }
  }
}

const START = Date.parse('2026-09-24T00:00:00.000Z')

it('approves a request under threshold with no prior approval', () => {
  const { approve } = makePolicy(START)
  expect(approve('originA', 1_000)).toEqual({ approve: true, reason: null })
})

it('refuses a request over threshold', () => {
  const { approve } = makePolicy(START)
  expect(approve('originA', THRESHOLD + 1)).toEqual({ approve: false, reason: 'over-threshold' })
})

it('refuses the same originator again within the cooldown window', () => {
  const { approve } = makePolicy(START)
  expect(approve('originA', 1_000).approve).toBe(true)
  expect(approve('originA', 1_000)).toEqual({ approve: false, reason: 'cooldown' })
})

it('still approves a DIFFERENT originator within the same cooldown window (per-origin)', () => {
  const { approve } = makePolicy(START)
  expect(approve('originA', 1_000).approve).toBe(true)
  expect(approve('originB', 1_000)).toEqual({ approve: true, reason: null })
})

it('approves the same originator again once the cooldown has elapsed', () => {
  const { approve, advance } = makePolicy(START)
  expect(approve('originA', 1_000).approve).toBe(true)
  advance(COOLDOWN_MS)
  expect(approve('originA', 1_000)).toEqual({ approve: true, reason: null })
})

it('falls through to the daily cap once cumulative approvals across ALL originators exceed it, even though each request is individually under threshold and past its own cooldown', () => {
  const { approve, advance } = makePolicy(START)
  const perRequest = THRESHOLD
  const requestsToFillCap = Math.floor(DAILY_CAP_SATS / perRequest) // 10
  for (let i = 0; i < requestsToFillCap; i++) {
    // Different originator each time so cooldown never blocks — isolates the cap.
    const decision = approve(`origin${i}`, perRequest)
    expect(decision).toEqual({ approve: true, reason: null })
    advance(1) // avoid any same-ms edge cases
  }
  // The (N+1)th request, from yet another fresh originator, is under
  // threshold and has no cooldown of its own, but pushes the rolling total
  // over the cap.
  expect(approve('originOverflow', perRequest)).toEqual({ approve: false, reason: 'daily-cap' })
})

it('does not count ledger entries older than 24 hours toward the daily cap', () => {
  const { approve, advance } = makePolicy(START)
  const perRequest = THRESHOLD
  const requestsToFillCap = Math.floor(DAILY_CAP_SATS / perRequest)
  for (let i = 0; i < requestsToFillCap; i++) {
    expect(approve(`origin${i}`, perRequest).approve).toBe(true)
    advance(1)
  }
  // Confirm the cap is currently exhausted.
  expect(approve('originOverflow', perRequest)).toEqual({ approve: false, reason: 'daily-cap' })
  // Move past 24h from the FIRST recorded entry — all prior entries expire.
  advance(24 * 60 * 60 * 1000)
  expect(approve('originFresh', perRequest)).toEqual({ approve: true, reason: null })
})
