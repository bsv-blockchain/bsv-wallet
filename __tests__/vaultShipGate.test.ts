/**
 * Vault creation ship gate (docs/security/external-review-closure.md).
 *
 * Lifted by the owner on 2026-09-27, after a physical-device mainnet run with
 * three YubiKeys: create, deposit, remove a key, re-lock, withdraw, add a key,
 * re-lock, and withdraw the full balance. The closure report records the
 * evidence and what is still open (wipe → restore-from-chain → withdraw, and
 * the second platform).
 *
 * Vault creation is on in production and both development profiles, and in no
 * other profile. Changing the set is a deliberate act: update the closure
 * report, eas.json and this test together.
 */
import easJson from '../eas.json'

type Profile = { env?: Record<string, string> }
const profiles = easJson.build as Record<string, Profile>

describe('Vault creation ship gate', () => {
  it('the production profile enables Vault output creation', () => {
    expect(profiles.production.env?.EXPO_PUBLIC_VAULT_ENABLED).toBe('true')
  })

  it('only production and the development profiles enable it', () => {
    const enabled = Object.entries(profiles)
      .filter(([, p]) => p.env?.EXPO_PUBLIC_VAULT_ENABLED === 'true')
      .map(([name]) => name)
      .sort()
    expect(enabled).toEqual(['dev-physical', 'development', 'production'])
  })
})
