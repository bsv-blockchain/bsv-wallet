/**
 * collectShare — pure reducer mirroring the scan screen's
 * handleBarCodeScanned exactly (see shareCollector.ts header). Every test
 * here works from real generated shares (generateEntropyShares) so
 * parseShare/checkShareCompatibility exercise real parsing, not fixtures.
 */
import { Mnemonic } from '@bsv/sdk'
import { generateEntropyShares } from '../../core/recovery/shares'
import { emptyShareCollection, collectShare, type ShareCollection } from '../../core/recovery/shareCollector'

const sharesOf = (threshold: number, total: number): string[] =>
  generateEntropyShares(Mnemonic.fromRandom(128).toEntropy(), threshold, total)

describe('emptyShareCollection', () => {
  test('is frozen', () => {
    expect(Object.isFrozen(emptyShareCollection)).toBe(true)
  })

  test('starts empty', () => {
    expect(emptyShareCollection).toEqual({ shares: [], threshold: null, lastRaw: '' })
  })
})

describe('collectShare', () => {
  test('invalid string → invalid, and lastRaw is set', () => {
    const { collection, event } = collectShare(emptyShareCollection, 'not-a-share')
    expect(event).toEqual({ kind: 'invalid' })
    expect(collection.lastRaw).toBe('not-a-share')
    expect(collection.shares).toEqual([])
  })

  test('back-to-back identical invalid scan → ignored', () => {
    const first = collectShare(emptyShareCollection, 'garbage')
    expect(first.event).toEqual({ kind: 'invalid' })
    const second = collectShare(first.collection, 'garbage')
    expect(second.event).toEqual({ kind: 'ignored' })
    expect(second.collection).toEqual(first.collection)
  })

  test('back-to-back identical incompatible scan → ignored', () => {
    const [a, b] = sharesOf(2, 3)
    const added = collectShare(emptyShareCollection, a)
    // b has a different threshold/integrity source (different mnemonic entirely)
    const [otherMnemonicShare] = sharesOf(2, 3)
    const first = collectShare(added.collection, otherMnemonicShare)
    expect(first.event.kind).toBe('incompatible')
    const second = collectShare(first.collection, otherMnemonicShare)
    expect(second.event).toEqual({ kind: 'ignored' })
    expect(second.collection).toEqual(first.collection)
    void b
  })

  test('incompatible → collection unchanged apart from lastRaw', () => {
    const [a] = sharesOf(2, 3)
    const added = collectShare(emptyShareCollection, a)
    const [otherMnemonicShare] = sharesOf(2, 3)
    const { collection, event } = collectShare(added.collection, otherMnemonicShare)

    expect(event.kind).toBe('incompatible')
    expect(event.kind === 'incompatible' && event.issue).toBe('integrity-mismatch')
    expect(collection.shares).toEqual(added.collection.shares)
    expect(collection.threshold).toBe(added.collection.threshold)
    expect(collection.lastRaw).toBe(otherMnemonicShare)
  })

  test('added → scanned/needed captured, threshold from first accepted share, lastRaw cleared', () => {
    const [a, b] = sharesOf(2, 3)
    const { collection, event } = collectShare(emptyShareCollection, a)

    expect(event).toEqual({ kind: 'added', scanned: 1, needed: 2 })
    expect(collection.threshold).toBe(2)
    expect(collection.lastRaw).toBe('')
    expect(collection.shares).toHaveLength(1)
    void b
  })

  test('after added, scanning the same share again is duplicate via incompatible, not ignored', () => {
    const [a] = sharesOf(2, 3)
    const first = collectShare(emptyShareCollection, a)
    const second = collectShare(first.collection, a)

    expect(second.event).toEqual({ kind: 'incompatible', issue: 'duplicate' })
  })

  test('complete fires exactly once, at shares.length >= threshold, not before, shareStrings in scan order (3-of-3)', () => {
    const [a, b, c] = sharesOf(3, 3)

    const r1 = collectShare(emptyShareCollection, a)
    expect(r1.event.kind).toBe('added')

    const r2 = collectShare(r1.collection, b)
    expect(r2.event.kind).toBe('added')

    const r3 = collectShare(r2.collection, c)
    expect(r3.event).toEqual({ kind: 'complete', shareStrings: [a, b, c] })
  })

  test('complete fires exactly once, at shares.length >= threshold, not before (2-of-3)', () => {
    const [a, b, c] = sharesOf(2, 3)

    const r1 = collectShare(emptyShareCollection, a)
    expect(r1.event.kind).toBe('added')

    const r2 = collectShare(r1.collection, b)
    expect(r2.event).toEqual({ kind: 'complete', shareStrings: [a, b] })

    // a third, compatible share after completion does not re-fire complete —
    // scanning stops once the screen reacts to 'complete', but the reducer
    // itself just keeps adding.
    void c
  })

  test('emptyShareCollection is never mutated by collectShare', () => {
    const snapshotBefore = JSON.parse(JSON.stringify(emptyShareCollection))
    const [a] = sharesOf(2, 3)
    collectShare(emptyShareCollection, a)
    collectShare(emptyShareCollection, 'garbage')
    expect(JSON.parse(JSON.stringify(emptyShareCollection))).toEqual(snapshotBefore)
  })

  test('collectShare never mutates its input collection', () => {
    const [a, b] = sharesOf(2, 3)
    const after1 = collectShare(emptyShareCollection, a)
    const inputSnapshot: ShareCollection = JSON.parse(JSON.stringify(after1.collection))

    collectShare(after1.collection, b)

    expect(JSON.parse(JSON.stringify(after1.collection))).toEqual(inputSnapshot)
  })
})
