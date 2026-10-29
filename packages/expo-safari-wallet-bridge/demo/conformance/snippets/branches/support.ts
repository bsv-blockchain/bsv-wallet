// @ts-nocheck
import { Random, Utils } from '@bsv/sdk'
import { executeSnippet, ProbeSkipped, type SnippetRunner } from '../../lib/snippet-runner'

export interface BranchCase { id: string; run: () => Promise<void> }
export const booleans = [false, true]
export const freshID = () => Utils.toHex(Random(8))

export async function runCases(runner: SnippetRunner, cases: BranchCase[]) {
  let failed = 0
  let skipped = 0
  for (const [index, test] of cases.entries()) {
    if (runner.shouldStop?.()) {
      for (const remaining of cases.slice(index)) runner.case?.(remaining.id, { status: 'skipped', durationMs: 0, message: 'Stopped before this case' })
      if (failed > 0) throw new Error(`${failed} branch cases failed before stopping. See case results.`)
      throw new ProbeSkipped(`Stopped before ${cases.length - index} remaining branch cases.`)
    }
    const result = await executeSnippet(test.run)
    runner.case?.(test.id, result)
    runner.log({ case: test.id, ...result })
    failed += Number(result.status === 'failed')
    skipped += Number(result.status === 'skipped')
  }
  if (failed > 0) throw new Error(`${failed} of ${cases.length} branch cases failed. See case results.`)
  if (skipped > 0) throw new ProbeSkipped(`${skipped} of ${cases.length} branch cases need fixtures or another run.`)
}
