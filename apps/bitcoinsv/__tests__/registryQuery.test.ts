import { registryQuery } from '../src/contacts/registryQuery'

describe('registryQuery (decision 8: a bare @name is on this build’s domain)', () => {
  it('qualifies a bare name or @name with the domain', () => {
    expect(registryQuery('@Rosa', 'bitcoinsv.com')).toBe('rosa@bitcoinsv.com')
    expect(registryQuery('rosa', 'bitcoinsv.com')).toBe('rosa@bitcoinsv.com')
  })
  it('keeps a full paymail, dropping a leading @', () => {
    expect(registryQuery('@rosa@handcash.io', 'bitcoinsv.com')).toBe('rosa@handcash.io')
    expect(registryQuery('rosa@handcash.io', 'bitcoinsv.com')).toBe('rosa@handcash.io')
  })
  it('asks nothing for empty input', () => {
    expect(registryQuery('  ', 'bitcoinsv.com')).toBeNull()
    expect(registryQuery('@', 'bitcoinsv.com')).toBeNull()
  })
  it('without a domain, passes the name through', () => {
    expect(registryQuery('@rosa', null)).toBe('rosa')
  })
})
