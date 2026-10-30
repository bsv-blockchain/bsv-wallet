/**
 * BRC-185 origin -> originator (spec 6.3).
 *
 * Pure: the only imports are constants. The strict ASCII grammar runs first and `URL` is used
 * only as a cross-check, because this code runs on Node (jest), WebKit (the extension) and
 * Hermes with `whatwg-url-minimum`, and they do not serialise origins identically.
 */
import { ADMIN_ORIGINATOR, LEGACY_ADMIN_ORIGINATOR } from './constants'
import {
  isLdhHostname,
  isUnattestedOriginator,
  MAX_ORIGINATOR_BYTES,
  MAX_UNVERIFIED_HOSTNAME_BYTES,
  OriginRefused
} from '../unverifiedOriginator'

export {
  hostnameOfUnattested,
  isGrantTag,
  isUnattestedOriginator,
  mintGrantTag,
  OriginRefused,
  unverifiedOriginator
} from '../unverifiedOriginator'

export type Attestation = 'browser' | 'unattested'

export interface CanonicalOrigin {
  applicationOrigin: string
  hostname: string
  attestation: Attestation
  /** The hostname for `browser`. Undefined for `unattested` until consent mints a grant tag (6.4). */
  originator: string | undefined
}

const MAX_ORIGIN_BYTES = 2048
const MAX_HOST_CHARS = 253
const HTTPS_RE = /^https:\/\/([^:/?#@\s]+)(?::([1-9][0-9]{0,4}))?$/
const LOCALHOST_HTTP_RE = /^http:\/\/localhost:([1-9][0-9]{0,4})$/

function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

function isAdminHost(host: string): boolean {
  return host === ADMIN_ORIGINATOR || host === LEGACY_ADMIN_ORIGINATOR
}

function crossCheck(origin: string, protocol: string, host: string, port: string | undefined): void {
  // Any disagreement with the platform URL parser, or a parser failure, refuses the origin.
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    throw new OriginRefused('origin not parseable')
  }
  if (u.protocol !== protocol || u.hostname !== host || u.port !== (port ?? '') || u.username || u.password) {
    throw new OriginRefused('origin parsers disagree')
  }
}

export function canonicalizeBridgeOrigin(input: {
  origin: string
  attestation: Attestation
  /** Host policy: `configureToolbox({ browserBridge: { allowLocalhostHttp } })`, gated on `__DEV__`. */
  allowLocalhostHttp?: boolean
}): CanonicalOrigin {
  const { origin, attestation } = input
  if (attestation !== 'browser' && attestation !== 'unattested') throw new OriginRefused('unknown attestation')
  if (typeof origin !== 'string' || origin.length === 0 || utf8Length(origin) > MAX_ORIGIN_BYTES) {
    throw new OriginRefused('origin missing or too long')
  }

  let host: string
  let port: string | undefined
  let protocol: string
  const https = HTTPS_RE.exec(origin)
  if (https) {
    protocol = 'https:'
    host = https[1]
    port = https[2]
    if (Number(port ?? 1) > 65535) throw new OriginRefused('port out of range')
    if (port === '443') throw new OriginRefused('default port is not canonical')
    if (!isLdhHostname(host, MAX_HOST_CHARS)) throw new OriginRefused('host is not a canonical ASCII hostname')
  } else {
    const dev = input.allowLocalhostHttp === true ? LOCALHOST_HTTP_RE.exec(origin) : null
    if (!dev || Number(dev[1]) > 65535) throw new OriginRefused('origin must be https')
    protocol = 'http:'
    host = 'localhost'
    port = dev[1]
  }

  // The `invalid` TLD holds the admin name and the unverified namespace; no site may claim it.
  if (isAdminHost(host) || host === 'invalid' || host.endsWith('.invalid')) {
    throw new OriginRefused('reserved host')
  }
  if (attestation === 'unattested' && host.length > MAX_UNVERIFIED_HOSTNAME_BYTES) {
    throw new OriginRefused('host too long for the unverified namespace')
  }
  if (host.length > MAX_ORIGINATOR_BYTES) throw new OriginRefused('host too long')

  crossCheck(origin, protocol, host, port)

  return {
    applicationOrigin: origin,
    hostname: host,
    attestation,
    originator: attestation === 'browser' ? host : undefined
  }
}

/**
 * Final check, run immediately before every wallet call (6.3 step 5). Requires a hostname shape,
 * no `:` or `@`, not admin, and `.invalid` only in the exact unverified form.
 */
export function assertCanonicalOriginator(o: unknown): asserts o is string {
  if (typeof o !== 'string' || o.length === 0 || utf8Length(o) > MAX_ORIGINATOR_BYTES) {
    throw new OriginRefused('originator missing or too long')
  }
  if (o.includes(':') || o.includes('@') || isAdminHost(o)) throw new OriginRefused('originator not permitted')
  const s: string = o
  if (isUnattestedOriginator(s)) return
  if (!isLdhHostname(s, MAX_ORIGINATOR_BYTES)) throw new OriginRefused('originator is not a canonical hostname')
  if (s === 'invalid' || s.endsWith('.invalid')) throw new OriginRefused('originator is in a reserved namespace')
}
