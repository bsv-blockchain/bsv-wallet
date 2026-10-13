import { resolveWebLink, toWebLink } from '../src/links/webLinks'

const KEY = '02' + 'ab'.repeat(32)
const D = 'bitcoinsv.com'

describe('website links', () => {
  it('opens Pay with the pay link a /pay/ link carries, query and all', () => {
    const route = resolveWebLink(`https://${D}/pay/${KEY}?sats=1500&note=Lunch%20Friday`, D)
    expect(route).toBe(`/send?link=${encodeURIComponent(`peerpay:${KEY}?sats=1500&note=Lunch%20Friday`)}`)
  })

  it('takes the www. host and a bare path as the phone may hand it over', () => {
    expect(resolveWebLink(`https://www.${D}/pay/${KEY}`, D)).toBe(`/send?link=${encodeURIComponent(`peerpay:${KEY}`)}`)
    expect(resolveWebLink(`/pay/${KEY}?sats=5`, D)).toBe(`/send?link=${encodeURIComponent(`peerpay:${KEY}?sats=5`)}`)
  })

  it('opens Pay on a handle', () => {
    expect(resolveWebLink(`https://${D}/@Ana`, D)).toBe('/send?handle=%40ana')
  })

  it('leaves alone other hosts, other paths, bad keys, and links when no domain is set', () => {
    expect(resolveWebLink(`https://evil.example/pay/${KEY}`, D)).toBeNull()
    expect(resolveWebLink(`https://${D}/about`, D)).toBeNull()
    expect(resolveWebLink(`https://${D}/pay/nope`, D)).toBeNull()
    expect(resolveWebLink('/pay', D)).toBeNull()
    expect(resolveWebLink(`https://${D}/pay/${KEY}`, '')).toBeNull()
  })

  it('turns a pay link into a website link, and back', () => {
    const peerpay = `peerpay:${KEY}?sats=1500&note=Lunch`
    const web = toWebLink(peerpay, D)
    expect(web).toBe(`https://${D}/pay/${KEY}?sats=1500&note=Lunch`)
    expect(resolveWebLink(web, D)).toBe(`/send?link=${encodeURIComponent(peerpay)}`)
    expect(toWebLink(peerpay, '')).toBe(peerpay)
  })
})
