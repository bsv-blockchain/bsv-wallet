// App-local theme for the Bitcoin SV Wallet app: the prototype's design
// language. Deliberately separate from the shared toolbox theme
// (packages/expo-wallet-toolbox/core/theme), whose defaults the existing app
// keeps unchanged.
import { useColorScheme, type TextStyle } from 'react-native'
import { dark, light, radii, type Palette } from './tokens'

export { dark, light, radii }
export type { Palette }

export function useIsDark(): boolean {
  return useColorScheme() === 'dark'
}

export function usePalette(): Palette {
  return useIsDark() ? dark : light
}

type Weight = 400 | 500 | 600 | 700 | 800 | 900

/**
 * Nunito, as the prototype uses it: body copy at 400, UI emphasis at 500–600,
 * headings at 700, big money at 800. The weights are embedded at build time
 * (app.config.js), so fontWeight selects the matching file on both platforms.
 */
export const font = (weight: Weight = 400): TextStyle => ({
  fontFamily: 'Nunito',
  fontWeight: String(weight) as TextStyle['fontWeight']
})

/** Caveat: the Home tour's handwritten labels only. */
export const handwriting = (weight: 600 | 700 = 600): TextStyle => ({
  fontFamily: 'Caveat',
  fontWeight: String(weight) as TextStyle['fontWeight']
})

/** The prototype's Tailwind text sizes (font size / line height, in points). */
export const text = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 24 },
  lg: { fontSize: 18, lineHeight: 28 },
  xl: { fontSize: 20, lineHeight: 28 },
  '2xl': { fontSize: 24, lineHeight: 32 },
  '3xl': { fontSize: 30, lineHeight: 36 },
  '4xl': { fontSize: 36, lineHeight: 40 }
} as const satisfies Record<string, TextStyle>
