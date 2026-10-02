/**
 * The profile switcher: what the Home avatar opens.
 *
 * One row per wallet profile (one mnemonic, many wallets — see
 * core/profiles/profileStore), a checkmark on the active one, and "Add profile"
 * underneath. Tapping the active row opens that profile's own screen (name,
 * handle, picture); tapping another switches the whole wallet to it.
 *
 * A small card hanging under the avatar, styled like the coin switcher
 * (AssetSwitcherDropdown). It sits in a transparent Modal rather than in-tree
 * because the avatar lives inside the header slot, whose box would clip it.
 *
 * While a switch runs, the same Modal turns into a full-screen cover: tearing
 * one wallet down and building the next takes a moment, and the old wallet must
 * not sit there looking live meanwhile. One Modal for both, because iOS will
 * not present a second one while the first is still dismissing.
 */
import React from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions
} from 'react-native'
import { useTranslation } from 'react-i18next'
import { hitTargets, radii, spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import type { ProfileRecord } from '../../../core/profiles/profileStore'
import { profileLabel } from '../../../core/profiles/profileLabel'
import type { AppChain } from '../../../core/config'
import type { AvatarIcon } from '../../../core/userAvatar'
import { AvatarGlyph } from './UserAvatar'

/** Same lazy load as AssetSwitcherDropdown — see the note there. */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

const NETWORK_LABEL_KEY: Record<AppChain, string> = { main: 'mainnet', test: 'testnet', teratest: 'teratest' }

export interface ProfileSwitcherPopoverProps {
  visible: boolean
  onClose: () => void
  /** Window coordinates of the avatar the card hangs from. */
  anchor: { x: number; y: number; height: number }
  /** Every record, removed ones included (their indices stay the other profiles' numbers); the card lists the live ones. */
  profiles: ProfileRecord[]
  active: number
  /** The active profile's avatar; other profiles show the default glyph. */
  avatar: AvatarIcon | null
  /** A build or switch is in flight: rows and Add are inert. */
  busy: boolean
  onSelect: (index: number) => void
  onOpenProfile: () => void
  onAdd: () => void
  /** A switch is running: show the full-screen cover instead of the card. */
  switchingTo?: number | null
  /** The running transition is the removal of `switchingTo`, not a switch to it. */
  removing?: boolean
}

export default function ProfileSwitcherPopover({
  visible,
  onClose,
  anchor,
  profiles,
  active,
  avatar,
  busy,
  onSelect,
  onOpenProfile,
  onAdd,
  switchingTo = null,
  removing = false
}: ProfileSwitcherPopoverProps) {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const { width } = useWindowDimensions()
  const Ionicons = loadIonicons()
  const cardWidth = Math.min(280, width - spacing.lg * 2)
  const left = Math.max(spacing.lg, Math.min(anchor.x, width - spacing.lg - cardWidth))
  const live = profiles.filter(p => !p.deleted)

  if (switchingTo !== null) {
    // Add heads for an index with no record yet, so fall back to the default label.
    const target = profiles.find(p => p.index === switchingTo) ?? { index: switchingTo }
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => {}} statusBarTranslucent>
        <View
          testID="profile-switch-cover"
          style={[styles.cover, { backgroundColor: colors.background }]}
          accessibilityViewIsModal
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator size="large" color={colors.textSecondary} />
          <Text style={[styles.coverLabel, { color: colors.textSecondary }]}>
            {t(removing ? 'profile_removing' : 'profile_switching', { profile: profileLabel(target, t) })}
          </Text>
        </View>
      </Modal>
    )
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('cancel')}
      />
      <View
        testID="profile-switcher"
        style={[
          styles.card,
          {
            top: anchor.y + anchor.height + spacing.xs,
            left,
            width: cardWidth,
            backgroundColor: colors.surfaceRaised,
            borderColor: colors.surfaceRaisedBorder,
            shadowColor: colors.textPrimary
          }
        ]}
      >
        <View style={styles.list}>
          {live.map(p => {
            const selected = p.index === active
            const label = profileLabel(p, t)
            const network = p.network !== 'main' ? t(NETWORK_LABEL_KEY[p.network]) : undefined
            return (
              <TouchableOpacity
                key={p.index}
                testID={`profile-row-${p.index}`}
                style={[styles.row, selected && { backgroundColor: colors.fill }]}
                onPress={() => (selected ? onOpenProfile() : onSelect(p.index))}
                disabled={busy}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: busy }}
                accessibilityLabel={[label, network].filter(Boolean).join(', ')}
              >
                <View
                  style={[styles.disc, { backgroundColor: colors.background, borderColor: colors.surfaceRaisedBorder }]}
                >
                  <AvatarGlyph
                    family={selected && avatar ? avatar.family : 'ionicons'}
                    name={selected && avatar ? avatar.name : 'person-outline'}
                    size={15}
                    color={colors.textSecondary}
                  />
                </View>
                <View style={styles.body}>
                  <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
                    {label}
                  </Text>
                  {!!network && (
                    <Text style={[styles.detail, { color: colors.textSecondary }]} numberOfLines={1}>
                      {network}
                    </Text>
                  )}
                </View>
                <View style={styles.check}>
                  {selected && <Ionicons name="checkmark" size={20} color={colors.accent} />}
                </View>
              </TouchableOpacity>
            )
          })}
        </View>
        <View style={[styles.separator, { backgroundColor: colors.separator }]} />
        <TouchableOpacity
          testID="profile-add"
          style={styles.row}
          onPress={onAdd}
          disabled={busy}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          accessibilityLabel={t('profile_add')}
        >
          <View style={styles.disc}>
            <Ionicons name="add-circle-outline" size={22} color={colors.accent} />
          </View>
          <Text style={[styles.name, styles.body, { color: colors.accent }]}>{t('profile_add')}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    // Same numbers as the coin switcher card, so the two read as one family.
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 6,
    elevation: 12,
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.22,
    shadowRadius: 30
  },
  list: { gap: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: hitTargets.minimum,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: radii.lg
  },
  disc: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center'
  },
  body: { flex: 1, minWidth: 0 },
  name: { ...typography.body, fontWeight: '600' },
  detail: { ...typography.footnote, marginTop: 1 },
  check: { width: 20, alignItems: 'center' },
  separator: { height: StyleSheet.hairlineWidth, marginHorizontal: 10, marginVertical: 4 },
  cover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg
  },
  coverLabel: { ...typography.body }
})
