// The recovery phrase's pieces (the prototype's components/backup-sheet.tsx):
// a word with its first four letters bold, writing mode (four words at a
// time, very large), all twelve large, the speak button, the keep-safe hints
// carousel, and the small marks the steps use.
import React, { useEffect, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Speech from 'expo-speech'
import { Check, ChevronLeft, ChevronRight, Volume2, X } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { barFill, enter, useReducedMotion } from '../ui/motion'
import { BalancedText } from '../ui/BalancedText'

/**
 * Word n's background in writing mode: oklch(0.34 0.075 85+n·22), one step
 * along the colour wheel per word, from gold through green and blue to
 * violet. Dark and muted, so white text stays readable on every one.
 */
const WORD_TINTS = ['#4a3400', '#3d3a00', '#2c3f10', '#134323', '#004434', '#004344', '#004151', '#023c5a', '#21375e', '#33325d', '#412d57', '#4c294c']

const WRITING_INK = '#161618'

/** Tailwind's default transition curve, cubic-bezier(0.4, 0, 0.2, 1). */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

/** 12 words as three groups of four. */
export function groupsOfFour(words: string[]): string[][] {
  return [0, 4, 8].map(i => words.slice(i, i + 4))
}

/**
 * Four words, numbered down each column like a list on paper (1 2 | 3 4):
 * CSS grid-flow-col over two rows.
 */
export function Columns<T>({ items, gap, rowGap, render }: { items: T[]; gap: number; rowGap: number; render: (item: T, i: number) => React.ReactNode }) {
  return (
    <View style={[styles.columns, { gap }]}>
      {[0, 2].map(c => (
        <View key={c} style={[styles.column, { gap: rowGap }]}>
          {items.slice(c, c + 2).map((item, k) => (
            <React.Fragment key={k}>{render(item, c + k)}</React.Fragment>
          ))}
        </View>
      ))}
    </View>
  )
}

/**
 * A recovery word with its first four letters in bold: those four are
 * unique across the whole word list, so they're what has to be right.
 */
export function Word({ w, size, color, style }: { w: string; size: number; color: string; style?: TextStyle }) {
  return (
    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.word, { fontSize: size, lineHeight: size * 1.15, color }, style]}>
      <Text style={font(800)}>{w.slice(0, 4)}</Text>
      <Text style={[font(400), { color: color + '99' }]}>{w.slice(4)}</Text>
    </Text>
  )
}

/**
 * Says the word out loud (the device's own voice, nothing leaves the
 * phone), for anyone unsure how it's spelled or read.
 */
export function SpeakButton({ word, disabled = false, large = false }: { word: string; disabled?: boolean; large?: boolean }) {
  const palette = usePalette()
  const speak = () => {
    void Speech.stop()
    Speech.speak(word, { language: 'en-US', rate: 0.8 })
  }
  return (
    <Pressable
      onPress={speak}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Say "${word}"`}
      hitSlop={4}
      style={({ pressed }) => [
        large ? styles.speakLarge : styles.speak,
        large && { backgroundColor: pressed ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)' },
        !large && pressed && { backgroundColor: palette.background }
      ]}
    >
      <Volume2 size={large ? 20 : 16} color={large ? 'rgba(255,255,255,0.8)' : palette.mutedForeground} />
    </Pressable>
  )
}

/** A full-screen dark layer over the sheet: writing mode and the large words. */
function Overlay({ label, dim, onRequestClose, children }: { label: string; dim: number; onRequestClose: () => void; children: React.ReactNode }) {
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onRequestClose}>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={label}
        style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${dim})` }, enter({ opacity: 0, duration: 200 })]}
      >
        {children}
      </Animated.View>
    </Modal>
  )
}

/**
 * Writing mode: four words at a time, very large, so the phrase goes onto
 * paper in order without skipping or swapping. Next moves on; the last
 * group's Done goes straight on to the check.
 */
