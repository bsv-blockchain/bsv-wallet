// Settings → App icon (the prototype's app/(wallet)/settings/app-icon/page.tsx):
// the icon as it is, big, on its white plate, and the icons to choose from.
// Choosing one tosses the coin: it crouches, jumps off the plate, spins three
// and a half turns, lands showing the new logo (the plate takes the landing,
// a gold ring and sparks burst out), and lies flat again. Then the phone's
// own notice (iOS shows it as the icon changes; Android, which switches it
// once you leave the app, says so in a toast).
// The home-screen icon really changes: src/settings/appIcons.ts.
import React, { useEffect, useState } from 'react'
import { Image, Platform, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  Easing,
  cubicBezier,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming
} from 'react-native-reanimated'
import { Check } from 'lucide-react-native'
import { showToast } from '../src/ui/Toast'
import { font, useIsDark, usePalette } from '../src/theme'
import { PageHeader } from '../src/ui/PageHeader'
import { DefaultBsvMark } from '../src/ui/BsvMark'
import { enter, useReducedMotion } from '../src/ui/motion'
import { PressScale } from '../src/ui/PressScale'
import { BalancedText } from '../src/ui/BalancedText'
import { ANDROID_DEV, APP_ICONS, COIN_IMAGES, applyAppIcon, canChangeAppIcon, currentAppIcon, type AppIconId } from '../src/settings/appIcons'

/** How long the toss takes, and when the coin lands on the plate. */
const TOSS_MS = 1500
const LAND = 0.86
const COIN = 128
/** the coin's edge, seen side-on (the prototype's 18 rim slices, 0.4 px apart) */
const RIM = 7.2
const SPARKS = 12

/** An icon's logo as itself, for the picker and the coin's faces. */
export function AppIconLogo({ id, size }: { id: AppIconId; size: number }) {
  if (id === 'classic') return <DefaultBsvMark size={size} />
  return <Image source={COIN_IMAGES[id]} style={{ width: size, height: size }} />
}

// the prototype's keyframe segments: [share of the toss, easing]
const SEG = [
  [0.08, Easing.in(Easing.quad)],
  [0.39, Easing.bezier(0.2, 0.7, 0.3, 1)],
  [0.39, Easing.bezier(0.6, 0, 0.85, 0.4)],
  [0.07, Easing.out(Easing.quad)],
  [0.07, Easing.in(Easing.quad)]
] as const
const seq = (values: number[]) =>
  withSequence(...values.map((v, i) => withTiming(v, { duration: SEG[i][0] * TOSS_MS, easing: SEG[i][1] })))

