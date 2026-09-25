/**
 * Vault creation ship gate (docs/security/external-review-closure.md).
 *
 * The v7 Vault output shape — a ~45 KB R1C lock followed by a 1-sat marker
 * and an OP_RETURN descriptor — passes the local strict interpreter and an
 * independent noble check, but has never been broadcast to ARC or mined, and
 * no v7 flow has run on a physical YubiKey (ledger rows NEW-04, NEW-05,
 * INT-05, XQ-003). Until that evidence exists, the production build must not
 * create Vault outputs. Development builds keep the flag so the proofs can be
 * gathered.
 *
 * Lifting the gate is a deliberate act: record the network and hardware
 * evidence in the closure report, then change this test together with
 * eas.json.
 */
import easJson from '../eas.json'

type Profile = { env?: Record<string, string> }
const profiles = easJson.build as Record<string, Profile>

describe('Vault creation ship gate', () => {
  it('the production profile does not enable Vault output creation', () => {
    expect(profiles.production.env?.EXPO_PUBLIC_VAULT_ENABLED).toBeUndefined()
  })

  it('no non-development profile enables it either', () => {
    const enabled = Object.entries(profiles)
      .filter(([, p]) => p.env?.EXPO_PUBLIC_VAULT_ENABLED === 'true')
      .map(([name]) => name)
      .sort()
    expect(enabled).toEqual(['dev-physical', 'development'])
  })
})
