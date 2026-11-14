/**
 * Production VaultChainLookup over WhatsOnChain (moved out of
 * chainRecovery.ts; chainRecovery.ts re-exports it).
 */
import { Utils } from '@bsv/sdk'
import { wocConfigFor, type WocConfig } from '../../pay/rails/address'
import type { AppChain } from '../../config'
import type { MarkerHistory, MarkerUnknownReason, VaultChainLookup } from './markerLookup'

/** Rows per confirmed-history page. */
export const VAULT_HISTORY_PAGE = 1000
/** Row cap of the plain /history endpoint. A confirmed page of exactly this
 * length with no token is read as cut off (fail closed), because the live
 * limit and token field names were not verifiable offline. */
export const VAULT_HISTORY_LEGACY_CAP = 100
/** Pages read before the window counts as full (5,000 confirmed rows). */
export const VAULT_HISTORY_MAX_PAGES = 5

/** Merge two HeadersInit values (plain object, Headers instance or array of
 * pairs) into a plain object. Later names win on a clash. */
function mergeHeaders(base?: HeadersInit, over?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of [base, over]) {
    if (!part) continue
    new Headers(part).forEach((value, name) => {
      out[name] = value
    })
  }
  return out
}

/**
 * Production VaultChainLookup over WhatsOnChain, following the exact request
 * patterns already used by core/pay/rails/address.ts (getUtxosForAddress,
 * the `/tx/{txid}/beef` fetch, parseWocBeefBody's response-shape checks).
 *
 * Response shapes checked against live mainnet WhatsOnChain on 2026-09-27:
 * `/address/{address}/history` answers `[{tx_hash, height}]`, or 404 "Not
 * Found" for an address with no history; `/tx/{txid}/out/{index}` answers
 * 502 for every output, so spent status comes from `POST /utxos/spent`,
 * which returns one row per outpoint (see outputStatus).
 */
