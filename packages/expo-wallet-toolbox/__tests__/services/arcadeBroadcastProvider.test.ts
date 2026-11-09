import { Beef, LockingScript, MerklePath, Transaction, UnlockingScript } from '@bsv/sdk'
import {
  createArcadeBroadcastService,
  createGorillaPoolBroadcastService,
  createWocBroadcastService,
  handleArcResponse
} from '../../core/services/arcadeBroadcastProvider'
import { NETWORKS, type AppChain } from '../../core/networks'

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
    const result = handleArcResponse('CustomArc', { ok: true, status: 200 }, { txid: txids[0] }, txids)
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
  // Arcade serves POST /tx at the root. GorillaPool runs
  // the same Arcade server and also serves POST /tx.
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
      createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb-token')
    )
    expect(url).toBe('https://broadcast.bsvblockchain.tech/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(init.headers['X-CallbackToken']).toBe('cb-token')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('trims a trailing slash from a user-entered URL', async () => {
    const { url } = await postOne(createArcadeBroadcastService('https://broadcast.bsvblockchain.tech/testnet/', 'cb'))
    expect(url).toBe('https://broadcast.bsvblockchain.tech/testnet/tx')
  })

  it('GorillaPool posts EF to /tx', async () => {
    const { url, init, ef } = await postOne(createGorillaPoolBroadcastService('https://arcade.gorillapool.io'))
    expect(url).toBe('https://arcade.gorillapool.io/tx')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/octet-stream')
    expect(Array.from(init.body)).toEqual(Array.from(ef))
  })

  it('XR-060: caps the logged response body instead of logging it in full', async () => {
    // A compromised/misbehaving ARC endpoint can return an oversized
    // txStatus/body field; logging it in full is itself unbounded memory/log
    // work on top of the JSON parse. The classification logic is untouched —
    // only what reaches console.log is capped. Kept well under
    // MAX_BROADCAST_BODY_BYTES (the separate XR-060 remainder bound below) so
    // this test still exercises log truncation on a body the size bound lets
    // through.
    const hugeStatus = 'x'.repeat(100_000)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ txid: 'abc', txStatus: hugeStatus })
    }) as unknown as typeof fetch
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'key')
    await service(beef, [tx.id('hex')])
    const [, loggedSnippet] = logSpy.mock.calls[0] as [string, string]
    expect(loggedSnippet.length).toBeLessThan(hugeStatus.length)
    logSpy.mockRestore()
  })
})

