/**
 * XR-102 (non-Vault residual): pending-abort entry authenticity.
 *
 * `pending_aborts` is a plain KV record. `guard.ts`'s `VAULT_ABORT_REPLAY_MARKER`
 * (also XR-102) already stops a replayed entry from bypassing the
 * vault-inventory check for a Vault reference -- but that check only exists
 * for Vault outpoints/references/txids. An ordinary localpay/PeerPay noSend
 * reference has no such inventory entry and no mandala settlement row either,
 * so a raw KV edit naming one was still replayed and aborted with zero proof
 * this wallet ever recorded a real decline for it.
 *
 * The fix: every entry `queuePendingAbort` writes is tagged with an HMAC over
 * its reference, computed with the ADMIN-scoped wallet under the
 * `pending abort authority` namespace reserved in
 * `core/services/vault/guard.ts`. `replayPendingAborts` re-derives and checks
 * that tag before ever calling `abortAction`; an entry with no tag, or one
 * that does not verify, is dropped -- never replayed. Exactly the pattern
 * XR-027's `connection authority` tag already established for saved pairings
 * (see `core/services/connectionAuthority.ts`) -- same reasoning applies here:
 * a local attacker who can write this KV key does not have the admin wallet's
 * key material, so they cannot mint a tag that verifies, however plausible
 * the reference or originator string they forge.
 */
import type { WalletInterface, WalletProtocol } from '@bsv/sdk'

export type PendingAbortTagWallet = Pick<WalletInterface, 'createHmac'>
export type PendingAbortVerifyWallet = Pick<WalletInterface, 'verifyHmac'>

/** Reserved identically to CONNECTION_AUTHORITY_PROTOCOL_NAMES in guard.ts --
 * see that file's PENDING_ABORT_AUTHORITY_PROTOCOL_NAMES for why a connected/
 * paired origin (whose site-scoped WalletClient forwards createHmac/verifyHmac
 * for any non-reserved namespace) must never be able to mint or verify this
 * tag itself. */
export const PENDING_ABORT_AUTHORITY_PROTOCOL_ID: WalletProtocol = [2, 'pending abort authority']
const PENDING_ABORT_AUTHORITY_DOMAIN = 'bsv-wallet-pending-abort-authority-v1'

function messageBytes(reference: string): number[] {
  return Array.from(new TextEncoder().encode(`${PENDING_ABORT_AUTHORITY_DOMAIN}|${reference}`))
}

/** Called by `queuePendingAbort` at the moment a reference is durably queued
 * -- the only moment this codebase can honestly assert "a real decline or
 * build failure just happened for this exact reference". `adminWallet` must
 * be the guardVaultAccess(..., adminOriginator)-wrapped wallet, called with
 * that same `adminOriginator`: that is what lets guard.ts's reservation
 * recognize this as trusted rather than an external call. */
export async function computePendingAbortAuthorityTag(
  adminWallet: PendingAbortTagWallet,
  adminOriginator: string,
  reference: string
): Promise<string> {
  const { hmac } = await adminWallet.createHmac(
    {
      protocolID: PENDING_ABORT_AUTHORITY_PROTOCOL_ID,
      keyID: reference,
      counterparty: 'self',
      data: messageBytes(reference)
    },
    adminOriginator
  )
  return Buffer.from(hmac).toString('base64url')
}

/**
 * Re-derives the tag over the CURRENT reference and compares it to the one on
 * file. Never throws: a missing tag, a malformed tag, or any wallet-side
 * failure (including `verifyHmac` REJECTING on an actual mismatch, per
 * `@bsv/sdk`) are all folded into "not authentic" -- the only correct
 * response to any of them is the same one, drop the entry, per
 * `replayPendingAborts`.
 */
export async function verifyPendingAbortAuthorityTag(
  adminWallet: PendingAbortVerifyWallet,
  adminOriginator: string,
  reference: string,
  tag: string | undefined
): Promise<boolean> {
  if (!tag) return false
  try {
    const hmac = Array.from(Buffer.from(tag, 'base64url'))
    const { valid } = await adminWallet.verifyHmac(
      {
        protocolID: PENDING_ABORT_AUTHORITY_PROTOCOL_ID,
        keyID: reference,
        counterparty: 'self',
        data: messageBytes(reference),
        hmac
      },
      adminOriginator
    )
    return valid === true
  } catch {
    return false
  }
}
