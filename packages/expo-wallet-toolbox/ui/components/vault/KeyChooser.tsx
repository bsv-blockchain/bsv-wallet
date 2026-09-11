/**
 * "Which key will you tap?" — a radio list of the vault's enrolled keys, used
 * before a withdrawal (spec §4.2 step 1) and before a re-lock (§4.3). Keys are
 * shown everywhere as `nickname · …serialTail4` (§3.3), which is what
 * `vaultKeyLabel` produces; the wizard, the vault screen and the transfer
 * screen all import it from here so the format is written once.
 *
 * Controlled: `selected` is the caller's state, and the default (the key used
 * last, `meta.lastUsedSerial`) is the caller's decision.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import PressableScale from '../ui/PressableScale'
import { useTheme, spacing, radii, typography, type VaultKeyRecord } from '@bsv/expo-wallet-toolbox'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as this
 * package's other native-module-boundary fixes (expo-router, expo-blur).
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

/** The one display form of a vault key: `nickname · …serialTail4`. */
export function vaultKeyLabel(k: { nickname: string; serial: string }): string {
  return `${k.nickname} · …${k.serial.slice(-4)}`
}

/** A serial grouped in threes from the right, e.g. `24939299` → `24 939 299`
 * — the vault screen's key row shows the FULL serial this way rather than
 * `vaultKeyLabel`'s truncated tail4 (that form stays for copy that names a
 * key in passing — alerts, the ceremony sheet). */
export function formatVaultSerial(serial: string): string {
  return serial.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export const KeyChooser: React.FC<{ keys: VaultKeyRecord[]; selected?: string; onSelect: (serial: string) => void }> = ({
  keys,
  selected,
  onSelect
}) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  return (
    <View style={[styles.list, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
      {keys.map((k, i) => {
        const on = k.serial === selected
        return (
          <PressableScale
            key={k.serial}
            haptic="tap"
            scaleTo={0.98}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(k.serial)}
            style={[
              styles.row,
              i < keys.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
            ]}
          >
            <Ionicons
              name={on ? 'radio-button-on' : 'radio-button-off'}
              size={22}
              color={on ? colors.accent : colors.textTertiary}
            />
            <Text style={[styles.label, { color: colors.textPrimary }]} numberOfLines={1}>
              {vaultKeyLabel(k)}
            </Text>
          </PressableScale>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg
  },
  label: { ...typography.body, flex: 1 }
})
