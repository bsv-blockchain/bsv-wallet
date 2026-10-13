// The prototype's TiltedPhone (components/why-art.tsx): the tilted phone the
// Welcome, Sync and backup visuals share. Ten edge layers give it depth; its
// screen takes `children`. Ink and paper flip in dark mode, as in the prototype.
import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useIsDark, usePalette } from '../theme'
import { Flat3D, Gradient, edgeOffset } from '../ui/Soft'

const EDGE_LAYERS = 10

export interface Pose {
  scale?: number
  rx: number
  ry: number
  rz: number
}

/** color-mix(in oklch, var(--ink), black 38%), per theme. */
const EDGE = { light: '#18181a', dark: '#929190' }

export function TiltedPhone({
  pose,
  height = 192,
  gap,
  children
}: {
  pose: Pose
  /** h-48 by default; the backup celebration's phone is h-44 */
  height?: number
  /** a gap between the screen's children */
  gap?: number
  children: React.ReactNode
}) {
  const palette = usePalette()
  const dark = useIsDark()
  const { rx, ry, rz, scale = 1 } = pose
  return (
    <Flat3D>
    <View
      style={[
        styles.phone,
        { height },
        { transform: [{ perspective: 700 }, { scale }, { rotateX: `${rx}deg` }, { rotateY: `${ry}deg` }, { rotateZ: `${rz}deg` }] }
      ]}
    >
      {Array.from({ length: EDGE_LAYERS }, (_, i) => {
        const o = edgeOffset(rx, ry, rz, (i + 1) * 0.9)
        return (
          <View
            key={i}
            style={[styles.layer, { backgroundColor: dark ? EDGE.dark : EDGE.light, transform: [{ translateX: o.x }, { translateY: o.y }] }]}
          />
        )
      }).reverse()}
      <View style={[styles.layer, styles.bezel, { backgroundColor: palette.ink }]}>
        <View style={[styles.screen, { backgroundColor: palette.background, gap }]}>
          <View style={[styles.notch, { backgroundColor: palette.ink }]} />
          {children}
        </View>
      </View>
      <Gradient
        direction="br"
        radius={17.6}
        stops={[
          { offset: 0, color: '#ffffff', opacity: 0.15 },
          { offset: 0.5, color: '#ffffff', opacity: 0 },
          { offset: 1, color: '#ffffff', opacity: 0 }
        ]}
      />
    </View>
    </Flat3D>
  )
}

const styles = StyleSheet.create({
  // h-48 w-24, rounded-[1.1rem]
  phone: { width: 96, height: 192 },
  layer: { ...StyleSheet.absoluteFill, borderRadius: 17.6 },
  bezel: { padding: 6 },
  // rounded-[0.8rem] px-2 pt-5
  screen: { flex: 1, borderRadius: 12.8, overflow: 'hidden', alignItems: 'center', paddingHorizontal: 8, paddingTop: 20 },
  notch: { position: 'absolute', top: 6, alignSelf: 'center', height: 6, width: 28, borderRadius: 3 }
})
