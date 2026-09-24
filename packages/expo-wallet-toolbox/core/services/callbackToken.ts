import { Hash, Utils, type KeyDeriver } from '@bsv/sdk'

/**
 * Derive the Arcade/broadcast X-CallbackToken from PRIVATE key material.
 *
 * Previously this was `keyDeriver.identityKey.substring(0, 32)` (misc-p2-06)
 * — the first 32 hex chars of the wallet's own PUBLIC identity key, a value
 * routinely disclosed to every counterparty and resolvable via the handle
 * registry, so it gave the callback header no confidentiality at all.
 *
 * Instead derive a BRC-42 private key under a fixed protocol/keyID for
 * counterparty 'self' and hash it. Deterministic per wallet build, but only
 * this wallet's root key can compute it — unlike the public identity key.
 */
export function deriveCallbackToken(keyDeriver: Pick<KeyDeriver, 'derivePrivateKey'>): string {
  const priv = keyDeriver.derivePrivateKey([2, 'arcade callback token'], '1', 'self')
  const digest = Hash.sha256(priv.toArray())
  return Utils.toHex(digest).slice(0, 32)
}
