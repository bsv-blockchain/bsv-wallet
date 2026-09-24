/**
 * WalletSecret — the one input every recovery/creation orchestration module
 * shares. `restoreWallet.ts`, `recoverWallet.ts` and `createWallet.ts` never
 * touch `@bsv/sdk` directly (a jest guard enforces this, see
 * `__tests__/recovery/sdkFree.test.ts`); they only see a `WalletSecret`, with
 * its `identityKey` already computed HERE, at classification time.
 *
 * Why compute the identity key this early rather than reading it off the
 * built wallet: `backupAttestation` needs an identity key to scope its
 * record, and it has to be writable the moment a secret is stored — before
 * the wallet's permissions manager exists to answer `getPublicKey`. A raw
 * private key's own public key (for a WIF/hex import) and a derived
 * `m/0'/0'` key's public key (for a mnemonic, matching every other place
 * this repo derives a wallet's identity from a phrase) are both cheap,
 * synchronous, sdk-only computations, so they happen here instead.
 *
 * This module does NOT decide storage, build order, or attestation — that is
 * `restoreWallet.ts`'s job. It does not touch UI, i18n, or navigation.
 */
import { Mnemonic, PrivateKey } from '@bsv/sdk'
import { recoverMnemonicWallet } from '../mnemonicWallet'
import { recoverSecretFromShares } from './shares'

export type WalletSecret =
  | { kind: 'mnemonic'; mnemonic: string; identityKey: string }
  | { kind: 'wif'; wif: string; identityKey: string }

const HEX_64 = /^[0-9a-fA-F]{64}$/

/**
 * Classify raw text pasted or typed into the "import an existing wallet"
 * input. Exactly two recognised shapes: a 64-hex-character private key, or a
 * BIP39 recovery phrase (12-24 words, valid checksum). Anything else —
 * including a hex string of the wrong length, which is NOT coerced or
 * truncated — is `null`, and the caller shows a single "invalid input"
 * message rather than a guess at what the user meant.
 */
export function classifyImportInput(text: string): WalletSecret | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  if (HEX_64.test(trimmed)) {
    const key = PrivateKey.fromHex(trimmed)
    return { kind: 'wif', wif: key.toWif(), identityKey: key.toPublicKey().toString() }
  }

  try {
    Mnemonic.fromString(trimmed)
  } catch {
    return null
  }

  return { kind: 'mnemonic', mnemonic: trimmed, identityKey: recoverMnemonicWallet(trimmed).identityKey }
}

/**
 * Recombine a scanned/entered set of backup shares into a WalletSecret.
 *
 * Delegates the actual Shamir recombination and entropy-vs-legacy
 * classification to `recoverSecretFromShares` (shares.ts) — this function's
 * only job is to turn that result into the same `WalletSecret` shape
 * `classifyImportInput` produces, so `restoreWallet` never has to know
 * whether a secret came from typed text or scanned paper.
 *
 * `legacy: true` mirrors shares.ts's own distinction: shares split from a raw
 * primary key (a wallet that itself has no mnemonic) recombine to a WIF, not
 * a phrase, and the caller shows a different post-recovery notice for it.
 *
 * Throws exactly when `recoverSecretFromShares` throws — invalid shares or
 * shares whose integrity tags disagree (mixed keys).
 */
export function secretFromShares(shareStrings: string[]): { secret: WalletSecret; legacy: boolean } {
  const recovered = recoverSecretFromShares(shareStrings)

  if (recovered.kind === 'entropy') {
    const mnemonic = Mnemonic.fromEntropy(recovered.entropy).toString()
    return {
      secret: { kind: 'mnemonic', mnemonic, identityKey: recoverMnemonicWallet(mnemonic).identityKey },
      legacy: false
    }
  }

  const key = new PrivateKey(recovered.primaryKey)
  return {
    secret: { kind: 'wif', wif: key.toWif(), identityKey: key.toPublicKey().toString() },
    legacy: true
  }
}
