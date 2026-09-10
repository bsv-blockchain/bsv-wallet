/**
 * The process-wide ceremony singleton.
 *
 * Constructed once against the live driver + store so the vault transfer flow
 * and the React vault context drive the SAME ceremony. Kept out of any React
 * module so importing it never pulls in the component graph.
 */
import { CeremonyController, VaultProgress, VaultSigner } from './ceremony'
import { getVaultDriver } from './driver'
import { vaultStore } from './vaultStore'

/** How long an armed signer stays usable before it relocks — refreshed by
 * progress notes and sign() calls, capped at 3× (see ceremony.ts). */
export const VAULT_RETENTION_MS = 120_000

/** Digests one NFC tap covers before the ceremony closes the session and
 * asks for a fresh tap (spec §4.2 step 6). PROVISIONAL: pinned by the §0
 * device run (a 32-input withdrawal on iOS) against the card's 15 s touch
 * cache and CoreNFC's 60 s session. Persistent readers (Android USB) ignore it. */
export const VAULT_INPUTS_PER_TAP = 16

export const ceremony = new CeremonyController({
  getDriver: getVaultDriver,
  store: {
    // Only what the ceremony needs to run a tap: which serials may answer and
    // which slot / public key each carries. Nicknames and timestamps stay in
    // the store — the sheet reads them from vaultStore directly.
    getMeta: async () => {
      const m = await vaultStore.getMeta()
      return m ? { keys: m.keys.map(k => ({ serial: k.serial, slot: k.slot, pubkey: k.pubkey })) } : null
    }
  },
  retentionMs: VAULT_RETENTION_MS,
  inputsPerTap: VAULT_INPUTS_PER_TAP
})

/** Tap the CHOSEN YubiKey to obtain a signer for one operation. Callers MUST
 * release() in a finally — that is what dismisses the NFC sheet and drops the
 * PIN. `reason` is what the sheet shows, and (Task 6, decision 1) the iOS NFC
 * alert text. */
export function requestVaultSigner(reason: string, chosenSerial: string): Promise<VaultSigner> {
  return ceremony.requestSigner(reason, chosenSerial)
}

/** Report post-arm progress (preparing with signed/total, broadcasting) so
 * the ceremony sheet can show activity through the seconds-long stretches
 * where the JS thread or the network is busy, and so the retention window
 * tracks a live operation instead of expiring underneath it. A no-op when
 * nothing is armed — which is what keeps the hardware-free deposit sheet-free. */
export function noteVaultProgress(p: VaultProgress): void {
  ceremony.noteProgress(p)
}
