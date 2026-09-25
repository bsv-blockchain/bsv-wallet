/**
 * expo-image is required lazily: its package entry is raw TypeScript that Jest
 * does not transform under this package's documented config, and this helper
 * is reached from the `ui` barrel. TrustScreen gives its Image the same
 * treatment.
 */
import { isPublicHttpsUrl } from '../core/net/publicDestination'

type ExpoImageModule = typeof import('expo-image')
let expoImage: ExpoImageModule | undefined
function loadExpoImage(): ExpoImageModule {
  if (!expoImage) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoImage = require('expo-image') as ExpoImageModule
  }
  return expoImage
}

export default async (url: string): Promise<boolean> => {
  // A trust manifest's icon URL is exactly as untrusted as the rest of the
  // manifest — prefetching it must not be able to reach a loopback or
  // private-network service (XR-073 / SEC2-057, SEC2-076).
  if (!isPublicHttpsUrl(url)) return false
  try {
    return await loadExpoImage().Image.prefetch(url)
  } catch {
    return false
  }
}
