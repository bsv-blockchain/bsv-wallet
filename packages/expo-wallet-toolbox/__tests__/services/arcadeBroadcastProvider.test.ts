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

  it('marks a proven double-spend attempt as doubleSpend, not just error', () => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus: 'DOUBLE_SPEND_ATTEMPTED' },
      txids
    )
    expect(result.status).toBe('error')
    expect(result.doubleSpend).toBe(true)
  })

  // XR-062: SEEN_IN_ORPHAN_MEMPOOL means the parent hasn't propagated yet — a
  // missing/unpropagated-parent transport condition, not a proven conflict.
  // It used to be lumped in with DOUBLE_SPEND_ATTEMPTED and fed the same
  // terminal rejection cascade (offline/plan.ts applyOutcome), permanently
  // rejecting a valid chained/offline payment and releasing its reservations
  // purely from ordinary propagation timing. It must be retryable
  // (serviceError), never doubleSpend.
  it('XR-062: marks an orphan-mempool status as a retryable serviceError, not doubleSpend', () => {
    const result = handleArcResponse(
      'Arcade',
      { ok: true, status: 200 },
      { txid: txids[0], txStatus: 'SEEN_IN_ORPHAN_MEMPOOL' },
      txids
    )
    expect(result.status).toBe('error')
    expect(result.doubleSpend).not.toBe(true)
    expect(result.serviceError).toBe(true)
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

  it('treats missing txStatus with ok response as success when the txid matches (built-in ARC parity)', () => {
    const result = handleArcResponse('TaalArc', { ok: true, status: 200 }, { txid: txids[0] }, txids)
    expect(result.status).toBe('success')
  })

  // XR-064: a custom (person-configured) ARC endpoint's success predicate was
  // `response.ok && data.txStatus !== 'REJECTED'` — with no txid match and no
  // requirement that txStatus be an explicit accepted value. An on-path
  // attacker on a person-chosen plaintext ARC endpoint (or simply a
  // misbehaving deployment) could return a bare `200 {}` and stop the
  // UntilSuccess chain right there, suppressing the real broadcast/fallback.
  it('XR-064: does NOT treat a bare 2xx body (no txStatus, no txid) as success', () => {
    const result = handleArcResponse('CustomArc', { ok: true, status: 200 }, {}, txids)
    expect(result.status).not.toBe('success')
    expect(result.serviceError).toBe(true)
  })

  it('XR-064: does not accept an unrecognized txStatus when the txid does not match either', () => {
    const result = handleArcResponse(
      'CustomArc',
      { ok: true, status: 200 },
      { txid: 'some-other-txid', txStatus: 'TOTALLY_MADE_UP' },
      txids
    )
    expect(result.status).not.toBe('success')
    expect(result.serviceError).toBe(true)
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

/**
 * XR-063: a broadcast provider that returns headers within the deadline and
 * then stalls its body used to hold the whole `service()` promise open
 * forever — the AbortController's timer was cleared as soon as fetch()
 * resolved, before response.json()/text() ever ran. Since this provider sits
 * first in the UntilSuccess fallback chain, a stall here blocked every later
 * fallback (Taal, GorillaPool, WoC) from ever being tried.
 */
describe('XR-063: a stalled body converts to a serviceError instead of hanging forever', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const txOf = () => {
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return { tx, beef }
  }

  it('Arcade (ARC) resolves with a serviceError rather than hanging when .json() never resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {})
    }) as unknown as typeof fetch
    const { tx, beef } = txOf()
    const { service } = createArcadeBroadcastService('https://arcade-v2-us-1.bsvblockchain.tech', 'cb-token')

    const pending = service(beef, [tx.id('hex')])
    await jest.advanceTimersByTimeAsync(30_000)
    const result = await pending

    expect(result.status).toBe('error')
    expect(result.txidResults[0].serviceError).toBe(true)
    expect(result.txidResults[0].doubleSpend).toBeUndefined()
  })

  it('WhatsOnChain resolves with a serviceError rather than hanging when .text() never resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => new Promise(() => {})
    }) as unknown as typeof fetch
    const { tx, beef } = txOf()
    const { service } = createWocBroadcastService('main')

    const pending = service(beef, [tx.id('hex')])
    await jest.advanceTimersByTimeAsync(30_000)
    const result = await pending

    expect(result.status).toBe('error')
    expect(result.txidResults[0].serviceError).toBe(true)
  })
})
