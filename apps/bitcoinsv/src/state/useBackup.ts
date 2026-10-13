// Backing up this wallet, against the shared core.
//
// The secret is read with the core's readBackupMaterial (the mnemonic when
// there is one, otherwise the restored key as hex), only after the briefing
// and a device check, and held only while the backup screen is open. "Backed
// up" is recorded with the core's single writer, recordBackupAttestation,
// only after the check passes; Home re-reads it when that happens.
import { useCallback } from 'react'
import * as LocalAuthentication from 'expo-local-authentication'
import { readBackupMaterial, recordBackupAttestation, useLocalStorage, useWallet } from '@bsv/expo-wallet-toolbox'
import type { BackupMaterial } from '@bsv/expo-wallet-toolbox/core/recovery/backupMaterial'

export type BackupMedium = 'phrase' | 'shares'

/* ---- "backed up" changed: Home's checklist and card listen ---- */

const listeners = new Set<() => void>()

export function onBackupChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * "Confirming it's you": the device's own Face ID, fingerprint or passcode,
 * before anything secret is shown. A presence check for whoever holds the
 * phone, not the key's protection: the secret itself stays behind the
 * core's secure store. A phone with no screen lock at all has nothing to ask.
 */
async function confirmPresence(promptMessage: string): Promise<boolean> {
  try {
    if ((await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.NONE) return true
    const r = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel: 'Cancel', disableDeviceFallback: false })
    return r.success
  } catch {
    return false
  }
}

export type UnlockResult = { kind: 'ok'; material: BackupMaterial } | { kind: 'cancelled' } | { kind: 'unavailable' }

export function useBackup() {
  const { getMnemonic, getRecoveredKey } = useLocalStorage()
  const { managers, adminOriginator } = useWallet()
  const wallet = managers.permissionsManager

  /** The device check, then the wallet's recovery material. */
  const unlock = useCallback(
    async (kind: 'phrase' | 'slices' | 'erase'): Promise<UnlockResult> => {
      const ok = await confirmPresence(
        kind === 'phrase' ? 'Show your recovery phrase' : kind === 'slices' ? 'Print your key slices' : 'Delete your synced copy'
      )
      if (!ok) return { kind: 'cancelled' }
      try {
        return { kind: 'ok', material: await readBackupMaterial({ getMnemonic, getRecoveredKey }) }
      } catch {
        return { kind: 'unavailable' }
      }
    },
    [getMnemonic, getRecoveredKey]
  )

  /** Records the backup; false when nothing was saved (the caller must say so). */
  const markBackedUp = useCallback(
    async (medium: BackupMedium): Promise<boolean> => {
      const ok = await recordBackupAttestation(wallet, adminOriginator, medium)
      if (ok) listeners.forEach(fn => fn())
      return ok
    },
    [wallet, adminOriginator]
  )

  return { unlock, markBackedUp }
}
