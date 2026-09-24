/**
 * Pure reducer for the scan-shares screen's accumulate/dedupe/threshold logic.
 *
 * Mirrors handleBarCodeScanned exactly, extracted so it can be unit-tested
 * without a camera, a screen, or React: `lastRaw` is set on every non-ignored
 * scan; on 'invalid'/'incompatible' it stays set, so scanning the exact same
 * bad code twice in a row is a cheap, harmless 'ignored' (protects against a
 * scanner firing multiple frames of the same code before the user moves the
 * camera) rather than re-showing the same error. After 'added' it is cleared
 * — scanning the just-accepted share again immediately is a genuine duplicate
 * scan of a *different* share now in the collection, reported as
 * 'incompatible' with issue 'duplicate', not silently swallowed as 'ignored'.
 * 'complete' fires exactly once, the instant shares.length reaches the
 * threshold (captured from the first accepted share) — never before, and the
 * reducer does not suppress it if called again past that point (the screen
 * stops scanning once it reacts to 'complete').
 */
import { checkShareCompatibility, parseShare } from './shares'
import type { ParsedShare, ShareCompatibilityIssue } from './shares'

export interface ShareCollection {
  shares: ParsedShare[]
  threshold: number | null
  lastRaw: string
}

export const emptyShareCollection: ShareCollection = Object.freeze({
  shares: [],
  threshold: null,
  lastRaw: ''
})

export type ShareCollectEvent =
  | { kind: 'ignored' } // same raw as the previous scan
  | { kind: 'invalid' } // parseShare → null
  | { kind: 'incompatible'; issue: ShareCompatibilityIssue }
  | { kind: 'added'; scanned: number; needed: number }
  | { kind: 'complete'; shareStrings: string[] }

export function collectShare(
  c: ShareCollection,
  raw: string
): { collection: ShareCollection; event: ShareCollectEvent } {
  if (raw === c.lastRaw) {
    return { collection: c, event: { kind: 'ignored' } }
  }

  const parsed = parseShare(raw)
  if (parsed === null) {
    return { collection: { ...c, lastRaw: raw }, event: { kind: 'invalid' } }
  }

  const issue = checkShareCompatibility(parsed, c.shares)
  if (issue !== null) {
    return { collection: { ...c, lastRaw: raw }, event: { kind: 'incompatible', issue } }
  }

  const shares = [...c.shares, parsed]
  const threshold = c.threshold ?? parsed.threshold
  const next: ShareCollection = { shares, threshold, lastRaw: '' }

  if (shares.length >= threshold) {
    return { collection: next, event: { kind: 'complete', shareStrings: shares.map(s => s.raw) } }
  }

  return { collection: next, event: { kind: 'added', scanned: shares.length, needed: threshold } }
}
