/**
 * Backup share PARSING and compatibility checks — split out of shares.ts.
 *
 * Deliberately has NO `@bsv/sdk` import. `shareCollector.ts` (the scan
 * screen's pure reducer) needs exactly these functions and nothing else from
 * shares.ts, and `shareCollector.ts` is one of the modules
 * `__tests__/recovery/sdkFree.test.ts` proves never loads `@bsv/sdk` — a
 * value import of the FULL shares.ts (which also frames/splits/recombines
 * secrets via `PrivateKey`/`Hash`) would pull `@bsv/sdk` in transitively at
 * module-load time even though shareCollector only calls these two
 * functions. shares.ts re-exports everything here (`export * from
 * './shareParsing'`) so every existing consumer of shares.ts — and, through
 * it, `ui/backupShares.ts` — is unaffected.
 */

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