export function WritingMode({
  words,
  group,
  onGroup,
  onClose,
  onDone
}: {
  words: string[]
  group: number
  onGroup: (g: number) => void
  onClose: () => void
  onDone: () => void
}) {
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  const groups = groupsOfFour(words)
  const last = group === groups.length - 1
  return (
    <Overlay label={`Writing mode, words ${group * 4 + 1} to ${group * 4 + 4}`} dim={0.95} onRequestClose={onClose}>
      <View style={[styles.writing, { paddingTop: Math.max(16, insets.top), paddingBottom: Math.max(24, insets.bottom) }]}>
        <View style={styles.writingHead}>
          <Text style={[font(600), styles.headText]}>
            Words {group * 4 + 1}–{group * 4 + 4} of 12
          </Text>
          <CloseButton label="Close writing mode" onPress={onClose} />
        </View>
        {/* one word after another, spread over two seconds, so the eye follows them in order */}
        <View key={group} style={styles.writingList}>
          {groups[group].map((w, i) => (
            <Animated.View
              key={i}
              style={[
                styles.writingRow,
                { backgroundColor: WORD_TINTS[group * 4 + i] },
                still ? null : enter({ opacity: 0, translateY: 12, duration: 500, delay: i * 500, easing: 'ease-out' })
              ]}
            >
              <View style={styles.writingNum}>
                <Text style={[font(700), styles.writingNumText]}>{group * 4 + i + 1}</Text>
              </View>
              <View style={styles.flex}>
                <Word w={w} size={36} color="#ffffff" style={styles.tight} />
              </View>
              <SpeakButton word={w} large />
            </Animated.View>
          ))}
        </View>
        <View style={styles.writingFoot}>
          <View style={styles.progress}>
            {groups.map((_, i) => (
              // transition-all: the current group's pill widens
              <Animated.View
                key={i}
                style={[
                  styles.progressDot,
                  i === group ? styles.progressOn : styles.progressOff,
                  { transitionProperty: ['width', 'backgroundColor'], transitionDuration: 150, transitionTimingFunction: EASE }
                ]}
              />
            ))}
          </View>
          <View style={styles.buttons}>
            {group > 0 && (
              <Pressable onPress={() => onGroup(group - 1)} accessibilityRole="button" style={styles.ghost}>
                <Text style={[font(600), styles.ghostText]}>Back</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => (last ? onDone() : onGroup(group + 1))}
              accessibilityRole="button"
              style={({ pressed }) => [styles.solid, pressed && { transform: [{ scale: 0.98 }] }]}
            >
              <Text style={[font(600), styles.solidText]}>{last ? 'Done, I wrote all 12' : 'Next 4 words'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Overlay>
  )
}

/**
 * The phrase in large type: all twelve words big, in three groups of four,
 * each numbered, so it can be copied onto paper without losing your place.
 * Tap anywhere to close.
 */
export function LargeWords({ words, onClose }: { words: string[]; onClose: () => void }) {
  return (
    <Overlay label="Recovery phrase, large" dim={0.9} onRequestClose={onClose}>
      <Pressable onPress={onClose} accessible={false} style={styles.large}>
        <Text style={[font(600), styles.headText]}>Your recovery phrase</Text>
        {/* three clear groups of four: more room between groups than within */}
        <View style={styles.largeGroups}>
          {groupsOfFour(words).map((g, gi) => (
            <Columns
              key={gi}
              items={g}
              gap={10}
              rowGap={10}
              render={(w, wi) => (
                <View style={styles.largeItem}>
                  <View style={styles.largeNum}>
                    <Text style={[font(700), styles.largeNumText]}>{gi * 4 + wi + 1}</Text>
                  </View>
                  <View style={styles.flex}>
                    <Word w={w} size={24} color="#ffffff" style={styles.tight} />
                  </View>
                </View>
              )}
            />
          ))}
        </View>
        <Pressable onPress={onClose} accessibilityRole="button" style={[styles.ghost, styles.largeDone]}>
          <Text style={[font(600), styles.ghostText]}>Done</Text>
        </Pressable>
      </Pressable>
    </Overlay>
  )
}

function CloseButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.close, { backgroundColor: pressed ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.1)' }]}
    >
      <X size={16} color="#ffffff" />
    </Pressable>
  )
}

/** How long each keep-safe hint shows before the next. */
const HINT_MS = 5000

/**
 * The keep-safe hints, one at a time: they move on by themselves (the
 * active bar fills as it waits), and the arrows or bars jump by hand.
 */
