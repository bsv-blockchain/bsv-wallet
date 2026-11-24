import {
  classifyPaymailDomain,
  classifyPaymailDomainDetailed,
  isLegacyCapabilityUrl
} from '../../../core/identity/handleRegistry/classify'
import type { CapabilityDiscovery } from '../../../core/identity/handleRegistry/resolver'

const LOOKUP = '0ace65da5987'
const DEST = '2a40af698840'
const RECV = '5c55a7fdb7bb'
const D_URL = 'https://h.example.com/p2p/{alias}@{domain.tld}/destination'
const R_URL = 'https://h.example.com/p2p/{alias}@{domain.tld}/beef'

const okMap = (capabilities: Record<string, unknown>): CapabilityDiscovery => ({
  kind: 'ok',
  domain: 'example.com',
  origin: 'https://h.example.com',
  capabilities
})

function setup(result: CapabilityDiscovery) {
  const discoverCapabilities = jest.fn(async () => result)
  const args = { resolver: { discoverCapabilities }, ownDomains: ['bitcoinsv.com', 'deggen.com'] }
  return { args, discoverCapabilities }
}

describe('classifyPaymailDomainDetailed', () => {
  it('own domain is peerpay with no lookup', async () => {
    const { args, discoverCapabilities } = setup({ kind: 'failed' })
    expect(await classifyPaymailDomainDetailed(args, 'BitcoinSV.com')).toEqual({ kind: 'peerpay' })
    expect(discoverCapabilities).not.toHaveBeenCalled()
  })

  it('0ace65da5987 present gives peerpay', async () => {
    const { args } = setup(okMap({ [LOOKUP]: 'https://x.example.com/api/handle/{query}' }))
    expect((await classifyPaymailDomainDetailed(args, 'example.com')).kind).toBe('peerpay')
  })

  it('peerpay wins when the legacy pair is also present', async () => {
    const { args } = setup(okMap({ [LOOKUP]: 'https://x.example.com/q', [DEST]: D_URL, [RECV]: R_URL }))
    expect((await classifyPaymailDomainDetailed(args, 'example.com')).kind).toBe('peerpay')
  })

  it('legacy pair without 0ace65da5987 gives legacy', async () => {
    const { args } = setup(
      okMap({
        [DEST]: D_URL,
        [RECV]: R_URL,
        '5f1323cddf31': 'https://h.example.com/pki/{alias}@{domain.tld}',
        pki: 'https://h.example.com/id/{alias}@{domain.tld}',
        paymentDestination: 'https://h.example.com/address/{alias}@{domain.tld}'
      })
    )
    expect(await classifyPaymailDomainDetailed(args, 'example.com')).toEqual({ kind: 'legacy' })
  })

  it.each([
    ['receive missing', { [DEST]: D_URL }],
    ['destination missing', { [RECV]: R_URL }]
  ])('one of the legacy pair gives unsupported (%s)', async (_n, caps) => {
    const { args } = setup(okMap(caps))
    expect(await classifyPaymailDomainDetailed(args, 'example.com')).toEqual({
      kind: 'unsupported',
      reason: 'no_capabilities'
    })
  })

  it.each([
    ['not a string', { [DEST]: 5, [RECV]: R_URL }],
    ['http', { [DEST]: 'http://h.example.com/{alias}@{domain.tld}', [RECV]: R_URL }],
    ['private', { [DEST]: 'https://10.0.0.1/{alias}@{domain.tld}', [RECV]: R_URL }]
  ])('a legacy URL that is %s gives unsupported', async (_n, caps) => {
    const { args } = setup(okMap(caps))
    expect((await classifyPaymailDomainDetailed(args, 'example.com')).kind).toBe('unsupported')
  })

  it('a legacy URL without {alias} gives unsupported', async () => {
    const { args } = setup(okMap({ [DEST]: 'https://h.example.com/p2p/{domain.tld}', [RECV]: R_URL }))
    expect((await classifyPaymailDomainDetailed(args, 'example.com')).kind).toBe('unsupported')
  })

  it('a legacy URL with a placeholder in the host gives unsupported', async () => {
    const { args } = setup(okMap({ [DEST]: 'https://{alias}.x.com/p/{domain.tld}', [RECV]: R_URL }))
    expect((await classifyPaymailDomainDetailed(args, 'example.com')).kind).toBe('unsupported')
  })

  it('document with neither gives unsupported / no_capabilities', async () => {
    const { args } = setup(okMap({ pki: 'https://h.example.com/id' }))
    expect(await classifyPaymailDomainDetailed(args, 'example.com')).toEqual({
      kind: 'unsupported',
      reason: 'no_capabilities'
    })
  })

  it('unsecured gives unsupported / unsecured', async () => {
    const { args } = setup({ kind: 'unsecured' })
    expect(await classifyPaymailDomainDetailed(args, 'example.com')).toEqual({
      kind: 'unsupported',
      reason: 'unsecured'
    })
  })

  it('none gives unsupported / no_capabilities', async () => {
    const { args } = setup({ kind: 'none' })
    expect(await classifyPaymailDomainDetailed(args, 'example.com')).toEqual({
      kind: 'unsupported',
      reason: 'no_capabilities'
    })
  })

  it('failed gives failed', async () => {
    const { args } = setup({ kind: 'failed' })
    expect(await classifyPaymailDomainDetailed(args, 'example.com')).toEqual({ kind: 'failed' })
  })

  it('not a domain gives unsupported without a resolver call', async () => {
    const { args, discoverCapabilities } = setup({ kind: 'failed' })
    expect(await classifyPaymailDomainDetailed(args, 'not a domain')).toEqual({
      kind: 'unsupported',
      reason: 'no_capabilities'
    })
    expect(discoverCapabilities).not.toHaveBeenCalled()
  })

  it('classifyPaymailDomain returns only the kind', async () => {
    const { args } = setup(okMap({ [DEST]: D_URL, [RECV]: R_URL }))
    expect(await classifyPaymailDomain(args, 'example.com')).toBe('legacy')
  })
})

describe('isLegacyCapabilityUrl', () => {
  it('requires every placeholder', () => {
    expect(isLegacyCapabilityUrl(D_URL, ['{alias}', '{domain.tld}'])).toBe(true)
    expect(isLegacyCapabilityUrl('https://h.example.com/{alias}', ['{alias}', '{domain.tld}'])).toBe(false)
  })
})