describe('createWocBroadcastService classification', () => {
  // createWocBroadcastService returns { name, service(beef, txids) }.
  // Each requested txid is posted as raw hex, so a minimal empty transaction
  // suffices for classification.
  const postOne = async (status: number, body: string) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService(NETWORKS.main.woc!)
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
    // Kept well under MAX_BROADCAST_BODY_BYTES (see below) so this still
    // exercises log truncation on a body the size bound lets through.
    const hugeBody = 'z'.repeat(100_000)
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
 * XR-060 remainder: XR-063's fetchWithBodyDeadline bounds how long a stalled
 * body can hang, but until now nothing bounded how LARGE a body that does
 * arrive can be before it is fully parsed/buffered — a compromised or
 * misbehaving endpoint could still force an unbounded JSON parse or string
 * allocation over a multi-megabyte response, exactly the gap XR-060's
 * original triage flagged and its first pass (commit f7c12255) deliberately
 * left open pending this fix. Mirrors
 * core/identity/handleRegistry/resolver.ts's XR-077/SEC2-027 byte cap: a
 * declared Content-Length over the cap is refused before anything is read,
 * and a streamed body is aborted the instant it crosses the cap — falling
 * back to a post-hoc size check only when the runtime (or a test double)
 * exposes no stream to count from. Either path fails to the ordinary
 * retryable serviceError outcome, never success.
 */
describe('XR-060 remainder: bounds the broadcast body size itself, not just what gets logged', () => {
  it('Arcade (ARC): an oversized parsed body is rejected as serviceError, never success', async () => {
    // No response.body stream in this mock, so the fallback path applies:
    // the original json() is still called (a real runtime with no stream
    // support is the "floor, not a firewall" case), but its result is
    // rejected once its size is over the cap, before handleArcResponse ever
    // sees it as a would-be RECEIVED/success.
    const hugePayload = { txid: 'abc123', txStatus: 'RECEIVED', junk: 'x'.repeat(3_000_000) }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => hugePayload
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb-token')
    const result = await service(beef, [tx.id('hex')])
    expect(result.status).not.toBe('success')
    expect(result.txidResults[0].serviceError).toBe(true)
    expect(result.txidResults[0].doubleSpend).toBeUndefined()
  })

  // Deliberately does NOT rely on the body ever failing to resolve (that is
  // XR-063's job, already covered below) — this stream resolves fully and
  // quickly, just with far more bytes than any real WoC reply. Pre-fix,
  // nothing stops that from completing and being classified as an ordinary
  // response.ok success; only a byte cap catches it.
  it('WhatsOnChain: a streamed body is aborted the instant it crosses the byte cap, never buffered whole', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x7a) // 256 KiB of 'z' per pull
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(chunk)
        // Safety valve only, well above the ~4-chunk cap — the fix must stop
        // long before this; the unfixed code relies on it to finish at all.
        if (pulls > 100) controller.close()
      }
    })
    // A stand-in for what a real Response.text() does: drain the same
    // underlying stream and decode it. The unfixed code calls this directly
    // with no cap, so it happily returns the full ~25 MB body.
    const readStreamAsText = async (): Promise<string> => {
      const reader = stream.getReader()
      const parts: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          parts.push(value)
          total += value.byteLength
        }
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const part of parts) {
        merged.set(part, offset)
        offset += part.byteLength
      }
      return new TextDecoder().decode(merged)
    }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: readStreamAsText,
      body: stream
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService(NETWORKS.main.woc!)
    const result = await service(beef, [tx.id('hex')])
    expect(result.status).not.toBe('success')
    expect(result.txidResults[0].serviceError).toBe(true)
    // MAX_BROADCAST_BODY_BYTES is 1,000,000; four 256 KiB chunks already
    // crosses it, so a bounded read must stop within a handful of chunks
    // rather than draining all 100+.
    expect(pulls).toBeLessThan(10)
  })

  it('WhatsOnChain: a declared Content-Length over the cap is refused before reading anything', async () => {
    const read = jest.fn()
    const body = { getReader: () => ({ read, cancel: jest.fn() }) }
    // If this were ever reached, it would read as an ordinary small success
    // body — proving the rejection came from the declared length, not from
    // the content itself.
    const textSpy = jest.fn(async () => '')
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? '99999999' : null) },
      text: textSpy,
      body
    }) as unknown as typeof fetch
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    const { service } = createWocBroadcastService(NETWORKS.main.woc!)
    const result = await service(beef, [tx.id('hex')])
    expect(result.status).not.toBe('success')
    expect(result.txidResults[0].serviceError).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(textSpy).not.toHaveBeenCalled()
  })
})

/**
 * XR-063: a broadcast provider that returns headers within the deadline and
 * then stalls its body used to hold the whole `service()` promise open
 * forever — the AbortController's timer was cleared as soon as fetch()
 * resolved, before response.json()/text() ever ran. Since this provider sits
 * first in the UntilSuccess fallback chain, a stall here blocked every later
 * fallback (GorillaPool, WoC) from ever being tried.
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
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb-token')

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
    const { service } = createWocBroadcastService(NETWORKS.main.woc!)

    const pending = service(beef, [tx.id('hex')])
    await jest.advanceTimersByTimeAsync(30_000)
    const result = await pending

    expect(result.status).toBe('error')
    expect(result.txidResults[0].serviceError).toBe(true)
  })
})

/**
 * XQ-011: the broadcast host comes from the network's own WhatsOnChain entry
 * in NETWORKS, not from a chain string matched against a ternary, so there is
 * no unrecognized value left to fail safe on — and a network with no
 * WhatsOnChain has no entry to build the service from.
 */
