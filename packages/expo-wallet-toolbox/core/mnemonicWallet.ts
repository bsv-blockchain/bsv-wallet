/**
 * Mnemonic-based wallet utilities for noWAB (self-custodial) mode
 *
 * Uses @bsv/sdk Mnemonic and HD classes for BIP39 mnemonic and BIP32 HD key derivation
 */

import { Mnemonic, HD, PrivateKey } from '@bsv/sdk'

export interface MnemonicWalletConfig {
  mnemonic?: string // Optional: provide existing mnemonic
  passphrase?: string // Optional BIP39 passphrase
  language?: 'en' | 'es' | 'fr' | 'it' | 'ja' | 'ko' | 'zh_CN' | 'zh_TW' // Default: 'en'
  /** Which wallet profile to derive. Default 0. See profilePaths. */
  profileIndex?: number
}

export interface ProfileKeys {
  privilegedKey: PrivateKey // Derived key at m/1'/n' for the privileged key manager
  primaryKey: number[] // Derived key at m/0'/n' for wallet
  identityKey: string // Public key hex of the primary key
}

export interface MnemonicWalletResult extends ProfileKeys {
  mnemonic: string
}

/**
 * The two hardened paths profile `n` derives from the shared seed. Every profile
 * is a separate wallet (its own identity, storage, backup account) yet one
 * mnemonic backs them all up. The privileged key sits on its own branch so no
 * profile ever shares key material with another, and none uses the BIP32 master.
 */
export function profilePaths(n: number): { primary: string; privileged: string } {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 31) {
    throw new Error(`Invalid profile index: ${n}`)
  }
  return { primary: `m/0'/${n}'`, privileged: `m/1'/${n}'` }
}

/** BIP39 seed → BIP32 root. The expensive step (PBKDF2): build once, derive many profiles. */
export function hdFromMnemonic(mnemonic: string, passphrase: string = ''): HD {
  return HD.fromSeed(Mnemonic.fromString(mnemonic).toSeed(passphrase))
}

/** Profile `n`'s keys from an already-built root. */
export function deriveProfileKeys(hdKey: HD, n: number): ProfileKeys {
  const paths = profilePaths(n)
  const primary = hdKey.derive(paths.primary).privKey
  return {
    privilegedKey: hdKey.derive(paths.privileged).privKey,
    primaryKey: primary.toArray(),
    identityKey: primary.toPublicKey().toString()
  }
}

/**
 * Generate a new mnemonic-based wallet
 */
export function generateMnemonicWallet(config: MnemonicWalletConfig = {}): MnemonicWalletResult {
  const { passphrase = '', profileIndex = 0 } = config

  // Validate and use the provided mnemonic, or generate a new random one
  // (128 bits = 12 words by default)
  const mnemonicInstance = config.mnemonic ? Mnemonic.fromString(config.mnemonic) : Mnemonic.fromRandom()
  const mnemonicString = mnemonicInstance.toString()
  const hdKey = HD.fromSeed(mnemonicInstance.toSeed(passphrase))

  return { mnemonic: mnemonicString, ...deriveProfileKeys(hdKey, profileIndex) }
}

/**
 * Recover wallet from existing mnemonic
 */
export function recoverMnemonicWallet(
  mnemonic: string,
  passphrase: string = '',
  profileIndex: number = 0
): MnemonicWalletResult {
  return generateMnemonicWallet({ mnemonic, passphrase, profileIndex })
}

/**
 * Validate a mnemonic phrase
 */
export function validateMnemonic(mnemonic: string): boolean {
  try {
    Mnemonic.fromString(mnemonic)
    return true
  } catch {
    return false
  }
}

/**
 * Generate a random mnemonic of specified strength
 * @param strength Entropy bits: 128 (12 words), 160 (15 words), 192 (18 words), 224 (21 words), 256 (24 words)
 */
export function generateRandomMnemonic(strength: 128 | 160 | 192 | 224 | 256 = 128): string {
  // For now, @bsv/sdk Mnemonic.fromRandom() generates 128 bits (12 words)
  // If you need different strengths, you may need to generate entropy manually
  const mnemonic = Mnemonic.fromRandom()
  return mnemonic.toString()
}

/**
 * Get word count for a mnemonic
 */
export function getMnemonicWordCount(mnemonic: string): number {
  return mnemonic.trim().split(/\s+/).length
}

/**
 * Get expected word count for entropy bits
 */
export function getExpectedWordCount(entropyBits: number): number {
  return Math.floor((entropyBits + entropyBits / 32) / 11)
}

/**
 * Parse mnemonic safely and return validation result
 */
export interface MnemonicValidationResult {
  valid: boolean
  wordCount?: number
  expectedWordCount?: number
  error?: string
}

export function parseMnemonic(mnemonic: string): MnemonicValidationResult {
  const trimmed = mnemonic.trim()
  const words = trimmed.split(/\s+/)
  const wordCount = words.length

  // Valid word counts: 12, 15, 18, 21, 24
  const validCounts = [12, 15, 18, 21, 24]

  if (!validCounts.includes(wordCount)) {
    return {
      valid: false,
      wordCount,
      error: `Invalid word count: ${wordCount}. Expected: ${validCounts.join(', ')}`
    }
  }

  try {
    Mnemonic.fromString(trimmed)
    return {
      valid: true,
      wordCount
    }
  } catch (error: any) {
    return {
      valid: false,
      wordCount,
      error: error.message || 'Invalid mnemonic phrase'
    }
  }
}

/**
 * Convert mnemonic to displayable format with numbered words
 */
export function formatMnemonicForDisplay(mnemonic: string): string[] {
  return mnemonic.trim().split(/\s+/)
}

/**
 * Helper to securely store mnemonic (should be encrypted in production)
 * Returns base64 encoded mnemonic
 */
export function encodeMnemonicForStorage(mnemonic: string): string {
  // In production, this should encrypt the mnemonic
  // For now, just base64 encode
  return btoa(mnemonic)
}

/**
 * Helper to retrieve stored mnemonic
 */
export function decodeMnemonicFromStorage(encoded: string): string {
  try {
    return atob(encoded)
  } catch {
    throw new Error('Failed to decode stored mnemonic')
  }
}
