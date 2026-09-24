/**
 * Backup shares — Shamir 2-of-3 recovery paper.
 *
 * The secret being split is the MNEMONIC ENTROPY, per BRC-157, not the primary
 * key at m/0'/0'. That derivation is hardened and one-way, so shares of it can
 * restore spending authority but can never rebuild the phrase — and the vault
 * key needs the phrase. Splitting the entropy makes paper and phrase two
 * encodings of one secret.
 *
 * The split payload is always exactly 32 bytes:
 *
 *     entropy(16) || sha256(entropy)[0..16]
 *
 * The tag exists so recovery can tell new paper from old WITHOUT a version
 * marker on the printed page, which would break every sheet already in a
 * drawer. Length cannot do that job: PrivateKey is a BigNumber and drops
 * leading zero bytes (~1 payload in 256), and an imported 24-word phrase
 * yields 32 bytes of entropy — the exact width of a legacy primary key.
 *
 * Do NOT try to validate the entropy branch by rebuilding a mnemonic and
 * checking its BIP39 checksum. Mnemonic.fromEntropy COMPUTES that checksum, so
 * it accepts any 16 bytes and can never reject a misclassification.
 */

import { PrivateKey, Hash } from '@bsv/sdk'

// ── Payload framing ──────────────────────────────────────────────────────────

/** Entropy of a 12-word BIP39 phrase. The only width v2 shares support. */
export const ENTROPY_BYTES = 16
/** Fixed width of the split secret. Never varies, never inferred. */
export const PAYLOAD_BYTES = 32

/** What a recombined payload turned out to be. */
export type RecoveredSecret = { kind: 'entropy'; entropy: number[] } | { kind: 'legacy'; primaryKey: number[] }

/** Wrap 16 bytes of entropy in the tagged 32-byte payload. */
export function frameEntropy(entropy: number[]): number[] {
  if (entropy.length !== ENTROPY_BYTES) {
    throw new Error(`frameEntropy: expected ${ENTROPY_BYTES} bytes, got ${entropy.length}`)
  }
  return [...entropy, ...Hash.sha256(entropy).slice(0, PAYLOAD_BYTES - ENTROPY_BYTES)]
}

/**
 * Restore a recombined payload to full width.
 *
 * Shamir recombination yields a PrivateKey, whose toArray() drops leading zero
 * bytes. Without this pad, roughly one payload in 256 decodes short and fails
 * to match anything.
 */
export function padPayload(bytes: number[]): number[] {
  if (bytes.length > PAYLOAD_BYTES) {
    throw new Error(`padPayload: payload exceeds ${PAYLOAD_BYTES} bytes`)
  }
  return [...new Array(PAYLOAD_BYTES - bytes.length).fill(0), ...bytes]
}

/** Decide whether a recombined payload is framed entropy or a legacy key. */
export function classifyPayload(raw: number[]): RecoveredSecret {
  const payload = padPayload(raw)
  const entropy = payload.slice(0, ENTROPY_BYTES)
  const tag = payload.slice(ENTROPY_BYTES)
  const expected = Hash.sha256(entropy).slice(0, PAYLOAD_BYTES - ENTROPY_BYTES)

  return tag.every((b, i) => b === expected[i]) ? { kind: 'entropy', entropy } : { kind: 'legacy', primaryKey: payload }
}

// ── Share generation ─────────────────────────────────────────────────────────

/**
 * Split mnemonic entropy into backup shares (the current format).
 * @param entropy 16 bytes, from Mnemonic.toEntropy()
 * @returns Share strings in the format base58(x).base58(y).threshold.integrity
 */
export function generateEntropyShares(entropy: number[], threshold: number = 2, totalShares: number = 3): string[] {
  return new PrivateKey(frameEntropy(entropy)).toBackupShares(threshold, totalShares)
}

/**
 * Split a raw private key (the legacy format).
 *
 * Still reachable for wallets that were themselves restored from legacy paper
 * and therefore have no mnemonic to frame. Removing it would leave that cohort
 * with no way to back up at all; the tag check routes their shares back to the
 * legacy branch on recovery, so this stays self-consistent.
 */
export function generateLegacyKeyShares(
  privateKeyBytes: number[],
  threshold: number = 2,
  totalShares: number = 3
): string[] {
  return new PrivateKey(privateKeyBytes).toBackupShares(threshold, totalShares)
}

// ── Share validation ─────────────────────────────────────────────────────────

export interface ParsedShare {
  raw: string
  x: string
  y: string
  threshold: number
  integrity: string
}

/**
 * Parse and validate a single backup share string.
 * @returns Parsed share or null if invalid format
 */
export function parseShare(shareString: string): ParsedShare | null {
  const parts = shareString.trim().split('.')
  if (parts.length !== 4) return null

  const [x, y, thresholdStr, integrity] = parts
  const threshold = Number(thresholdStr)

  if (!x || !y || isNaN(threshold) || threshold < 2 || !integrity) return null

  return { raw: shareString.trim(), x, y, threshold, integrity }
}

/** Why a newly scanned share cannot join the shares collected so far. */
export type ShareCompatibilityIssue = 'threshold-mismatch' | 'integrity-mismatch' | 'duplicate'

/**
 * Validate that a new share is compatible with previously collected shares.
 * Returns a code, not prose, so callers (screens) translate it themselves.
 * @returns The issue code, or null if the share is compatible.
 */
export function checkShareCompatibility(
  newShare: ParsedShare,
  existing: ParsedShare[]
): ShareCompatibilityIssue | null {
  if (existing.length === 0) return null

  const first = existing[0]

  if (newShare.threshold !== first.threshold) {
    return 'threshold-mismatch'
  }

  if (newShare.integrity !== first.integrity) {
    return 'integrity-mismatch'
  }

  // Check for duplicate (same x.y point)
  const isDuplicate = existing.some(s => s.x === newShare.x && s.y === newShare.y)
  if (isDuplicate) {
    return 'duplicate'
  }

  return null
}

const COMPATIBILITY_MESSAGES: Record<ShareCompatibilityIssue, string> = {
  'threshold-mismatch': 'Threshold does not match previous shares',
  'integrity-mismatch': 'Integrity hash does not match — shares are from different keys',
  duplicate: 'This share has already been scanned'
}

/**
 * Validate that a new share is compatible with previously collected shares.
 * @returns Error message string or null if valid
 * @deprecated use checkShareCompatibility and translate the code in the UI layer
 */
export function validateShareCompatibility(newShare: ParsedShare, existingShares: ParsedShare[]): string | null {
  const issue = checkShareCompatibility(newShare, existingShares)
  return issue === null ? null : COMPATIBILITY_MESSAGES[issue]
}

/**
 * Recombine shares and say what came out.
 * @param shareStrings At least `threshold` raw share strings
 * @throws If the shares are invalid or their integrity hashes disagree
 */
export function recoverSecretFromShares(shareStrings: string[]): RecoveredSecret {
  return classifyPayload(Array.from(PrivateKey.fromBackupShares(shareStrings).toArray()))
}
