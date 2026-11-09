import { NETWORKS } from '../../core/networks'
import { KNOWN_ARC_URLS } from '../../core/constants'

describe('BSV Broadcaster endpoints', () => {
  it.each([
    ['main', 'https://broadcast.bsvblockchain.tech', 'https://arcade.gorillapool.io'],
    ['test', 'https://broadcast.bsvblockchain.tech/testnet', 'https://testnet.arcade.gorillapool.io'],
    ['teratest', 'https://broadcast.bsvblockchain.tech/ttn', undefined],
    ['scaletest', 'https://broadcast.bsvblockchain.tech/tstn', undefined]
  ] as const)('%s uses the BSV Broadcaster front door', (net, primary, gorilla) => {
    expect(NETWORKS[net].arcadeUrl).toBe(primary)
    expect(NETWORKS[net].gorillaPoolArcUrl).toBe(gorilla)
    expect('taalArcUrl' in NETWORKS[net]).toBe(false)
  })

  it('presets list only BSV Broadcaster instances', () => {
    expect(KNOWN_ARC_URLS.main.map(p => p.url)).toEqual([
      'https://broadcast.bsvblockchain.tech',
      'https://arcade-us-1.bsvblockchain.tech',
      'https://arcade-eu-1.bsvblockchain.tech'
    ])
    for (const net of ['test', 'teratest', 'scaletest'] as const)
      expect(KNOWN_ARC_URLS[net].map(p => p.url)).toEqual([NETWORKS[net].arcadeUrl])
    expect(KNOWN_ARC_URLS.main[0].label).toBe('BSV Broadcaster (default)')
    for (const list of Object.values(KNOWN_ARC_URLS)) for (const p of list) expect(p.requiresToken).toBe(false)
  })
})

describe('eas.json build env', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const eas = require('fs').readFileSync(require('path').resolve(__dirname, '../../../../eas.json'), 'utf8')
  const env = JSON.parse(eas).build.production.env as Record<string, string>
  it.each([
    ['', 'main'],
    ['TEST_', 'test'],
    ['TERATEST_', 'teratest']
  ] as const)('%sARC/CHAINTRACKS overrides match the BSV Broadcaster front door', (infix, net) => {
    expect(env[`EXPO_PUBLIC_${infix}ARC_URL`]).toBe(NETWORKS[net].arcadeUrl)
    expect(env[`EXPO_PUBLIC_${infix}CHAINTRACKS_URL`]).toBe(`${NETWORKS[net].arcadeUrl}/chaintracks/v1`)
  })
})
