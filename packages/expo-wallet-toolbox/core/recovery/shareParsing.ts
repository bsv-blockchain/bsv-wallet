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
  /** Random per print, identical on every page of one print. Absent on old 4-part pages. */
  printId?: string
}

/** Crockford base32 without I, L, O, U. */
export const PRINT_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PRINT_ID_LENGTH = 6

/** True when the value is exactly PRINT_ID_LENGTH characters from PRINT_ID_ALPHABET. */
export function isPrintId(value: string): boolean {
  if (typeof value !== 'string' || value.length !== PRINT_ID_LENGTH) return false
  for (const ch of value) if (!PRINT_ID_ALPHABET.includes(ch)) return false
  return true
}

/**
 * Parse and validate a single backup share string: `x.y.threshold.integrity`
 * (old, 4 parts) or `x.y.threshold.integrity.printId` (5 parts). `raw` is
 * always the 4-part canonical string without the print ID, so
 * PrivateKey.fromBackupShares keeps working unchanged.
 * @returns Parsed share or null if invalid format
 */
export function parseShare(shareString: string): ParsedShare | null {
  const parts = shareString.trim().split('.')
  if (parts.length !== 4 && parts.length !== 5) return null

  const [x, y, thresholdStr, integrity, printId] = parts
  if (parts.length === 5 && !isPrintId(printId)) return null
  const threshold = Number(thresholdStr)

  if (!x || !y || isNaN(threshold) || threshold < 2 || !integrity) return null

  const raw = parts.slice(0, 4).join('.')
  return parts.length === 5 ? { raw, x, y, threshold, integrity, printId } : { raw, x, y, threshold, integrity }
}

/** Why a newly scanned share cannot join the shares collected so far. */
export type ShareCompatibilityIssue = 'threshold-mismatch' | 'integrity-mismatch' | 'duplicate' | 'print-mismatch'

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

  // One print never mixes IDs, and never mixes an ID with no ID.
  if (newShare.printId !== first.printId) {
    return 'print-mismatch'
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
  duplicate: 'This share has already been scanned',
  'print-mismatch': 'These slices are from different prints and do not combine'
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
