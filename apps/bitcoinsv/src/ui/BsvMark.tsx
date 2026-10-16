// The BitcoinSV mark, as the prototype's components/brand/bsv-logo.tsx
// (BsvMark): gold disc with a white ₿ for coins and hero figures, or set in
// ink beside amounts at text size (dark disc on paper, white disc in dark).
//
// With another app icon chosen (Settings → App icon), that icon's coin takes
// the mark's place everywhere; DefaultBsvMark is always the Bitcoin SV one.
// The default BSV Wallet icon keeps the drawn mark too: its dark tile reads as
// an app icon, not as a coin beside an amount.
import React from 'react'
import { Image } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { useIsDark } from '../theme'
import { DISC, GLYPH } from './bsvMarkPaths'
import { COIN_IMAGES, useAppIcon } from '../settings/appIcons'


export function BsvMark({ size, ink = false }: { size: number; ink?: boolean }) {
  const icon = useAppIcon()
  if (icon !== 'classic' && icon !== 'wallet')
    return <Image source={COIN_IMAGES[icon]} style={{ width: size, height: size }} accessibilityLabel="BitcoinSV" />
  return <DefaultBsvMark size={size} ink={ink} />
}

export function DefaultBsvMark({ size, ink = false }: { size: number; ink?: boolean }) {
  // ink: #1D1D1F disc / white glyph on paper, reversed in dark mode
  const darkMode = useIsDark()
  const disc = ink ? (darkMode ? '#FFFFFF' : '#1D1D1F') : '#EAB300'
  const glyph = ink ? (darkMode ? '#1D1D1F' : '#FFFFFF') : '#FFFFFF'
  return (
    <Svg width={size} height={size} viewBox="0 0 2500 2500" accessibilityLabel="BitcoinSV">
      <Path fill={disc} d={DISC} />
      <Path fill={glyph} d={GLYPH} />
    </Svg>
  )
}
