/**
 * Whether a URL is safe to hand to a native fetch/prefetch as a destination
 * this app does not control.
 *
 * There is no synchronous DNS resolution available on this runtime, so this
 * cannot catch a hostname that only *resolves* to a private address (DNS
 * rebinding) — that needs a redirect/connect-time check on the platform's
 * networking stack, which this codebase does not have. What it DOES catch,
 * cheaply and up front, is the concrete class of report this closes: a
 * foreign paymail registry, a user-typed trust-provider domain, or a search
 * result that names a loopback/private/link-local address or IP literal
 * directly (XR-073 / SEC2-057, SEC2-076). A hostname is otherwise accepted
 * without being resolved — this is a floor, not a firewall.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isPrivateIPv4(host: string): boolean {
  const m = IPV4.exec(host)
  if (!m) return false
  const parts = m.slice(1, 5).map(Number)
  if (parts.some(n => n > 255)) return false
  const [a, b] = parts
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (RFC6598)
  if (a === 0) return true // "this network"
  if (a >= 224) return true // multicast + reserved
  return false
}

/** Also catches the bracketed literal a URL's `hostname` gives back, e.g. `[::1]`. */
function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true // link-local fe80::/10
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique local fc00::/7
  // IPv4-mapped/compatible — judge the embedded address. A URL's `.hostname`
  // canonicalises the literal to hex groups (`::ffff:a.b.c.d` becomes
  // `::ffff:7f00:1`), so the last two 16-bit groups are read back as bytes
  // rather than matched against the dotted form.
  if (h.includes('ffff')) {
    const groups = h.split(':')
    const last = groups.slice(-2)
    if (last.length === 2 && last.every(g => /^[0-9a-f]{1,4}$/.test(g))) {
      const hi = parseInt(last[0], 16)
      const lo = parseInt(last[1], 16)
      const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
      if (isPrivateIPv4(ipv4)) return true
    }
  }
  return false
}

/**
 * A parseable, credential-free `https://` URL whose host is not a loopback,
 * private-use, link-local, CGNAT, multicast/reserved, or `.local`/`localhost`
 * address. The path/query is not otherwise restricted — this is a host-class
 * check, not a full origin policy.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host === 'local' || host.endsWith('.local')) return false
  if (host.startsWith('[') || host.includes(':')) return !isPrivateIPv6(host)
  return !isPrivateIPv4(host)
}
