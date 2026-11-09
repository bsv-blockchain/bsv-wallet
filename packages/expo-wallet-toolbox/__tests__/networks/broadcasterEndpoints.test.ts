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
