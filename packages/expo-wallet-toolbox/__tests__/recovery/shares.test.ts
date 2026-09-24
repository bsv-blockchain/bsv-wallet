/**
 * checkShareCompatibility — the code-returning sibling of validateShareCompatibility.
 *
 * Screens need a translatable code, not English prose, so the check itself was
 * split out; validateShareCompatibility (kept, deprecated) becomes a thin
 * prose wrapper over this. Order of checks matters: threshold, then
 * integrity, then duplicate — mirrored exactly from the original prose
 * function so behaviour for existing callers is unchanged.
 */
import { Mnemonic } from '@bsv/sdk'
import {
  checkShareCompatibility,
  validateShareCompatibility,
  generateEntropyShares,
  parseShare,
  type ParsedShare
} from '../../core/recovery/shares'

const entropyOf = (m: Mnemonic): number[] => m.toEntropy()

function makeShares(): ParsedShare[] {
  const entropy = entropyOf(Mnemonic.fromRandom(128))
  const raws = generateEntropyShares(entropy)
  return raws.map(r => parseShare(r) as ParsedShare)
}

describe('checkShareCompatibility', () => {
  test('first share (empty existing) is always compatible', () => {
    const [a] = makeShares()
    expect(checkShareCompatibility(a, [])).toBeNull()
  })

  test('same threshold and integrity, different point → compatible', () => {
    const [a, b] = makeShares()
    expect(checkShareCompatibility(b, [a])).toBeNull()
  })

  test('mismatched threshold → threshold-mismatch', () => {
    const [a] = makeShares()
    const other: ParsedShare = { ...a, x: 'differentx', threshold: a.threshold + 1 }
    expect(checkShareCompatibility(other, [a])).toBe('threshold-mismatch')
  })

  test('mismatched integrity → integrity-mismatch', () => {
    const [a] = makeShares()
    const other: ParsedShare = { ...a, x: 'differentx', integrity: `${a.integrity}ff` }
    expect(checkShareCompatibility(other, [a])).toBe('integrity-mismatch')
  })

  test('same (x,y) point already present → duplicate', () => {
    const [a] = makeShares()
    const dup: ParsedShare = { ...a }
    expect(checkShareCompatibility(dup, [a])).toBe('duplicate')
  })

  test('check order matches validateShareCompatibility: threshold before integrity before duplicate', () => {
    const [a] = makeShares()
    // Both threshold AND integrity differ: threshold-mismatch wins.
    const thresholdAndIntegrity: ParsedShare = {
      ...a,
      x: 'differentx',
      threshold: a.threshold + 1,
      integrity: `${a.integrity}ff`
    }
    expect(checkShareCompatibility(thresholdAndIntegrity, [a])).toBe('threshold-mismatch')

    // Integrity differs AND it's a duplicate point: integrity-mismatch wins.
    const integrityAndDuplicate: ParsedShare = { ...a, integrity: `${a.integrity}ff` }
    expect(checkShareCompatibility(integrityAndDuplicate, [a])).toBe('integrity-mismatch')
  })
})

describe('validateShareCompatibility (deprecated wrapper)', () => {
  test('returns the existing English strings unchanged', () => {
    const [a] = makeShares()
    const thresholdMismatch: ParsedShare = { ...a, x: 'differentx', threshold: a.threshold + 1 }
    const integrityMismatch: ParsedShare = { ...a, x: 'differentx', integrity: `${a.integrity}ff` }

    expect(validateShareCompatibility(thresholdMismatch, [a])).toBe('Threshold does not match previous shares')
    expect(validateShareCompatibility(integrityMismatch, [a])).toBe(
      'Integrity hash does not match — shares are from different keys'
    )
    expect(validateShareCompatibility(a, [a])).toBe('This share has already been scanned')
    expect(validateShareCompatibility(a, [])).toBeNull()
  })
})
