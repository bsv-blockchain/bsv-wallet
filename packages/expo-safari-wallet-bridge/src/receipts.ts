/**
 * Receipts (spec 6.7, 6.12): what the user is told after a page's call has been answered. A receipt is
 * built from the request and the outcome by wrapping P1's `dispatch`; `neededApproval` says whether the
 * user had to look at the app for it (a sheet, or the wallet not being ready), which decides between the
 * done screen and the toast.
 */
import type { Dispatcher } from '@bsv/expo-wallet-toolbox/core/bridge/dispatcher'

export type ReceiptSummary =
  | { kind: 'payment'; amount: string }
  | { kind: 'action' | 'signed' | 'encrypted' | 'certificate' | 'approved' }

export interface Receipt {
  origin: string
  method: string
  summary: ReceiptSummary
  ok: boolean
  neededApproval: boolean
  epoch: string
}

/** What the done screen shows: one receipt, one site with several, or several sites. */
export interface DoneModel {
  /** The site's name; absent when several sites are summarised. */
  site?: string
  /** The number of sites; present only when it is more than one. */
  sites?: number
  /** The line under the headline; absent when several sites are summarised. */
  summary?: ReceiptSummary | { kind: 'requests'; n: number }
}

export interface ReceiptTracker {
  /**
   * Whether an attention that needs the user fired for this epoch while the call was in flight. Called
   * once per call, when its outcome returns.
   */
  neededApproval(epoch: string): boolean
  /** Called when a call starts, so the tracker can tell an attention that belongs to it. */
  begin?(epoch: string): void
}

const SIGNED = new Set(['createSignature', 'verifySignature', 'createHmac', 'verifyHmac'])
const ENCRYPTED = new Set(['encrypt', 'decrypt'])
const CERTIFICATE = new Set(['acquireCertificate', 'proveCertificate', 'listCertificates', 'relinquishCertificate'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** The satoshis the request's outputs pay out; zero-value outputs (data) do not count. */
function outputSatoshis(args: unknown): number {
  if (!isRecord(args) || !Array.isArray(args.outputs)) return 0
  let total = 0
  for (const o of args.outputs) {
    const sats = isRecord(o) ? o.satoshis : undefined
    if (typeof sats === 'number' && Number.isFinite(sats) && sats > 0) total += sats
  }
  return total
}

/**
 * The summary line by method (spec 6.12). A `createAction` or `signAction` whose outputs pay out is a
 * payment with the exact amount in the user's display format; any other action is an action. The
 * amount comes from the request's outputs, so a `signAction` (which carries none) is an action.
 */
export function summarize(method: string, args: unknown, format: (sats: number) => string): ReceiptSummary {
  if (method === 'createAction' || method === 'signAction') {
    const sats = outputSatoshis(args)
    return sats > 0 ? { kind: 'payment', amount: format(sats) } : { kind: 'action' }
  }
  if (SIGNED.has(method)) return { kind: 'signed' }
  if (ENCRYPTED.has(method)) return { kind: 'encrypted' }
  if (CERTIFICATE.has(method)) return { kind: 'certificate' }
  return { kind: 'approved' }
}

/** The text a site is shown under: the hostname of an origin, or the origin itself when it does not parse. */
export function siteOf(origin: string): string {
  try {
    const host = new URL(origin).hostname
    return host.length > 0 ? host : origin
  } catch {
    return origin
  }
}

export function aggregate(receipts: Receipt[]): DoneModel {
  if (receipts.length === 0) return {}
  const sites = Array.from(new Set(receipts.map(r => r.origin)))
  if (sites.length > 1) return { sites: sites.length }
  const site = siteOf(sites[0])
  if (receipts.length === 1) return { site, summary: receipts[0].summary }
  return { site, summary: { kind: 'requests', n: receipts.length } }
}

/**
 * Wraps `dispatch` so each settled call reports a receipt. `onReceipt` is isolated: a throw there never
 * changes the outcome the page gets.
 */
export function createReceiptDispatch(
  dispatch: Dispatcher['dispatch'],
  tracker: ReceiptTracker,
  options: { format?: (sats: number) => string; onReceipt?: (receipt: Receipt) => void } = {}
): Dispatcher['dispatch'] {
  const format = options.format ?? ((sats: number) => `${sats} sats`)
  return async input => {
    const request = input.request
    tracker.begin?.(request.epoch)
    let outcome: Awaited<ReturnType<Dispatcher['dispatch']>> | undefined
    try {
      outcome = await dispatch(input)
      return outcome
    } finally {
      // A rejection is not an outcome; the tracker still has to see the call end.
      const needed = tracker.neededApproval(request.epoch)
      if (outcome !== undefined) {
        try {
          options.onReceipt?.({
            origin: request.origin,
            method: request.method,
            summary: summarize(request.method, request.args, format),
            ok: outcome.ok,
            neededApproval: needed,
            epoch: request.epoch
          })
        } catch (e) {
          console.warn('[safari-bridge] receipt failed', e)
        }
      }
    }
  }
}

/**
 * Per-epoch bookkeeping for `neededApproval`: a call marks nothing itself, the transport's
 * `requestAttention` (consent, wallet-not-ready) and `onPromptRaised` do. A mark made while no call of
 * the epoch is in flight is dropped, so it cannot leak into the next call.
 */
export function createReceiptTracker(): ReceiptTracker & { mark(epoch: string): void } {
  const state = new Map<string, { inflight: number; needed: boolean }>()
  return {
    begin(epoch) {
      const s = state.get(epoch) ?? { inflight: 0, needed: false }
      if (s.inflight === 0) s.needed = false
      s.inflight++
      state.set(epoch, s)
    },
    mark(epoch) {
      const s = state.get(epoch)
      if (s !== undefined && s.inflight > 0) s.needed = true
    },
    neededApproval(epoch) {
      const s = state.get(epoch)
      if (s === undefined) return false
      const needed = s.needed
      s.inflight = Math.max(0, s.inflight - 1)
      if (s.inflight === 0) state.delete(epoch)
      return needed
    }
  }
}
