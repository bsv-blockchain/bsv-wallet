/**
 * Where an externally-opened link (a system deep link, not an in-app
 * navigation) sends the user.
 *
 * Two protocols are handled: `peerpay:` — the toolbox's own payment-request
 * scheme, recognised regardless of which app owns it — and the host app's own
 * custom URL schemes, supplied by the caller as `walletSchemes` so this stays
 * usable by a second wallet app with different scheme names. Both app schemes
 * use the host as the first route segment. `pair` is rewritten to
 * `connections` as a whole route only — never a prefix — so an internal
 * `/pair` approval screen and unrelated routes like `/pairing` are untouched;
 * external pairing links land on Connections instead.
 */
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
      return `/${route.replace(/^pair\/?(?=[?#]|$)/i, 'connections')}`
    }
    return path || '/'
  } catch {
    return '/'
  }
}
