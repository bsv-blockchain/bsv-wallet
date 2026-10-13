// The prototype's BottomSheet (components/ui/bottom-sheet.tsx on vaul): slides
// up from the bottom edge with vaul's 500ms cubic-bezier(0.32, 0.72, 0, 1),
// over a light dim and a little blur (the overlay's bg-black/10 backdrop-blur-xs);
// drag it down (or tap outside) to dismiss, as vaul does: the dim follows the
// sheet, a quarter of the way or a flick closes it, anything less springs
// back, and a pull upwards gives a little. The body scrolls first: the sheet
// only drags once it's back at its top. Rounded top, a grab handle, a
// centred title with an optional line under it, and a body that scrolls when
// it overflows.
import React, { useEffect, useRef, useState } from 'react'
import { usePathname } from 'expo-router'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent
} from 'react-native'
import Animated, {
  Easing,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BlurView } from 'expo-blur'
import { ArrowLeft, X } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { useReducedMotion } from './motion'
import { BalancedText } from './BalancedText'

const VAUL = Easing.bezier(0.32, 0.72, 0, 1)
const DURATION = 500
/** vaul's CLOSE_THRESHOLD and VELOCITY_THRESHOLD (0.4 px/ms) */
const CLOSE_AT = 0.25
const FLICK = 400

/** vaul's dampenValue: how far a pull upwards actually moves the sheet. */
function rubber(pulled: number) {
  'worklet'
  return Math.max(0, 8 * (Math.log(pulled + 1) - 2))
}

/** Sheets on their way out: still mounted, sliding down. */
let closing = 0
const waiting: (() => void)[] = []
/** How long iOS takes to tear a modal down once its view is gone. */
const SETTLE = 120

function settled() {
  if (closing > 0) return
  const run = waiting.splice(0)
  if (run.length) setTimeout(() => run.forEach(fn => fn()), SETTLE)
}

/**
 * Run `fn` once every sheet that's closing has actually gone, not after a
 * guess at how long that takes: iOS won't present a modal over one still on
 * its way out, and a new modal mounted while another is being removed can
 * crash React Native's mounting (unmountChildComponentView). A busy JS thread
 * makes a close finish late, so this waits for the sheet itself to say so
 * (with a cap, so nothing waits for ever).
 */
export function afterSheetCloses(fn: () => void) {
  let done = false
  const once = () => {
    if (done) return
    done = true
    fn()
  }
  // a frame for the sheet just told to close to say it's closing
  setTimeout(() => {
    if (closing === 0) once()
    else waiting.push(once)
  }, 50)
  setTimeout(once, DURATION + 2500)
}

