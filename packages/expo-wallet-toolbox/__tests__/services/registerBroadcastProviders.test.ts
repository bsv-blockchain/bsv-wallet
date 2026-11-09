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

  it('Bitails never yields a terminal verdict (-25 missing inputs is retryable)', async () => {
    const raw = {
      postBeef: async () => ({
        name: 'Bitails',
        status: 'error',
        txidResults: [
          { txid: 'a', status: 'error', doubleSpend: true, competingTxs: ['x'] },
          { txid: 'b', status: 'error' },
          { txid: 'c', status: 'success' }
        ]
      })
    }
    const added: Provider[] = []
    const s2 = { postBeefServices: { add: (p: Provider) => added.push(p), remove: () => {} } }
    registerBroadcastProviders(s2, NETWORKS.main, NETWORKS.main.arcadeUrl, 'cb', undefined, raw as any)
    const res = await added.find(p => p.name === 'Bitails')!.service({} as Beef, ['a', 'b', 'c'])
    expect(res.txidResults[0]).toMatchObject({ txid: 'a', status: 'error', serviceError: true })
    expect(res.txidResults[0].doubleSpend).toBeUndefined()
    expect(res.txidResults[0].competingTxs).toBeUndefined()
    expect(res.txidResults[1]).toMatchObject({ status: 'error', serviceError: true })
    expect(res.txidResults[2]).toMatchObject({ status: 'success' })
  })
})
