/**
 * A small client for legacy paymail (HandCash and similar): ask a receiver for
 * a P2P payment destination, then post it the transaction as plain BEEF.
 *
 * Own code on the toolbox's bounded fetch, not `@bsv/paymail`: that package's
 * main bundle drags in an Express router and `joi`, and its own discovery
 * would skip our AD-flag and public-URL checks. Every URL here comes from the
 * resolver's checked discovery and is checked again once it is filled in.
 */
import { isLegacyCapabilityUrl } from '../../identity/handleRegistry/classify'
import {
  REGISTRY_MAX_BODY_BYTES,
  fetchWithTimeout,
  type RegistryResolver
} from '../../identity/handleRegistry/resolver'
import { BRFC_P2P_DESTINATION, BRFC_P2P_RECEIVE_BEEF } from '../../identity/handleRegistry/rules'
import { parsePaymail } from './address'
import { isPublicHttpsUrl } from '../../net/publicDestination'
import { createBoundedNativeFetch } from '../../network/boundedFetch'

export const PAYMAIL_TIMEOUT_MS = 15_000
export const MAX_DESTINATION_OUTPUTS = 10

const MAX_SCRIPT_HEX_CHARS = 10_000
const MAX_REFERENCE_CHARS = 4_096
const PLACEHOLDERS = ['{alias}', '{domain.tld}'] as const
const MAX_ERROR_MESSAGE_CHARS = 200
const HEX_FORMAT = /^(?:[0-9a-f]{2})+$/i
const TXID_FORMAT = /^[0-9a-f]{64}$/i

export interface P2pOutput {
  script: string
  satoshis: number
}
export interface P2pDestination {
  outputs: P2pOutput[]
  reference: string
  beefEndpoint: string
}
export type DestinationResult =
  | { kind: 'ok'; destination: P2pDestination }
  | {
      kind: 'failed'
      reason: 'invalid_paymail' | 'unsupported' | 'unreachable' | 'refused' | 'invalid_destination'
      message: string
    }
export type PostBeefResult =
  | { kind: 'accepted'; txid: string; note: string }
  | { kind: 'http'; status: number; message: string }
  | { kind: 'network'; message: string }

export interface LegacyPaymailClient {
  getP2pDestination(paymail: string, satoshis: number): Promise<DestinationResult>
  postBeef(args: { endpoint: string; beefHex: string; reference: string }): Promise<PostBeefResult>
}

type Failed = Extract<DestinationResult, { kind: 'failed' }>
const fail = (reason: Failed['reason'], message: string): Failed => ({ kind: 'failed', reason, message })

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The body as JSON, or the sentinel when it is not JSON. Never throws. */
async function readJson(res: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await res.json() }
  } catch {
    return { ok: false }
  }
}

function errorMessage(parsed: { ok: true; body: unknown } | { ok: false }, status: number): string {
  if (parsed.ok && isPlainObject(parsed.body) && typeof parsed.body.message === 'string') {
    // The host's text is untrusted: no control characters, a short length.
    // eslint-disable-next-line no-control-regex
    const clean = parsed.body.message.slice(0, 2_000).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
    if (clean) return clean.slice(0, MAX_ERROR_MESSAGE_CHARS)
  }
  return `HTTP ${status}`
}

function fill(template: string, alias: string, domain: string): string {
  return template
    .split('{alias}')
    .join(encodeURIComponent(alias))
    .split('{domain.tld}')
    .join(encodeURIComponent(domain))
}

function parseDestinationBody(body: unknown, satoshis: number): { outputs: P2pOutput[]; reference: string } | null {
  if (!isPlainObject(body)) return null
  const { outputs, reference } = body
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > MAX_DESTINATION_OUTPUTS) return null
  if (typeof reference !== 'string' || reference === '' || reference.length > MAX_REFERENCE_CHARS) return null
  const parsed: P2pOutput[] = []
  let sum = 0
  for (const o of outputs) {
    if (!isPlainObject(o)) return null
    const { script, satoshis: amount } = o
    if (typeof script !== 'string' || script.length > MAX_SCRIPT_HEX_CHARS || !HEX_FORMAT.test(script)) return null
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null
    sum += amount
    parsed.push({ script, satoshis: amount })
  }
  if (sum !== satoshis) return null
  return { outputs: parsed, reference }
}

export function createLegacyPaymailClient(args: {
  resolver: Pick<RegistryResolver, 'discoverCapabilities'>
  fetchImpl?: typeof fetch
}): LegacyPaymailClient {
  const fetchImpl = args.fetchImpl ?? createBoundedNativeFetch(REGISTRY_MAX_BODY_BYTES)
  const post = (url: string, body: unknown) =>
    fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body)
      },
      PAYMAIL_TIMEOUT_MS
    )

  return {
    async getP2pDestination(paymail, satoshis) {
      const parsedAddress = parsePaymail(paymail)
      if (!parsedAddress) return fail('invalid_paymail', 'Not a valid paymail.')
      const { alias, domain } = parsedAddress
      const found = await args.resolver.discoverCapabilities(domain)
      if (found.kind === 'failed') return fail('unreachable', 'Could not reach that paymail host.')
      if (found.kind !== 'ok') return fail('unsupported', 'That paymail host does not take this kind of payment.')
      const destTemplate = found.capabilities[BRFC_P2P_DESTINATION]
      const beefTemplate = found.capabilities[BRFC_P2P_RECEIVE_BEEF]
      if (!isLegacyCapabilityUrl(destTemplate, PLACEHOLDERS) || !isLegacyCapabilityUrl(beefTemplate, PLACEHOLDERS)) {
        return fail('unsupported', 'That paymail host does not take this kind of payment.')
      }
      const destUrl = fill(destTemplate, alias, domain)
      const beefEndpoint = fill(beefTemplate, alias, domain)
      if (!isPublicHttpsUrl(destUrl) || !isPublicHttpsUrl(beefEndpoint)) {
        return fail('unsupported', 'That paymail host does not take this kind of payment.')
      }
      let res: Response
      try {
        res = await post(destUrl, { satoshis })
      } catch {
        return fail('unreachable', 'Could not reach that paymail host.')
      }
      const parsed = await readJson(res)
      if (!res.ok) return fail('refused', errorMessage(parsed, res.status))
      if (!parsed.ok) return fail('invalid_destination', 'The paymail host sent an unreadable destination.')
      const dest = parseDestinationBody(parsed.body, satoshis)
      if (!dest) return fail('invalid_destination', 'The paymail host sent a destination that does not check out.')
      return { kind: 'ok', destination: { ...dest, beefEndpoint } }
    },

    async postBeef({ endpoint, beefHex, reference }) {
      if (!isPublicHttpsUrl(endpoint)) return { kind: 'network', message: 'endpoint_not_public' }
      let res: Response
      try {
        res = await post(endpoint, { beef: beefHex, reference })
      } catch (e) {
        return { kind: 'network', message: e instanceof Error ? e.message : String(e) }
      }
      const parsed = await readJson(res)
      if (!res.ok) return { kind: 'http', status: res.status, message: errorMessage(parsed, res.status) }
      // The receiver answered 2xx, so it may well hold the payment: anything we
      // cannot read is an unknown result, never a refusal.
      if (!parsed.ok || !isPlainObject(parsed.body)) return { kind: 'network', message: 'unreadable_receipt' }
      const { txid, note } = parsed.body
      if (typeof txid !== 'string' || !TXID_FORMAT.test(txid)) return { kind: 'network', message: 'unreadable_receipt' }
      return { kind: 'accepted', txid, note: typeof note === 'string' ? note : '' }
    }
  }
}
