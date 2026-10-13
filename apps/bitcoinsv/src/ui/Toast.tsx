// The prototype's toasts (app/layout.tsx's sonner <Toaster position=
// "bottom-center">, styled by components/ui/sonner.tsx): cards at the bottom
// of the screen, max(16, safe area) up, popover on a 1px border, 13px text,
// the type's lucide icon in the text colour, 4 seconds each. A new one rises
// from below over 400ms; the ones before it step back behind it (14pt up,
// 5% smaller each, three at most showing), sonner's collapsed stack.
//
//   showToast('Copied', { type: 'success' })
//   showToast('Ana deleted', { action: { label: 'Undo', onPress } })
//
// Same call as the core's showToast; the core's own ToastHost stays mounted
// for the core's screens.
import React, { useCallback, useEffect, useState } from 'react'
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CircleCheck, Info, OctagonX, TriangleAlert } from 'lucide-react-native'
import { haptics } from '@bsv/expo-wallet-toolbox'
import { font, radii, useIsDark, usePalette } from '../theme'
import { useReducedMotion } from './motion'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

type Entry = {
  id: number
  title?: string
  description?: string
  type?: ToastType
  /** sonner's action button: "Undo" */
  action?: { label: string; onPress: () => void }
  /** unstyled content, as sonner's toast.custom (the money toast) */
  render?: (dismiss: () => void) => React.ReactNode
  duration: number
}

/** sonner's defaults */
const DURATION = 4000
const GAP = 14
const VISIBLE = 3
const TIME = 400
// CSS `ease`
const EASE = Easing.bezier(0.25, 0.1, 0.25, 1)

let next = 0
const listeners = new Set<(e: Entry) => void>()
const dismissers = new Set<(id: number) => void>()

function push(e: Omit<Entry, 'id'>): number {
  const entry = { ...e, id: ++next }
  if (!listeners.size) console.warn('[Toast] host not mounted:', e.title)
  listeners.forEach(fn => fn(entry))
  return entry.id
}

export function showToast(
  message: string,
  opts?: { type?: ToastType; description?: string; duration?: number; action?: { label: string; onPress: () => void } }
): number {
  // as the core's toast: a tap of feedback for the outcome
  if (opts?.type === 'success') haptics.success()
  if (opts?.type === 'error') haptics.error()
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility([message, opts?.description].filter(Boolean).join('. '))
  return push({ title: message, description: opts?.description, type: opts?.type, action: opts?.action, duration: opts?.duration ?? DURATION })
}

/** sonner's toast.custom: your own card in the same stack. */
export function showCustomToast(render: (dismiss: () => void) => React.ReactNode, opts?: { duration?: number }): number {
  return push({ render, duration: opts?.duration ?? DURATION })
}

export function dismissToast(id: number) {
  dismissers.forEach(fn => fn(id))
}

type Item = { entry: Entry; removed: boolean; lastIndex: number }

export function ToastHost() {
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<Item[]>([])
  const [heights, setHeights] = useState<Record<number, number>>({})

  const dismiss = useCallback((id: number) => {
    setItems(list => {
      const live = list.filter(i => !i.removed)
      const index = live.findIndex(i => i.entry.id === id)
      if (index < 0) return list
      return list.map(i => (i.entry.id === id ? { ...i, removed: true, lastIndex: index } : i))
    })
    // gone once its exit has played
    setTimeout(() => {
      setItems(list => list.filter(i => i.entry.id !== id))
      setHeights(({ [id]: _, ...rest }) => rest)
    }, TIME + 100)
  }, [])

  useEffect(() => {
    const add = (entry: Entry) => setItems(list => [{ entry, removed: false, lastIndex: 0 }, ...list])
    listeners.add(add)
    dismissers.add(dismiss)
    return () => {
      listeners.delete(add)
      dismissers.delete(dismiss)
    }
  }, [dismiss])

  const onHeight = useCallback((id: number, h: number) => setHeights(all => (all[id] === h ? all : { ...all, [id]: h })), [])

  if (!items.length) return null
  const live = items.filter(i => !i.removed)
  const frontHeight = (live[0] && heights[live[0].entry.id]) || 0
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: Math.max(16, insets.bottom) }]}>
      <View pointerEvents="box-none" style={[styles.column, { height: frontHeight }]}>
        {items.map((item, i) => {
          const index = item.removed ? item.lastIndex : live.indexOf(item)
          return (
            <ToastCard
              key={item.entry.id}
              entry={item.entry}
              index={index}
              removed={item.removed}
              height={heights[item.entry.id] ?? 0}
              frontHeight={frontHeight}
              zIndex={items.length - i}
              onHeight={onHeight}
              dismiss={dismiss}
            />
          )
        })}
      </View>
    </View>
  )
}

