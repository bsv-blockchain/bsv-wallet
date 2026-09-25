import { ADMIN_ORIGINATOR } from '../config'
import { isPrivateNetworkHost } from '../net/publicDestination'

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
  // The wallet's own authority lives in the reserved `.invalid` TLD (see
  // ADMIN_ORIGINATOR). No real origin can be served from it, so refuse the
  // whole TLD rather than only the exact label.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'invalid' || hostname.endsWith('.invalid') || originator === ADMIN_ORIGINATOR.toLowerCase()) {
    throw new Error('Origin is reserved for the wallet')
  }
  // XR-024 (SEC2-055): TLS certificate validity gates WHO can claim a given
  // hostname, not WHERE that hostname points -- a self-signed pairing payload
  // naming a loopback/RFC1918/link-local literal directly gets a real fetch
  // into the device's own local network with no DNS trickery needed. This is
  // a floor, not a firewall: a public hostname that only *resolves* to such
  // an address (DNS rebinding) needs a redirect/connect-time check on the
  // platform's networking stack, which this codebase does not have.
  if (isPrivateNetworkHost(url.hostname)) {
    throw new Error('Origin must not name a loopback or private-network destination')
  }
  return { origin: url.origin, originator }
}
