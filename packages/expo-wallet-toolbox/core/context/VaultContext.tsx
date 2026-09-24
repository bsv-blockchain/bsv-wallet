/**
 * VaultContext — the React face of the ceremony singleton.
 *
 * Subscribes to the shared CeremonyController (services/vault/ceremonyHost) and
 * republishes its state to the ceremony sheet, and owns the *effects* of a
 * ceremony: on arm, the success haptic; on relock, the confirm haptic and a
 * toast. No tone: arming and relocking are hardware/session events, not a
 * deposit or a withdrawal — those get their own tones (vaultDeposit /
 * vaultWithdraw) at the transfer screen's actual success moment instead.
 *
 * WalletContext owns the unplug→relock wiring; this owns the user-facing
 * feedback. They never fire the same haptic twice — the pairing rules live in
 * hooks/useConfirmationSound.
 */
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { ceremony } from '../services/vault/ceremonyHost'
import { CeremonyState } from '../services/vault/ceremony'
import { haptics } from '../hooks/useHaptics'
import i18n from '../i18n/translations'
import { vaultStore } from '../services/vault/vaultStore'

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
  /**
   * F-07: whether this device holds ANY local Vault enrollment record, on any
   * scope — regardless of isVaultAvailable's release/network gate. An
   * existing, already-funded vault must stay reachable from Home/Settings
   * even when the flag is off or the network switched; only entry-point
   * VISIBILITY needs this — VaultScreen's own canDeposit/canEnroll stay gated
   * on the flag exactly as before. Backed by the same device-local
   * vaultStore.isEnrolled() read the screen's own reload() already performs
   * (no network call), refreshed once here rather than by every consumer.
   */
  hasVaultMeta: boolean
}

const VaultContext = createContext<VaultContextValue>({
  state: { phase: 'idle' },
  submitPin: () => {},
  cancel: () => {},
  retry: () => {},
  hasVaultMeta: false
})

export const VaultProvider: React.FC<{ children: React.ReactNode; onToast?: VaultToast }> = ({ children, onToast }) => {
  const [state, setState] = useState<CeremonyState>(ceremony.state)
  const [hasVaultMeta, setHasVaultMeta] = useState(false)

  useEffect(() => ceremony.subscribe(setState), [])

  // Re-check once per ceremony-phase transition — enrollment, key removal and
  // re-lock all happen around a ceremony, so this stays fresh without giving
  // every render its own device-local read.
  useEffect(() => {
    let cancelled = false
    vaultStore
      .isEnrolled()
      .then(enrolled => {
        if (!cancelled) setHasVaultMeta(enrolled)
      })
      .catch(() => {
        if (!cancelled) setHasVaultMeta(false)
      })
    return () => {
      cancelled = true
    }
  }, [state.phase])

  // Effects of a completed ceremony: the haptic, and nothing else. `onArmed`
  // deliberately ignores its VaultSigner argument — the signer is owned by the
  // transfer that requested it (transfers.ts obtains it from ceremonyHost) and
  // must never reach React state (see VaultSigner in services/vault/ceremony.ts).
  useEffect(() => {
    ceremony.onArmed = () => {
      haptics.success()
    }
    ceremony.onRelock = () => {
      haptics.confirm()
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

  const value = useMemo(
    () => ({ state, submitPin, cancel, retry, hasVaultMeta }),
    [state, submitPin, cancel, retry, hasVaultMeta]
  )
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

export const useVault = (): VaultContextValue => useContext(VaultContext)
