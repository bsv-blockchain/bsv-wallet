import { Beef, Transaction } from '@bsv/sdk'
import type { NetworkProfile, WocEndpoints } from '../networks'
import type { PostBeefResult, PostTxResultForTxid } from '../toolboxTypes'

const BROADCAST_TIMEOUT_MS = 30_000

/**
 * XR-060 remainder: XR-063's body deadline below bounds how long a stalled
 * body can hang, but not how LARGE a body that does arrive can be — a
 * compromised/misbehaving broadcast endpoint could still force an unbounded
 * JSON parse or string allocation over a multi-megabyte response before
 * classification (and the already-capped log line) ever run. Comfortably
 * over anything a real ARC/WoC reply ever carries.
 */
const MAX_BROADCAST_BODY_BYTES = 1_000_000

/**
 * Reads a body no bigger than `maxBytes`. Mirrors
 * core/identity/handleRegistry/resolver.ts's readBoundedJson (XR-077 /
 * SEC2-027): a declared Content-Length over the cap is refused before
 * anything is read; otherwise, when the runtime exposes the body as a
 * stream, chunks are counted as they arrive and the read is aborted the
 * instant the running total crosses the cap, so an untrusted endpoint cannot
 * make this buffer more than the cap regardless of what it claims or how it
 * paces the bytes. Returns undefined when neither check applies (no
 * Content-Length header and no stream to count from), leaving the caller to
 * fall back to the runtime's own read and check its decoded size instead —
 * a floor, not a firewall, for a runtime (or test double) with no stream.
 */
async function readBoundedBytes(res: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = res.headers?.get?.('content-length')
  if (declared) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`broadcast response declared ${n} bytes, over the ${maxBytes} byte limit`)
    }
  }
  const reader = (res as { body?: ReadableStream<Uint8Array> | null }).body?.getReader?.()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`broadcast response exceeded the ${maxBytes} byte limit while streaming`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

async function readBoundedText(res: Response, fallback: () => Promise<string>, maxBytes: number): Promise<string> {
  const bytes = await readBoundedBytes(res, maxBytes)
  if (bytes !== undefined) return new TextDecoder().decode(bytes)
  const text = await fallback()
  if (text.length > maxBytes) {
    throw new Error(`broadcast response exceeded the ${maxBytes} byte limit`)
  }
  return text
}

async function readBoundedJson(res: Response, fallback: () => Promise<unknown>, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(res, maxBytes)
  if (bytes !== undefined) return JSON.parse(new TextDecoder().decode(bytes))
  const data = await fallback()
  if (JSON.stringify(data).length > maxBytes) {
    throw new Error(`broadcast response exceeded the ${maxBytes} byte limit`)
  }
  return data
}

/**
 * XR-063: a broadcast provider that delivers headers within the deadline and
 * then stalls (or drips) its body used to hold this promise open forever —
 * the AbortController's timer was cleared as soon as fetch() resolved,
 * before response.json()/text() ever ran, and since this provider sits first
 * in the UntilSuccess fallback chain, a stall here blocked every later
 * fallback from ever being tried. Mirrors
 * core/identity/handleRegistry/resolver.ts's fetchWithTimeout: the same
 * overall deadline that bounds the connection also bounds the body read, by
 * racing it against a timer that aborts the underlying request too. Combined
 * with readBoundedJson/readBoundedText above, the body read is now bounded
 * in both time (this deadline) and size (XR-060 remainder).
 */
