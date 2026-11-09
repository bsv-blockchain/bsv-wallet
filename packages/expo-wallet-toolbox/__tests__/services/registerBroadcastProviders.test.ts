import type { Beef } from '@bsv/sdk'
import { NETWORKS } from '../../core/networks'
import { registerBroadcastProviders } from '../../core/services/arcadeBroadcastProvider'

type Provider = { name: string; service: (beef: Beef, txids: string[]) => Promise<any> }

function makeServices(initial: string[] = []) {
  let list: Provider[] = initial.map(name => ({ name, service: async () => ({}) as any }))
  return {
    names: () => list.map(p => p.name),
    postBeefServices: {
      add: (s: Provider) => {
        list.push(s)
      },
      remove: (name: string) => {
        list = list.filter(p => p.name !== name)
      }
    }
  }
}

const bitails = { postBeef: async () => ({}) as any }

describe('registerBroadcastProviders', () => {
  it('main: BSV Broadcaster, GorillaPool, WhatsOnChain, Bitails in order', () => {
    const services = makeServices()
    const names = registerBroadcastProviders(services, NETWORKS.main, NETWORKS.main.arcadeUrl, 'cb', undefined, bitails)
    expect(names).toEqual(['Arcade', 'GorillaPoolArc', 'WhatsOnChain', 'Bitails'])
    expect(services.names()).toEqual(names)
  })

  it('teratest: Arcade and WhatsOnChain only', () => {
    const services = makeServices()
    expect(
      registerBroadcastProviders(services, NETWORKS.teratest, NETWORKS.teratest.arcadeUrl, 'cb', undefined, bitails)
    ).toEqual(['Arcade', 'WhatsOnChain'])
  })

  it('scaletest: Arcade only', () => {
    const services = makeServices()
    expect(
      registerBroadcastProviders(services, NETWORKS.scaletest, NETWORKS.scaletest.arcadeUrl, 'cb', undefined, bitails)
    ).toEqual(['Arcade'])
  })

  it('does not register GorillaPool twice when it is the primary (trailing slash)', () => {
    const services = makeServices()
    expect(
      registerBroadcastProviders(services, NETWORKS.main, 'https://arcade.gorillapool.io/', 'cb', undefined, bitails)
    ).toEqual(['Arcade', 'WhatsOnChain', 'Bitails'])
  })

  it('removes the toolbox defaults first', () => {
    const services = makeServices([
      'ArcadeBeef',
      'GorillaPoolArcBeef',
      'TaalArcBeef',
      'Bitails',
      'WhatsOnChain',
      'Other'
    ])
    registerBroadcastProviders(services, NETWORKS.main, NETWORKS.main.arcadeUrl, 'cb', undefined, undefined)
    expect(services.names()).toEqual(['Other', 'Arcade', 'GorillaPoolArc', 'WhatsOnChain'])
  })
})