describe('XQ-011: createWocBroadcastService posts to the network table host', () => {
  const txOf = () => {
    const tx = new Transaction()
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return { tx, beef }
  }

  const urlOf = async (chain: AppChain): Promise<string> => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ''
    }) as unknown as typeof fetch
    const { tx, beef } = txOf()
    const { service } = createWocBroadcastService(NETWORKS[chain].woc!)
    await service(beef, [tx.id('hex')])
    return (global.fetch as jest.Mock).mock.calls[0][0] as string
  }

  it('main -> the mainnet endpoint', async () => {
    expect(await urlOf('main')).toMatch(/^https:\/\/api\.whatsonchain\.com\/v1\/bsv\/main/)
  })

  it('test -> the testnet endpoint', async () => {
    expect(await urlOf('test')).toMatch(/^https:\/\/api\.whatsonchain\.com\/v1\/bsv\/test/)
  })

  it('teratest -> the teratest endpoint', async () => {
    expect(await urlOf('teratest')).toMatch(/^https:\/\/api\.woc-ttn\.bsvblockchain\.tech\/v1\/bsv\/test/)
  })

  it('scaletest has no WhatsOnChain to broadcast to', () => {
    expect(NETWORKS.scaletest.woc).toBeUndefined()
  })
})

function chainedParentChild() {
  const parent = new Transaction()
  parent.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1000 })
  const child = new Transaction()
  child.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript()
  })
  child.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 900 })
  const beef = new Beef()
  beef.mergeTransaction(child)
  return {
    parent,
    child,
    beef,
    parentId: parent.id('hex'),
    childId: child.id('hex')
  }
}

