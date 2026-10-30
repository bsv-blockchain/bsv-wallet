import { allowedHosts, isAllowedHost } from '../../../core/bridge/loopback/hostCheck'
import rows from './fixtures/host-check.json'

describe('loopback host check', () => {
  it('allowedHosts both families includes localhost', () => {
    expect(allowedHosts({ port: 3321, ipv4: true, ipv6: true })).toEqual([
      '127.0.0.1:3321',
      '[::1]:3321',
      'localhost:3321'
    ])
  })

  it('ipv4 only omits localhost and [::1]', () => {
    expect(allowedHosts({ port: 3321, ipv4: true, ipv6: false })).toEqual(['127.0.0.1:3321'])
  })

  it('host with wrong port, missing, uppercase LOCALHOST and trailing dot are refused (fixture rows)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15)
    for (const r of rows) {
      const got = isAllowedHost(r.host as string | undefined, { port: r.port, ipv4: r.ipv4, ipv6: r.ipv6 })
      expect({ name: r.name, got }).toEqual({ name: r.name, got: r.expected })
    }
    expect(isAllowedHost(undefined, { port: 3321, ipv4: true, ipv6: true })).toBe(false)
  })
})
