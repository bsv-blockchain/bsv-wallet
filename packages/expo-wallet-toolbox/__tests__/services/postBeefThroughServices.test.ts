import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { NETWORKS } from '../../core/networks'
import { createServices } from '../../core/services/walletServiceConfig'
import {
  BROADCAST_PROVIDER_BUDGET_MS,
  registerBroadcastProviders
} from '../../core/services/arcadeBroadcastProvider'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'

beforeEach(() => {
  configureToolbox({ backupUrl: null })
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
  resetToolboxConfig()
})

const rate = () => ({ timestamp: new Date(), base: 'USD' as const, rate: 1 })
const FRONT = 'https://broadcast.bsvblockchain.tech/testnet'

function chain(n: number) {
  const txs: Transaction[] = []
  for (let i = 0; i < n; i++) {
    const tx = new Transaction()
    if (i > 0) {
      tx.addInput({ sourceTransaction: txs[i - 1], sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
    }
    tx.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1000 - i })
    txs.push(tx)
  }
  const beef = new Beef()
  beef.mergeTransaction(txs[n - 1])
  return { beef, ids: txs.map(t => t.id('hex')) }
}

function setup() {
  const { services } = createServices('test', 'cb', rate())
  registerBroadcastProviders(services, NETWORKS.test, NETWORKS.test.arcadeUrl, 'cb', '', undefined)
  return services
}

type Answer = { status: number; body: Record<string, unknown> }

/** Mock fetch by URL prefix: every POST answers after 600 ms. */
function mockFetch(answer: (url: string, txid: string) => Answer) {
  const urls: string[] = []
  const fn = jest.fn((url: string, init: { body: Uint8Array }) => {
    urls.push(url)
    const txid = Transaction.fromEF(Array.from(init.body)).id('hex')
    const a = answer(url, txid)
    return new Promise(resolve => {
      setTimeout(() => resolve({ ok: a.status < 300, status: a.status, json: async () => a.body }), 600)
    })
  })
  global.fetch = fn as unknown as typeof fetch
  return { fn, urls }
}

const accepted = (txid: string): Answer => ({ status: 202, body: { txid, txStatus: 'SEEN_ON_NETWORK' } })

describe('postBeef through Services', () => {
  it('soft timeout is a flat 30 s', () => {
    const { services } = createServices('test', 'cb', rate())
    expect(services.postBeefUntilSuccessSoftTimeoutMs).toBe(BROADCAST_PROVIDER_BUDGET_MS)
    expect(services.postBeefUntilSuccessSoftTimeoutPerKbMs).toBe(0)
    expect(services.postBeefUntilSuccessSoftTimeoutMaxMs).toBe(BROADCAST_PROVIDER_BUDGET_MS)
    expect((services as any).getPostBeefSoftTimeoutMs(10_000_000)).toBe(30000)
  })

  it.each([1, 2, 25])('%i transactions publish on BSV Broadcaster alone', async n => {
    const services = setup()
    const { beef, ids } = chain(n)
    const { fn, urls } = mockFetch((_u, txid) => accepted(txid))
    const pending = services.postBeef(beef, [ids[n - 1]])
    await jest.advanceTimersByTimeAsync(600 * n + 1000)
    const rs = await pending
    expect(rs).toHaveLength(1)
    expect(rs[0].name).toBe('Arcade')
    expect(rs[0].status).toBe('success')
    expect(rs[0].txidResults.map(r => r.txid)).toEqual([ids[n - 1]])
    for (const u of urls) expect(u.startsWith(`${FRONT}/tx`)).toBe(true)
    expect(fn).toHaveBeenCalledTimes(n)
  })

  it('requesting every txid of the chain returns them in the requested order', async () => {
    const services = setup()
    const { beef, ids } = chain(25)
    mockFetch((_u, txid) => accepted(txid))
    const pending = services.postBeef(beef, ids)
    await jest.advanceTimersByTimeAsync(600 * 25 + 1000)
    const rs = await pending
    expect(rs).toHaveLength(1)
    expect(rs[0].txidResults.map(r => r.txid)).toEqual(ids)
  })

  it('a rejected parent stops its descendants and falls through', async () => {
    const services = setup()
    const { beef, ids } = chain(2)
    mockFetch((url, txid) =>
      url.startsWith(FRONT) && txid === ids[0] ? { status: 400, body: { txid, status: 461 } } : accepted(txid)
    )
    const pending = services.postBeef(beef, ids)
    await jest.advanceTimersByTimeAsync(10_000)
    const rs = await pending
    expect(rs[0].name).toBe('Arcade')
    expect(rs[0].txidResults[1].serviceError).toBe(true)
    expect(rs[1].name).toBe('GorillaPoolArc')
    expect(rs[1].status).toBe('success')
  })
})
