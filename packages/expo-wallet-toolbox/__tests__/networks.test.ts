import { APP_CHAINS, NETWORKS, hasOverlay, isAppChain } from '../core/networks'
import { toWalletChain } from '../core/config'
import { HEADER_CHECKPOINTS } from '../core/headers/checkpoints'
import { createServices } from '../core/services/walletServiceConfig'
import { configureToolbox, resetToolboxConfig } from '../core/toolboxConfig'

describe('NETWORKS', () => {
  it('maps every app chain to its toolbox chain', () => {
    expect(APP_CHAINS.map(toWalletChain)).toEqual(['main', 'test', 'ttn', 'regtest'])
  })

  it('gives every network its own Arcade and MessageBox server, over https', () => {
    const arcades = APP_CHAINS.map(c => NETWORKS[c].arcadeUrl)
    const boxes = APP_CHAINS.map(c => NETWORKS[c].messageBoxUrl)
    expect(new Set(arcades).size).toBe(APP_CHAINS.length)
    expect(new Set(boxes).size).toBe(APP_CHAINS.length)
    for (const url of [...arcades, ...boxes]) expect(url).toMatch(/^https:\/\/[^/]+$/)
  })

  it('has WhatsOnChain everywhere except the scaling teratestnet', () => {
    expect(NETWORKS.teratest.woc?.apiBase).toBe('https://api.woc-ttn.bsvblockchain.tech')
    expect(NETWORKS.scaletest.woc).toBeUndefined()
  })

  it('looks identities up in each network’s own overlay, and in none on scaletest', () => {
    expect(APP_CHAINS.map(c => NETWORKS[c].overlayPreset)).toEqual(['mainnet', 'testnet', 'teratestnet', 'local'])
    expect(hasOverlay('teratest')).toBe(true)
    expect(hasOverlay('scaletest')).toBe(false)
  })

  it('registers push only with the server that sends it', () => {
    expect(APP_CHAINS.filter(c => NETWORKS[c].push)).toEqual(['main'])
  })

  it('only knows the app chain names', () => {
    expect(isAppChain('scaletest')).toBe(true)
    expect(isAppChain('ttn')).toBe(false)
    expect(isAppChain(undefined)).toBe(false)
  })
})

// The deployed scaling teratestnet runs regtest parameters, which the installed
// toolbox (2.14.x) cannot verify. Until @bsv/wallet-toolbox 2.15.0 adds the
// 'regtest' chain it must stay out of the picker.
describe('scaletest is wired but not offered', () => {
  afterEach(() => resetToolboxConfig())

  it('is not available, while every other network is', () => {
    expect(APP_CHAINS.filter(c => !NETWORKS[c].available)).toEqual(['scaletest'])
  })

  it('anchors its header window at the regtest genesis, which every chain reset keeps', () => {
    expect(HEADER_CHECKPOINTS.regtest).toEqual({
      height: 0,
      hash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'
    })
  })

  // A canary. The installed toolbox has no 'regtest' chain, which is why
  // scaletest is gated off. When this starts failing, the dependency supports
  // regtest (@bsv/wallet-toolbox >= 2.15.0, bsv-blockchain/ts-stack#819): set
  // NETWORKS.scaletest.available, drop the casts in toWalletChain and
  // headerStore, and replace this test with one that builds the services.
  it('cannot build its services on the installed toolbox yet', () => {
    configureToolbox({ backupUrl: null })
    const stub = { getChain: async () => 'regtest' } as never
    expect(() =>
      createServices(
        'scaletest',
        'callback-token',
        { timestamp: new Date(), base: 'USD', rate: 1 },
        undefined,
        undefined,
        stub
      )
    ).toThrow()
  })
})
