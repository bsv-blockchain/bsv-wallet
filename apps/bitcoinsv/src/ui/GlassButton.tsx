// The prototype's GlassButton (components/ui/glass-button.tsx): the large
// flow CTA. Gold (primary) or a quiet neutral (outline), pill-shaped, bold,
// with the press ripple and slight press-down.
import React from 'react'
import { Text, View } from 'react-native'
import { font, usePalette } from '../theme'
import { PressFeedback } from './PressFeedback'
import { Spinner } from './Spinner'

/** .glass-btn:disabled's saturate(0.4): the colour 60% of the way to its own grey. */
function desaturate(hex: string, amount = 0.4): string {
  const n = parseInt(hex.slice(1, 7), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const mix = (c: number) => Math.round(grey + (c - grey) * amount)
  return '#' + [mix(r), mix(g), mix(b)].map(c => c.toString(16).padStart(2, '0')).join('')
}

const SIZES = {
  default: { height: 48, paddingHorizontal: 24, fontSize: 16 },
  lg: { height: 52, paddingHorizontal: 28, fontSize: 17 },
  sm: { height: 40, paddingHorizontal: 20, fontSize: 15 }
} as const

export function GlassButton({
  label,
  onPress,
  variant = 'gold',
  size = 'default',
  icon,
  disabled = false,
  loading = false
}: {
  label: string
  onPress: () => void
  variant?: 'gold' | 'outline'
  size?: keyof typeof SIZES
  /** an icon before the label (gap-2) */
  icon?: React.ReactNode
  disabled?: boolean
  /** a spinning Loader2 before the label (the prototype's busy CTAs); not pressable */
  loading?: boolean
}) {
  const palette = usePalette()
  const s = SIZES[size]
  const gold = variant === 'gold'
  return (
    <PressFeedback
      onPress={onPress}
      accessibilityLabel={label}
      disabled={disabled || loading}
      // white ripple on gold; ink at 14% on the neutral fill
      rippleColor={gold ? 'rgba(255,255,255,0.55)' : palette.foreground + '24'}
      style={{
        height: s.height,
        paddingHorizontal: s.paddingHorizontal,
        borderRadius: 999,
        justifyContent: 'center',
        backgroundColor: gold ? (disabled || loading ? desaturate(palette.gold) : palette.gold) : palette.secondary
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {loading ? (
          <Spinner size={16} strokeWidth={2.5} color={gold ? palette.goldForeground : palette.foreground} />
        ) : (
          icon
        )}
        <Text style={[font(700), { fontSize: s.fontSize, lineHeight: s.fontSize * 1.3, color: gold ? palette.goldForeground : palette.foreground }]}>
          {label}
        </Text>
      </View>
    </PressFeedback>
  )
}