export function KeepSafeHints({ hints, label }: { hints: readonly string[]; label: string }) {
  const palette = usePalette()
  const dark = useIsDark()
  const [i, setI] = useState(0)
  // bumped on every move, so the bar restarts even when landing on the same hint
  const [cycle, setCycle] = useState(0)
  const n = hints.length
  const go = (to: number) => {
    setI(((to % n) + n) % n)
    setCycle(c => c + 1)
  }
  useEffect(() => {
    const t = setTimeout(() => {
      setI(x => (x + 1) % n)
      setCycle(c => c + 1)
    }, HINT_MS)
    return () => clearTimeout(t)
  }, [cycle, n])
  const arrow = [styles.arrow, { backgroundColor: dark ? '#000000' : '#ffffff', boxShadow: `0 0 0 1px ${palette.border}` }]
  return (
    <View accessibilityLabel={label} style={styles.hints}>
      <View style={styles.hintRow}>
        <Pressable onPress={() => go(i - 1)} accessibilityRole="button" accessibilityLabel="Previous tip" style={arrow}>
          <ChevronLeft size={16} color={palette.foreground} />
        </Pressable>
        <Animated.View key={i} style={[styles.hintBox, enter({ opacity: 0, duration: 500 })]}>
          <BalancedText accessibilityLiveRegion="polite" style={[font(400), styles.hintText, { color: palette.foreground }]}>
            {hints[i]}
          </BalancedText>
        </Animated.View>
        <Pressable onPress={() => go(i + 1)} accessibilityRole="button" accessibilityLabel="Next tip" style={arrow}>
          <ChevronRight size={16} color={palette.foreground} />
        </Pressable>
      </View>
      {/* the current tip as a bar that fills; the rest as dots */}
      <View style={styles.hintBars}>
        {hints.map((t, k) => (
          <Pressable
            key={t}
            onPress={() => go(k)}
            accessibilityRole="button"
            accessibilityLabel={`Tip ${k + 1} of ${n}`}
            hitSlop={8}
          >
            <Animated.View
              style={[
                styles.hintBar,
                {
                  width: k === i ? 32 : 6,
                  backgroundColor: palette.foreground + (k === i ? '26' : '40'),
                  transitionProperty: 'width',
                  transitionDuration: 300
                }
              ]}
            >
              {k === i && (
                <Animated.View
                  key={cycle}
                  style={[
                    StyleSheet.absoluteFill,
                    {
                      borderRadius: 3,
                      backgroundColor: palette.foreground,
                      transformOrigin: 'left',
                      animationName: barFill,
                      animationDuration: HINT_MS,
                      animationTimingFunction: 'linear',
                      animationFillMode: 'both'
                    }
                  ]}
                />
              )}
            </Animated.View>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

/** The square tick before "Got it, I'll keep my backup safe". */
export function Tick({ on }: { on: boolean }) {
  const palette = usePalette()
  const dark = useIsDark()
  return (
    <View
      style={[
        styles.tickBox,
        on
          ? { borderColor: palette.ink, backgroundColor: palette.ink }
          : { borderColor: palette.foreground + '4d', backgroundColor: dark ? '#000000' : '#ffffff' }
      ]}
    >
      {on && <Check size={14} color={palette.inkForeground} strokeWidth={3} />}
    </View>
  )
}

/**
 * The dim circle before a quiz choice, so it reads as "pick one": empty
 * until picked, then a check (right) or a cross (wrong).
 */
export function ChoiceMark({ state }: { state: 'off' | 'right' | 'wrong' }) {
  const palette = usePalette()
  return (
    <View
      style={[
        styles.choice,
        state === 'off' && { borderColor: palette.foreground + '40' },
        state === 'right' && { borderColor: palette.inkForeground, backgroundColor: palette.inkForeground },
        state === 'wrong' && { borderColor: palette.destructive, backgroundColor: palette.destructive }
      ]}
    >
      {state === 'right' && <Check size={10} color={palette.ink} strokeWidth={3.5} />}
      {state === 'wrong' && <X size={10} color="#ffffff" strokeWidth={3.5} />}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  columns: { flexDirection: 'row' },
  column: { flex: 1 },
  word: { includeFontPadding: false },
  tight: { lineHeight: undefined },
  speak: { marginVertical: -4, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  speakLarge: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  writing: { flex: 1, paddingHorizontal: 20 },
  writingHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headText: { fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.7)' },
  close: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  writingList: { flex: 1, justifyContent: 'center', gap: 12 },
  writingRow: { flexDirection: 'row', alignItems: 'center', gap: 16, borderRadius: radii['2xl'], padding: 16 },
  writingNum: { height: 32, width: 36, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  writingNumText: { fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.6)', fontVariant: ['tabular-nums'] },
  writingFoot: { gap: 16 },
  progress: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  progressDot: { height: 6, borderRadius: 3 },
  progressOn: { width: 20, backgroundColor: '#ffffff' },
  progressOff: { width: 6, backgroundColor: 'rgba(255,255,255,0.3)' },
  buttons: { flexDirection: 'row', gap: 8 },
  ghost: {
    height: 48,
    borderRadius: 999,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)'
  },
  ghostText: { fontSize: 15, lineHeight: 20, color: '#ffffff' },
  solid: { flex: 1, height: 48, borderRadius: 999, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' },
  solidText: { fontSize: 15, lineHeight: 20, color: WRITING_INK },
  large: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, paddingHorizontal: 20 },
  largeGroups: { width: '100%', maxWidth: 448, gap: 32 },
  largeItem: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii['2xl'], backgroundColor: 'rgba(255,255,255,0.1)', paddingVertical: 12, paddingLeft: 12, paddingRight: 16 },
  largeNum: { height: 24, width: 28, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  largeNumText: { fontSize: 12, lineHeight: 16, color: 'rgba(255,255,255,0.6)', fontVariant: ['tabular-nums'] },
  largeDone: { marginTop: 8, height: 44, paddingHorizontal: 40 },
  hints: { alignItems: 'center', gap: 12 },
  hintRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12 },
  arrow: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  hintBox: { flex: 1, minHeight: 60, alignItems: 'center', justifyContent: 'center' },
  hintText: { textAlign: 'center', fontSize: 14, lineHeight: 20 },
  hintBars: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hintBar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  tickBox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  choice: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }
})
