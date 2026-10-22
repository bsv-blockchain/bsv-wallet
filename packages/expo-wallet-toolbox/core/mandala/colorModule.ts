/**
 * The wallet's one assembly of the BRC-207 color module (plan 07 Task 10).
 *
 * The module holds all token custody and evidence. It is registered in the
 * permissions manager as `permissionModules.color`, so every `p color` basket,
 * label and protocol call — from any originator — passes through it.
 *
 * Registration (IC §8.2):
 *  · `wallet` is the UNDERLYING wallet, never the permissions manager. The
 *    module derives keys and signs on it directly; handing it the manager would
 *    route the module's own calls back into itself.
 *  · profiles: the built-in attested profile and the Mandala issuer-v1 profile,
 *    whose one configured overlay is this chain's (overlayUrl, K). An asset
 *    naming any other K has no provider and fails closed (S5).
 *  · provider (W3): the default provider is the SAME Mandala overlay provider
 *    instance the profile routes to. This is a Mandala wallet: a profile-free
 *    1Color asset is checked against the Mandala overlay and fails closed there.
 *  · store: the module's durable `color.v1.` records over the wallet's
 *    `key_value_store`. The wallet never reads those keys (IC §2.1).
 *
 * Construction does no I/O. Every throw here (a malformed overlay key or url)
 * means no module: the caller then registers no `color` key, so `p color`
 * calls fail closed with "Unsupported P-module scheme".
 */
import {
  ATTESTED_PROFILE_ID,
  createAttestedProfile,
  createColorModule,
  type ColorModuleStore,
  type ColorOverlayProvider,
  type ColorPermissionModule,
  type ColorTokenAccessHandler
} from '@bsv/color-permission-module'
import { MANDALA_PROFILE_ID, createMandalaOverlayProvider, createMandalaProfile } from '@bsv/mandala/profile'
import type { WalletInterface } from '@bsv/sdk'
import type { MandalaEndpointConfig } from '../toolboxConfig'
import { createColorModuleStore, type WalletKv } from './kvStore'

export interface BuildColorModuleArgs {
  /** The UNDERLYING wallet, never the permissions manager. */
  wallet: WalletInterface
  endpoints: MandalaEndpointConfig
  kv: WalletKv
  requestTokenAccess: ColorTokenAccessHandler
  fetch?: typeof fetch
}

export interface BuiltColorModule {
  module: ColorPermissionModule
  provider: ColorOverlayProvider & { readonly url: string; readonly identityKey: string }
  store: ColorModuleStore
}

export function buildColorModule(a: BuildColorModuleArgs): BuiltColorModule {
  const { overlayUrl, overlayIdentityKey } = a.endpoints
  const fetchOption = a.fetch === undefined ? {} : { fetch: a.fetch }
  const provider = createMandalaOverlayProvider({ url: overlayUrl, identityKey: overlayIdentityKey, ...fetchOption })
  const store = createColorModuleStore(a.kv)
  const module = createColorModule({
    wallet: a.wallet,
    provider,
    requestTokenAccess: a.requestTokenAccess,
    store,
    profiles: {
      [ATTESTED_PROFILE_ID]: createAttestedProfile(),
      [MANDALA_PROFILE_ID]: createMandalaProfile({
        overlays: [{ identityKey: overlayIdentityKey, url: overlayUrl }],
        ...fetchOption
      })
    }
  })
  return { module, provider, store }
}
