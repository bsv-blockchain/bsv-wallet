/**
 * Print ID on backup slices. One print = three pages carrying the same random
 * 6-character ID as a fifth dot-separated part. Old 4-part pages stay valid.
 * Port of audit PoC secrets-export/shares_poc.cjs (slices finding).
 */
import * as fs from 'fs'
import * as path from 'path'
import { Mnemonic } from '@bsv/sdk'
import {
  generateEntropyShares,
  generatePrintId,
  attachPrintId,
  recoverSecretFromShares
} from '../../core/recovery/shares'
import { parseShare, isPrintId, PRINT_ID_ALPHABET, PRINT_ID_LENGTH } from '../../core/recovery/shareParsing'
import { collectShare, emptyShareCollection } from '../../core/recovery/shareCollector'

describe('print ID', () => {
  test('slices PoC: two slices from two prints of the same wallet carry the same integrity and previously combined into a failure; with print IDs the collector reports print-mismatch', () => {
    const entropy = Mnemonic.fromRandom(128).toEntropy()
    const printA = generateEntropyShares(entropy, 2, 3)
    const printB = generateEntropyShares(entropy, 2, 3)
    // Same wallet: same integrity on every slice of both prints.
    expect(printA[0].split('.')[3]).toBe(printB[0].split('.')[3])
    // Without IDs the mix is accepted and fails only at recombination.
    const mixedOld = collectShare(collectShare(emptyShareCollection, printA[0]).collection, printB[1])
    expect(mixedOld.event.kind).toBe('complete')
    expect(() => recoverSecretFromShares((mixedOld.event as any).shareStrings)).toThrow()

    const idA = 'AAAAAA'
    const idB = 'BBBBBB'
    const first = collectShare(emptyShareCollection, attachPrintId(printA[0], idA))
    expect(first.event.kind).toBe('added')
    const second = collectShare(first.collection, attachPrintId(printB[1], idB))
    expect(second.event).toEqual({ kind: 'incompatible', issue: 'print-mismatch' })
  })

  test('two slices of one print with the same ID combine and recoverSecretFromShares succeeds', () => {
    const entropy = Mnemonic.fromRandom(128).toEntropy()
    const print = generateEntropyShares(entropy, 2, 3)
    const id = generatePrintId()
    const first = collectShare(emptyShareCollection, attachPrintId(print[0], id))
    const second = collectShare(first.collection, attachPrintId(print[2], id))
    expect(second.event.kind).toBe('complete')
    const strings = (second.event as { kind: 'complete'; shareStrings: string[] }).shareStrings
    expect(strings.every(s => s.split('.').length === 4)).toBe(true)
    const recovered = recoverSecretFromShares(strings)
    expect(recovered).toEqual({ kind: 'entropy', entropy })
  })

  test('old 4-part pages still parse and combine with each other', () => {
    const entropy = Mnemonic.fromRandom(128).toEntropy()
    const print = generateEntropyShares(entropy, 2, 3)
    const parsed = parseShare(print[0])
    expect(parsed).not.toBeNull()
    expect(parsed?.printId).toBeUndefined()
    const first = collectShare(emptyShareCollection, print[0])
    const second = collectShare(first.collection, print[1])
    expect(second.event.kind).toBe('complete')
    expect(recoverSecretFromShares((second.event as any).shareStrings)).toEqual({ kind: 'entropy', entropy })
  })

  test('a 4-part page and a 5-part page do not combine (print-mismatch)', () => {
    const print = generateEntropyShares(Mnemonic.fromRandom(128).toEntropy(), 2, 3)
    const withId = attachPrintId(print[0], 'ABCDEF')
    const a = collectShare(emptyShareCollection, withId)
    expect(collectShare(a.collection, print[1]).event).toEqual({ kind: 'incompatible', issue: 'print-mismatch' })
    const b = collectShare(emptyShareCollection, print[1])
    expect(collectShare(b.collection, withId).event).toEqual({ kind: 'incompatible', issue: 'print-mismatch' })
  })

  test('parseShare rejects a fifth part that is not a valid print ID, and a six-part string', () => {
    const [share] = generateEntropyShares(Mnemonic.fromRandom(128).toEntropy(), 2, 3)
    expect(parseShare(`${share}.ABCDE`)).toBeNull() // too short
    expect(parseShare(`${share}.ABCDEFG`)).toBeNull() // too long
    expect(parseShare(`${share}.abcdef`)).toBeNull() // lower case
    expect(parseShare(`${share}.ABCDEI`)).toBeNull() // I is not in the alphabet
    expect(parseShare(`${share}.ABCDEL`)).toBeNull()
    expect(parseShare(`${share}.ABCDEO`)).toBeNull()
    expect(parseShare(`${share}.ABCDEU`)).toBeNull()
    expect(parseShare(`${share}.`)).toBeNull()
    expect(parseShare(`${share}.ABCDEF.GHJKMN`)).toBeNull() // six parts
    expect(parseShare(`${share}.ABCDEF`)).not.toBeNull()
  })

  test('generatePrintId returns 6 valid characters and two calls differ', () => {
    const ids = Array.from({ length: 20 }, () => generatePrintId())
    for (const id of ids) {
      expect(id).toHaveLength(PRINT_ID_LENGTH)
      expect(isPrintId(id)).toBe(true)
      for (const ch of id) expect(PRINT_ID_ALPHABET).toContain(ch)
    }
    expect(new Set(ids).size).toBeGreaterThan(1)
    expect(PRINT_ID_ALPHABET).toHaveLength(32)
  })

  test('shareParsing.ts imports nothing from @bsv/sdk', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../core/recovery/shareParsing.ts'), 'utf8')
    expect(src).not.toMatch(/from\s+['"]@bsv\/sdk['"]/)
    expect(src).not.toMatch(/require\(\s*['"]@bsv\/sdk['"]/)
  })

  test('attachPrintId round trips through parseShare (raw equals the original share, printId equals the ID)', () => {
    const [share] = generateEntropyShares(Mnemonic.fromRandom(128).toEntropy(), 2, 3)
    const attached = attachPrintId(share, '7M3Z9K')
    expect(attached).toBe(`${share}.7M3Z9K`)
    const parsed = parseShare(attached)
    expect(parsed?.raw).toBe(share)
    expect(parsed?.printId).toBe('7M3Z9K')
  })

  test('attachPrintId validates both arguments', () => {
    const [share] = generateEntropyShares(Mnemonic.fromRandom(128).toEntropy(), 2, 3)
    expect(() => attachPrintId(share, 'nope')).toThrow()
    expect(() => attachPrintId('garbage', 'ABCDEF')).toThrow()
    expect(() => attachPrintId(`${share}.ABCDEF`, 'ABCDEF')).toThrow() // already has an ID
  })
})
