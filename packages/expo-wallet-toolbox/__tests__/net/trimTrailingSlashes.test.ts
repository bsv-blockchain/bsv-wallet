import { trimTrailingSlashes } from '../../core/net/trimTrailingSlashes'

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash, as /\\/+$/ did', () => {
    for (const s of [
      '',
      '/',
      '///',
      'https://host',
      'https://host/',
      'https://host///',
      'https://host/a/b//',
      'a//b'
    ]) {
      expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''))
    }
  })

  it('returns the same string when there is nothing to trim', () => {
    const s = 'https://messagebox.bsvblockchain.tech'
    expect(trimTrailingSlashes(s)).toBe(s)
  })

  it('stays linear on many slashes that are not at the end', () => {
    const s = '/'.repeat(200_000) + 'x'
    const t0 = Date.now()
    expect(trimTrailingSlashes(s)).toBe(s)
    expect(Date.now() - t0).toBeLessThan(100)
  })
})
