/**
 * XQ-014 — pivReset's "unrecognized occupied slot" consent overclaimed what
 * the app can actually verify.
 *
 * pivReset.ts's own docstring is explicit about the residual: a vault
 * belonging to a DIFFERENT wallet identity on this device is invisible to
 * `enrolledSerialsAcrossChains` (SecureStore cannot be enumerated across
 * identities — see vaultStore.ts and pivReset.ts's module doc). Guard 3's
 * consent copy (`vault_reset_unknown_ack`) nonetheless told the user "no
 * vault on this device claims" the key — an assertion of fact the code
 * cannot verify for exactly that same-device, different-identity case,
 * matching a shared physical YubiKey reused across two wallet profiles.
 *
 * Closing the underlying gap for real needs a cross-identity registry with
 * correct reference counting across every enroll/add-key/remove-key/disable
 * path (a serial can legitimately be enrolled under more than one identity
 * at once) — a redesign beyond a safe small change for this Medium,
 * narrow-precondition finding. The safe, local, backwards-compatible
 * narrowing available now is to stop the copy claiming a certainty the code
 * does not have: state the true uncertainty instead of a false negative.
 */
import { resources } from '../../core/i18n/translations'

describe('vault_reset_unknown_ack (XQ-014)', () => {
  it('states the true uncertainty rather than a false negative for a same-device, different-identity vault', () => {
    const english = resources.en.translation as Record<string, string>
    const copy = english.vault_reset_unknown_ack
    expect(copy).toBeDefined()

    // The overclaiming assertion this finding is about: the app cannot
    // actually verify "no vault on this device claims" this key, because a
    // different wallet identity's vault is invisible to it by design.
    expect(copy).not.toMatch(/no vault on this device claims/i)

    // The replacement copy must actually disclose the uncertainty (not just
    // remove the false claim) and keep the one thing that IS still true:
    // proceeding may destroy the key for good.
    expect(copy.toLowerCase()).toContain('cannot confirm')
    expect(copy.toLowerCase()).toMatch(/destroy/i)
  })
})
