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
 * Wiring: as soon as the runtime is loaded it builds the `ConsentStore`, installs the dispatcher
 * on it, registers the store's withdrawal with the runtime and hands the store to the
 * PermissionSheet's `connection` kind. The dispatcher is installed whether or not a wallet is
 * built, so a request that arrives while the wallet is still building parks (6.6) instead of
 * failing. The store reaches the admin-scoped wallet (wrapped exactly as `PairScreen` wraps it for
 * `connectionAuthority`) through a lookup that always reads the current one, and the dispatcher
 * only touches the store once readiness is `ready`. A wallet replacement settles pending consent
 * through the binding close (`account-changed`), not by declining it; unmount withdraws the
 * requests and uninstalls all of it.
 *
 * Readiness: `blocked` while the secrets layer is locked, `ready` once a manager and its account
 * context are in hand, `building` while a build runs or the context is still being derived, and
 * `none` otherwise.
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WalletInterface } from '@bsv/sdk'
import { profileScopedKey } from '../profiles/profileStore'
import { capWalletArgs } from '../services/capWalletArgs'
import { guardVaultAccess } from '../services/vault/guard'
import { getUnlockState, subscribeUnlockState } from '../services/secrets'
import { useWallet, useWalletManagers, useWalletStatus } from '../context/WalletContext'
import type { SigningPolicyPermissionsManager } from '../services/signingPermissionPolicy'
import { createConsentStore, type HmacCapableWallet } from './consent'
import { mintGrantTag, unverifiedOriginator, isUnattestedOriginator } from './unverifiedOriginator'
import { createDispatcher, installDispatcher } from './dispatcher'
import { setConsentSheetSource } from './consentSheetSource'
import { loadStoredPolicy, resolvePermissionPolicy, type PermissionPolicy } from './permissionPolicy'
import {
  attachBridgeHost,
  computeAccountContext,
  initBridgeRuntime,
  publish,
  registerConsentWithdrawal,
  setActiveConsent,
  getBridgeSnapshot,
  getPublishedManagers,
  setBridgeBaseVersion,
  type BridgeManager,
  type BridgeReadiness
} from './runtime'