async function fetchWithBodyDeadline(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const startedAt = Date.now()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  const withBodyDeadline = <T>(read: () => Promise<T>) => {
    return (): Promise<T> => {
      let bodyTimer: ReturnType<typeof setTimeout> | undefined
      return new Promise<T>((resolve, reject) => {
        bodyTimer = setTimeout(
          () => {
            controller.abort()
            reject(new Error(`body did not complete within ${timeoutMs}ms`))
          },
          Math.max(0, timeoutMs - (Date.now() - startedAt))
        )
        void read().then(resolve, reject)
      }).finally(() => {
        if (bodyTimer !== undefined) clearTimeout(bodyTimer)
      })
    }
  }
  if (typeof response.json === 'function') {
    const originalJson = response.json.bind(response)
    response.json = withBodyDeadline(() => readBoundedJson(response, originalJson, MAX_BROADCAST_BODY_BYTES))
  }
  if (typeof response.text === 'function') {
    const originalText = response.text.bind(response)
    response.text = withBodyDeadline(() => readBoundedText(response, originalText, MAX_BROADCAST_BODY_BYTES))
  }
  return response
}

/**
 * ARC intermediate statuses that still mean "accepted for relay".
 * Arcade often replies immediately with RECEIVED (HTTP 202); SEEN_* / MINED
 * typically arrive later via SSE. The toolbox's built-in ARC provider treats any
 * non-double-spend 2xx as success — match that so we do not fail over to WoC
 * after Arcade already accepted the tx.
 */
const ARC_DOUBLE_SPEND_STATUSES = new Set(['DOUBLE_SPEND_ATTEMPTED'])

/** WhatsOnChain bodies meaning this exact txid is already known or mined. */
const WOC_ALREADY_HAVE_TX = /already[ -](known|in[ -]the[ -]mempool|in[ -](the[ -])?block[ -]?chain)/i

/**
 * XR-062: SEEN_IN_ORPHAN_MEMPOOL means the parent hasn't propagated yet — a
 * transport/timing condition, not a proven conflict. offline/plan.ts's
 * applyOutcome routes any `doubleSpend` outcome into a terminal, irreversible
 * rejection cascade (the tx and every descendant, with reservations
 * released), so lumping this in with a real double spend permanently kills a
 * valid chained/offline payment purely from ordinary propagation timing.
 * Treat it as retryable instead, like any other service hiccup.
 */
const ARC_RETRYABLE_STATUSES = new Set(['SEEN_IN_ORPHAN_MEMPOOL'])

/**
 * ARC codes (the `status` number in a BSV Broadcaster 400 body) that are a
 * validator verdict about the transaction bytes: 461 (invalid unlocking
 * scripts / malformed) and 464 (invalid outputs). The list is deliberately
 * short. A false terminal verdict is the XR-062 cascade: offline/plan.ts
 * applyOutcome releases reservations and kills every descendant of a
 * terminally rejected transaction. Codes such as 460 (not EF), 462 (inputs,
 * can be propagation lag), 465 (fee policy differs per instance), 466
 * (conflict; double spends come only from DOUBLE_SPEND_ATTEMPTED) and 476
 * (locktime not final yet) stay retryable.
 */
export const ARC_INVALID_CODES = new Set([461, 464])

/**
 * XR-064: explicit ARC statuses that mean "accepted for relay". A custom
 * (person-configured) ARC endpoint's success predicate used to be
 * `response.ok && data.txStatus !== 'REJECTED'` — no txid match, no
 * requirement that txStatus be one of these. An on-path attacker on a
 * person-chosen plaintext endpoint (or a misbehaving deployment) could
 * therefore return a bare `200 {}` and have it accepted as delivery,
 * suppressing the real broadcast/fallback chain for that attempt.
 */
const ARC_ACCEPTED_STATUSES = new Set([
  'RECEIVED',
  'STORED',
  'SENT_TO_NETWORK',
  'ACCEPTED_BY_NETWORK',
  'SEEN_ON_NETWORK',
  'SEEN_MULTIPLE_NODES',
  'MINED',
  'IMMUTABLE'
])

/**
 * XR-060: a compromised/misbehaving broadcast endpoint can answer with a
 * response body far larger than any real ARC/WoC reply. Classification below
 * still runs over the full body — this only bounds what a diagnostic log line
 * repeats into memory/log storage.
 */
const MAX_LOGGED_BODY_CHARS = 2000

