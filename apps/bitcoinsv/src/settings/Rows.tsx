// Settings' rows (the prototype's app/(wallet)/settings/page.tsx): an icon in
// a rounded tile, the label, a value and a chevron; or a switch with a line
// under its label. Sections have a small spaced-out heading.
//
// A search that lands on a row (Activity's "Settings" results): the screen
// says which row, through SettingsSearch; each section reports where it sits,
// and the row with that label lights up.
import React, { createContext, useContext, useState } from 'react'
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { ChevronRight, type LucideIcon } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { Switch } from '../ui/Switch'

export const SettingsSearch = createContext<{ lit?: string; onSection?: (title: string, y: number) => void }>({})

/** Tailwind's transition-colors: 150ms cubic-bezier(0.4, 0, 0.2, 1). */
const EASE = cubicBezier(0.4, 0, 0.2, 1)
// colours ease; a ring (lit, or the tour row's) fades over 500ms
const FADE = {
  transitionProperty: ['backgroundColor', 'boxShadow'] as ('backgroundColor' | 'boxShadow')[],
  transitionDuration: [150, 500],
  transitionTimingFunction: EASE
}

/** A row's fill: lit by a search, greyed while held (secondary/60), or clear. */
function useRowFill(label: string | undefined, pressed: boolean) {
  const palette = usePalette()
  const { lit } = useContext(SettingsSearch)
  const on = !!label && lit === label
  return {
    // clear is the same colour at nothing, so it eases without going dark
    backgroundColor: pressed ? palette.secondary + '99' : on ? palette.gold + '1a' : palette.secondary + '00',
    boxShadow: `0 0 0 2px ${palette.gold}${on ? '' : '00'}`
  }
}

/**
 * A row that greys while it's held (hover:bg-secondary/60
 * active:bg-secondary/60 transition-colors), easing in and out.
 */
export function PressRow({
  style,
  outerStyle,
  label,
  children,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle>
  /** the touch area's own style (its margins) */
  outerStyle?: StyleProp<ViewStyle>
  /** the settings row this is, for a search to light up */
  label?: string
  children: React.ReactNode | ((pressed: boolean) => React.ReactNode)
}) {
  const [pressed, setPressed] = useState(false)
  const fill = useRowFill(label, pressed)
  return (
    <Pressable
      {...rest}
      style={outerStyle}
      onPressIn={e => {
        setPressed(true)
        onPressIn?.(e)
      }}
      onPressOut={e => {
        setPressed(false)
        onPressOut?.(e)
      }}
    >
      <Animated.View style={[style, fill, FADE]}>{typeof children === 'function' ? children(pressed) : children}</Animated.View>
    </Pressable>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const palette = usePalette()
  const { onSection } = useContext(SettingsSearch)
  return (
    <View onLayout={onSection ? e => onSection(title, e.nativeEvent.layout.y) : undefined}>
      <Text accessibilityRole="header" style={[font(600), styles.heading, { color: palette.mutedForeground }]}>
        {title.toUpperCase()}
      </Text>
      <View style={styles.rows}>{children}</View>
    </View>
  )
}

function Tile({ Icon, lifted }: { Icon: LucideIcon; lifted?: boolean }) {
  const palette = usePalette()
  const dark = useIsDark()
  // the tile lifts to white (black in dark) as the row greys, so it keeps its shape
  return (
    <Animated.View
      style={[
        styles.tile,
        { backgroundColor: lifted ? (dark ? '#000000' : '#ffffff') : palette.secondary },
        { transitionProperty: 'backgroundColor', transitionDuration: 150, transitionTimingFunction: EASE }
      ]}
    >
      <Icon size={16} color={palette.foreground} />
    </Animated.View>
  )
}

export function SettingsRow({
  icon,
  label,
  value,
  onPress,
  tone
}: {
  icon: LucideIcon
  label: string
  value?: string
  onPress: () => void
  tone?: 'warning'
}) {
  const palette = usePalette()
  return (
    <PressRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      label={label}
      style={styles.row}
    >
      {pressed => (
        <>
          <Tile Icon={icon} lifted={pressed} />
          <Text numberOfLines={1} style={[font(500), styles.label, { color: palette.foreground }]}>
            {label}
          </Text>
          {value ? (
            <Text numberOfLines={1} style={[font(tone ? 600 : 400), styles.value, { color: tone ? palette.warning : palette.mutedForeground }]}>
              {value}
            </Text>
          ) : null}
          <ChevronRight size={16} color={palette.mutedForeground} />
        </>
      )}
    </PressRow>
  )
}

export function SwitchRow({
  icon,
  label,
  description,
  value,
  onValueChange
}: {
  icon: LucideIcon
  label: string
  description?: string
  value: boolean
  onValueChange: (v: boolean) => void
}) {
  const palette = usePalette()
  const fill = useRowFill(label, false)
  // the whole row toggles, not just the switch
  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      accessibilityHint={description}
    >
      <Animated.View style={[styles.row, fill, FADE]}>
      <Tile Icon={icon} />
      <View style={styles.middle}>
        <Text style={[font(500), styles.label14, { color: palette.foreground }]}>{label}</Text>
        {description ? (
          <Text numberOfLines={1} style={[font(400), styles.description, { color: palette.mutedForeground }]}>
            {description}
          </Text>
        ) : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} label={label} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // text-[11px] uppercase tracking-widest (0.1em)
  heading: { fontSize: 11, lineHeight: 16, letterSpacing: 1.1, paddingBottom: 6, paddingLeft: 4 },
  rows: { marginHorizontal: -8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 12, paddingVertical: 12 },
  tile: { width: 36, height: 36, borderRadius: radii.xl, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1, fontSize: 14, lineHeight: 20 },
  label14: { fontSize: 14, lineHeight: 20 },
  middle: { flex: 1, minWidth: 0 },
  value: { fontSize: 13, lineHeight: 18, maxWidth: '45%' },
  description: { fontSize: 12, lineHeight: 16 }
})
