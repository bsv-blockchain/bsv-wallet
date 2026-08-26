export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path?.toLowerCase().startsWith('peerpay:')) {
      return `/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`
    }
    return path || '/'
  } catch {
    return '/'
  }
}