function loggableSnippet(text: string): string {
  return text.length > MAX_LOGGED_BODY_CHARS
    ? `${text.slice(0, MAX_LOGGED_BODY_CHARS)}… [${text.length} chars total]`
    : text
}

/**
 * Shared response handling for ARC-compatible services (Arcade, GorillaPool).
 * Maps txStatus to the correct PostTxResultForTxid fields.
 *
 * Exported for unit tests.
 */
export function handleArcResponse(
  serviceName: string,
  response: { ok: boolean; status: number },
  data: { txid?: string; txStatus?: string; status?: number | string },
  txids: string[]
): PostTxResultForTxid {
  const txResult: PostTxResultForTxid = {
    txid: data.txid || txids[0],
    status: 'error',
    notes: [
      {
        when: new Date().toISOString(),
        what: `${serviceName}PostEF`,
        txStatus: data.txStatus,
        httpStatus: response.status
      }
    ]
  }
  const hasAcceptedStatus = data.txStatus !== undefined && ARC_ACCEPTED_STATUSES.has(data.txStatus)
  const hasMatchingTxid = data.txid !== undefined && data.txid === txids[0]
  if (data.txStatus && ARC_DOUBLE_SPEND_STATUSES.has(data.txStatus)) {
    txResult.doubleSpend = true
  } else if (data.txStatus && ARC_RETRYABLE_STATUSES.has(data.txStatus)) {
    txResult.serviceError = true
  } else if (response.ok && data.txStatus !== 'REJECTED' && (hasAcceptedStatus || hasMatchingTxid)) {
    // RECEIVED / STORED / SENT_TO_NETWORK / ACCEPTED_BY_NETWORK / SEEN_* / MINED
    // all mean the broadcaster accepted the tx. Page-load 402 must not wait for
    // SSE SEEN_ON_NETWORK before treating the post as successful. An
    // unrecognized-but-matching-txid response is also accepted (forward
    // compatibility with a status this list doesn't know yet) — but a bare
    // or unrelated response is not (XR-064).
    txResult.status = 'success'
  } else if (response.status === 400 && data.txid === txids[0] && ARC_INVALID_CODES.has(Number(data.status))) {
    // Final rejection: leave status 'error' with no serviceError, no doubleSpend.
  } else {
    txResult.serviceError = true
  }
  return txResult
}

/** Longest a provider may spend on one BEEF, walk included. */
export const BROADCAST_PROVIDER_BUDGET_MS = 30_000

/**
 * What to post, and in what order. `order` holds every txid in the BEEF that
 * has a raw transaction and no merkle path (parents first), then any requested
 * txid the BEEF does not hold. `proven` holds the requested txids whose BEEF
 * entry already has a merkle path. Works on a copy, so the caller's `beef`
 * keeps its order.
 */
function postingPlan(beef: Beef, txids: string[]): { order: string[]; proven: Set<string> } {
  const sorted = Beef.fromBinary(beef.toBinary())
  sorted.sortTxs()
  const wanted = new Set(txids)
  const order: string[] = []
  const proven = new Set<string>()
  for (const btx of sorted.txs) {
    if (btx.hasProof) {
      if (wanted.has(btx.txid)) proven.add(btx.txid)
    } else if (!btx.isTxidOnly) {
      order.push(btx.txid)
    }
  }
  const known = new Set(order)
  for (const txid of txids) if (!proven.has(txid) && !known.has(txid)) order.push(txid)
  return { order, proven }
}

/**
 * Post every unconfirmed transaction of the BEEF, parents first, and return one
 * result per requested txid. A transaction whose parent was not accepted is not
 * posted. The walk stops once `budgetMs` has passed.
 */
