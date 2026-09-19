import { mergeContactCache } from '../../core/contacts/contactCache'

describe('mergeContactCache', () => {
  it('keeps a column this pass learned nothing about', () => {
    expect(mergeContactCache({ cachedHandle: 'dee@deggen.com' }, { cachedAvatarUrl: 'https://a/x.png' })).toEqual({
      cachedHandle: 'dee@deggen.com',
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
  })

  it('treats an empty learned value as "there is none", and clears it', () => {
    expect(
      mergeContactCache({ cachedHandle: 'dee@deggen.com', cachedAvatarUrl: 'https://a/x.png' }, { cachedHandle: '' })
    ).toEqual({
      cachedHandle: undefined,
      cachedAvatarUrl: 'https://a/x.png',
      cachedCertifier: undefined
    })
  })

  it('never touches a certifier it was not given', () => {
    const merged = mergeContactCache(
      { cachedCertifier: '02aa', cachedHandle: 'old@deggen.com' },
      { cachedHandle: 'dee@deggen.com' }
    )
    expect(merged?.cachedCertifier).toBe('02aa')
  })

  it('answers null when there is nothing to write', () => {
    const current = { cachedHandle: 'dee@deggen.com', cachedAvatarUrl: 'https://a/x.png' }
    expect(
      mergeContactCache(current, { cachedHandle: 'dee@deggen.com', cachedAvatarUrl: 'https://a/x.png' })
    ).toBeNull()
    expect(mergeContactCache({}, {})).toBeNull()
  })
})
