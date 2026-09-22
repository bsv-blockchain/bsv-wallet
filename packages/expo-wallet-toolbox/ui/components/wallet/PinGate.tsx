/**
 * The app-wide lock gate: shows the PIN pad whenever the KEK needs one, and
 * owns the optional re-lock on backgrounding.
 *
 * Mounted once at the root, beside the other global sheets, because being
 * locked is a property of the process rather than of a screen — arriving here
 * from Settings, from a payment, or from a cold start all mean the same thing.
 *
 * It deliberately does NOT drive the first unlock of a session. That still
 * belongs to the read path in LocalStorageProvider, which prompts at wallet
 * instantiation and nowhere else; this component only reacts to the state that
 * path publishes, plus the one transition that path cannot see — the app
 * coming back from the background with auto-lock on.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, AppStateStatus } from 'react-native'
import {
  AUTO_LOCK_GRACE_MS,
  getUnlockState,
  i18n,
  isAutoLockEnabled,
  loadAutoLockPref,
  lockKek,
  readSentinel,
  subscribeUnlockState,
  unlockKek,
  useWallet,
  type UnlockState
} from '@bsv/expo-wallet-toolbox'
import { PinUnlockSheet } from './PinUnlockSheet'

export const PinGate: React.FC = () => {
  const [state, setState] = useState<UnlockState>(getUnlockState)
  const [biometricAvailable, setBiometricAvailable] = useState(false)
  /** When the app last went to the background. null while foregrounded. */
  const backgroundedAt = useRef<number | null>(null)
  const { buildWalletFromMnemonic, walletBuilt, walletBuilding } = useWallet()
  const prevStatus = useRef<UnlockState['status']>(state.status)

  useEffect(() => subscribeUnlockState(setState), [])

  /**
   * Build the wallet once the KEK finally arrives.
   *
   * WalletContext's auto-build effect fires once, early, and on a PIN-only
   * install it runs while the KEK is still sealed: getMnemonic returns null,
   * the build gives up, and the effect's dependencies never change again. The
   * user would enter the right PIN and land on an empty wallet.
   *
   * So the transition INTO `unlocked` is the trigger. Guarded on both build
   * flags because the ordinary biometric path has usually built already by the
   * time anything here runs, and a second build would tear down a live one.
   */
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = state.status
    if (state.status !== 'unlocked' || was === 'unlocked') return
    if (walletBuilt || walletBuilding) return
    void buildWalletFromMnemonic()
  }, [state.status, walletBuilt, walletBuilding, buildWalletFromMnemonic])
  useEffect(() => {
    void loadAutoLockPref()
  }, [])

  /* Whether to offer "Use Face ID instead" on the pad. Read from the sentinel
     rather than remembered, because Settings can flip it while this is mounted. */
  useEffect(() => {
    if (state.status !== 'needs-pin') return
    let cancelled = false
    void readSentinel().then(s => {
      if (!cancelled) setBiometricAvailable(s?.policy === 'biometric')
    })
    return () => {
      cancelled = true
    }
  }, [state.status])

  const onForeground = useCallback(async () => {
    const since = backgroundedAt.current
    backgroundedAt.current = null
    if (since === null || !isAutoLockEnabled()) return
    if (Date.now() - since < AUTO_LOCK_GRACE_MS) return

    // Nothing to lock on a device with no wallet, and prompting there would be
    // a biometric sheet on the welcome screen.
    const sentinel = await readSentinel()
    if (!sentinel || sentinel.names.length === 0) return

    lockKek()
    // Re-ask straight away rather than waiting for the next secret read: the
    // user is looking at the app now, and a wallet that silently became locked
    // is one that fails at the next tap for no visible reason.
    await unlockKek(i18n.t('biometric_unlock_wallet'))
  }, [])

  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'active') {
        void onForeground()
        return
      }
      // 'inactive' is also the app-switcher preview and an incoming call, which
      // is exactly when a phone changes hands — start the clock on both.
      if (backgroundedAt.current === null) backgroundedAt.current = Date.now()
    }
    const sub = AppState.addEventListener('change', onChange)
    return () => sub.remove()
  }, [onForeground])

  return (
    <PinUnlockSheet
      visible={state.status === 'needs-pin'}
      biometricAvailable={biometricAvailable}
    />
  )
}

export default PinGate