function ToastCard({
  entry,
  index,
  removed,
  height,
  frontHeight,
  zIndex,
  onHeight,
  dismiss
}: {
  entry: Entry
  index: number
  removed: boolean
  /** its own height, once measured */
  height: number
  frontHeight: number
  zIndex: number
  onHeight: (id: number, h: number) => void
  dismiss: (id: number) => void
}) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const front = index === 0
  const styled = !entry.render
  const mounted = height > 0

  // its own clock, from when it's on screen
  useEffect(() => {
    if (!mounted || removed) return
    const t = setTimeout(() => dismiss(entry.id), entry.duration)
    return () => clearTimeout(t)
  }, [mounted, removed, entry.id, entry.duration, dismiss])

  // sonner's --y, scale, opacity and height, each eased over 400ms
  const y = useSharedValue(0)
  const scale = useSharedValue(1)
  const opacity = useSharedValue(0)
  const content = useSharedValue(1)
  const h = useSharedValue(0)
  useEffect(() => {
    if (!mounted) return
    const time = (ms: number) => ({ duration: still ? 0 : ms, easing: EASE })
    // first frame: below its own bottom edge, then up into place
    if (h.value === 0) {
      y.value = still ? 0 : height
      h.value = height
    }
    let toY: number
    let toOpacity: number
    let yTime = TIME
    let opacityTime = still ? 200 : TIME
    if (removed && front) {
      // the front one drops back down the way it came
      toY = still ? 0 : height
      toOpacity = 0
    } else if (removed) {
      toY = still ? 0 : height * 0.4
      toOpacity = 0
      yTime = 500
      opacityTime = 200
    } else {
      toY = -GAP * index
      toOpacity = index < VISIBLE ? 1 : 0
    }
    y.value = withTiming(toY, time(yTime))
    opacity.value = withTiming(toOpacity, { duration: opacityTime, easing: EASE })
    scale.value = withTiming(removed && front ? 1 : 1 - 0.05 * index, time(TIME))
    // behind the front one, a card is cut to its height, its words faded
    h.value = withTiming(front || !frontHeight ? height : frontHeight, time(TIME))
    content.value = withTiming(front ? 1 : 0, { duration: still ? 0 : TIME, easing: EASE })
  }, [mounted, removed, front, index, height, frontHeight, still, y, scale, opacity, content, h])

  const cardStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    height: h.value || undefined,
    transform: [{ translateY: y.value }, { scale: scale.value }]
  }))
  const contentStyle = useAnimatedStyle(() => ({ opacity: content.value }))

  const onLayout = (e: LayoutChangeEvent) => {
    // the card's border is outside the measured content
    const natural = Math.ceil(e.nativeEvent.layout.height) + (styled ? 2 : 0)
    if (Math.abs(natural - height) > 0.5) onHeight(entry.id, natural)
  }

  const Icon = entry.type === 'success' ? CircleCheck : entry.type === 'error' ? OctagonX : entry.type === 'warning' ? TriangleAlert : entry.type === 'info' ? Info : null
  const interactive = front && !removed && (!!entry.action || !!entry.render)

  return (
    <Animated.View
      pointerEvents={interactive ? 'box-none' : 'none'}
      accessibilityLiveRegion="polite"
      style={[
        styles.card,
        { zIndex },
        // behind the front one a card is cut to its height (a custom card's
        // own shadow stays: its words are faded out there anyway)
        styled && {
          overflow: 'hidden',
          backgroundColor: palette.popover,
          borderColor: palette.border,
          borderWidth: 1,
          borderRadius: radii.lg,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
        },
        cardStyle
      ]}
    >
      <Animated.View onLayout={onLayout} style={[styled && styles.row, contentStyle]}>
        {entry.render ? (
          entry.render(() => dismiss(entry.id))
        ) : (
          <>
            {Icon && (
              <View style={styles.icon}>
                <Icon size={16} color={palette.popoverForeground} />
              </View>
            )}
            <View style={styles.text}>
              <Text style={[font(500), styles.title, { color: palette.popoverForeground }]}>{entry.title}</Text>
              {entry.description ? (
                <Text style={[font(400), styles.description, { color: dark ? '#e8e8e8' : '#3f3f3f' }]}>{entry.description}</Text>
              ) : null}
            </View>
            {entry.action && (
              <Pressable
                onPress={() => {
                  entry.action!.onPress()
                  dismiss(entry.id)
                }}
                accessibilityRole="button"
                hitSlop={10}
                style={[styles.button, { backgroundColor: palette.popoverForeground }]}
              >
                <Text style={[font(500), styles.buttonText, { color: palette.popover }]}>{entry.action.label}</Text>
              </Pressable>
            )}
          </>
        )}
      </Animated.View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  // mobile: 16 from each side; the toaster is 356 wide at most
  wrap: { position: 'absolute', left: 16, right: 16, zIndex: 10001, alignItems: 'center' },
  column: { width: '100%', maxWidth: 356 },
  card: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 16, flexShrink: 0 },
  icon: { width: 16, height: 16, marginLeft: -3, marginRight: 4, justifyContent: 'center' },
  text: { flexShrink: 1, gap: 2 },
  title: { fontSize: 13, lineHeight: 19.5 },
  description: { fontSize: 13, lineHeight: 18.2 },
  button: { marginLeft: 'auto', height: 24, borderRadius: 4, paddingHorizontal: 8, justifyContent: 'center', flexShrink: 0 },
  buttonText: { fontSize: 12, lineHeight: 16 }
})
