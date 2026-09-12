import { ADMIN_ORIGINATOR } from '../config'

export interface ExternalOrigin {
  /** Canonical HTTPS origin used for relay discovery and persistence. */
  origin: string
  /** Canonical host (and non-default port) used by WalletClient permissions. */
  originator: string
}

/**
 * Parse an untrusted pairing origin at the external/internal trust boundary.
 *
 * Pairing relies on TLS for control of the advertised origin, so accepting a
 * fallback string, cleartext URL, credentials, or a URL with path/query data
 * turns an authorization identity into attacker-controlled text. Every fresh
 * pairing and reconnect must pass through this function before constructing a
 * WalletClient or fetching relay metadata.
 */
export function parseExternalOrigin(raw: string): ExternalOrigin {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Origin URL is not valid')
  }
  if (url.protocol !== 'https:') throw new Error('Origin must use https://')
  if (!url.hostname) throw new Error('Origin must include a hostname')
  if (url.username || url.password) throw new Error('Origin must not include credentials')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Origin must be a bare HTTPS origin without a path, query, or fragment')
  }

  const originator = url.port ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase()
  // Defense in depth if the internal label ever changes back to something URL-shaped.
  if (originator === ADMIN_ORIGINATOR.toLowerCase() || url.origin.toLowerCase() === ADMIN_ORIGINATOR.toLowerCase()) {
    throw new Error('Origin is reserved for the wallet')
  }
  return { origin: url.origin, originator }
}