export default function AppIconScreen() {
  const palette = usePalette()
  const dark = useIsDark()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const still = useReducedMotion()
  const [current, setCurrent] = useState<AppIconId>(currentAppIcon)
  const [faces, setFaces] = useState<{ front: AppIconId; back: AppIconId }>({ front: current, back: current })
  const [tossing, setTossing] = useState(false)
  const supported = canChangeAppIcon()

  const y = useSharedValue(0)
  const turn = useSharedValue(0)
  const scale = useSharedValue(1)
  const plate = useSharedValue(1)
  const shadow = useSharedValue(1)
  const burst = useSharedValue(0)

  useEffect(() => {
    setFaces({ front: current, back: current })
  }, [current])

  const landed = async (id: AppIconId) => {
    setCurrent(id)
    try {
      await applyAppIcon(id)
      // iOS says so itself ("You have changed the icon for…"); Android doesn't
      if (Platform.OS === 'android')
        showToast(ANDROID_DEV ? 'Development builds keep the home-screen icon' : 'Your home screen shows it once you leave the app', { type: 'success' })
    } catch {
      showToast('This phone didn’t let the icon change', { type: 'error' })
    }
  }
  const flat = () => {
    setTossing(false)
    // back to 0° once both faces show the new icon (the faces' render first),
    // so no frame shows the old one
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        turn.value = 0
      })
    )
  }

  const choose = (id: AppIconId) => {
    if (tossing || id === faces.front) return
    if (still) {
      void landed(id)
      return
    }
    setFaces({ front: faces.front, back: id })
    setTossing(true)
    // up off the plate, three and a half turns, down onto the other face
    y.value = seq([8, -130, 0, -12, 0])
    scale.value = seq([0.94, 1.14, 1, 1, 1])
    turn.value = withSequence(
      withTiming(0, { duration: SEG[0][0] * TOSS_MS }),
      withTiming(630, { duration: SEG[1][0] * TOSS_MS, easing: SEG[1][1] }),
      withTiming(1260, { duration: SEG[2][0] * TOSS_MS, easing: SEG[2][1] }, done => {
        if (done) runOnJS(landed)(id)
      }),
      withTiming(1260, { duration: (1 - LAND) * TOSS_MS }, done => {
        if (done) runOnJS(setFaces)({ front: id, back: id })
        if (done) runOnJS(flat)()
      })
    )
    // its shadow on the plate shrinks and fades as it rises
    shadow.value = withSequence(
      withTiming(0.35, { duration: 0.47 * TOSS_MS }),
      withTiming(1, { duration: (LAND - 0.47) * TOSS_MS }),
      withTiming(1, { duration: (1 - LAND) * TOSS_MS })
    )
    // the plate takes the landing
    plate.value = withDelay(
      TOSS_MS * LAND - 40,
      withSequence(withTiming(0.94, { duration: 140 }), withTiming(1.03, { duration: 140 }), withTiming(1, { duration: 140 }))
    )
    // and a gold ring and sparks burst out
    burst.value = 0
    burst.value = withDelay(TOSS_MS * LAND, withTiming(1, { duration: 700, easing: Easing.bezier(0.2, 0.8, 0.3, 1) }))
  }

  // the coin turns by narrowing to its edge and widening again, and the angle
  // says which face is up: drawn flat, never mirrored (a 3D turn with hidden
  // back faces isn't kept in 3D by React Native, and lands showing a face
  // back to front)
  const coinStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: y.value },
      { scaleX: Math.max(Math.abs(Math.cos((turn.value * Math.PI) / 180)), 0.001) },
      { scale: scale.value }
    ]
  }))
  const frontStyle = useAnimatedStyle(() => ({ opacity: Math.cos((turn.value * Math.PI) / 180) >= 0 ? 1 : 0 }))
  const backStyle = useAnimatedStyle(() => ({ opacity: Math.cos((turn.value * Math.PI) / 180) < 0 ? 1 : 0 }))
  // the edge shows as the coin turns side-on
  const rimStyle = useAnimatedStyle(() => ({
    opacity: Math.abs(Math.sin((turn.value * Math.PI) / 180)),
    transform: [{ translateY: y.value }, { scale: scale.value }]
  }))
  const shadowStyle = useAnimatedStyle(() => ({ opacity: interpolate(shadow.value, [0.35, 1], [0.25, 1]), transform: [{ scale: shadow.value }] }))
  const plateStyle = useAnimatedStyle(() => ({ transform: [{ scale: plate.value }] }))
  const ringStyle = useAnimatedStyle(() => ({
    opacity: burst.value === 0 ? 0 : 0.9 * (1 - burst.value),
    transform: [{ scale: 0.6 + 1.3 * burst.value }]
  }))

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <PageHeader title="App icon" onBack={() => router.back()} />

      {/* the icon, big, on its plate, with room above for the toss */}
      <View style={styles.stage}>
        <View style={[styles.glow, { backgroundColor: palette.gold + '33', boxShadow: `0 0 80px 40px ${palette.gold}26` }]} />
        <Animated.View
          accessible
          accessibilityRole="image"
          accessibilityLabel={`App icon: ${APP_ICONS.find(i => i.id === current)?.name}`}
          style={[
            styles.plate,
            { boxShadow: dark ? '0 24px 60px -18px rgba(0,0,0,0.9), 0 0 0 1px rgba(0,0,0,0.05)' : '0 24px 60px -18px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.05)' },
            plateStyle
          ]}
        >
          {/* the coin's shadow on the plate */}
          <Animated.View style={[styles.shadow, shadowStyle]} />
          <Animated.View style={[styles.rim, rimStyle]} />
          <Animated.View style={[styles.coin, coinStyle]}>
            <Animated.View style={[styles.face, frontStyle]}>
              <AppIconLogo id={faces.front} size={COIN} />
            </Animated.View>
            <Animated.View style={[styles.face, backStyle]}>
              <AppIconLogo id={faces.back} size={COIN} />
            </Animated.View>
          </Animated.View>
        </Animated.View>
        {/* the landing: a gold ring and sparks */}
        <View pointerEvents="none" style={styles.burst}>
          <Animated.View style={[styles.ring, { borderColor: palette.gold }, ringStyle]} />
          {Array.from({ length: SPARKS }, (_, i) => (
            <Spark key={i} i={i} burst={burst} color={palette.gold} />
          ))}
        </View>
      </View>

      {/* the icons to choose from, in a row like a home screen's */}
      <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel="App icon">
        {APP_ICONS.map(icon => {
          const on = current === icon.id
          return (
            // transition-transform active:scale-95
            <View key={icon.id} style={styles.cell}>
              <PressScale
                scale={0.95}
                onPress={() => choose(icon.id)}
                disabled={tossing || !supported}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled: tossing || !supported }}
                accessibilityLabel={icon.name}
                style={styles.option}
              >
                {/* the tick after the tile, not in it: the tile's gold ring is its shadow, painted over its own children */}
                <View style={styles.tileWrap}>
                  <Animated.View
                    style={[
                      styles.tile,
                      {
                        // ring-1 ring-black/5 under the shadow, or the gold ring
                        // (as many shadows either way, so they ease one into the other)
                        boxShadow: on
                          ? `0 0 0 1px rgba(0,0,0,0.05), 0 0 0 3px ${palette.background}, 0 0 0 5.5px ${palette.gold}, 0 10px 24px -8px rgba(234,179,0,0.55)`
                          : '0 0 0 1px rgba(0,0,0,0.05), 0 6px 16px -6px rgba(0,0,0,0.25), 0 0 0 0 rgba(0,0,0,0), 0 0 0 0 rgba(0,0,0,0)',
                        // transition-[box-shadow,transform] duration-300
                        transitionProperty: 'boxShadow',
                        transitionDuration: still ? 0 : 300,
                        transitionTimingFunction: EASE
                      }
                    ]}
                  >
                    <AppIconLogo id={icon.id} size={54} />
                  </Animated.View>
                  {on && (
                    <Animated.View
                      style={[
                        styles.tick,
                        { backgroundColor: palette.gold, boxShadow: `0 0 0 2px ${palette.background}` },
                        // animate-in zoom-in-50 duration-300 (no fade: it's whole as it grows)
                        !still && enter({ opacity: 1, scale: 0.5, duration: 300 })
                      ]}
                    >
                      <Check size={12} color={palette.goldForeground} strokeWidth={3.5} />
                    </Animated.View>
                  )}
                </View>
                <Text style={[font(600), styles.name, { color: on ? palette.foreground : palette.mutedForeground }]}>{icon.name}</Text>
              </PressScale>
            </View>
          )
        })}
      </View>
      <BalancedText style={[font(400), styles.note, { color: palette.mutedForeground }]}>
        {supported ? 'Your home screen shows it too.' : 'This build of the app can’t change its home-screen icon.'}
      </BalancedText>
    </View>
  )
}

