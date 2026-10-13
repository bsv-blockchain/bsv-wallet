// The prototype's Coin (components/buy-bsv-card.tsx): a coin or token seen at
// an angle, the face squashed into an ellipse and tipped, with darker discs
// stacked behind it for a milled edge. Plain 2D transforms, as in the
// prototype. With `icon`: the icon on a card-coloured token, tilted the other way.
// With `coin` a token (the prototype's coinId): its own face on a silver edge.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useIsDark, usePalette } from '../theme'
import { BsvMark } from './BsvMark'
import { CoinMark, type Coin as CoinKind } from './CoinMark'
import { Gradient, SoftEllipse } from './Soft'

const EDGE = 10
const BASE = 112

export function Coin({ size = BASE, icon, coin }: { size?: number; icon?: React.ReactNode; coin?: CoinKind }) {
  const palette = usePalette()
  const dark = useIsDark()
  // color-mix(in oklch, var(--card), var(--foreground) 26% / 16%), per theme
  // a token's edge is the prototype's USDsv silver (COIN_STYLE.usd)
  const token = !icon && coin?.kind === 'token' ? coin : undefined
  const edge: [string, string] = icon
    ? dark
      ? ['#4f4f51', '#3a3a3c']
      : ['#c6c6c7', '#dcdcdc']
    : token
      ? ['#8A8A8E', '#9E9EA3']
      : ['#B58700', '#C79500']
  const turn = icon ? -1 : 1
  const scale = size / BASE
  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.base, { transform: [{ translateX: -(BASE - size) / 2 }, { translateY: -(BASE - size) / 2 }, { scale }] }]}>
        {/* soft shadow on the "table" */}
        <SoftEllipse frame={{ left: 16, top: BASE - 8, width: 80, height: 16 }} color="#000000" opacity={0.4} blur={12} />
        <View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${-14 * turn}deg` }] }]}>
          <View style={[StyleSheet.absoluteFill, { transform: [{ scaleX: 0.84 }] }]}>
            {/* the edge: discs stepping out to the right, darker further back */}
            {Array.from({ length: EDGE }, (_, k) => {
              const i = EDGE - k
              return <View key={i} style={[styles.disc, { transform: [{ translateX: i * 1.1 }], backgroundColor: i % 2 ? edge[0] : edge[1] }]} />
            })}
            {icon ? (
              <View style={[styles.disc, styles.face, { backgroundColor: palette.card, boxShadow: 'inset 0 0 0 1.5px rgba(0,0,0,0.08)' }]}>{icon}</View>
            ) : token ? (
              <View style={styles.disc}>
                <CoinMark coin={token} size={BASE} />
              </View>
            ) : (
              <View style={styles.disc}>
                <BsvMark size={BASE} />
              </View>
            )}
            {/* raised rim and a sheen */}
            <View
              pointerEvents="none"
              style={[styles.disc, { boxShadow: 'inset 0 0 0 3px rgba(255,255,255,0.3), inset 0 -8px 14px rgba(0,0,0,0.18)' }]}
            />
            <Gradient
              direction="br"
              radius={BASE / 2}
              stops={[
                { offset: 0, color: '#ffffff', opacity: 0.35 },
                { offset: 0.5, color: '#ffffff', opacity: 0 },
                { offset: 1, color: '#ffffff', opacity: 0 }
              ]}
            />
          </View>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  base: { width: BASE, height: BASE },
  disc: { ...StyleSheet.absoluteFill, borderRadius: BASE / 2, overflow: 'hidden' },
  face: { alignItems: 'center', justifyContent: 'center' }
})
