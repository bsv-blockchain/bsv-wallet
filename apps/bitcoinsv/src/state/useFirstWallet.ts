// Creating this installation's first wallet, and claiming its handle.
//
// The wallet comes from the shared core's createNewWallet (the same guarded
// path the existing app uses: refuses if a wallet or identity already
// exists, stores the secret, marks the backup pending, builds). The handle is
// then registered with the shared registration flow once the new wallet and
// its storage are live. A handle that can't be claimed right now never blocks
// the wallet: it stays pending on this device, and Home tries it again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bindOriginator, getHandleRegistryConfig, useActiveProfileIndex, useRecoveryDeps, useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import { createNewWallet, type CreateOutcome } from '@bsv/expo-wallet-toolbox/core/recovery/createWallet'
import {
  createHandleRegistryClient,
  type AvailabilityResult,
  type HandleRegistryClient
} from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/client'
import { registerHandle, type RegistrationResult } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/registration'
import { DISPLAY_NAME_KV_KEY, HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import type { ProfileSigner } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileCert'
import { setPref, usePrefs } from './prefs'

export type ClaimOutcome =
  | { kind: 'claimed'; paymail: string }
  /** kept on this device; to be claimed again later */
  | { kind: 'pending'; handle: string; reason: string }
  /** the registry said no to this name */
  | { kind: 'refused'; handle: string; reason: string }

interface KeyValueStorage {
  getKeyValue(k: string): Promise<string | undefined>
  setKeyValue(k: string, v: string): Promise<void>
}

/** The registry client for this build's network, or null when none is configured. */
function useRegistry() {
  const { selectedNetwork } = useWallet()
  const registry = getHandleRegistryConfig(selectedNetwork)
  const domain = registry?.domain ?? null
  const url = registry?.url ?? null
  const client = useMemo(() => (domain && url ? createHandleRegistryClient({ pinned: { domain, url } }) : null), [domain, url])
  return { domain, client }
}

/** One attempt to claim `handle` for the live wallet; records the outcome on this device. */
async function claimHandle(
  args: { client: HandleRegistryClient; signer: ProfileSigner; storage: KeyValueStorage },
  handle: string,
  displayName: string
): Promise<ClaimOutcome> {
  let result: RegistrationResult
  try {
    result = await registerHandle(args, { handle, displayName })
  } catch (err) {
    result = { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
  }
  await args.storage.setKeyValue(DISPLAY_NAME_KV_KEY, displayName).catch(() => {})
  if (result.kind === 'registered') {
    await args.storage.setKeyValue(HANDLE_KV_KEY, result.paymail).catch(() => {})
    setPref('pendingHandle', null)
    setPref('pendingDisplayName', null)
    return { kind: 'claimed', paymail: result.paymail }
  }
  if (result.kind === 'rejected') {
    setPref('pendingHandle', null)
    setPref('pendingDisplayName', null)
    return { kind: 'refused', handle, reason: result.description }
  }
  return {
    kind: 'pending',
    handle,
    reason: result.kind === 'failed' ? result.message : result.kind === 'pending' ? 'still confirming' : 'the registry couldn’t be reached'
  }
}

export function useFirstWallet() {
  const deps = useRecoveryDeps()
  const { managers, adminOriginator, storage } = useWallet()
  const { domain, client } = useRegistry()

  /** Ask the registry whether a handle is free (null when no registry is configured). */
  const checkAvailability = useCallback(
    async (handle: string): Promise<AvailabilityResult | null> => (client ? client.checkAvailability(handle) : null),
    [client]
  )

  // the handle to claim once the new wallet is live
  const [claim, setClaim] = useState<{ handle: string; displayName: string } | null>(null)
  const [claimed, setClaimed] = useState<ClaimOutcome | null>(null)
  const claiming = useRef(false)

  const create = useCallback(
    async (handle: string, displayName: string): Promise<CreateOutcome> => {
      const outcome = await createNewWallet(deps)
      if (outcome.kind === 'created') {
        setPref('pendingHandleProfile', 0)
        setPref('pendingHandle', handle)
        setPref('pendingDisplayName', displayName)
        setClaim({ handle, displayName })
      }
      return outcome
    },
    [deps]
  )

  // the permissions layer: it accepts the admin originator (Profile signs through it too)
  const wallet = managers.permissionsManager
  useEffect(() => {
    if (!claim || !wallet || !storage || claiming.current) return
    if (!client) {
      setClaimed({ kind: 'pending', handle: claim.handle, reason: 'handles aren’t available in this build yet' })
      setClaim(null)
      return
    }
    claiming.current = true
    const signer = bindOriginator(wallet, adminOriginator) as unknown as ProfileSigner
    void claimHandle({ client, signer, storage }, claim.handle, claim.displayName).then(outcome => {
      setClaimed(outcome)
      claiming.current = false
      setClaim(null)
    })
  }, [claim, wallet, storage, client, adminOriginator])

  return { domain, checkAvailability, create, claimed, claiming: !!claim }
}

/** Home: a handle left pending at creation is tried again, once per launch, by the wallet it's for. */
const triedThisLaunch = new Set<number>()

export function usePendingHandleClaim() {
  const prefs = usePrefs()
  const { managers, adminOriginator, storage, walletBuilding } = useWallet()
  const active = useActiveProfileIndex()
  const { client } = useRegistry()
  const wallet = managers.permissionsManager
  useEffect(() => {
    if (!prefs.loaded || !prefs.pendingHandle || !wallet || !storage || !client || walletBuilding) return
    // only while that wallet is the open one (and is built: not mid-switch)
    if (prefs.pendingHandleProfile !== active || triedThisLaunch.has(active)) return
    triedThisLaunch.add(active)
    const signer = bindOriginator(wallet, adminOriginator) as unknown as ProfileSigner
    const handle = prefs.pendingHandle
    void claimHandle({ client, signer, storage }, handle, prefs.pendingDisplayName ?? handle).then(outcome => {
      if (outcome.kind === 'claimed') showToast(`@${handle} is yours`, { type: 'success' })
      if (outcome.kind === 'refused') showToast(`@${handle} couldn’t be claimed: ${outcome.reason}`, { type: 'error' })
    })
  }, [prefs.loaded, prefs.pendingHandle, prefs.pendingDisplayName, prefs.pendingHandleProfile, active, walletBuilding, wallet, storage, client, adminOriginator])
}
