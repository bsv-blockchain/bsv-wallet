// The app's typeface on paper. A page printed on the phone (expo-print) is
// laid out by a web view that can't see the fonts embedded in the app, so
// Nunito travels inside the page: each weight as a base64 @font-face, read
// once from the bundled font files and kept for the next print.
//
// The native modules load on first use, so tests that import the callers
// don't need them.

/* eslint-disable @typescript-eslint/no-require-imports */
const FACES: [weight: number, module: number][] = [
  [400, require('@expo-google-fonts/nunito/400Regular/Nunito_400Regular.ttf')],
  [600, require('@expo-google-fonts/nunito/600SemiBold/Nunito_600SemiBold.ttf')],
  [700, require('@expo-google-fonts/nunito/700Bold/Nunito_700Bold.ttf')],
  [800, require('@expo-google-fonts/nunito/800ExtraBold/Nunito_800ExtraBold.ttf')],
  [900, require('@expo-google-fonts/nunito/900Black/Nunito_900Black.ttf')]
]
/* eslint-enable @typescript-eslint/no-require-imports */

let cached: Promise<string> | null = null

/** `@font-face` rules for Nunito 400 to 900; empty if the files can't be read (the page then falls back to the system font). */
export function nunitoFontFaces(): Promise<string> {
  cached ??= load().catch(() => {
    cached = null
    return ''
  })
  return cached
}

/** A bundled file's bytes, base64. */
async function base64Of(module: number): Promise<string> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Asset } = require('expo-asset') as typeof import('expo-asset')
  const { File } = require('expo-file-system') as typeof import('expo-file-system')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const asset = Asset.fromModule(module)
  await asset.downloadAsync()
  return new File(asset.localUri ?? asset.uri).base64()
}

/** A bundled image as a data URI, for a printed page; undefined if it can't be read. */
export async function assetDataUri(module: number, type: string): Promise<string | undefined> {
  try {
    return `data:${type};base64,${await base64Of(module)}`
  } catch {
    return undefined
  }
}

async function load(): Promise<string> {
  const rules = await Promise.all(
    FACES.map(async ([weight, module]) => {
      const data = await base64Of(module)
      return `@font-face{font-family:'Nunito';font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${data}) format('truetype')}`
    })
  )
  return rules.join('\n')
}
