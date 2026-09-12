#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const jest = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js')
const test = path.join(root, 'packages', 'expo-wallet-toolbox', '__tests__', 'vault', 'r1comb.test.ts')

const result = spawnSync(process.execPath, [
  jest,
  test,
  '--runInBand',
  '--watchman=false',
  '--testNamePattern',
  'rejects the signature-free CRT forgery'
], {
  cwd: root,
  stdio: 'inherit'
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