export function wocChainLookup(chain: AppChain, requestInit?: RequestInit): VaultChainLookup {
  const woc: WocConfig | undefined = wocConfigFor(chain)
  // Vault is mainnet-only, so this only fires on a misrouted call. Refuse it
  // rather than answer "no marker": an empty answer is a genuine miss here.
  if (!woc) throw new Error(`Vault chain recovery needs WhatsOnChain, which ${chain} does not have`)
  const base = `${woc.apiBase}/v1/bsv/${woc.segment}`

  // `requestInit` (for example the app's WhatsOnChain key header) is merged
  // into every request. Headers given per call win on a name clash.
  const doFetch = (url: string, init?: RequestInit): Promise<Response> => {
    if (!requestInit) return init ? fetch(url, init) : fetch(url)
    return fetch(url, {
      ...requestInit,
      ...init,
      headers: mergeHeaders(requestInit.headers, init?.headers)
    })
  }

  /** One page of rows from a history endpoint. `rows: undefined` with a
   * `reason` is a failure; a 404 is a page with no rows. */
  type Page = { rows: string[]; fullPage: boolean; token?: string } | { failed: MarkerUnknownReason }
  const readPage = async (url: string, pageSize: number, suspectCaps: number[] = []): Promise<Page> => {
    let response: Response
    try {
      response = await doFetch(url)
    } catch {
      return { failed: 'request-failed' }
    }
    if (response.status === 404) return { rows: [], fullPage: false }
    if (response.status === 429) return { failed: 'rate-limited' }
    if (!response.ok) return { failed: 'request-failed' }
    let body: any
    try {
      body = await response.json()
    } catch {
      return { failed: 'malformed' }
    }
    // The plain /history endpoint answers a bare array; the paged endpoints
    // answer {result: [...]}.
    const list: unknown = Array.isArray(body)
      ? body
      : body !== null && typeof body === 'object'
        ? body.result
        : undefined
    if (!Array.isArray(list)) return { failed: 'malformed' }
    const rows: string[] = list.map((r: any) => r?.tx_hash).filter((h: unknown) => typeof h === 'string')
    const token = Array.isArray(body) ? undefined : pageTokenFrom(body)
    return {
      rows,
      // A page as long as the request, or exactly as long as a server-side cap
      // we know of (the plain /history cap of 100), with no token after it is
      // treated as cut off, never as complete.
      fullPage: list.length >= pageSize || suspectCaps.includes(list.length),
      token
    }
  }

  return {
    async transactionsForLockingScript(lockingScriptHex: string): Promise<string[]> {
      // The marker is always a P2PKH output; derive its address from the
      // script's hash160 rather than adding a second WoC endpoint shape.
      //
      // The VaultChainLookup contract (see this file's interface doc) treats
      // an EMPTY result as a genuine "no marker at this index" miss — so a
      // failure to even ask the question (an unrecognizable script), a
      // non-2xx response (rate limiting, a transient 5xx, a maintenance
      // window) or a thrown exception (DNS failure, timeout, offline) must
      // never collapse into that same empty array: recoverVaultFromChain's
      // OWN catch around this call (never a miss, and now bounded — see
      // VAULT_RECOVERY_MAX_CONSECUTIVE_PROBLEMS) is what has to handle these,
      // not the miss-counting branch.
      const address = p2pkhAddressFromScript(lockingScriptHex, woc.network)
      if (!address) {
        throw new Error('wocChainLookup: marker script is not a recognizable P2PKH script')
      }
      const response = await doFetch(`${base}/address/${address}/history`)
      // WhatsOnChain's answer for an address that has never been used: a
      // genuine miss, not a failure.
      if (response.status === 404) return []
      if (!response.ok) {
        throw new Error(`wocChainLookup: address history request failed (HTTP ${response.status})`)
      }
      const body = await response.json()
      const rows = Array.isArray(body) ? body : Array.isArray(body?.result) ? body.result : []
      const txids = rows.map((r: any) => r?.tx_hash).filter((h: unknown) => typeof h === 'string')
      return [...new Set<string>(txids)]
    },

    markerAddress(lockingScriptHex: string): string | undefined {
      return p2pkhAddressFromScript(lockingScriptHex, woc.network)
    },

    async markerHistory(lockingScriptHex: string): Promise<MarkerHistory> {
      const address = p2pkhAddressFromScript(lockingScriptHex, woc.network)
      if (!address) return { status: 'unknown', reason: 'malformed', txids: [] }

      const seen = new Set<string>()
      let problem: MarkerUnknownReason | undefined
      const note = (reason: MarkerUnknownReason) => {
        problem ??= reason
      }

      // Confirmed rows, oldest first, paged by token.
      let token: string | undefined
      for (let page = 1; page <= VAULT_HISTORY_MAX_PAGES; page++) {
        const url =
          `${base}/address/${address}/confirmed/history?order=asc&limit=${VAULT_HISTORY_PAGE}` +
          (token === undefined ? '' : `&token=${encodeURIComponent(token)}`)
        const result = await readPage(url, VAULT_HISTORY_PAGE, [VAULT_HISTORY_LEGACY_CAP])
        if ('failed' in result) {
          note(result.failed)
          break
        }
        for (const txid of result.rows) seen.add(txid)
        if (result.token === undefined) {
          // A full page with nothing after it: the window is cut off.
          if (result.fullPage) note('window-full')
          break
        }
        if (page === VAULT_HISTORY_MAX_PAGES) {
          note('window-full')
          break
        }
        token = result.token
      }

      // Unconfirmed rows. Skipped after a failure that a second request would
      // only make worse; still read when the confirmed window was just full.
      if (problem === undefined || problem === 'window-full') {
        const result = await readPage(`${base}/address/${address}/unconfirmed/history`, Number.POSITIVE_INFINITY)
        if ('failed' in result) note(result.failed)
        else for (const txid of result.rows) seen.add(txid)
      }

      // Legacy plain /history (newest first, capped at 100 rows): the endpoint
      // the base code used, verified live on 2026-09-27. Its rows are unioned
      // in so base behaviour is the floor if the paged endpoints differ from
      // their documentation (a 404 there must not read as "no history"). Its
      // cap is not a window problem: only a failure counts.
      if (problem === undefined || problem === 'window-full') {
        const result = await readPage(`${base}/address/${address}/history`, Number.POSITIVE_INFINITY)
        if ('failed' in result) note(result.failed)
        else for (const txid of result.rows) seen.add(txid)
      }

      const txids = [...seen]
      if (problem !== undefined) return { status: 'unknown', reason: problem, txids }
      return txids.length > 0 ? { status: 'found', txids } : { status: 'none' }
    },

    async transactionForTxid(txid: string): Promise<{ beef: number[]; confirmed: boolean } | null> {
      try {
        const [beefResp, txResp] = await Promise.all([
          doFetch(`${base}/tx/${txid}/beef`),
          doFetch(`${base}/tx/hash/${txid}`)
        ])
        const beef = parseWocBeefBodyText(beefResp.ok, await beefResp.text())
        if (!beef) return null
        let confirmed = false
        if (txResp.ok) {
          const info = await txResp.json()
          confirmed = Number.isInteger(info?.confirmations) && info.confirmations > 0
        }
        return { beef, confirmed }
      } catch {
        return null
      }
    },

    async outputStatus(outpoint: { txid: string; vout: number }): Promise<'unspent' | 'spent' | 'unknown'> {
      // Fail-safe default is 'unknown' (never trusted as unspent — see this
      // file's VaultChainLookup interface doc). The row must be about this
      // exact outpoint. Unspent is a clean row with no `spentIn`; spent is a
      // `spentIn` naming another transaction; an unknown output comes back as
      // `spentIn.status: "Unknown UTXO"` echoing its own txid, which is
      // neither.
      try {
        const response = await doFetch(`${base}/utxos/spent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ utxos: [{ txid: outpoint.txid, vout: outpoint.vout }] })
        })
        if (!response.ok) return 'unknown'
        const body = await response.json()
        const row = Array.isArray(body) && body.length === 1 ? body[0] : undefined
        if (row === null || typeof row !== 'object') return 'unknown'
        if (row.utxo?.txid !== outpoint.txid || row.utxo?.vout !== outpoint.vout) return 'unknown'
        if (row.error !== '') return 'unknown'
        const spentIn = row.spentIn
        if (spentIn === undefined) return 'unspent'
        if (
          spentIn !== null &&
          typeof spentIn === 'object' &&
          typeof spentIn.txid === 'string' &&
          /^[0-9a-fA-F]{64}$/.test(spentIn.txid) &&
          spentIn.txid.toLowerCase() !== outpoint.txid.toLowerCase() &&
          spentIn.status !== 'Unknown UTXO'
        ) {
          return 'spent'
        }
        return 'unknown'
      } catch {
        return 'unknown'
      }
    }
  }
}

/**
 * Next-page token of a history response. The documented field name is not
 * confirmed against the live API, so the known names come first and any other
 * top-level string field that looks like a page token is accepted too. A
 * missed token would read a truncated page as complete, which is the unsafe
 * direction.
 */
export function pageTokenFrom(body: Record<string, unknown>): string | undefined {
  const known = body.nextPageToken ?? body['next-page']
  if (typeof known === 'string' && known.length > 0) return known
  for (const [key, value] of Object.entries(body)) {
    if (key === 'address' || key === 'script' || key === 'error' || key === 'result') continue
    if (typeof value === 'string' && value.length > 0 && /token|next|cursor|page/i.test(key)) return value
  }
  return undefined
}

/** Local copy of address.ts's parseWocBeefBody signature over (ok, text)
 * rather than a Response, so this module does not need to import it just to
 * reshape the call. */
function parseWocBeefBodyText(ok: boolean, text: string): number[] | undefined {
  if (!ok) return undefined
  const hex = text.trim()
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined
  try {
    return Utils.toArray(hex, 'hex') as number[]
  } catch {
    return undefined
  }
}

/** hash160 out of a standard P2PKH script, re-encoded as a base58check
 * address for the WoC address-history endpoint, via @bsv/sdk's own public
 * `Utils.toBase58Check` (already imported for toHex/toArray above) — the
 * same primitive `PublicKey.prototype.toAddress()` uses internally elsewhere
 * in this codebase (core/pay/rails/address.ts). Returns undefined for
 * anything else (defensive — deriveVaultMarkerScript always builds P2PKH). */
export function p2pkhAddressFromScript(lockingScriptHex: string, network: 'mainnet' | 'testnet'): string | undefined {
  let bytes: number[]
  try {
    bytes = Utils.toArray(lockingScriptHex, 'hex') as number[]
  } catch {
    return undefined
  }
  if (
    bytes.length !== 25 ||
    bytes[0] !== 0x76 ||
    bytes[1] !== 0xa9 ||
    bytes[2] !== 0x14 ||
    bytes[23] !== 0x88 ||
    bytes[24] !== 0xac
  ) {
    return undefined
  }
  const hash160 = bytes.slice(3, 23)
  return Utils.toBase58Check(hash160, [network === 'mainnet' ? 0x00 : 0x6f])
}