async function postEachTransaction(
  name: string,
  beef: Beef,
  txids: string[],
  postOne: (tx: Transaction, txid: string) => Promise<PostTxResultForTxid>,
  budgetMs: number = BROADCAST_PROVIDER_BUDGET_MS
): Promise<PostBeefResult> {
  const retryable = (txid: string, data: string): PostTxResultForTxid => ({
    txid,
    status: 'error',
    serviceError: true,
    data
  })
  const work = Beef.fromBinary(beef.toBinary())
  const { order, proven } = postingPlan(work, txids)
  const results = new Map<string, PostTxResultForTxid>()
  const notAccepted = new Set<string>()
  const start = Date.now()
  for (const txid of order) {
    if (Date.now() - start >= budgetMs) break
    let result: PostTxResultForTxid
    try {
      const tx = work.findAtomicTransaction(txid)
      if (tx == null) {
        result = retryable(txid, `transaction ${txid} not found in beef`)
      } else {
        const blockedBy = tx.inputs
          .map(input => input.sourceTXID ?? input.sourceTransaction?.id('hex'))
          .find(parent => parent != null && notAccepted.has(parent))
        if (blockedBy != null) {
          const parent = results.get(blockedBy)
          const why = parent?.data ?? parent?.notes?.find(note => note.txStatus != null)?.txStatus
          result = retryable(txid, `parent ${blockedBy} not accepted${why != null ? `: ${String(why)}` : ''}`)
        } else {
          result = await postOne(tx, txid)
        }
      }
    } catch (err: any) {
      result = retryable(txid, `cannot post ${txid}: ${err?.message ?? String(err)}`)
    }
    if (result.status !== 'success') notAccepted.add(txid)
    results.set(txid, result)
  }
  const txidResults = txids.map((txid): PostTxResultForTxid => {
    if (proven.has(txid)) return { txid, status: 'success' }
    const result = results.get(txid)
    return result != null ? { ...result, txid } : retryable(txid, 'broadcast budget exceeded')
  })
  return {
    name,
    status: txidResults.every(result => result.status === 'success') ? 'success' : 'error',
    txidResults
  }
}

/** Drop trailing slashes so a user-entered URL joins cleanly with a path. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Create a BSV Broadcaster (Arcade) compatible service that posts EF-format
 * transactions to `${url}/tx`. Arcade and GorillaPool's Arcade both serve
 * POST /tx and take EF as application/octet-stream.
 */
function createArcBroadcastService(name: string, arcUrl: string, headers: Record<string, string>) {
  const txPath = '/tx'
  const endpoint = `${normalizeUrl(arcUrl)}${txPath}`
  return {
    name,
    service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> =>
      await postEachTransaction(name, beef, txids, async (tx, txid) => {
        try {
          const response = await fetchWithBodyDeadline(
            endpoint,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream', ...headers },
              body: new Uint8Array(tx.toEF()) as unknown as BodyInit
            },
            BROADCAST_TIMEOUT_MS
          )
          const data = await response.json()
          console.log(`[${name}] POST ${txPath} ${response.status}`, loggableSnippet(JSON.stringify(data)))
          return handleArcResponse(name, response, data, [txid])
        } catch (err: any) {
          console.log(`[${name}] POST ${txPath} error: ${err.message}`)
          return { txid, status: 'error', serviceError: true, data: err.message }
        }
      })
  }
}

/**
 * BSV Broadcaster (Arcade) service — EF format with callback token for SSE updates.
 */
export function createArcadeBroadcastService(arcadeUrl: string, callbackToken: string) {
  return createArcBroadcastService('Arcade', arcadeUrl, {
    'X-CallbackToken': callbackToken,
    'X-FullStatusUpdates': 'true'
  })
}

/**
 * GorillaPool broadcast service — EF format, posts to `${url}/tx`.
 */
export function createGorillaPoolBroadcastService(arcUrl: string) {
  return createArcBroadcastService('GorillaPoolArc', arcUrl, {})
}

type BroadcastProvider = { name: string; service: (beef: Beef, txids: string[]) => Promise<PostBeefResult> }