export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  onBack,
  action,
  hideHeader = false,
  fullScreen = false,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** one line under the title */
  description?: string
  /** a round back button left of the title (a step inside the sheet) */
  onBack?: () => void
  /** a button right of the title */
  action?: React.ReactNode
  /** no header row: the title is kept for screen readers only */
  hideHeader?: boolean
  /** cover the whole screen (no top gap, square corners, a close button); the body scrolls */
  fullScreen?: boolean
  children: React.ReactNode
}) {
  const palette = usePalette()
  const dark = useIsDark()
  const insets = useSafeAreaInsets()
  const { height: screen } = useWindowDimensions()
  const still = useReducedMotion()
  // stays mounted through the closing slide
  const [mounted, setMounted] = useState(open)
  const [height, setHeight] = useState(0)
  const offset = useSharedValue(screen)
  const dim = useSharedValue(0)
  const duration = still ? 0 : DURATION

  useEffect(() => {
    if (open) setMounted(true)
  }, [open])

  // another screen opened over this one (a link, a toast): the sheet goes, so
  // it can't sit on top of the new screen
  const pathname = usePathname()
  const openedOn = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      openedOn.current = null
      return
    }
    if (openedOn.current === null) openedOn.current = pathname
    else if (openedOn.current !== pathname) onOpenChange(false)
  }, [open, pathname, onOpenChange])

  // counted while it's on its way out, for afterSheetCloses
  const counted = useRef(false)
  useEffect(() => {
    if (!open && mounted && !counted.current) {
      counted.current = true
      closing++
    } else if ((open || !mounted) && counted.current) {
      counted.current = false
      closing--
      settled()
    }
  }, [open, mounted])
  useEffect(
    () => () => {
      if (!counted.current) return
      counted.current = false
      closing--
      settled()
    },
    []
  )

  useEffect(() => {
    if (!mounted || !height) return
    if (open) {
      offset.value = withTiming(0, { duration, easing: VAUL })
      dim.value = withTiming(1, { duration, easing: VAUL })
    } else {
      offset.value = withTiming(height, { duration, easing: VAUL }, done => {
        if (done) runOnJS(setMounted)(false)
      })
      dim.value = withTiming(0, { duration, easing: VAUL })
    }
  }, [open, mounted, height, duration, offset, dim])

  const close = () => onOpenChange(false)

  // where the body's scroll is, and whether it has anywhere to scroll
  const scrollY = useSharedValue(0)
  const scrollable = useSharedValue(false)
  const viewport = useRef(0)
  const content = useRef(0)
  const measureScroll = () => {
    scrollable.value = content.current > viewport.current + 1
  }
  const onScroll = useAnimatedScrollHandler(e => {
    scrollY.value = e.contentOffset.y
  })

  // the drag starts counting from where the sheet took over from the scroll
  const anchored = useSharedValue(false)
  const base = useSharedValue(0)
  const sheetHeight = useSharedValue(0)
  useEffect(() => {
    sheetHeight.value = height
  }, [height, sheetHeight])

  /**
   * Drag to dismiss, as vaul. `followScroll`: the body's own drag, which
   * leaves it to scroll until it's at its top (and lets a body that scrolls
   * take an upward pull); the handle and header drag the sheet straight away.
   */
  const dragGesture = (enabled: boolean, followScroll: boolean) =>
    Gesture.Pan()
      .enabled(enabled)
      .activeOffsetY([-8, 8])
      .failOffsetX([-16, 16])
      .onStart(() => {
        anchored.value = false
      })
      .onUpdate(e => {
        if (followScroll && scrollY.value > 0.5) {
          anchored.value = false
          return
        }
        if (!anchored.value) {
          anchored.value = true
          base.value = e.translationY
        }
        const d = e.translationY - base.value
        if (d >= 0) offset.value = d
        else if (followScroll && scrollable.value) {
          // up is the body's: it scrolls
          offset.value = 0
          anchored.value = false
        } else offset.value = -rubber(-d)
        const h = sheetHeight.value || 1
        dim.value = 1 - Math.min(1, Math.max(0, offset.value) / h)
      })
      .onEnd(e => {
        const down = offset.value
        if (down > 0 && (down >= sheetHeight.value * CLOSE_AT || e.velocityY > FLICK)) {
          runOnJS(close)()
        } else if (down !== 0) {
          offset.value = withTiming(0, { duration: DURATION, easing: VAUL })
          dim.value = withTiming(1, { duration: DURATION, easing: VAUL })
        }
      })
  // the body's scroll and its drag both see every touch
  const scrollGesture = Gesture.Native()
  const bodyDrag = dragGesture(!fullScreen, true).simultaneousWithExternalGesture(scrollGesture)
  scrollGesture.simultaneousWithExternalGesture(bodyDrag)
  const headerDrag = dragGesture(true, false)

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }))
  const overlayStyle = useAnimatedStyle(() => ({ opacity: dim.value }))

  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height
    if (!height) offset.value = h
    if (Math.abs(h - height) > 1) setHeight(h)
  }

  // full-screen sheets can't be dragged away easily, so they get an X
  const right =
    action ??
    (fullScreen ? (
      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[styles.back, { backgroundColor: palette.secondary }]}
      >
        <X size={16} color={palette.foreground} />
      </Pressable>
    ) : undefined)

  if (!mounted) return null
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, overlayStyle]}>
          {/* backdrop-blur-xs under the dim, fading with it (Android's blur
              needs its target view, which a modal can't reach: the dim alone) */}
          {Platform.OS === 'ios' && <BlurView intensity={12} tint={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />}
          <Pressable style={[StyleSheet.absoluteFill, styles.overlay]} onPress={close} accessibilityLabel="Close" />
        </Animated.View>
        {/* a translucent modal isn't resized for the keyboard on Android either */}
        <KeyboardAvoidingView behavior="padding" style={styles.anchor} pointerEvents="box-none">
          <Animated.View
            onLayout={onLayout}
            accessibilityViewIsModal
            style={[
              styles.sheet,
              { maxHeight: screen * 0.92, backgroundColor: palette.popover, borderTopColor: palette.border },
              // fills the space above the keyboard rather than being pushed up past the top
              fullScreen && [styles.full, styles.fill, { maxHeight: screen, paddingTop: insets.top }],
              // first layout happens off screen, then it slides up
              !height && { opacity: 0 },
              sheetStyle
            ]}
          >
            {/* vaul's ::after: the sheet carries on below its edge, for a pull upwards */}
            {!fullScreen && <View style={[styles.below, { backgroundColor: palette.popover }]} />}
            <GestureDetector gesture={headerDrag}>
              <View>
                <View style={[styles.handle, { backgroundColor: palette.muted }]} />
                {!hideHeader && (
                  <View style={styles.header}>
                    {onBack || right ? (
                      // equal side columns keep the title centred; a long title
                      // takes what's left and ends in an ellipsis
                      <View style={styles.titleRow}>
                        <View style={styles.side}>
                          {onBack && (
                            <Pressable
                              onPress={onBack}
                              accessibilityRole="button"
                              accessibilityLabel="Back"
                              style={[styles.back, { backgroundColor: palette.secondary }]}
                            >
                              <ArrowLeft size={16} color={palette.foreground} />
                            </Pressable>
                          )}
                        </View>
                        <Text numberOfLines={1} accessibilityRole="header" style={[font(700), styles.title, { color: palette.popoverForeground }]}>
                          {title}
                        </Text>
                        <View style={[styles.side, styles.right]}>{right}</View>
                      </View>
                    ) : (
                      <Text accessibilityRole="header" style={[font(700), styles.title, styles.wide, { color: palette.popoverForeground }]}>
                        {title}
                      </Text>
                    )}
                    {description && (
                      <BalancedText style={[font(400), styles.description, { color: palette.mutedForeground }]}>
                        {description}
                      </BalancedText>
                    )}
                  </View>
                )}
              </View>
            </GestureDetector>
            <GestureDetector gesture={bodyDrag}>
              <Animated.View collapsable={false} style={[styles.shrink, fullScreen && styles.fill]}>
                <GestureDetector gesture={scrollGesture}>
                  <Animated.ScrollView
                    keyboardShouldPersistTaps="handled"
                    bounces={false}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                    onLayout={e => {
                      viewport.current = e.nativeEvent.layout.height
                      measureScroll()
                    }}
                    onContentSizeChange={(_, h) => {
                      content.current = h
                      measureScroll()
                    }}
                    style={fullScreen ? styles.fill : undefined}
                    contentContainerStyle={[styles.body, fullScreen && styles.grow, { paddingBottom: Math.max(40, insets.bottom) }]}
                  >
                    {children}
                  </Animated.ScrollView>
                </GestureDetector>
              </Animated.View>
            </GestureDetector>
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { backgroundColor: 'rgba(0,0,0,0.1)' },
  anchor: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    marginTop: 24,
    borderTopLeftRadius: radii['3xl'],
    borderTopRightRadius: radii['3xl'],
    borderTopWidth: 1
  },
  below: { position: 'absolute', left: 0, right: 0, top: '100%', height: 200 },
  handle: { alignSelf: 'center', marginTop: 16, height: 4, width: 100, borderRadius: 2 },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 2, alignItems: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  side: { flex: 1, flexDirection: 'row', gap: 8 },
  right: { justifyContent: 'flex-end' },
  full: { marginTop: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, borderTopWidth: 0 },
  fill: { flex: 1 },
  shrink: { flexShrink: 1 },
  grow: { flexGrow: 1 },
  back: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  title: { flexShrink: 1, textAlign: 'center', fontSize: 18, lineHeight: 28 },
  wide: { alignSelf: 'stretch' },
  description: { textAlign: 'center', fontSize: 12, lineHeight: 16 },
  body: { gap: 16, paddingHorizontal: 16, paddingTop: 4 }
})
