export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path?.toLowerCase().startsWith('peerpay:')) {
      return `/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`
    }
    const walletScheme = /^bsv-(?:wallet|browser):\/\//i
    if (walletScheme.test(path)) {
      // Both app schemes use the host as the first route segment. Return a
      // relative path so Expo Router preserves encoded pairing parameters.
      const route = path.replace(walletScheme, '').replace(/^\/+/, '')
      // External pairing links use Connections; internal /pair still shows
      // its existing approval screen. Match the complete route, not a prefix.
      return `/${route.replace(/^pair\/?(?=[?#]|$)/i, 'connections')}`
    }
    return path || '/'
  } catch {
    return '/'
  }
}
