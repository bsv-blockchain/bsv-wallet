/**
 * The universal recipient field: one input that takes a handle, a public key,
 * an address or a peerpay link, plus the QR button that scans the same set. It
 * shows the search dropdown for free text, a status row for a resolved target
 * or a checksum failure, and collapses to an identity card once a search hit
 * is chosen. What the text MEANS is decided in core/pay/rails and held by
 * useRecipientInput; this file only renders that state.
 */
import React from 'react'
import { ActivityIndicator, Image, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import type { DisplayableIdentity } from '@bsv/sdk'
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated'
import { spacing, typography, radii, springs } from '@bsv/expo-wallet-toolbox'
import type { RecipientInlineError, RecipientTarget } from './useRecipientInput'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

interface RecipientFieldProps {
  readonly selectedIdentity: DisplayableIdentity | null
  readonly inputText: string
  readonly target: RecipientTarget | null
  readonly inlineError: RecipientInlineError | null
  readonly isSearching: boolean
  readonly searchResults: DisplayableIdentity[]
  readonly colors: ReturnType<typeof import('@bsv/expo-wallet-toolbox').useTheme>['colors']
  readonly t: ReturnType<typeof import('react-i18next').useTranslation>['t']
  readonly onChangeText: (v: string) => void
  readonly onSelectIdentity: (i: DisplayableIdentity) => void
  readonly onClear: () => void
  readonly onOpenScanner: () => void
}

export default function RecipientField({
  selectedIdentity,
  inputText,
  target,
  inlineError,
  isSearching,
  searchResults,
  colors,
  t,
  onChangeText,
  onSelectIdentity,
  onClear,
  onOpenScanner
}: RecipientFieldProps) {
  const Ionicons = loadIonicons()
  const reducedMotion = useReducedMotion()
  if (selectedIdentity) {
    const identityEntering = reducedMotion
      ? undefined
      : FadeInDown.springify().stiffness(springs.snappy.stiffness).damping(springs.snappy.damping)
    return (
      <Animated.View
        entering={identityEntering}
        style={[styles.selectedRecipient, { backgroundColor: colors.backgroundSecondary }]}
      >
        {selectedIdentity.avatarURL ? (
          <Image source={{ uri: selectedIdentity.avatarURL }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatarPlaceholder, { backgroundColor: colors.accent }]}>
            <Ionicons name="person" size={20} color={colors.background} />
          </View>
        )}
        <View style={styles.selectedInfo}>
          <Text style={[styles.selectedName, { color: colors.textPrimary }]} numberOfLines={1}>
            {selectedIdentity.name || t('unknown')}
          </Text>
          <Text style={[styles.selectedKey, { color: colors.textSecondary }]} numberOfLines={1}>
            {selectedIdentity.abbreviatedKey || `${selectedIdentity.identityKey.slice(0, 10)}...`}
          </Text>
        </View>
        <TouchableOpacity onPress={onClear} style={styles.clearButton}>
          <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
        </TouchableOpacity>
      </Animated.View>
    )
  }
  const showDropdown = (isSearching || searchResults.length > 0) && !target && !inlineError
  const borderColor = inlineError ? colors.error : target ? colors.success : colors.separator
  const borderWidth = inlineError || target ? 1 : StyleSheet.hairlineWidth
  return (
    <>
      <View style={[styles.inputRow, { backgroundColor: colors.backgroundSecondary, borderColor, borderWidth }]}>
        <TextInput
          value={inputText}
          onChangeText={onChangeText}
          placeholder={t('recipient_placeholder')}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.recipientInput, { color: colors.textPrimary }]}
        />
        <TouchableOpacity onPress={onOpenScanner} style={styles.inputAction} accessibilityLabel={t('scan_qr_code')}>
          <Ionicons name="qr-code-outline" size={20} color={colors.accent} />
        </TouchableOpacity>
      </View>
      {inlineError ? (
        <View style={styles.statusRow}>
          <Ionicons name="close-circle-outline" size={14} color={colors.error} />
          <Text style={[styles.statusText, { color: colors.error }]}>{t(inlineError)}</Text>
        </View>
      ) : target?.kind === 'handle' ? (
        <View style={styles.statusRow}>
          <Ionicons name="key-outline" size={14} color={colors.success} />
          <Text style={[styles.statusText, { color: colors.success }]}>{t('valid_identity_key')}</Text>
        </View>
      ) : target?.kind === 'address' ? (
        <View style={styles.statusRow}>
          <Ionicons name="wallet-outline" size={14} color={colors.success} />
          <Text style={[styles.statusText, { color: colors.success }]}>{t('valid_bsv_address')}</Text>
        </View>
      ) : null}
      {showDropdown && (
        <View
          style={[styles.searchResults, { backgroundColor: colors.backgroundSecondary, borderColor: colors.separator }]}
        >
          {isSearching ? (
            <View style={styles.searchLoading}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.searchLoadingText, { color: colors.textSecondary }]}>{t('searching')}</Text>
            </View>
          ) : (
            searchResults.map((identity, idx) => (
              <TouchableOpacity
                key={identity.identityKey + idx}
                onPress={() => onSelectIdentity(identity)}
                style={[
                  styles.searchResultRow,
                  idx < searchResults.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.separator
                  }
                ]}
              >
                {identity.avatarURL ? (
                  <Image source={{ uri: identity.avatarURL }} style={styles.searchAvatar} />
                ) : (
                  <View style={[styles.searchAvatarPlaceholder, { backgroundColor: colors.accent }]}>
                    <Ionicons name="person" size={18} color={colors.background} />
                  </View>
                )}
                <View style={styles.searchResultInfo}>
                  <Text style={[styles.searchResultName, { color: colors.textPrimary }]} numberOfLines={1}>
                    {identity.name || t('unknown')}
                  </Text>
                  <Text style={[styles.searchResultKey, { color: colors.textSecondary }]} numberOfLines={1}>
                    {identity.abbreviatedKey || `${identity.identityKey.slice(0, 20)}...`}
                  </Text>
                </View>
                {identity.badgeLabel ? (
                  <View style={[styles.badge, { backgroundColor: colors.fill }]}>
                    <Text style={[styles.badgeText, { color: colors.accent }]}>{identity.badgeLabel}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            ))
          )}
        </View>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  // Selected recipient
  selectedRecipient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radii.md
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18
  },
  avatarPlaceholder: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  selectedInfo: {
    flex: 1,
    marginLeft: spacing.md
  },
  selectedName: {
    ...typography.subhead,
    fontWeight: '600'
  },
  selectedKey: {
    ...typography.caption1,
    fontFamily: 'monospace'
  },
  clearButton: {
    padding: spacing.xs
  },

  // Status row (resolved target or inline error)
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  statusText: {
    ...typography.caption1,
    fontWeight: '500'
  },

  // Search results
  searchResults: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
    overflow: 'hidden'
  },
  searchLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
    gap: spacing.sm
  },
  searchLoadingText: {
    ...typography.subhead
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md
  },
  searchAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: spacing.md
  },
  searchAvatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  searchResultInfo: {
    flex: 1
  },
  searchResultName: {
    ...typography.subhead,
    fontWeight: '500'
  },
  searchResultKey: {
    ...typography.caption1,
    fontFamily: 'monospace'
  },
  badge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: 3,
    marginLeft: spacing.sm,
    flexShrink: 1
  },
  badgeText: {
    ...typography.caption2,
    fontWeight: '600',
    fontSize: 10
  },

  // Recipient input row (text field + QR scan button)
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden'
  },
  recipientInput: {
    ...typography.body,
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  inputAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