/**
 * Replace the toolbox's default broadcast providers with ours, in order:
 * BSV Broadcaster (primary) -> GorillaPool -> WhatsOnChain -> Bitails. Each
 * fallback is registered only where `network` says it serves the network, and
 * GorillaPool is skipped when the person's primary URL already is GorillaPool.
 * Returns the registered provider names, in order.
 */
export function registerBroadcastProviders(
  services: { postBeefServices: { add(s: BroadcastProvider): void; remove(name: string): void } },
  network: NetworkProfile,
  primaryUrl: string,
  callbackToken: string,
  whatsOnChainApiKey: string | undefined,
  bitails: { postBeef: (beef: Beef, txids: string[]) => Promise<PostBeefResult> } | undefined
): string[] {
  const { postBeefServices } = services
  for (const name of ['ArcadeBeef', 'GorillaPoolArcBeef', 'TaalArcBeef', 'Bitails', 'WhatsOnChain']) {
    postBeefServices.remove(name)
  }
  const registered: string[] = []
  const add = (provider: BroadcastProvider) => {
    postBeefServices.add(provider)
    registered.push(provider.name)
  }
  add(createArcadeBroadcastService(primaryUrl, callbackToken))
  if (network.gorillaPoolArcUrl && normalizeUrl(network.gorillaPoolArcUrl) !== normalizeUrl(primaryUrl)) {
    add(createGorillaPoolBroadcastService(network.gorillaPoolArcUrl))
  }
  if (network.woc) add(createWocBroadcastService(network.woc, whatsOnChainApiKey))
  if (bitails && network.bitails) add({ name: 'Bitails', service: bitails.postBeef.bind(bitails) })
  return registered
}

/**
 * WhatsOnChain broadcast service — raw tx hex.
 */
export function createWocBroadcastService(woc: WocEndpoints, apiKey?: string) {
  // XQ-011: this used to take the raw chain string and pick a host with a
  // ternary, so a corrupted value needed a fail-safe branch. It now takes the
  // network's own WhatsOnChain entry from NETWORKS: a network with no
  // WhatsOnChain has no entry, and the caller does not register this service.
  const baseUrl = `${woc.apiBase}/v1/bsv/${woc.segment}`
  const name = 'WhatsOnChain'

  return {
    name,
    service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> =>
      await postEachTransaction(name, beef, txids, async (tx, txid) => {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'text/plain'
          }
          if (apiKey) headers['woc-api-key'] = apiKey
          const response = await fetchWithBodyDeadline(
            `${baseUrl}/tx/raw`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ txhex: tx.toHex() })
            },
            BROADCAST_TIMEOUT_MS
          )
          const body = await response.text()
          console.log(`[${name}] POST /tx/raw ${response.status}`, loggableSnippet(body))
          const txResult: PostTxResultForTxid = {
            txid,
            status: 'error',
            notes: [{ when: new Date().toISOString(), what: 'wocPostRawTx', httpStatus: response.status }]
          }
          if (response.ok) {
            txResult.status = 'success'
          } else if (WOC_ALREADY_HAVE_TX.test(body)) {
            // Idempotent same-txid rebroadcast (already in the mempool, already
            // known, or already mined — an unconfirmed ancestor may have been
            // mined before its proof was fetched). A conflicting DIFFERENT tx
            // cannot produce these messages, so they can't mask a double-spend.
            txResult.status = 'success'
          } else {
            // Never classify from WoC body strings. "Missing inputs" is ambiguous
            // (propagation lag vs mined double-spend) and a wrong terminal verdict
            // cascades to reject descendants. Terminal verdicts come from Arcade's
            // structured txStatus only (handleArcResponse); everything here is
            // retryable, and the release engine's topological order — foreign
            // ancestors included — is what prevents the orphan case at the source.
            txResult.serviceError = true
          }
          return txResult
        } catch (err: any) {
          console.log(`[${name}] POST /tx/raw error: ${err.message}`)
          return {
            txid,
            status: 'error',
            serviceError: true,
            data: err.message
          }
        }
      })
  }
}
