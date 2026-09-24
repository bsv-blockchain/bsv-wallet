/**
 * Where an externally-opened link (a system deep link, not an in-app
 * navigation) sends the user.
 *
 * Two protocols are handled: `peerpay:` — the toolbox's own payment-request
 * scheme, recognised regardless of which app owns it — and the host app's own
 * custom URL schemes, supplied by the caller as `walletSchemes` so this stays
 * usable by a second wallet app with different scheme names. Both app schemes
 * use the host as the first route segment.
 *
 * `pair` is passed straight through to `/pair` (PairScreen), unchanged. It
 * used to be rewritten to `connections`, on the theory that Connections
 * already shows its own approval step for a scanned/pasted URI — but a deep
 * link never went through that step: ConnectionsScreen's `deepLinkParams`
 * effect called straight into `connect()` with no user gesture in between
 * (see the MITM-P1-deeplink-autoconnect finding). `/pair` is the screen that
 * actually renders origin + permissions + Approve/Reject, so an external
 * pairing link now gets exactly the same consent step a scanned QR gets —
 * never less.
 *
 * `auth/scan-shares` and `auth/mnemonic` with `flow=import` in its query are
 * the two destructive entry points into the recovery module — a deep link
 * landing on either one overwrites the device's only stored secret. They are
 * redirected to `/` instead of passed through, regardless of what an
 * attacker puts in the rest of the link. `auth/mnemonic?flow=backup` (and any
 * other `flow`) is unaffected — it only reads/displays the existing secret,
 * never overwrites it. This is layer 1 of two; layer 2 lives in
 * `recoverWallet.ts`, which refuses to overwrite an existing identity from
 * ANY entry point (in-app or not) unless the caller explicitly confirms.
 */
const AUTH_SCAN_SHARES_ROUTE = /^auth\/scan-shares\/?(?=[?#]|$)/i
const AUTH_MNEMONIC_ROUTE = /^auth\/mnemonic\/?(?=[?#]|$)/i

function isDestructiveAuthRoute(route: string): boolean {
  if (AUTH_SCAN_SHARES_ROUTE.test(route)) return true
  const match = AUTH_MNEMONIC_ROUTE.exec(route)
  if (!match) return false
  const rest = route.slice(match[0].length)
  if (!rest.startsWith('?')) return false
  const query = rest.slice(1).split('#')[0]
  return new URLSearchParams(query).get('flow')?.toLowerCase() === 'import'
}

export function resolveNativeIntent(path: string, opts: { walletSchemes: string[] }): string {
  try {
    if (path?.toLowerCase().startsWith('peerpay:')) {
      return `/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`
    }
    const escaped = opts.walletSchemes.map(scheme => scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const walletScheme = new RegExp(`^(?:${escaped.join('|')}):\\/\\/`, 'i')
    if (escaped.length > 0 && walletScheme.test(path)) {
      // Return a relative path so Expo Router preserves encoded pairing parameters.
      const route = path.replace(walletScheme, '').replace(/^\/+/, '')
      if (isDestructiveAuthRoute(route)) return '/'
      return `/${route}`
    }
    return path || '/'
  } catch {
    return '/'
  }
}
