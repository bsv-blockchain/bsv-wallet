// The prototype's PageHeader (components/shell/page-header.tsx): a round
// back button, the title centred (or, given, something in its place), an
// optional action on the right. `align="left"` is the list pages' own header
// (Activity, Contacts): the title left, text-2xl bold, beside the back button.
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
import { font, usePalette } from '../theme'

export function PageHeader({
  title,
  onBack,
  action,
  center,
  backRef,
  align = 'center'
}: {
  title: string
  /** shown in the title's place (a coin's docked pill) */
  center?: React.ReactNode
  onBack?: () => void
  action?: React.ReactNode
  /** the back button, for a tap hint to point at */
  backRef?: React.Ref<View>
  align?: 'center' | 'left'
}) {
  const palette = usePalette()
  const router = useRouter()
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))
  return (
    <View style={[styles.bar, align === 'left' && styles.barLeft]}>
      {/* size-8 (32) in the bar's 36 slot; active:translate-y-px */}
      <View style={styles.round}>
        <Pressable
          ref={backRef}
          onPress={back}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={4}
          style={({ pressed }) => [styles.back, { backgroundColor: palette.secondary }, pressed && styles.down]}
        >
          <ArrowLeft size={16} color={palette.foreground} />
        </Pressable>
      </View>
      {center ? (
        <View style={styles.center}>{center}</View>
      ) : (
        <Text numberOfLines={1} accessibilityRole="header" style={[font(700), align === 'left' ? styles.titleLeft : styles.title, { color: palette.foreground }]}>
          {title}
        </Text>
      )}
      {action ?? (align === 'left' ? null : <View style={styles.round} />)}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  back: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  down: { transform: [{ translateY: 1 }] },
  center: { flex: 1, alignItems: 'center' },
  barLeft: { gap: 12, paddingTop: 8 },
  titleLeft: { flex: 1, fontSize: 24, lineHeight: 32, letterSpacing: -0.6 },
  title: { flex: 1, textAlign: 'center', fontSize: 20, lineHeight: 28, letterSpacing: -0.5 }
})
