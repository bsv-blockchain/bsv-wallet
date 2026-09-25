/**
 * XR-031: checkUtxoSpendability (WalletContext.tsx) must not commit
 * `spendable:false` against a UTXO until AFTER it has confirmed the alleged
 * spending transaction's own parsed BEEF actually consumes that exact
 * outpoint — not merely on two independent chain-service oracles agreeing on
 * a bare claim (misc-p2-01's `shouldMarkUnspendable` gate).
 *
 * WalletContext itself has no test harness (see __tests__/walletMonitor.test.ts
 * and __tests__/context/mandalaDrainTick.test.ts for the same constraint), so
 * the wiring is checked structurally: the destructive write must appear, in
 * source order, after the outpoint-verification call within the same block.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, '../../core/context/WalletContext.tsx'), 'utf8')

describe('XR-031: checkUtxoSpendability write ordering', () => {
  const gateStart = source.indexOf('const markUnspendable = shouldMarkUnspendable(')
  const writeStart = source.indexOf('spendingDescription: JSON.stringify({ claimedSpender: spendingTxid')

  it('has not lost the second-source gate or the destructive write this test locates', () => {
    expect(gateStart).toBeGreaterThan(0)
    expect(writeStart).toBeGreaterThan(gateStart)
  })

  it('verifies the spender actually consumes this outpoint BEFORE the spendable:false write', () => {
    const verifyCall = source.indexOf('spenderConsumesOutpoint(', gateStart)
    expect(verifyCall).toBeGreaterThan(gateStart)
    expect(verifyCall).toBeLessThan(writeStart)
  })

  it('does not write spendable:false unless the outpoint verification passed', () => {
    // The write must sit inside the same guarded block: a `continue` (or
    // return) reachable from a failed verification, strictly between the
    // verification call and the write, is what keeps an unverified claim
    // from ever reaching storage.updateOutput.
    const verifyCall = source.indexOf('spenderConsumesOutpoint(', gateStart)
    const between = source.slice(verifyCall, writeStart)
    expect(between).toContain('continue')
  })
})
