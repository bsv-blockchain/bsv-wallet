/**
 * The E2E harness is off unless configureToolbox is given an e2e broadcaster,
 * and while it is on the wallet cannot be placed on mainnet or behind a
 * biometric prompt.
 */
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { fake as localAuth } from '../__mocks__/localAuthFake'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'
import { e2eSafeChain, isE2eBuild, resetE2eMode } from '../../core/e2e/mode'
import { defaultProfilesState, parseProfilesState } from '../../core/profiles/profileStore'
import { resolveProvisioningPolicy } from '../../core/services/secrets/policy'

const BROADCASTER = 'http://10.0.2.2:8787'

afterEach(() => {
  resetToolboxConfig()
  resetE2eMode()
  localAuth.__reset()
})

describe('e2e harness', () => {
  test('a normal configure leaves mainnet alone and does not skip biometrics', async () => {
    configureToolbox({ backupUrl: null })
    expect(isE2eBuild()).toBe(false)
    expect(e2eSafeChain('main')).toBe('main')
    expect(defaultProfilesState().profiles[0].network).toBe('main')
    localAuth.__setLevel(localAuth.SecurityLevel.BIOMETRIC_STRONG)
    await expect(resolveProvisioningPolicy()).resolves.toMatchObject({ policy: 'biometric' })
  })

  test('the harness forces testnet, refuses mainnet services, and skips the biometric probe', async () => {
    configureToolbox({ backupUrl: null, e2e: { broadcasterUrl: BROADCASTER } })
    expect(isE2eBuild()).toBe(true)
    expect(e2eSafeChain('main')).toBe('test')
    expect(e2eSafeChain('teratest')).toBe('teratest')
    expect(defaultProfilesState()).toEqual({ active: 0, profiles: [{ index: 0, network: 'test' }] })
    expect(parseProfilesState(JSON.stringify({ active: 0, profiles: [{ index: 0, network: 'main' }] }))).toEqual({
      active: 0,
      profiles: [{ index: 0, network: 'test' }]
    })
    localAuth.getEnrolledLevelAsync.mockClear()
    await expect(resolveProvisioningPolicy()).resolves.toMatchObject({
      policy: 'dev-plain',
      requireAuthentication: false
    })
    expect(localAuth.getEnrolledLevelAsync).not.toHaveBeenCalled()
  })

  test('a harness that still names mainnet, backup, vault, or push does not boot', () => {
    expect(() =>
      configureToolbox({ backupUrl: 'https://backup.example', e2e: { broadcasterUrl: BROADCASTER } })
    ).toThrow(/backupUrl/)
    expect(isE2eBuild()).toBe(false)
    expect(() =>
      configureToolbox({
        backupUrl: null,
        vaultEnabled: true,
        e2e: { broadcasterUrl: BROADCASTER }
      })
    ).toThrow(/vault/)
    expect(() =>
      configureToolbox({
        backupUrl: null,
        services: { main: { arcUrl: 'https://arc.example' } },
        e2e: { broadcasterUrl: BROADCASTER }
      })
    ).toThrow(/mainnet/)
    expect(() => configureToolbox({ backupUrl: null, e2e: { broadcasterUrl: 'http://evil.example' } })).toThrow(
      /broadcasterUrl/
    )
    expect(() => configureToolbox({ backupUrl: null, e2e: { broadcasterUrl: 'https://arc.example' } })).toThrow(
      /broadcasterUrl/
    )
  })
})