const ACCOUNT_CONTEXT_RETRY_MS = 1000
const ACCOUNT_CONTEXT_RETRY_MAX_MS = 30_000

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
  const { withdrawPrompts, configStatus } = useWallet()
  const unlock = useSyncExternalStore(subscribeUnlockState, getUnlockState, getUnlockState)

  // The context value changes on every queue change; teardown needs the current function.
  const withdrawRef = useRef(withdrawPrompts)
  withdrawRef.current = withdrawPrompts

  // Cold start: until the wallet shell has read its stored config (`configStatus` leaves 'initial'
  // for the first time) it is not yet known whether this install has a wallet, so the bridge
  // reports `building`, never `none` (spec 6.15 item 9). A later 'initial' (after logout) is not a
  // cold start: the ref is cleared for good.
  const coldStartRef = useRef(true)
  if (configStatus !== 'initial') coldStartRef.current = false
  const awaitingConfig = coldStartRef.current

  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let current = true
    const detach = attachBridgeHost({ withdrawPrompts: old => withdrawRef.current(old), hasWallet: true })
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

  // The account context of the wallet it was derived from, never of its predecessor. A failed
  // derivation (a locked keychain, a transient secure-store error) is retried with a growing
  // delay; readiness stays `building` meanwhile, so requests park and the dispatcher's own
  // `wallet-not-ready` nudge stays true.
  const [contextFor, setContextFor] = useState<ContextFor | undefined>(undefined)
  const [contextAttempt, setContextAttempt] = useState(0)
  const contextFailures = useRef(0)
  useEffect(() => {
    if (!loaded || !walletBuilt || !signing || !wallet) return
    let current = true
    let retry: ReturnType<typeof setTimeout> | undefined
    wallet
      .getPublicKey({ identityKey: true }, adminOriginator)
      .then(({ publicKey }) => computeAccountContext(publicKey, selectedNetwork))
      .then(value => {
        contextFailures.current = 0
        if (current) setContextFor({ signing, network: selectedNetwork, value })
      })
      .catch(e => {
        console.warn('[BrowserBridgeProvider] No account context:', e instanceof Error ? e.message : String(e))
        if (!current) return
        const delay = Math.min(
          ACCOUNT_CONTEXT_RETRY_MAX_MS,
          ACCOUNT_CONTEXT_RETRY_MS * 2 ** Math.min(contextFailures.current++, 8)
        )
        retry = setTimeout(() => setContextAttempt(n => n + 1), delay)
      })
    return () => {
      current = false
      if (retry !== undefined) clearTimeout(retry)
    }
  }, [loaded, walletBuilt, signing, wallet, adminOriginator, selectedNetwork, contextAttempt, unlock.status])

  // The admin-scoped wallet the consent store authenticates with. Read through `adminRef`, so the
  // one store (below) always uses the current wallet and never a stale one.
  const adminWallet = useMemo(
    () => (wallet ? capWalletArgs(guardVaultAccess(wallet, adminOriginator)) : undefined),
    [wallet, adminOriginator]
  )
  const adminRef = useRef(adminWallet)
  adminRef.current = adminWallet

  // The user's stored prompt policy, as the wallet was built with it: what the sheet discloses.
  const storedPolicyRef = useRef<PermissionPolicy | undefined>(undefined)
  useEffect(() => {
    storedPolicyRef.current = undefined
    if (!loaded || !adminWallet) return
    let current = true
    loadStoredPolicy(profileScopedKey(''), adminWallet, adminOriginator).then(
      p => {
        if (current) storedPolicyRef.current = p
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [loaded, adminWallet, adminOriginator])

  // Consent store and dispatcher, installed once the runtime is loaded and kept across wallet
  // replacements. The store's records are tagged by the admin key, so a different wallet never
  // shares one; the profile key is read live, so the store notices a profile switch that has not
  // yet produced a new wallet.
  useEffect(() => {
    if (!loaded) return
    const lookup = (): HmacCapableWallet => {
      const w = adminRef.current
      if (!w) throw new Error('No wallet is available')
      return w
    }
    const lazyAdmin: HmacCapableWallet = {
      createHmac: (args, originator) => lookup().createHmac(args, originator),
      verifyHmac: (args, originator) => lookup().verifyHmac(args, originator)
    }
    const store = createConsentStore({
      storage: AsyncStorage,
      adminWallet: lazyAdmin,
      adminOriginator,
      profileKey: () => profileScopedKey(''),
      now: () => Date.now(),
      randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      // The manager that will check the group: the unverified one for an unverified originator.
      mint: async (originator, group) => {
        const published = getPublishedManagers()
        const manager = isUnattestedOriginator(originator) ? published.unverified : published.attested
        if (manager === undefined) throw new Error('No permissions manager to mint under')
        await manager.signing.mintGroupedPermissions(originator, group)
      }
    })
    const unregister = registerConsentWithdrawal(() => store.withdrawAll())
    const unregisterActive = setActiveConsent({
      store,
      adminWallet: lazyAdmin,
      adminOriginator,
      profileKey: () => profileScopedKey('')
    })
    const dispatcher = createDispatcher({
      consent: store,
      previewGroup: async binding => {
        const host = /^https?:\/\/([^/:]+)(?::\d+)?$/.exec(binding.applicationOrigin)?.[1]
        if (host === undefined) return null
        const published = getPublishedManagers()
        // An unverified site's real originator carries a grant tag minted at approval; the
        // preview needs only the hostname, which the unverified manager reads the manifest from.
        const preview =
          binding.attestation === 'unattested'
            ? { manager: published.unverified, originator: unverifiedOriginator(host, mintGrantTag()) }
            : { manager: published.attested, originator: host }
        return (await preview.manager?.signing.peekGroupPermissions(preview.originator)) ?? null
      }
    })
    installDispatcher(dispatcher)
    setConsentSheetSource({
      store,
      context: () => ({ walletRevision: Number(getBridgeSnapshot().walletRevision), profileKey: profileScopedKey('') }),
      // The policy the unverified manager was built with (WalletContext): the host's statement
      // plus the user's stored policy.
      policy: () => resolvePermissionPolicy(storedPolicyRef.current)
    })
    return () => {
      store.withdrawAll()
      unregister()
      unregisterActive()
      setConsentSheetSource(undefined)
      installDispatcher(undefined)
    }
  }, [loaded, adminOriginator])

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
    else if (walletBuilding || haveWallet || awaitingConfig) readiness = 'building'
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
    awaitingConfig,
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
