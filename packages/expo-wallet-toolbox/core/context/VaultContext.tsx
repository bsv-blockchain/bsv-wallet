/**
 * VaultContext — the React face of the ceremony singleton.
 *
 * Subscribes to the shared CeremonyController (services/vault/ceremonyHost) and
 * republishes its state to the ceremony sheet, and owns the *effects* of a
 * ceremony: on arm, play the open sound + success haptic; on relock, play the
 * close sound + confirm haptic and toast.
 *
 * WalletContext owns the unplug→relock wiring; this owns the user-facing
 * feedback. They never fire the same haptic twice — the pairing rules live in
 * hooks/useConfirmationSound.
 */
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { ceremony } from '../services/vault/ceremonyHost'
import { CeremonyState } from '../services/vault/ceremony'
import { vaultStore } from '../services/vault/vaultStore'
import { sounds } from '../hooks/useConfirmationSound'
import { haptics } from '../hooks/useHaptics'
import i18n from '../i18n/translations'

/**
 * Minimal shape of the app's toast function. `core` must never import a `ui`
 * component (see the module doc above and hooks/useHaptics.ts /
 * hooks/useConfirmationSound.ts for the same boundary), so VaultProvider
 * takes an optional toast callback instead of importing one — the host app
 * wires its own toast implementation (e.g. `components/ui/Toast`'s
 * `showToast`) in via the `onToast` prop.
 */
export type VaultToast = (message: string, opts?: { type?: 'info' | 'success' | 'error' }) => void

interface VaultContextValue {
  state: CeremonyState
  submitPin: (pin: string) => void
  cancel: () => void
  retry: () => void
}

const VaultContext = createContext<VaultContextValue>({
  state: { phase: 'idle' },
  submitPin: () => {},
  cancel: () => {},
  retry: () => {}
})

export const VaultProvider: React.FC<{ children: React.ReactNode; onToast?: VaultToast }> = ({ children, onToast }) => {
  const [state, setState] = useState<CeremonyState>(ceremony.state)

  useEffect(() => ceremony.subscribe(setState), [])

  // One-time cleanup of the K1-era sealed blob (spec §3.2). Fire-and-forget:
  // migrateLegacySeal swallows its own errors.
  useEffect(() => {
    void vaultStore.migrateLegacySeal()
  }, [])

  // Effects of a completed ceremony: the open cue, and nothing else. `onArmed`
  // deliberately ignores its VaultSigner argument — the signer is owned by the
  // transfer that requested it (transfers.ts obtains it from ceremonyHost) and
  // must never reach React state (see VaultSigner in services/vault/ceremony.ts).
  useEffect(() => {
    ceremony.onArmed = () => {
      haptics.success()
      sounds.vaultOpen()
    }
    ceremony.onRelock = () => {
      haptics.confirm()
      sounds.vaultClose()
      onToast?.(i18n.t('vault_locked'), { type: 'info' })
    }
    return () => {
      ceremony.onArmed = undefined
      ceremony.onRelock = undefined
    }
  }, [onToast])

  const submitPin = useCallback((pin: string) => ceremony.submitPin(pin), [])
  const cancel = useCallback(() => ceremony.cancel(), [])
  const retry = useCallback(() => ceremony.retry(), [])

  const value = useMemo(() => ({ state, submitPin, cancel, retry }), [state, submitPin, cancel, retry])
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

export const useVault = (): VaultContextValue => useContext(VaultContext)
