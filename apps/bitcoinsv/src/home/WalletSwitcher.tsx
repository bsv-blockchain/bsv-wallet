// The wallet switcher (the prototype's components/wallet-switcher.tsx): the
// avatar in Home's top bar opens a card over it listing every wallet on this
// phone. Tap one to open it; at the bottom, bring a wallet you already have
// (decision 5: it takes this phone's place, after asking) or make a new one.
//
// The wallets are the shared core's profiles: one recovery phrase covers them
// all (decision 3), each a wallet of its own with its own @handle and history.
// Only the open wallet's balance can be read, so the others show their handle.
// Each row's pencil opens that wallet's profile (switching to it first). Import
// shows the older wallets it can bring over; Create, a face that keeps changing.
import React from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, Download, Pencil, Plus } from 'lucide-react-native'
import { liveProfiles, useActiveProfileIndex, useProfiles, useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import { font, radii, usePalette } from '../theme'
import { enter, useReducedMotion } from '../ui/motion'
import { Avatar, CyclingAvatar, type AvatarBg, type Portrait } from '../ui/Avatar'
import { LegacyFacepile } from './LegacyFacepile'
import { Money } from '../ui/Money'
import { afterSheetCloses } from '../ui/BottomSheet'
import { usePrefs } from '../state/prefs'
import { useAssets } from '../state/useAssets'
import { useWalletList } from './useWalletList'

export function WalletSwitcher({
  open,
  onOpenChange,
  onImport,
  onCreate
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onImport: () => void
  onCreate: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    // the popover brings its own entrance (no Modal fade) and leaves at once
    <Modal transparent visible={open} animationType="none" statusBarTranslucent onRequestClose={() => onOpenChange(false)}>
      {/* nothing dims: a tap outside closes it, as a popover's does */}
      <Pressable style={StyleSheet.absoluteFill} onPress={() => onOpenChange(false)} accessibilityLabel="Close" />
      {/* over the avatar that opened it (align="start" alignOffset={-8}
          sideOffset={-44}: the bar sits 16pt down, the avatar 12pt into it) */}
      <WalletCard top={insets.top + 20} left={8} onClose={() => onOpenChange(false)} onImport={onImport} onCreate={onCreate} />
    </Modal>
  )
}

/**
 * The switcher's card. `peek`: shown for the Home tour to point at, under its
 * dim, and not in use; `importRef` and `createRef` let it light those rows.
 */
export function WalletCard({
  top,
  left,
  onClose,
  onImport,
  onCreate,
  peek = false,
  importRef,
  createRef
}: {
  top: number
  left: number
  onClose: () => void
  onImport: () => void
  onCreate: () => void
  peek?: boolean
  importRef?: React.Ref<View>
  createRef?: React.Ref<View>
}) {
  const palette = usePalette()
  const router = useRouter()
  const prefs = usePrefs()
  const still = useReducedMotion()
  const profiles = liveProfiles(useProfiles())
  const active = useActiveProfileIndex()
  const { switchProfile, profilesSupported } = useWallet()
  const { totalFiat } = useAssets()

  const wallets = useWalletList()
  const name = (index: number) => wallets.find(w => w.index === index)?.name ?? `Wallet ${index + 1}`

  return (
    <Animated.View
      accessibilityViewIsModal={!peek}
      accessibilityElementsHidden={peek}
      importantForAccessibility={peek ? 'no-hide-descendants' : 'auto'}
      pointerEvents={peek ? 'none' : 'auto'}
      style={[
        styles.card,
        {
          top,
          left,
          backgroundColor: palette.popover,
          // shadow-md, ring-1 ring-foreground/10
          boxShadow: `0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1), 0 0 0 1px ${palette.foreground}1a`
        },
        // fade-in zoom-in-95 slide-in-from-top-2, 100ms, from the avatar's corner
        still ? null : [{ transformOrigin: 'top left' }, enter({ opacity: 0, scale: 0.95, translateY: -8, duration: 100 })]
      ]}
    >
      {profiles.map(p => {
        const look = p.index === active ? { avatarBg: prefs.avatarBg, avatarPortrait: prefs.avatarPortrait, avatarUri: prefs.avatarUri } : prefs.looks[p.index]
        const on = p.index === active
        return (
          <View key={p.index} style={styles.rowWrap}>
            <Pressable
              onPress={async () => {
                onClose()
                if (on) return
                await switchProfile(p.index)
                showToast(`Switched to ${name(p.index)}`, { type: 'success' })
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${name(p.index)}${on ? ', open' : ''}`}
              style={({ pressed }) => [styles.row, styles.flex, pressed && { backgroundColor: palette.secondary + '99' }]}
            >
              <View>
                <Avatar
                  bg={(look?.avatarBg as AvatarBg) ?? 'mint'}
                  portrait={(look?.avatarPortrait as Portrait) ?? 'dragon'}
                  uri={look?.avatarUri}
                  size={36}
                />
                {on && (
                  <View style={[styles.tick, { backgroundColor: palette.gold, boxShadow: `0 0 0 2px ${palette.popover}` }]}>
                    <Check size={10} color={palette.goldForeground} strokeWidth={3.5} />
                  </View>
                )}
              </View>
              <View style={styles.flex}>
                {/* its handle alone ("@vince"), or "Wallet 2" before it has one */}
                <Text numberOfLines={1} style={[font(600), styles.small, { color: palette.foreground }]}>
                  {name(p.index)}
                </Text>
                {on && totalFiat != null ? (
                  <Money amount={totalFiat} unit="usd" privacy={prefs.privacy} style={[font(400), styles.xs, { color: palette.mutedForeground }]} />
                ) : (
                  <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{on ? ' ' : 'Tap to open'}</Text>
                )}
              </View>
            </Pressable>
            {/* that wallet's profile: opened, if it isn't already */}
            <Pressable
              onPress={async () => {
                onClose()
                if (!on) await switchProfile(p.index)
                router.push('/profile')
              }}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${name(p.index)}`}
              hitSlop={4}
              style={({ pressed }) => [styles.edit, pressed && { backgroundColor: palette.secondary + '99' }]}
            >
              <Pencil size={16} color={palette.mutedForeground} />
            </Pressable>
          </View>
        )
      })}
      <View style={[styles.actions, { borderTopColor: palette.border }]}>
        <Pressable
          ref={importRef}
          onPress={() => {
            onClose()
            onImport()
          }}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed && { backgroundColor: palette.secondary + '99' }]}
        >
          <Download size={16} color={palette.foreground} style={styles.actionIcon} />
          <Text style={[font(600), styles.small, { color: palette.foreground }]}>Import wallet</Text>
          {/* the older wallets it can bring over, pinned right */}
          <View style={styles.actionRight}>
            <LegacyFacepile ring={palette.popover} />
          </View>
        </Pressable>
        {profilesSupported && (
          <Pressable
            ref={createRef}
            onPress={() => {
              onClose()
              afterSheetCloses(onCreate)
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, pressed && { backgroundColor: palette.secondary + '99' }]}
          >
            <Plus size={16} color={palette.foreground} style={styles.actionIcon} />
            <Text style={[font(600), styles.small, { color: palette.foreground }]}>Create new wallet</Text>
            {/* a new face every moment, pinned right */}
            <View style={styles.actionRight}>
              <CyclingAvatar />
            </View>
          </Pressable>
        )}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  card: { position: 'absolute', width: 320, maxWidth: '94%', borderRadius: radii['2xl'], padding: 8 },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  edit: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 8, paddingVertical: 8 },
  tick: { position: 'absolute', right: -2, bottom: -2, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  // the popover's gap-2.5, then mt-1 border-t pt-1
  actions: { marginTop: 14, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth },
  action: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: radii.xl },
  actionIcon: { position: 'absolute', left: 20 },
  actionRight: { position: 'absolute', right: 12 }
})
