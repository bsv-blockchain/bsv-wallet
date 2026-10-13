// Website links (bitcoinsv.com, or EXPO_PUBLIC_LINK_DOMAIN): what opens the app
// from a browser, a message or another app, once BSVA hosts the two files that
// let the phone hand the domain to the app (web/.well-known/, and
// docs/backend-integration.md):
//   https://<domain>/pay/<identity key>?sats=…&note=…&url=…   pay them (a pay link)
//   https://<domain>/@<handle>                                  pay them by handle
// The pay link's own query (BRC-125's sats/asset/amount, and the url and note
// extensions) goes through unchanged, so a website link is a pay link with
// another front. Pure (the domain is passed in: src/links/linkDomain.ts);
// app/+native-intent.ts and the Share buttons use it.

const KEY = /^0[23][0-9a-f]{64}$/i
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/**
 * Where a website link goes in the app, or null when it isn't one. Takes the
 * full URL, or (as a universal link can arrive) just its path.
 */
export function resolveWebLink(link: string, domain: string): string | null {
  if (!link) return null
  let path: string
  let query: string
  try {
    if (/^https?:\/\//i.test(link)) {
      if (!domain) return null
      const url = new URL(link)
      const host = url.hostname.toLowerCase()
      if (host !== domain && host !== `www.${domain}`) return null
      path = url.pathname
      query = url.search.replace(/^\?/, '')
    } else {
      const i = link.indexOf('?')
      path = i < 0 ? link : link.slice(0, i)
      query = i < 0 ? '' : link.slice(i + 1)
    }
  } catch {
    return null
  }
  const pay = /^\/pay\/([^/]+)\/?$/.exec(path)
  if (pay && KEY.test(pay[1])) {
    const peerpay = `peerpay:${pay[1].toLowerCase()}${query ? `?${query}` : ''}`
    return `/send?link=${encodeURIComponent(peerpay)}`
  }
  const handle = /^\/@([^/]+)\/?$/.exec(path)
  if (handle && HANDLE.test(decodeURIComponent(handle[1]))) {
    return `/send?handle=${encodeURIComponent(`@${decodeURIComponent(handle[1]).toLowerCase()}`)}`
  }
  return null
}

/** A pay link as a website link (what's shared once a domain is set up), or the pay link itself. */
export function toWebLink(peerpay: string, domain: string): string {
  if (!domain) return peerpay
  const m = /^peerpay:(?:\/\/)?(0[23][0-9a-f]{64})(\?.*)?$/i.exec(peerpay.trim())
  return m ? `https://${domain}/pay/${m[1].toLowerCase()}${m[2] ?? ''}` : peerpay
}
