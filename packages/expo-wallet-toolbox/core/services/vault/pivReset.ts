/**
 * Resetting a YubiKey's PIV application back to factory state.
 *
 * Kept out of VaultKeyService.ts on purpose: this is a destructive maintenance
 * operation with its own failure modes, not part of the enrollment state
 * machine. It runs in its own card session — never folded into an enrollment
 * tap — so a dropped session can never leave the enrollment quarantine
 * machinery in a state it was not designed for.
 *
 * SAFETY. A PIV reset destroys the P-256 key in Vault slot 0x82. The vault
 * script accepts a signature from ANY ONE of its enrolled keys (1-of-N, not a
 * threshold scheme), so resetting one enrolled key does not by itself lock
 * funds committed to multiple keys — but it permanently removes that key's
 * own ability to satisfy the script, and if the vault currently has only one
 * enrolled key (or an output was locked before other keys were added), that
 * reset destroys the only remaining way to spend those outputs. The
 * enrolled-serial refusal below runs before the card is touched AND again
 * inside the session, and is deliberately not overridable by any caller flag
 * — unlike `replaceOccupiedVaultSlot`, which consents to replacing a slot
 * that is by definition not yet part of the vault.
 *
 * "Enrolled" is read wider than `getMeta` reads it, on purpose:
 *
 *  - a key in `pendingRemoval` is NOT in `meta.keys` (isVaultMeta enforces
 *    their disjointness), but it is still recoverable — `cancelUnbroadcastKeyRemoval`
 *    splices it back into the active list — so wiping it would leave the vault
 *    listing an active signer whose card holds no key;
 *  - metadata is namespaced per wallet+chain, but a YubiKey is one physical
 *    object. The card enrolled in the mainnet vault is the same card the
 *    testnet enrollment wizard sees as unknown, so the refusal set comes from
 *    `vaultStore.enrolledSerialsAcrossChains`, not `getMeta`.
 *
 * What that still cannot see is a vault belonging to a DIFFERENT wallet
 * identity on this device: SecureStore cannot be enumerated, so proving that
 * negative needs a device-wide serial index this module does not have. Against
 * that residual there is one last, purely local signal — a key sitting in slot
 * 0x82 means this card is a vault key for SOME vault — so an occupied slot is
 * refused unless the caller passes `acknowledgeUnrecognizedVaultKey`. That one
 * IS overridable, because a card left over from a vault the user has already
 * abandoned is the whole reason this service exists; the enrolled-serial
 * refusal above is not.
 *
 * That occupancy question goes to `isVaultSlotOccupied`, which both platforms
 * answer from the card (iOS attests the slot; Android reads its metadata) and
 * which fails closed — only an explicit reference-not-found reports the slot
 * empty. It is deliberately NOT `readVaultPublicKey() !== null`: that returns
 * a public key, and iOS cannot read a retired slot's certificate at all, so it
 * reports null for every 0x82 and this refusal would never fire there.
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
  /** Consent to wiping a card whose Vault slot already holds a key that belongs
   * to no vault this device can see — an abandoned vault, or one enrolled under
   * another wallet identity. Never a way past the enrolled-serial refusal. */
  acknowledgeUnrecognizedVaultKey?: true
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
    // Across every chain, and including a key mid-removal. See the header.
    const enrolled = new Set<string>([
      ...(await vaultStore.enrolledSerialsAcrossChains(scopeToken)),
      ...(args.refuseSerials ?? [])
    ])
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

      // Guard 3: the card's own answer, for the vaults no namespace on this
      // device can show us. Reused code, not new copy: 'slot-occupied' is
      // already enrollment's "slot 0x82 is not empty".
      //
      // `isVaultSlotOccupied`, never `readVaultPublicKey`: the latter returns a
      // public KEY, and iOS cannot read a retired slot's certificate, so it
      // answers null for every 0x82 — occupied or not. Asked that way this
      // guard was a no-op on iOS and the whole consent below it unreachable
      // there. Occupancy fails closed on both platforms: anything short of the
      // card saying "no key here" counts as occupied and takes the consent.
      if (args.acknowledgeUnrecognizedVaultKey !== true && (await driver.isVaultSlotOccupied(args.serial)).occupied) {
        throw new VaultError(
          'slot-occupied',
          'This YubiKey already holds a vault key that belongs to no vault on this device',
          undefined,
          { serial: args.serial }
        )
      }
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
