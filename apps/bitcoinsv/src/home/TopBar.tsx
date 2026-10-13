// Home's top bar (app/(wallet)/page.tsx): wallets, scan to sign in, the
// search pill, help and settings. It stays put and gains a hairline once
// content scrolls under it.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { MessageCircleQuestion, ScanQrCode, Search, Settings } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { Avatar, type AvatarBg, type Portrait } from '../ui/Avatar'
import { tourTarget, type TourTarget } from '../tour/targets'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import { useReducedMotion } from '../ui/motion'

/**
 * The prototype's glow (page.tsx's el.animate): a box-shadow growing from 0
 * to 14px in rgba(234,179,0,0.65) as it fades, as a filled disc scaling from
 * the button's 32pt to 60pt.
 */
const glowDisc = css.keyframes({
  '0%': { transform: [{ scale: 1 }], opacity: 1 },
  '100%': { transform: [{ scale: 1.875 }], opacity: 0 }
})

/** Tailwind's default transition curve */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

function GhostIcon({
  label,
  onPress,
  round,
  tour,
  lit,
  children
}: {
  label: string
  onPress: () => void
  round?: boolean
  tour: TourTarget
  /** lit up in gold, pulsing (where the tour lives, after it) */
  lit?: boolean
  children: React.ReactNode
}) {
  const palette = usePalette()
  const still = useReducedMotion()
  const [pressed, setPressed] = useState(false)
  return (
    <Pressable
      ref={tourTarget(tour)}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
    >
      <Animated.View
        style={[
          styles.ghost,
          round && styles.round,
          {
            backgroundColor: lit ? palette.gold + '26' : pressed ? palette.muted : 'transparent',
            // ring-2 ring-gold while lit
            boxShadow: lit ? `0 0 0 2px ${palette.gold}` : undefined,
            // the button's active:translate-y-px
            transform: [{ translateY: pressed ? 1 : 0 }]
          },
          // Settings: transition-colors duration-500 (its press moves at once);
          // the rest: transition-all, 150ms
          round
            ? { transitionProperty: 'backgroundColor', transitionDuration: 500, transitionTimingFunction: EASE }
            : { transitionProperty: ['backgroundColor', 'transform'], transitionDuration: 150, transitionTimingFunction: EASE }
        ]}
      >
        {lit && !still && (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              styles.round,
              { backgroundColor: 'rgba(234,179,0,0.65)' },
              { animationName: glowDisc, animationDuration: 900, animationIterationCount: 3, animationTimingFunction: 'ease-out', animationFillMode: 'forwards' }
            ]}
          />
        )}
        {children}
      </Animated.View>
    </Pressable>
  )
}

export function TopBar({
  avatarBg,
  avatarPortrait,
  avatarUri,
  scrolled,
  onWallets,
  onScan,
  onSearch,
  onHelp,
  onSettings,
  settingsLit
}: {
  avatarBg: AvatarBg
  avatarPortrait?: Portrait
  avatarUri?: string | null
  scrolled: boolean
  onWallets: () => void
  onScan: () => void
  onSearch: () => void
  onHelp: () => void
  onSettings: () => void
  /** after the tour: the Settings button glows where it lives */
  settingsLit?: boolean
}) {
  const palette = usePalette()
  const dark = useIsDark()
  return (
    // transition-colors duration-200: the hairline fades in and out
    <Animated.View
      style={[
        styles.bar,
        {
          backgroundColor: palette.background,
          borderBottomColor: scrolled ? palette.border : 'transparent',
          transitionProperty: 'borderBottomColor',
          transitionDuration: 200,
          transitionTimingFunction: EASE
        }
      ]}
    >
      <Pressable ref={tourTarget('wallets')} onPress={onWallets} accessibilityRole="button" accessibilityLabel="Your wallets" style={styles.avatar}>
        <Avatar bg={avatarBg} portrait={avatarPortrait} uri={avatarUri} size={32} />
      </Pressable>
      <GhostIcon label="Scan to sign in" onPress={onScan} tour="signin">
        <ScanQrCode size={20} color={palette.foreground} />
      </GhostIcon>
      <Pressable
        ref={tourTarget('search')}
        onPress={onSearch}
        accessibilityRole="search"
        accessibilityLabel="Search contacts, transactions and more"
        style={[
          styles.search,
          {
            backgroundColor: palette.card + 'b3',
            // ring-1 ring-border plus the soft lift
            boxShadow: `0 0 0 1px ${palette.border}, ${dark ? '0 2px 26px -2px rgba(255,255,255,0.10)' : '0 2px 22px -2px rgba(20,24,40,0.16)'}`
          }
        ]}
      >
        <Search size={16} color={palette.mutedForeground} />
        <Text numberOfLines={1} style={[font(400), styles.searchText, { color: palette.mutedForeground }]}>
          Search contacts, tx, etc.
        </Text>
      </Pressable>
      <GhostIcon label="Help & support" onPress={onHelp} tour="help">
        <MessageCircleQuestion size={20} color={palette.foreground} />
      </GhostIcon>
      <GhostIcon label="Settings" onPress={onSettings} round tour="settings" lit={settingsLit}>
        <Settings size={20} color={settingsLit ? palette.goldDeep : palette.foreground} />
      </GhostIcon>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  avatar: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
  ghost: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radii.lg },
  round: { borderRadius: 16 },
  search: {
    flex: 1,
    minWidth: 0,
    height: 40,
    marginHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderRadius: 20
  },
  searchText: { flex: 1, fontSize: 14, lineHeight: 20 }
})
