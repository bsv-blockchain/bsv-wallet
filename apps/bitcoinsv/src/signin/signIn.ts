// Scan to sign in (app/sign-in.tsx), on the shared core's wallet pairing: a
// website's sign-in code is a bsv-wallet://pair link (a relay topic, the
// site's key, the protocol it signs under, its origin, an expiry and its
// signature). Approving opens an end-to-end encrypted session over the relay
// in which the site asks the wallet for what BRC-100 lets it (who you are,
// signatures), each under the wallet's own permission prompts.
//
// The approval is the core's PairScreen's, step for step: a wallet guarded
// against the Vault and scoped to the site's origin, and an authority tag
// for exactly the tuple approved, staged before connecting (XR-027).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { WalletClient } from '@bsv/sdk'
import {
  ADMIN_ORIGINATOR,
  AUTO_APPROVE_STORAGE_KEY,
  DEFAULT_AUTO_APPROVE_THRESHOLD,
  capWalletArgs,
  connectionStore,
  guardVaultAccess
} from '@bsv/expo-wallet-toolbox'
import { computeConnectionAuthorityTag } from '@bsv/expo-wallet-toolbox/core/services/connectionAuthority'
import { profileScopedKey } from '@bsv/expo-wallet-toolbox/core/profiles/profileStore'
import type { ConnectParams } from '@bsv/expo-wallet-toolbox'
import type { SignInCode } from './code'

/** How much a signed-in site may spend without asking (0: always asks). */
export async function autoApproveThreshold(): Promise<number> {
  const v = await AsyncStorage.getItem(profileScopedKey(AUTO_APPROVE_STORAGE_KEY)).catch(() => null)
  return v === null ? DEFAULT_AUTO_APPROVE_THRESHOLD : Number(v) || 0
}

type Connect = (params: ConnectParams, wallet: WalletClient) => Promise<void>

/** Sign in: the core PairScreen's handleApprove. */
export async function approveSignIn(manager: unknown, code: SignInCode, connect: Connect): Promise<void> {
  const guarded = () => capWalletArgs(guardVaultAccess(manager as never, ADMIN_ORIGINATOR))
  const { params } = code
  // the site's own wallet: scoped to its origin, never the Vault
  const wallet = new WalletClient(guarded() as never, code.originator)
  try {
    const tag = await computeConnectionAuthorityTag(guarded() as never, ADMIN_ORIGINATOR, {
      origin: code.origin,
      topic: params.topic,
      protocolID: params.protocolID,
      backendIdentityKey: params.backendIdentityKey
    })
    connectionStore.stageAuthorityTag(params.topic, tag)
  } catch {
    // untagged: a later reconnect asks again, never a silent downgrade
    connectionStore.discardStagedAuthorityTag(params.topic)
  }
  await connect({ ...params, origin: code.origin }, wallet)
}
