#!/usr/bin/env node
/**
 * Runs the whole Vault proof bar in order and prints a per-proof pass/fail
 * summary, exiting non-zero on any failure. Mirrors run-r1c-crt-forgery.cjs's
 * spawn pattern (invoking the workspace's own jest binary directly, not
 * `npx`), extended to a fixed sequence of proofs and a final report.
 *
 * Order:
 *   1. script matrix        — proofBar.scriptMatrix.test.ts        (bar §4.1)
 *   2. CRT forgery harness  — r1comb.test.ts (one named test)      (bar §4.1)
 *   3. clean-device I1 proof— proofBar.cleanDeviceRecovery.test.ts (bar §4.2)
 *   4. exclusion matrix     — proofBar.exclusionMatrix.test.ts     (bar §4.3)
 *   5. rail-isolation proof — proofBar.railIsolation.test.ts       (bar §4.4)
 *   6. no-production-mock   — proofBar.noProductionMock.test.ts    (bar §4.5)
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const jestBin = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js')
const vaultTests = path.join(root, 'packages', 'expo-wallet-toolbox', '__tests__', 'vault')

const PROOFS = [
  {
    name: 'script matrix (proof bar §4.1)',
    args: [path.join(vaultTests, 'proofBar.scriptMatrix.test.ts')]
  },
  {
    name: 'CRT forgery harness (proof bar §4.1)',
    args: [
      path.join(vaultTests, 'r1comb.test.ts'),
      '--testNamePattern', 'rejects the signature-free CRT forgery'
    ]
  },
  {
    name: 'clean-device I1 proof (proof bar §4.2)',
    args: [path.join(vaultTests, 'proofBar.cleanDeviceRecovery.test.ts')]
  },
  {
    name: 'exclusion matrix I2 (proof bar §4.3)',
    args: [path.join(vaultTests, 'proofBar.exclusionMatrix.test.ts')]
  },
  {
    name: 'rail-isolation proof I3 (proof bar §4.4)',
    args: [path.join(vaultTests, 'proofBar.railIsolation.test.ts')]
  },
  {
    name: 'no-production-mock proof (proof bar §4.5)',
    args: [path.join(vaultTests, 'proofBar.noProductionMock.test.ts')]
  }
]

const COMMON_ARGS = ['--runInBand', '--watchman=false']

function runOne(proof) {
  const started = Date.now()
  console.log(`\n${'─'.repeat(70)}\n▶ ${proof.name}\n${'─'.repeat(70)}`)
  const result = spawnSync(process.execPath, [jestBin, ...proof.args, ...COMMON_ARGS], {
    cwd: root,
    stdio: 'inherit'
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.error) {
    return { name: proof.name, ok: false, seconds, error: result.error.message }
  }
  return { name: proof.name, ok: result.status === 0, seconds }
}

function main() {
  const results = PROOFS.map(runOne)

  console.log(`\n${'='.repeat(70)}\nProof bar summary\n${'='.repeat(70)}`)
  let passCount = 0
  let failCount = 0
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL'
    if (r.ok) passCount++
    else failCount++
    console.log(`  [${mark}] ${r.name} (${r.seconds}s)${r.error ? ` — ${r.error}` : ''}`)
  }
  console.log(`${'-'.repeat(70)}`)
  console.log(`  ${passCount} passed, ${failCount} failed, ${results.length} total`)
  console.log(`${'='.repeat(70)}`)

  process.exit(failCount === 0 ? 0 : 1)
}

main()
