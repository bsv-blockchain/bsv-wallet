import {
  MAX_CERT_BODY_BYTES,
  MAX_FIELDS,
  MAX_FIELD_NAME_BYTES,
  MAX_FIELD_VALUE_BYTES,
  MAX_SEARCH_QUERY_LENGTH,
  PROFILE_CERT_TYPE,
  BRFC_LOOKUP,
  BRFC_REVERSE_LOOKUP,
  SEARCH_MIN_QUERY_LENGTH,
  ZERO_OUTPOINT,
  isRoutableSearchQuery,
  isValidHandleFormat,
  looksLikeDomain,
  parsePaymail,
  utf8ByteLength
} from '../../../core/identity/handleRegistry/rules'

describe('constants', () => {
  it('states the registry values the server enforces', () => {
    expect(PROFILE_CERT_TYPE).toBe('SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE=')
    expect(BRFC_LOOKUP).toBe('0ace65da5987')
    expect(BRFC_REVERSE_LOOKUP).toBe('43dcf83ddc5f')
    expect(ZERO_OUTPOINT).toBe('0000000000000000000000000000000000000000000000000000000000000000.0')
    expect([MAX_FIELDS, MAX_FIELD_NAME_BYTES, MAX_FIELD_VALUE_BYTES, MAX_CERT_BODY_BYTES]).toEqual([
      32, 50, 1024, 16384
    ])
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(2)
    expect(MAX_SEARCH_QUERY_LENGTH).toBe(32)
  })
})

// The server's own table (pkg/handles): ^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$.
describe('isValidHandleFormat', () => {
  it.each(['dee', 'de.ggen', 'de_gen-1', 'a1b', '0x0', 'a'.repeat(32)])('accepts %s', h =>
    expect(isValidHandleFormat(h)).toBe(true)
  )
  it.each(['de', 'a'.repeat(33), 'Dee', '.dee', 'dee.', '-dee', 'dee-', '_dee', 'de gen', 'dee!', 'dée', ''])(
    'rejects %s',
    h => expect(isValidHandleFormat(h)).toBe(false)
  )
})

describe('looksLikeDomain', () => {
  it.each(['deggen.com', 'example.co.uk', 'a.io', 'my-host.example.com'])('accepts %s', d =>
    expect(looksLikeDomain(d)).toBe(true)
  )
  it.each(['example', 'exa mple.com', '-bad.com', 'bad-.com', '.com', 'example..com', ''])('rejects %s', d =>
    expect(looksLikeDomain(d)).toBe(false)
  )
  it('lowercases before judging, the way a typed domain arrives', () => {
    expect(looksLikeDomain('  Deggen.COM ')).toBe(true)
  })
})

// The server's own gate on a search path segment (pkg/handlers/lookup.go
// `normaliseQuery`, `queryRE`, `maxQueryLength`), plus the two segments that
// never reach the search route at all.
describe('isRoutableSearchQuery', () => {
  it.each(['de', 'dee', 'de.ggen', 'de_gen-1', 'a'.repeat(32)])('accepts %s', q =>
    expect(isRoutableSearchQuery(q)).toBe(true)
  )
  it.each(['d', '', 'a'.repeat(33), 'Dee', 'de gen', 'dee!', 'dée', 'de/gen', 'dee@x'])('rejects %s', q =>
    expect(isRoutableSearchQuery(q)).toBe(false)
  )
  it('rejects the one word the registry answers with a 400 instead of a search', () => {
    // GET /api/handle/available is mounted ahead of GET /api/handle/{query} and
    // answers ERR_INVALID_LOOKUP, which `search` would raise as an outage.
    expect(isRoutableSearchQuery('available')).toBe(false)
    expect(isRoutableSearchQuery('availables')).toBe(true)
  })
  it('rejects the segment the URL parser eats before the request leaves the device', () => {
    // new URL('https://h/api/handle/..').href is 'https://h/api/', which the
    // route table does not serve. Encoding cannot rescue it: the URL spec reads
    // '%2e%2e' as the same double-dot segment. Two dots in the Pay recipient
    // field would otherwise raise the outage banner.
    expect(isRoutableSearchQuery('..')).toBe(false)
    // Only that whole segment — a handle may carry consecutive dots.
    expect(isRoutableSearchQuery('a..b')).toBe(true)
  })
})

describe('parsePaymail', () => {
  it('splits, trims and lowercases', () => {
    expect(parsePaymail('  Dee@Deggen.COM ')).toEqual({ handle: 'dee', domain: 'deggen.com' })
  })
  it.each(['dee', 'dee@', '@deggen.com', 'dee@deggen', 'a@b@c', 'd@deggen.com', ''])('rejects %s', text =>
    expect(parsePaymail(text)).toBeNull()
  )
})

describe('utf8ByteLength', () => {
  it('counts bytes, not code units', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('Üser')).toBe(5)
    expect(utf8ByteLength('日本')).toBe(6)
    // A surrogate pair is one 4-byte character, not two 3-byte ones.
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('a😀b')).toBe(6)
  })
})
