import { Beef, Transaction, Utils } from '@bsv/sdk'
import type { PostBeefResult, PostTxResultForTxid } from '../toolboxTypes'

const BROADCAST_TIMEOUT_MS = 30_000

/**
 * XR-063: a broadcast provider that delivers headers within the deadline and
 * then stalls (or drips) its body used to hold this promise open forever —
 * the AbortController's timer was cleared as soon as fetch() resolved,
 * before response.json()/text() ever ran, and since this provider sits first
 * in the UntilSuccess fallback chain, a stall here blocked every later
 * fallback from ever being tried. Mirrors
 * core/identity/handleRegistry/resolver.ts's fetchWithTimeout: the same
 * overall deadline that bounds the connection also bounds the body read, by
 * racing it against a timer that aborts the underlying request too.
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
  if (typeof response.json === 'function') response.json = withBodyDeadline(response.json.bind(response))
  if (typeof response.text === 'function') response.text = withBodyDeadline(response.text.bind(response))
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
 * Shared response handling for ARC-compatible services (Arcade, Taal, GorillaPool).
 * Maps txStatus to the correct PostTxResultForTxid fields.
 *
 * Exported for unit tests.
 */
export function handleArcResponse(
  serviceName: string,
  response: { ok: boolean; status: number },
  data: { txid?: string; txStatus?: string },
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
  } else {
    txResult.serviceError = true
  }
  return txResult
}

/**
 * Convert BEEF to EF-format binary for ARC-compatible endpoints.
 */
function beefToEF(beef: Beef): Uint8Array {
  const tx = Transaction.fromBEEF(beef.toBinary())
  return new Uint8Array(tx.toEF())
}

/**
 * Create an ARC-compatible broadcast service that posts EF-format transactions.
 *
 * `txPath` is where the deployment serves its submit route. Arcade serves
 * POST /tx at the root; standard ARC (TAAL, GorillaPool) serves POST /v1/tx and
 * answers POST /tx with 404. Both take EF as application/octet-stream.
 */
function createArcBroadcastService(
  name: string,
  arcUrl: string,
  txPath: '/tx' | '/v1/tx',
  headers: Record<string, string>
) {
  return {
    name,
    service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> => {
      const r: PostBeefResult = { name, status: 'success', txidResults: [] }
      try {
        const ef = beefToEF(beef)
        const response = await fetchWithBodyDeadline(
          `${arcUrl}${txPath}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              ...headers
            },
            body: ef as unknown as BodyInit
          },
          BROADCAST_TIMEOUT_MS
        )
        const data = await response.json()
        console.log(`[${name}] POST ${txPath} ${response.status}`, loggableSnippet(JSON.stringify(data)))
        const txResult = handleArcResponse(name, response, data, txids)
        r.txidResults.push(txResult)
        r.status = txResult.status
      } catch (err: any) {
        console.log(`[${name}] POST ${txPath} error: ${err.message}`)
        r.status = 'error'
        r.txidResults.push({
          txid: txids[0],
          status: 'error',
          serviceError: true,
          data: err.message
        })
      }
      return r
    }
  }
}

/**
 * Arcade broadcast service — EF format with callback token for SSE updates.
 */
export function createArcadeBroadcastService(arcadeUrl: string, callbackToken: string) {
  return createArcBroadcastService('Arcade', arcadeUrl, '/tx', {
    'X-CallbackToken': callbackToken,
    'X-FullStatusUpdates': 'true'
  })
}

/**
 * Taal ARC broadcast service — EF format.
 */
export function createTaalBroadcastService(arcUrl: string, apiKey?: string) {
  const headers: Record<string, string> = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return createArcBroadcastService('TaalArc', arcUrl, '/v1/tx', headers)
}

/**
 * GorillaPool ARC broadcast service — EF format.
 */
export function createGorillaPoolBroadcastService(arcUrl: string) {
  return createArcBroadcastService('GorillaPoolArc', arcUrl, '/v1/tx', {})
}

/**
 * WhatsOnChain broadcast service — raw tx hex.
 */
export function createWocBroadcastService(chain: string, apiKey?: string) {
  const baseUrl =
    chain === 'main'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : chain === 'test'
        ? 'https://api.whatsonchain.com/v1/bsv/test'
        : chain === 'ttn'
          ? 'https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test'
          : 'https://api.whatsonchain.com/v1/bsv/main'
  const name = 'WhatsOnChain'

  return {
    name,
    service: async (beef: Beef, txids: string[]): Promise<PostBeefResult> => {
      const r: PostBeefResult = { name, status: 'success', txidResults: [] }
      try {
        const tx = Transaction.fromBEEF(beef.toBinary())
        const rawHex = Utils.toHex(tx.toBinary())
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
            body: JSON.stringify({ txhex: rawHex })
          },
          BROADCAST_TIMEOUT_MS
        )
        const body = await response.text()
        console.log(`[${name}] POST /tx/raw ${response.status}`, loggableSnippet(body))
        const txResult: PostTxResultForTxid = {
          txid: txids[0],
          status: 'error',
          notes: [{ when: new Date().toISOString(), what: 'wocPostRawTx', httpStatus: response.status }]
        }
        if (response.ok) {
          txResult.status = 'success'
        } else if (body.includes('already in the mempool')) {
          // Idempotent same-txid rebroadcast — a conflicting DIFFERENT tx cannot
          // produce this message, so it can't mask a double-spend.
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
        r.txidResults.push(txResult)
        r.status = txResult.status
      } catch (err: any) {
        console.log(`[${name}] POST /tx/raw error: ${err.message}`)
        r.status = 'error'
        r.txidResults.push({
          txid: txids[0],
          status: 'error',
          serviceError: true,
          data: err.message
        })
      }
      return r
    }
  }
}