/** Tailwind's default transition curve, cubic-bezier(0.4, 0, 0.2, 1). */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

/** One spark, flying out from the landing. */
function Spark({ i, burst, color }: { i: number; burst: { value: number }; color: string }) {
  const a = (i / SPARKS) * Math.PI * 2
  const r = 120 + (i % 3) * 22
  const size = i % 2 ? 6 : 9
  const style = useAnimatedStyle(() => ({
    opacity: burst.value === 0 ? 0 : 1 - burst.value,
    transform: [{ translateX: Math.cos(a) * r * burst.value }, { translateY: Math.sin(a) * r * burst.value }, { scale: 1 - 0.7 * burst.value }]
  }))
  return (
    <Animated.View
      style={[
        styles.spark,
        { width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, backgroundColor: color, boxShadow: `0 0 8px 2px ${color}99` },
        style
      ]}
    />
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  stage: { height: 368, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 40 },
  glow: { position: 'absolute', left: 40, right: 40, top: 120, bottom: 20, borderRadius: 999 },
  plate: { width: 176, height: 176, borderRadius: 40, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  shadow: { position: 'absolute', bottom: 20, width: 96, height: 12, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.15)', boxShadow: '0 0 12px 4px rgba(0,0,0,0.15)' },
  rim: { position: 'absolute', width: RIM, height: COIN, borderRadius: RIM / 2, backgroundColor: '#b88a00' },
  coin: { width: COIN, height: COIN },
  face: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  burst: { position: 'absolute', bottom: 40 + 88, left: '50%', width: 0, height: 0 },
  ring: { position: 'absolute', width: 176, height: 176, left: -88, top: -88, borderRadius: 88, borderWidth: 3 },
  spark: { position: 'absolute', left: 0, top: 0, borderRadius: 999 },
  grid: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8 },
  cell: { flex: 1, alignItems: 'center' },
  option: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  tile: { width: 72, height: 72, borderRadius: 20, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  tileWrap: { width: 72, height: 72 },
  tick: { position: 'absolute', zIndex: 1, right: -6, top: -6, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 13, lineHeight: 18 },
  note: { fontSize: 12, lineHeight: 16, textAlign: 'center', paddingTop: 16 }
})
