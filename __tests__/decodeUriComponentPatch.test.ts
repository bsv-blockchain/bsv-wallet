/**
 * patches/decode-uri-component+0.2.2.patch (GHSA-vcc3-ghjq-m6fr).
 *
 * expo-router@57 pulls in query-string@7, which require()s decode-uri-component
 * 0.2.2 to decode deep-link URLs. 0.2.2's recovery path for malformed
 * percent-encoding is polynomial in the run length, so a crafted link could
 * hang the app; the fixed 0.5.0 is ESM-only and cannot replace it. The patch
 * backports 0.5.0's linear decoder. If a dependency bump makes the patch stop
 * applying, patch-package fails the install; this test catches the patch being
 * dropped while the vulnerable version is still installed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const decode = require('decode-uri-component') as (input: string) => string

describe('decode-uri-component (patched 0.2.2)', () => {
  it.each([
    ['%25', '%'],
    ['%', '%'],
    ['st%C3%A5le', 'ståle'],
    ['%st%C3%A5le%', '%ståle%'],
    ['%%7Bst%C3%A5le%7D%', '%{ståle}%'],
    ['%7B%ab%%7C%de%%7D', '{%ab%|%de%}'],
    ['%FE%FF', '��'],
    ['%C2', '�'],
    ['%C2%B5', 'µ'],
    ['a+b', 'a b']
  ])('decodes %j as %j, as 0.2.2 always did', (input, expected) => {
    expect(decode(input)).toBe(expected)
  })

  it('decodes a long malformed percent run in linear time', () => {
    // Unpatched 0.2.2 takes seconds on these 200 repetitions (~2.4 s in plain
    // Node, far longer under jest) and ~11 s on 400, growing polynomially; the
    // patched decoder takes about a millisecond. Kept small so a regression
    // fails here rather than hanging the run.
    const input = '%E0%A4'.repeat(200)
    const started = Date.now()
    const out = decode(input)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(out).toBe(input)
  })
})
