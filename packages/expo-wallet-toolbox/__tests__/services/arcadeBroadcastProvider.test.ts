import { Beef, Transaction } from '@bsv/sdk'
import {
  createArcadeBroadcastService,
  createGorillaPoolBroadcastService,
  createTaalBroadcastService,
  createWocBroadcastService,
  handleArcResponse
} from '../../core/services/arcadeBroadcastProvider'

describe('handleArcResponse', () => {
  const txids = ['abc123']

  it('treats Arcade RECEIVED (HTTP 202) as success', () => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 202 },
      { txid: txids[0], txStatus: 'RECEIVED' },
      txids
    )
    expect(result.status).toBe('success')
    expect(result.txid).toBe(txids[0])
    expect(result.doubleSpend).toBeUndefined()
    expect(result.serviceError).toBeUndefined()
  })

  it.each([
    'STORED',
    'SENT_TO_NETWORK',
    'ACCEPTED_BY_NETWORK',
    'SEEN_ON_NETWORK',
    'SEEN_MULTIPLE_NODES',
    'MINED',
    'IMMUTABLE'
  ] as const)('treats %s as success when response.ok', txStatus => {
    const result = handleArcResponse('Arcade', { ok: true, status: 200 }, { txid: txids[0], txStatus }, txids)
    expect(result.status).toBe('success')
  })

  it('marks double-spend statuses without success', () => {
    for (const txStatus of ['DOUBLE_SPEND_ATTEMPTED', 'SEEN_IN_ORPHAN_MEMPOOL'] as const) {
      const result = handleArcResponse('Arcade', { ok: true, status: 200 }, { txid: txids[0], txStatus }, txids)
      expect(result.status).toBe('error')
      expect(result.doubleSpend).toBe(true)
    }
  })

  it('marks REJECTED and non-ok HTTP as serviceError', () => {
    const rejected = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus: 'REJECTED' },
      txids
    )
    expect(rejected.status).toBe('error')
    expect(rejected.serviceError).toBe(true)

    const httpErr = handleArcResponse(
      'Arcade',
      { ok: false, status: 500 },
      { txid: txids[0], txStatus: 'RECEIVED' },
      txids
    )
    expect(httpErr.status).toBe('error')
    expect(httpErr.serviceError).toBe(true)
  })

  it('treats missing txStatus with ok response as success (built-in ARC parity)', () => {
    const result = handleArcResponse('TaalArc', { ok: true, status: 200 }, { txid: txids[0] }, txids)
    expect(result.status).toBe('success')
  })
})

describe('ARC-compatible factories post to the path each deployment serves', () => {
  // Arcade serves POST /tx at the root. TAAL and GorillaPool are standard ARC,
  // where POST /tx is a 404 ("no matching operation was found") and the route
  // is POST /v1/tx — probed live 2026-09-24.
  const postOne = async (factory: { service: (beef: Beef, txids: string[]) => Promise<unknown> }) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ txid: 'ignored', txStatus: 'SEEN_ON_NETWORK' })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const result = await factory.service(beef, [tx.id('hex')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    return { url, init, result, ef: new Uint8Array(tx.toEF()) }
  }

  it('Arcade posts EF to /tx at the root', async () => {
    const { url, init, ef } = await postOne(
      createArcadeBroadcastService('https://arcade-v2-us-1.bsvblockchain.tech', 'cb-token')
    )
    expect(url).toBe('https://arcade-v2-us-1.bsvblockchain.tech/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(init.headers['X-CallbackToken']).toBe('cb-token')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('TAAL posts EF to /v1/tx with its bearer key', async () => {
    const { url, init, ef } = await postOne(createTaalBroadcastService('https://arc.taal.com', 'taal-key'))
    expect(url).toBe('https://arc.taal.com/v1/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(init.headers.Authorization).toBe('Bearer taal-key')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('TAAL testnet posts to /v1/tx', async () => {
    const { url } = await postOne(createTaalBroadcastService('https://arc-test.taal.com'))
    expect(url).toBe('https://arc-test.taal.com/v1/tx')
  })

  it('GorillaPool posts EF to /v1/tx', async () => {
    const { url, init, ef } = await postOne(createGorillaPoolBroadcastService('https://arc.gorillapool.io'))
    expect(url).toBe('https://arc.gorillapool.io/v1/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('XR-060: caps the logged response body instead of logging it in full', async () => {
    // A compromised/misbehaving ARC endpoint can return an oversized
    // txStatus/body field; logging it in full is itself unbounded memory/log
    // work on top of the JSON parse. The classification logic is untouched —
    // only what reaches console.log is capped.
    const hugeStatus = 'x'.repeat(5_000_000)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ txid: 'abc', txStatus: hugeStatus })
    }) as unknown as typeof fetch
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createTaalBroadcastService('https://arc.taal.com', 'key')
    await service(beef, [tx.id('hex')])
    const [, loggedSnippet] = logSpy.mock.calls[0] as [string, string]
    expect(loggedSnippet.length).toBeLessThan(hugeStatus.length)
    logSpy.mockRestore()
  })
})

describe('createWocBroadcastService classification', () => {
  // createWocBroadcastService returns { name, service(beef, txids) } —
  // services/arcadeBroadcastProvider.ts:141-155. It reads the LAST tx out of
  // the beef and POSTs its raw hex, so a minimal empty transaction suffices.
  const postOne = async (status: number, body: string) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService('main')
    return service(beef, [tx.id('hex')])
  }

  it('keeps "already in the mempool" as success (same-txid idempotent rebroadcast)', async () => {
    const r = await postOne(422, 'unexpected response code 500: 257: txn-already-in-mempool already in the mempool')
    expect(r.txidResults[0].status).toBe('success')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
  })

  it('classifies "Missing inputs" as a retryable serviceError, never doubleSpend', async () => {
    const r = await postOne(422, 'unexpected response code 500: Missing inputs')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
    expect(r.txidResults[0].serviceError).toBe(true)
  })

  it('classifies "mempool-conflict" as a retryable serviceError, never doubleSpend', async () => {
    const r = await postOne(422, '258: txn-mempool-conflict')
    expect(r.txidResults[0].doubleSpend).toBeUndefined()
    expect(r.txidResults[0].serviceError).toBe(true)
  })

  it('XR-060: caps the logged response body instead of logging it in full', async () => {
    const hugeBody = 'z'.repeat(5_000_000)
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const r = await postOne(500, hugeBody)
    // Classification still runs over the full body — only the log is capped.
    expect(r.txidResults[0].serviceError).toBe(true)
    const [, loggedSnippet] = logSpy.mock.calls[0] as [string, string]
    expect(loggedSnippet.length).toBeLessThan(hugeBody.length)
    logSpy.mockRestore()
  })
})
