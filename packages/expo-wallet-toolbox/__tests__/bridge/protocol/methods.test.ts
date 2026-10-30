import { BRIDGE_METHODS } from '../../../core/bridge/protocol/methods'

// Keys of the SDK's WalletInterface (BRC-100), read from the shipped declaration so a new
// SDK method fails this test instead of slipping past the bridge.
function sdkMethodNames(): string[] {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const src = fs.readFileSync(
    path.resolve(process.cwd(), 'node_modules/@bsv/sdk/dist/types/src/wallet/Wallet.interfaces.d.ts'),
    'utf8'
  )
  const start = src.indexOf('export interface WalletInterface')
  const body = src.slice(start)
  const names = new Set<string>()
  // Members are declared as `name: (args...` at four-space indent.
  for (const m of body.matchAll(/^ {4}([A-Za-z]+): \(/gm)) names.add(m[1])
  return [...names]
}

describe('BRIDGE_METHODS', () => {
  it('has exactly the 28 SDK WalletInterface methods', () => {
    const sdk = sdkMethodNames().sort()
    expect(sdk).toHaveLength(28)
    expect(Object.keys(BRIDGE_METHODS).sort()).toEqual(sdk)
  })

  it('flags probes: only getVersion and isAuthenticated', () => {
    const probes = Object.entries(BRIDGE_METHODS)
      .filter(([, v]) => v.probe)
      .map(([k]) => k)
      .sort()
    expect(probes).toEqual(['getVersion', 'isAuthenticated'])
  })

  it('flags mutating methods per spec 6.6 step 10', () => {
    const mutating = Object.entries(BRIDGE_METHODS)
      .filter(([, v]) => v.mutating)
      .map(([k]) => k)
      .sort()
    expect(mutating).toEqual(
      [
        'abortAction',
        'acquireCertificate',
        'createAction',
        'internalizeAction',
        'relinquishCertificate',
        'relinquishOutput',
        'signAction'
      ].sort()
    )
  })

  it('is frozen so a caller cannot widen it', () => {
    expect(Object.isFrozen(BRIDGE_METHODS)).toBe(true)
  })
})
