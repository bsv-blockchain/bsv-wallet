/** CORS and base headers for loopback responses (spec 6.6.1). Never credentials, wildcard or null. */

export type CorsKind = 'public' | 'binding'

/** On every response, errors included. `Content-Length` and `Connection: close` are added by the writer. */
export const BASE_HEADERS: readonly [string, string][] = Object.freeze([
  ['Cache-Control', 'no-store'],
  ['Vary', 'Origin'],
  ['X-Content-Type-Options', 'nosniff']
] as [string, string][])

const ALLOWED_REQUEST_HEADERS = [
  'Content-Type',
  'BRC-185-Epoch',
  'BRC-185-Instance',
  'BRC-185-Key',
  'BRC-185-Android-Binding'
]

function assertOrigin(origin: string): void {
  if (typeof origin !== 'string' || origin === '' || origin === '*' || origin === 'null') {
    throw new Error('CORS origin must be a concrete origin')
  }
}

/**
 * `public`: discovery, connect, preflight (exposes the describe/connect ack). `binding`: RPC and DELETE for the live
 * binding's origin (exposes the reconnect token). Callers send no CORS headers at all for any other origin.
 */
export function corsHeaders(opts: { origin: string; kind: CorsKind }): [string, string][] {
  assertOrigin(opts.origin)
  return [
    ['Access-Control-Allow-Origin', opts.origin],
    ['Access-Control-Expose-Headers', opts.kind === 'public' ? 'BRC-185-Android-Ack' : 'BRC-185-Reconnect-Token']
  ]
}

export function preflightHeaders(req: {
  origin: string
  requestHeaders?: string
  privateNetwork?: boolean
}): [string, string][] {
  assertOrigin(req.origin)
  const asked = (req.requestHeaders ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s !== '')
  const allow = ALLOWED_REQUEST_HEADERS.filter(h => asked.includes(h.toLowerCase()))
  const out: [string, string][] = [
    ['Access-Control-Allow-Origin', req.origin],
    ['Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS']
  ]
  if (allow.length > 0) out.push(['Access-Control-Allow-Headers', allow.join(', ')])
  if (req.privateNetwork === true) out.push(['Access-Control-Allow-Private-Network', 'true'])
  for (const h of BASE_HEADERS) out.push([h[0], h[1]])
  return out
}
