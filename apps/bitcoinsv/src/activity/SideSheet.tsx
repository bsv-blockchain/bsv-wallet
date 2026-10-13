// The prototype's side sheet (components/ui/sheet.tsx, side="right", as
// activity-filter-sheet.tsx opens it): a full-height panel at the right edge,
// rounded on its left (rounded-l-3xl), over a 10% black dim. It slides in
// 40px and fades (slide-in-from-right-10, 200ms ease-in-out) while the dim
// fades in over 100ms; it leaves the same way. A header (title and a line
// under it) with the close button, a body that scrolls, and a footer on a
// hairline. Swipe it right or tap the dim to close.
import React, { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'
import { useReducedMotion } from '../ui/motion'

/** ease-in-out */
const EASE = Easing.bezier(0.42, 0, 0.58, 1)
const SLIDE = 40
/** w-full sm:max-w-sm: the whole width on a phone, 384 from 640 up (a tablet) */
const MAX_WIDTH = 384
const SM = 640

export function SideSheet({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** pinned under the body, on a border-t */
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const { width: screen } = useWindowDimensions()
  const still = useReducedMotion()
  const width = screen >= SM ? MAX_WIDTH : screen
  // stays mounted through the closing slide
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  const shift = useSharedValue(SLIDE)
  const shown = useSharedValue(0)
  const dim = useSharedValue(0)

  useEffect(() => {
    if (!mounted) return
    const sheet = { duration: still ? 0 : 200, easing: EASE }
    const fade = { duration: still ? 0 : 100, easing: EASE }
    if (open) {
      shift.set(withTiming(0, sheet))
      shown.set(withTiming(1, sheet))
      dim.set(withTiming(1, fade))
    } else {
      shift.set(withTiming(SLIDE, sheet))
      dim.set(withTiming(0, fade))
      shown.set(
        withTiming(0, sheet, done => {
          if (done) runOnJS(setMounted)(false)
        })
      )
    }
  }, [open, mounted, still, shift, shown, dim])

  const close = () => onOpenChange(false)

  // swipe it back off to the right: a quarter of the way, or a flick
  const drag = Gesture.Pan()
    .activeOffsetX(8)
    .failOffsetY([-12, 12])
    .onUpdate(e => {
      shift.set(Math.max(0, e.translationX))
    })
    .onEnd(e => {
      if (e.translationX > width * 0.25 || e.velocityX > 800) runOnJS(close)()
      else shift.set(withTiming(0, { duration: 200, easing: EASE }))
    })

  const sheetStyle = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateX: shift.get() }] }))
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.get() }))

  if (!mounted) return null
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
        </Animated.View>
        <GestureDetector gesture={drag}>
          <Animated.View
            accessibilityViewIsModal
            style={[styles.sheet, { width, backgroundColor: palette.popover }, sheetStyle]}
          >
            {/* SheetHeader px-5 pt-5: SheetTitle text-lg bold, SheetDescription text-sm */}
            <View style={[styles.header, { paddingTop: insets.top + 20 }]}>
              <Text accessibilityRole="header" style={[font(700), styles.title, { color: palette.popoverForeground }]}>
                {title}
              </Text>
              {description ? <Text style={[font(400), styles.description, { color: palette.mutedForeground }]}>{description}</Text> : null}
            </View>
            {/* the close button, ghost icon-sm at top-3 right-3 */}
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={6}
              style={({ pressed }) => [styles.close, { top: insets.top + 12 }, pressed && { backgroundColor: palette.secondary }]}
            >
              <X size={16} color={palette.foreground} />
            </Pressable>
            <ScrollView style={styles.fill} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
            {footer ? (
              <View style={[styles.footer, { borderTopColor: palette.border, paddingBottom: Math.max(20, insets.bottom) }]}>{footer}</View>
            ) : null}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  dim: { backgroundColor: 'rgba(0,0,0,0.1)' },
  sheet: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radii['3xl'],
    borderBottomLeftRadius: radii['3xl'],
    overflow: 'hidden',
    // shadow-lg
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)'
  },
  header: { gap: 2, paddingHorizontal: 20, paddingBottom: 16, paddingRight: 52 },
  title: { fontSize: 18, lineHeight: 28 },
  description: { fontSize: 14, lineHeight: 20 },
  close: { position: 'absolute', right: 12, width: 32, height: 32, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
  // flex-col gap-7 px-5 pb-4 pt-2
  body: { gap: 28, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  footer: { gap: 8, paddingHorizontal: 20, paddingTop: 16, borderTopWidth: 1 }
})
