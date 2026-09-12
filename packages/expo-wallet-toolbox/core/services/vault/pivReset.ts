/**
 * Resetting a YubiKey's PIV application back to factory state.
 *
 * Kept out of VaultKeyService.ts on purpose: this is a destructive maintenance
 * operation with its own failure modes, not part of the enrollment state
 * machine. It runs in its own card session — never folded into an enrollment
 * tap — so a dropped session can never leave the enrollment quarantine
 * machinery in a state it was not designed for.
 *
 * SAFETY. A PIV reset destroys the P-256 key in Vault slot 0x82. If the token
 * is already an enrolled vault key, that removes one of the k-of-n signers and
 * can make vault funds permanently unspendable. The enrolled-serial refusal
 * below runs before the card is touched AND again inside the session, and is
 * deliberately not overridable by any caller flag — unlike
 * `replaceOccupiedVaultSlot`, which consents to replacing a slot that is by
 * definition not yet part of the vault.
 */
import { getVaultDriver } from './driver'
import { withKeySession } from './session'
import { VaultError } from './types'
import { isVaultSerial, vaultStore, type VaultScopeToken } from './vaultStore'

export type PivResetPhase = 'waiting' | 'resetting'

export async function resetPivApplication(args: {
  /** The reset tap must present exactly this key. */
  serial: string
  /** Serials the caller holds beyond the stored meta — a wizard's pending
   * records. Refused alongside meta. */
  refuseSerials?: readonly string[]
  /** Explicit acknowledgement that this destroys every credential on the
   * token, not only Vault's slot. */
  acknowledgeDestroysAllCredentials: true
  scopeToken?: VaultScopeToken
  nfcMessage?: string
  onPhase?: (p: PivResetPhase) => void
}): Promise<void> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  if (args.acknowledgeDestroysAllCredentials !== true) {
    throw new VaultError('template-invalid', 'Confirm that resetting destroys every credential on this YubiKey')
  }
  if (!isVaultSerial(args.serial)) {
    throw new VaultError('template-invalid', 'Invalid YubiKey serial')
  }
  const scopeToken = args.scopeToken ?? vaultStore.captureScopeToken()

  const refuse = async () => {
    const meta = await vaultStore.getMeta(scopeToken)
    const enrolled = new Set<string>([...(meta?.keys.map(k => k.serial) ?? []), ...(args.refuseSerials ?? [])])
    if (enrolled.has(args.serial)) {
      // The message IS the serial, matching enrollKey's convention.
      throw new VaultError('key-already-enrolled', args.serial, undefined, { serial: args.serial })
    }
  }

  // Guard 1: before any card contact.
  await refuse()
  vaultStore.assertScopeToken(scopeToken)

  await withKeySession(
    driver,
    async () => {
      vaultStore.assertScopeToken(scopeToken)
      const info = await driver.getKeyInfo()
      if (info.serial !== args.serial) {
        throw new VaultError('serial-mismatch', 'A different YubiKey was presented', undefined, {
          tapped: info.serial,
          chosen: args.serial
        })
      }
      // Guard 2: re-read inside the session. Meta can change between the
      // first check and the tap, and this is the last chance before an
      // irreversible destruction.
      await refuse()
      vaultStore.assertScopeToken(scopeToken)

      args.onPhase?.('resetting')
      await driver.resetPivApplication(args.serial)

      // The reset destroyed whatever partial state these described. Leaving
      // them would refuse this key forever.
      vaultStore.assertScopeToken(scopeToken)
      await vaultStore.discardEnrollmentDraft(args.serial, scopeToken)
      await vaultStore.discardEnrollmentQuarantine(args.serial, scopeToken)
    },
    () => args.onPhase?.('waiting'),
    { nfcMessage: args.nfcMessage }
  )
}
