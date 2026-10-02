/**
 * The keys behind push registration for every profile of a wallet.
 *
 * Registering a device as a profile needs only BRC-103 authentication, which a
 * `ProtoWallet` built from the profile's primary key (m/0'/n') does with exactly
 * the identity key and signatures the profile's own wallet has. So a profile that
 * is not open is registered without building its wallet, opening its database or
 * going through its permissions manager. Nothing here derives the privileged key.
 */
import { AuthFetch, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { hdFromMnemonic, profilePaths } from '../mnemonicWallet'
import type { PushPost } from './registration'

export interface PushProfileKey {
  index: number
  primaryKey: number[]
}

/** One profile as the push sync sees it: who it is, and the wallet that signs in as it. */
export interface PushProfile {
  index: number
  /** Compressed public key hex, the same string as `ProfileRecord.identityKey`. */
  identityKey: string
  /** A `ProtoWallet`. Opaque here: only the MessageBox client and AuthFetch use it. */
  wallet: unknown
}

/** Primary keys for `indices`, from ONE seed-to-root derivation (the expensive step). Throws on a bad mnemonic. */
export function derivePushProfileKeys(mnemonic: string, indices: readonly number[]): PushProfileKey[] {
  if (indices.length === 0) return []
  const hd = hdFromMnemonic(mnemonic)
  return indices.map(index => ({ index, primaryKey: hd.derive(profilePaths(index).primary).privKey.toArray() }))
}

export function makePushProfile(index: number, primaryKey: number[]): PushProfile {
  const key = new PrivateKey(primaryKey)
  return { index, identityKey: key.toPublicKey().toString(), wallet: new ProtoWallet(key) }
}

/**
 * `POST` JSON through an AuthFetch signed in as `wallet`'s identity. Resolves with
 * the status of whatever the server answered, any status; rejects only when no
 * answer came. A fresh AuthFetch per call: each runs its own handshake, and none
 * outlives its request.
 */
export function authPostFor(wallet: unknown): PushPost {
  return async (url, body) => {
    const response = await new AuthFetch(wallet as never).fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: response.status }
  }
}
