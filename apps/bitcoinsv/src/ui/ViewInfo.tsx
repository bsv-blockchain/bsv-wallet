// The prototype's ViewInfo (components/view-info.tsx): the (i) beside a
// screen's title, opening a small card under it where the wallet says what
// the view does, a sentence a line. A tap anywhere puts it away. The card
// opens and closes as the prototype's popover (components/ui/popover.tsx):
// a 100ms fade and zoom from 95%, sliding 8pt down from its top right corner
// on the way in.
import React, { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import Animated, { css } from 'react-native-reanimated'
import { Info } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'
import { enter, useReducedMotion } from './motion'

const OUT = 100

/** animate-out fade-out-0 zoom-out-95 */
const popoverOut = css.keyframes({
  from: { opacity: 1, transform: [{ scale: 1 }] },
  to: { opacity: 0, transform: [{ scale: 0.95 }] }
})

/** One line per sentence, as the prototype splits them. */
const sentences = (text: string) =>
  text
    .split(/(?<=[.!?])\s+(?=[A-Z“"‘'])/)
    .map(s => s.trim())
    .filter(Boolean)

export function ViewInfo({ about, text }: { about: string; text: string }) {
  const palette = usePalette()
  const still = useReducedMotion()
  const { width: screen } = useWindowDimensions()
  const button = useRef<View>(null)
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  const [closing, setClosing] = useState(false)
  const open = () =>
    button.current?.measureInWindow((x, y, w, h) => {
      setClosing(false)
      setAt({ top: y + h + 8, right: Math.max(16, screen - (x + w)) })
    })
  const close = () => {
    if (still) return setAt(null)
    setClosing(true)
  }
  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => {
      setAt(null)
      setClosing(false)
    }, OUT)
    return () => clearTimeout(t)
  }, [closing])
  return (
    <>
      <Pressable
        ref={button}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`About ${about}`}
        hitSlop={6}
        style={({ pressed }) => [styles.button, pressed && { backgroundColor: palette.secondary }]}
      >
        <Info size={18} color={palette.mutedForeground} />
      </Pressable>
      <Modal transparent visible={!!at} animationType="none" statusBarTranslucent onRequestClose={close}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
        {at && (
          <Animated.View
            accessibilityViewIsModal
            style={[
              styles.card,
              {
                top: at.top,
                right: at.right,
                maxWidth: Math.min(320, screen - 32),
                backgroundColor: palette.popover,
                // shadow-md, ring-1 ring-foreground/10
                boxShadow: `0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1), 0 0 0 1px ${palette.foreground}1a`
              },
              still
                ? null
                : closing
                  ? { animationName: popoverOut, animationDuration: OUT, animationTimingFunction: 'ease', animationFillMode: 'both' }
                  : enter({ opacity: 0, scale: 0.95, translateY: -8, duration: 100 })
            ]}
          >
            {sentences(text).map(line => (
              <Text key={line} style={[font(400), styles.line, { color: palette.mutedForeground }]}>
                {line}
              </Text>
            ))}
          </Animated.View>
        )}
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  button: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  // it grows from the corner under the (i)
  card: { position: 'absolute', borderRadius: radii['3xl'], padding: 16, gap: 6, transformOrigin: 'top right' },
  line: { fontSize: 13, lineHeight: 21, textAlign: 'center' }
})
