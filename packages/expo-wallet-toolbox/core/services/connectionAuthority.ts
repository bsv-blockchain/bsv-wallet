/**
 * XR-027: saved pairing authority.
 *
 * ConnectionStore persists an approved (origin, topic, protocolID,
 * backendIdentityKey) tuple in plain AsyncStorage. Reconnect used to trust
 * that tuple structurally -- any well-formed replacement (a different
 * backend/origin, planted by anything that can write to AsyncStorage)
 * authenticated exactly like the real one on the next Reconnect tap.
 *
 * The fix computes an HMAC over the tuple with the ADMIN-scoped wallet, under
 * the `connection authority` namespace reserved in
 * core/services/vault/guard.ts, and stores it alongside the record. Reconnect
 * re-verifies it before ever trusting the tuple.
 *
 * WHY ADMIN-SCOPED, NOT THE WALLET ALREADY PASSED TO connect()/reconnect().
 * That WalletClient is deliberately scoped to the PAIRED SITE'S OWN
 * originator (PairScreen.tsx/ConnectionsScreen.tsx construct it with
 * `external.originator`, never ADMIN_ORIGINATOR) and forwards
 * createHmac/verifyHmac for any non-reserved protocol namespace straight to
 * the underlying wallet (see IMPLEMENTED_METHODS in
 * WalletConnectionContext.tsx). Computing this tag with that wallet -- under
 * ANY namespace it could reach -- would let the paired peer itself mint or
 * reproduce the exact same tag over that same already-allowlisted RPC method,
 * which authenticates nothing. Deliberately independent of connect()/
 * reconnect(): this module never touches either function or its signature --
 * the two pairing/reconnect screens compute and verify the tag themselves,
 * with their own admin-scoped wallet, entirely around those calls.
 */
import type { WalletInterface } from '@bsv/sdk'
import {
  CONNECTION_AUTHORITY_PROTOCOL_ID,
  buildConnectionAuthorityMessage,
  type ConnectionAuthorityTuple
} from './walletConnectionValidation'

type HmacCapableWallet = Pick<WalletInterface, 'createHmac' | 'verifyHmac'>

function authorityMessageBytes(tuple: ConnectionAuthorityTuple): number[] {
  return Array.from(new TextEncoder().encode(buildConnectionAuthorityMessage(tuple)))
}

/** Called once, at approval time, by the screen that just showed the user
 * this exact tuple (PairScreen's Approve, ConnectionsScreen's scan/paste) --
 * BEFORE connect() is invoked, from data the screen already fully controls.
 * `adminWallet` must be wrapped in guardVaultAccess(..., adminOriginator)
 * (and typically capWalletArgs too) exactly like every other external-facing
 * wallet in this package; passing `adminOriginator` as the call's originator
 * is what lets guard.ts's reservation recognize this as trusted. */
export async function computeConnectionAuthorityTag(
  adminWallet: HmacCapableWallet,
  adminOriginator: string,
  tuple: ConnectionAuthorityTuple
): Promise<string> {
  const { hmac } = await adminWallet.createHmac(
    {
      protocolID: CONNECTION_AUTHORITY_PROTOCOL_ID,
      keyID: tuple.topic,
      counterparty: 'self',
      data: authorityMessageBytes(tuple)
    },
    adminOriginator
  )
  return Buffer.from(hmac).toString('base64url')
}

/**
 * Re-derives the tag over the CURRENT (possibly tampered) tuple and compares
 * it to the one on file. Never throws: a missing tag, a malformed tag, a
 * mismatched tuple, or any wallet-side failure are all indistinguishable
 * "not authentic" outcomes to the caller, which must treat every one of them
 * as "needs re-approval" -- never silently reconnect. `@bsv/sdk`'s
 * `verifyHmac` itself REJECTS (does not resolve false) on a mismatched HMAC,
 * which the try/catch below turns into `false` like every other failure mode.
 */
export async function verifyConnectionAuthorityTag(
  adminWallet: HmacCapableWallet,
  adminOriginator: string,
  tuple: ConnectionAuthorityTuple,
  tag: string | undefined
): Promise<boolean> {
  if (!tag) return false
  try {
    const hmac = Array.from(Buffer.from(tag, 'base64url'))
    const { valid } = await adminWallet.verifyHmac(
      {
        protocolID: CONNECTION_AUTHORITY_PROTOCOL_ID,
        keyID: tuple.topic,
        counterparty: 'self',
        data: authorityMessageBytes(tuple),
        hmac
      },
      adminOriginator
    )
    return valid === true
  } catch {
    return false
  }
}
