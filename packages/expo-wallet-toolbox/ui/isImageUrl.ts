/**
 * expo-image is required lazily: its package entry is raw TypeScript that Jest
 * does not transform under this package's documented config, and this helper
 * is reached from the `ui` barrel. TrustScreen gives its Image the same
 * treatment.
 */
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
  try {
    return await loadExpoImage().Image.prefetch(url)
  } catch {
    return false
  }
}
