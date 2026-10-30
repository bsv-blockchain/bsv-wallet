/**
 * The wallet's one assembly of the BRC-207 color module (plan 07 Task 10).
 *
 * The module holds all token custody (B7: no history evidence). It is registered in the
 * permissions manager as `permissionModules.color`, so every `p color` basket,
 * label and protocol call — from any originator — passes through it.
 *
 * Registration (IC §8.2, Revision 3 / design §9 B7):
 *  · `wallet` is the UNDERLYING wallet, never the permissions manager. The
 *    module derives keys and signs on it directly; handing it the manager would
 *    route the module's own calls back into itself.
 *  · profiles: the Mandala issuer-v1 profile only (B7: no attested profile),
 *    whose one configured overlay is this chain's (overlayUrl, K). An asset
 *    naming any other K has no provider and fails closed (S5).
 *  · ledger: the Mandala HOST LEDGER (`createHostLedger`) over the wallet's
 *    `key_value_store` (`mandala.host.v1.record.*`). One object, shared by the
 *    issuer-v1 handler (it credits a receipt only from it, or after its own
 *    verified submit) and the runtime's send, receive and settle paths. It is
 *    in-process only: no BRC-100 method reaches it, so no app can make the
 *    handler credit anything.
 *  · provider (W3): the default provider is the plain Mandala overlay provider
 *    for this chain. This is a Mandala wallet: a profile-free 1Color asset is
 *    checked against the Mandala overlay and fails closed there.
 *  · store: the module's durable `color.v1.` records over the wallet's
 *    `key_value_store`. The wallet never reads those keys (IC §2.1); it calls
 *    the host-only `module.markSettled(txid)` instead.
 *
 * Construction does no I/O. Every throw here (a malformed overlay key or url)
 * means no module: the caller then registers no `color` key, so `p color`
 * calls fail closed with "Unsupported P-module scheme".
 */
import {
  createColorModule,
  type ColorModuleStore,
  type ColorOverlayProvider,
  type ColorPermissionModule,
  type ColorTokenAccessHandler
} from '@bsv/color-permission-module'
import { createHostLedger, type HostLedger } from '@bsv/mandala'
import { MANDALA_PROFILE_ID, createMandalaOverlayProvider, createMandalaProfile } from '@bsv/mandala/profile'
import type { WalletInterface } from '@bsv/sdk'
import type { MandalaEndpointConfig } from '../toolboxConfig'
import { createColorModuleStore, createMandalaKvStorage, type WalletKv } from './kvStore'

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
  /** The host ledger the issuer-v1 handler credits from (shared with the runtime). */
  ledger: HostLedger
}

export function buildColorModule(a: BuildColorModuleArgs): BuiltColorModule {
  const { overlayUrl, overlayIdentityKey } = a.endpoints
  const fetchOption = a.fetch === undefined ? {} : { fetch: a.fetch }
  const provider = createMandalaOverlayProvider({ url: overlayUrl, identityKey: overlayIdentityKey, ...fetchOption })
  const store = createColorModuleStore(a.kv)
  const ledger = createHostLedger(createMandalaKvStorage(a.kv))
  const module = createColorModule({
    wallet: a.wallet,
    provider,
    requestTokenAccess: a.requestTokenAccess,
    store,
    profiles: {
      [MANDALA_PROFILE_ID]: createMandalaProfile({
        overlays: [{ identityKey: overlayIdentityKey, url: overlayUrl }],
        ledger,
        ...fetchOption
      })
    }
  })
  return { module, provider, store, ledger }
}