describe('multi-transaction BEEF', () => {
  it('posts every txid, parent first, with one result per txid', async () => {
    const { parent, child, beef, parentId, childId } = chainedParentChild()
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ txStatus: 'SEEN_ON_NETWORK' })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb-token')
    const result = await service(beef, [childId, parentId])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Array.from(fetchMock.mock.calls[0][1].body)).toEqual(Array.from(parent.toEF()))
    expect(Array.from(fetchMock.mock.calls[1][1].body)).toEqual(Array.from(child.toEF()))
    expect(result.status).toBe('success')
    expect(result.txidResults.map(r => r.txid)).toEqual([childId, parentId])
    expect(result.txidResults.every(r => r.status === 'success')).toBe(true)
  })

  it('does not post a child whose parent was rejected, and reports it as retryable', async () => {
    const { beef, parentId, childId } = chainedParentChild()
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ txid: parentId, txStatus: 'REJECTED' })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb-token')
    const result = await service(beef, [childId, parentId])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const childResult = result.txidResults.find(r => r.txid === childId)
    expect(childResult?.status).toBe('error')
    expect(childResult?.serviceError).toBe(true)
    expect(childResult?.doubleSpend).toBeUndefined()
  })

  it('WhatsOnChain posts both /tx/raw bodies, parent hex then child hex', async () => {
    const { parent, child, beef, parentId, childId } = chainedParentChild()
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ''
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createWocBroadcastService(NETWORKS.main.woc!)
    const result = await service(beef, [childId, parentId])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/tx\/raw$/)
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/tx\/raw$/)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ txhex: parent.toHex() })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ txhex: child.toHex() })
    expect(result.status).toBe('success')
    expect(result.txidResults.map(r => r.txid)).toEqual([childId, parentId])
  })

  function chain(n: number) {
    const txs: Transaction[] = []
    for (let i = 0; i < n; i++) {
      const tx = new Transaction()
      if (i > 0) {
        tx.addInput({
          sourceTransaction: txs[i - 1],
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript()
        })
      }
      tx.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1000 - i })
      txs.push(tx)
    }
    const beef = new Beef()
    beef.mergeTransaction(txs[n - 1])
    return { txs, beef, ids: txs.map(t => t.id('hex')) }
  }

  const okFetch = () =>
    jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ txStatus: 'SEEN_ON_NETWORK' }) })

  it('posts unconfirmed ancestors that are not requested', async () => {
    const { txs, beef, ids } = chain(3)
    const fetchMock = okFetch()
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb')
    const result = await service(beef, [ids[2]])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    txs.forEach((tx, i) => {
      expect(Array.from(fetchMock.mock.calls[i][1].body)).toEqual(Array.from(tx.toEF()))
    })
    expect(result.txidResults).toHaveLength(1)
    expect(result.txidResults[0]).toMatchObject({ txid: ids[2], status: 'success' })
  })

  it('skips a proven ancestor', async () => {
    const { txs, beef, ids } = chain(3)
    const mp = new MerklePath(1, [
      [
        { offset: 0, hash: ids[0], txid: true },
        { offset: 1, duplicate: true }
      ]
    ])
    beef.mergeBump(mp)
    const fetchMock = okFetch()
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb')
    await service(beef, [ids[2]])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Array.from(fetchMock.mock.calls[0][1].body)).toEqual(Array.from(txs[1].toEF()))
  })

  it('a proven requested txid is success and not posted', async () => {
    const { beef, ids } = chain(2)
    const mp = new MerklePath(1, [
      [
        { offset: 0, hash: ids[0], txid: true },
        { offset: 1, duplicate: true }
      ]
    ])
    beef.mergeBump(mp)
    const fetchMock = okFetch()
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb')
    const result = await service(beef, [ids[1], ids[0]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.txidResults).toEqual([
      expect.objectContaining({ txid: ids[1], status: 'success' }),
      { txid: ids[0], status: 'success' }
    ])
  })

  it("does not mutate the caller's beef", async () => {
    const { beef, ids } = chain(3)
    const before = beef.toHex()
    global.fetch = okFetch() as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb')
    await service(beef, [ids[2]])
    expect(beef.toHex()).toBe(before)
  })

  it('a txid-only grandparent gives retryable errors, never throws', async () => {
    const { beef, ids } = chain(3)
    beef.makeTxidOnly(ids[0])
    const fetchMock = okFetch()
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb')
    const result = await service(beef, [ids[1], ids[2]])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.status).toBe('error')
    for (const r of result.txidResults) {
      expect(r.status).toBe('error')
      expect(r.serviceError).toBe(true)
    }
  })

  it('stops at the budget', async () => {
    const { beef, ids } = chain(5)
    let now = 1_000_000
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    const fetchMock = jest.fn().mockImplementation(async () => {
      now += 10_000
      return { ok: true, status: 200, json: async () => ({ txStatus: 'SEEN_ON_NETWORK' }) }
    })
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb')
      const result = await service(beef, [ids[4], ids[3], ids[0]])
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3)
      const byId = new Map(result.txidResults.map(r => [r.txid, r]))
      expect(byId.get(ids[0])?.status).toBe('success')
      expect(byId.get(ids[3])).toMatchObject({ status: 'error', serviceError: true, data: 'broadcast budget exceeded' })
      expect(byId.get(ids[4])).toMatchObject({ status: 'error', serviceError: true, data: 'broadcast budget exceeded' })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('result txid is the requested txid', async () => {
    const { beef, ids } = chain(1)
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ txid: 'ff'.repeat(32), txStatus: 'SEEN_ON_NETWORK' })
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const { service } = createArcadeBroadcastService('https://broadcast.bsvblockchain.tech', 'cb')
    const result = await service(beef, [ids[0]])
    expect(result.txidResults[0].txid).toBe(ids[0])
  })
})
