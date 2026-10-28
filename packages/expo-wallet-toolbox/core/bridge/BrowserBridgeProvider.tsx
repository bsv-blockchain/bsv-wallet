/**
 * BrowserBridgeProvider publishes the open wallet to the bridge runtime (spec 6.9).
 *
 * Mount it inside `WalletContextProvider` (opt-in; without it every bridge request fails
 * `CONFIGURATION_ERROR`). It follows the `DirectPayProvider` template: once the wallet is built it
 * reads the identity key from that wallet's manager, derives the account context from it and the
 * network, and keeps the result keyed on the manager's object identity so a rebuilt wallet never
 * publishes the last one's context.
 *
 * It reports, in one place: the attested manager, the unverified one when an unattested transport
 * was registered at build time, readiness, network and account context. What the runtime does with
 * a replaced manager (revision bump, binding close, prompt withdrawal) is in `runtime.ts`.
 *
 * Wiring: once a wallet is in hand it also builds the `ConsentStore` (authenticated by the
 * admin-scoped wallet, wrapped exactly as `PairScreen` wraps it for `connectionAuthority`),
 * installs the dispatcher on it, registers the store's withdrawal with the runtime and hands the
 * store to the PermissionSheet's `connection` kind. A rebuilt wallet gets a fresh store; teardown
 * and unmount withdraw its requests and uninstall all of it.
 *
 * Readiness: `blocked` while the secrets layer is locked, `ready` once a manager and its account
 * context are in hand, `building` while a build runs or the context is still being derived, and
 * `none` otherwise.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WalletInterface } from '@bsv/sdk'
import { profileScopedKey } from '../profiles/profileStore'
import { capWalletArgs } from '../services/capWalletArgs'
import { guardVaultAccess } from '../services/vault/guard'
import { getUnlockState, subscribeUnlockState } from '../services/secrets'
import { useWallet, useWalletManagers, useWalletStatus } from '../context/WalletContext'
import type { SigningPolicyPermissionsManager } from '../services/signingPermissionPolicy'
import { createConsentStore } from './consent'
import { createDispatcher, installDispatcher } from './dispatcher'
import { setConsentSheetSource } from './consentSheetSource'
import { resolvePermissionPolicy } from './permissionPolicy'
import {
  attachBridgeHost,
  computeAccountContext,
  initBridgeRuntime,
  publish,
  registerConsentWithdrawal,
  getBridgeSnapshot,
  setBridgeBaseVersion,
  type BridgeManager,
  type BridgeReadiness
} from './runtime'

interface ContextFor {
  signing: SigningPolicyPermissionsManager
  network: string
  value: string
}

export const BrowserBridgeProvider: React.FC<{ children?: React.ReactNode; baseVersion?: string }> = ({
  children,
  baseVersion
}) => {
  const { managers, adminOriginator } = useWalletManagers()
  const { walletBuilt, walletBuilding, selectedNetwork } = useWalletStatus()
  const { withdrawPrompts } = useWallet()
  const unlock = useSyncExternalStore(subscribeUnlockState, getUnlockState, getUnlockState)

  // The context value changes on every queue change; teardown needs the current function.
  const withdrawRef = useRef(withdrawPrompts)
  withdrawRef.current = withdrawPrompts

  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let current = true
    const detach = attachBridgeHost({ withdrawPrompts: old => withdrawRef.current(old) })
    initBridgeRuntime().then(
      () => {
        if (current) setLoaded(true)
      },
      e => console.warn('[BrowserBridgeProvider] runtime did not load:', e instanceof Error ? e.message : String(e))
    )
    return () => {
      current = false
      detach()
    }
  }, [])

  useEffect(() => {
    if (baseVersion !== undefined) setBridgeBaseVersion(baseVersion)
  }, [baseVersion])

  const signing = managers.signingPermissionsManager
  const wallet = managers.permissionsManager as unknown as (WalletInterface & object) | undefined

  // The account context of the wallet it was derived from, never of its predecessor.
  const [contextFor, setContextFor] = useState<ContextFor | undefined>(undefined)
  useEffect(() => {
    if (!loaded || !walletBuilt || !signing || !wallet) return
    let current = true
    wallet
      .getPublicKey({ identityKey: true }, adminOriginator)
      .then(({ publicKey }) => computeAccountContext(publicKey, selectedNetwork))
      .then(value => {
        if (current) setContextFor({ signing, network: selectedNetwork, value })
      })
      .catch(e =>
        console.warn('[BrowserBridgeProvider] No account context:', e instanceof Error ? e.message : String(e))
      )
    return () => {
      current = false
    }
  }, [loaded, walletBuilt, signing, wallet, adminOriginator, selectedNetwork])

  // Consent store and dispatcher for this wallet. The store's records are tagged by this wallet's
  // admin key, so a different wallet never shares one; the profile key is read live, so the store
  // notices a profile switch that has not yet produced a new wallet.
  useEffect(() => {
    if (!loaded || !walletBuilt || !wallet) return
    const adminWallet = capWalletArgs(guardVaultAccess(wallet, adminOriginator))
    const store = createConsentStore({
      storage: AsyncStorage,
      adminWallet,
      adminOriginator,
      profileKey: () => profileScopedKey(''),
      now: () => Date.now(),
      randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n))
    })
    const unregister = registerConsentWithdrawal(() => store.withdrawAll())
    const dispatcher = createDispatcher({ consent: store })
    installDispatcher(dispatcher)
    setConsentSheetSource({
      store,
      context: () => ({ walletRevision: Number(getBridgeSnapshot().walletRevision), profileKey: profileScopedKey('') }),
      // The policy the unverified manager was built with (WalletContext): the host's statement.
      policy: () => resolvePermissionPolicy()
    })
    return () => {
      store.withdrawAll()
      unregister()
      setConsentSheetSource(undefined)
      installDispatcher(undefined)
    }
  }, [loaded, walletBuilt, wallet, adminOriginator])

  const unverifiedSigning = managers.unverifiedSigningPermissionsManager
  const unverifiedWallet = managers.unverifiedPermissionsManager as unknown as WalletInterface | undefined

  useEffect(() => {
    if (!loaded) return
    const haveWallet = walletBuilt && !!signing && !!wallet
    const accountContext =
      haveWallet && contextFor?.signing === signing && contextFor.network === selectedNetwork ? contextFor.value : ''
    const status = unlock.status
    let readiness: BridgeReadiness
    if (status === 'locked' || status === 'unlocking' || status === 'cancelled') readiness = 'blocked'
    else if (haveWallet && accountContext) readiness = 'ready'
    else if (walletBuilding || haveWallet) readiness = 'building'
    else readiness = 'none'

    const attestedManager: BridgeManager | undefined = haveWallet ? { wallet: wallet!, signing: signing! } : undefined
    const unverifiedManager: BridgeManager | undefined =
      haveWallet && unverifiedSigning && unverifiedWallet
        ? { wallet: unverifiedWallet, signing: unverifiedSigning }
        : undefined
    publish({ attestedManager, unverifiedManager, readiness, network: selectedNetwork, accountContext })
  }, [
    loaded,
    walletBuilt,
    walletBuilding,
    signing,
    wallet,
    unverifiedSigning,
    unverifiedWallet,
    selectedNetwork,
    contextFor,
    unlock.status
  ])

  return <>{children}</>
}
