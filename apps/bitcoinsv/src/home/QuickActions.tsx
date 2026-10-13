// Home's quick actions: flat squircle tiles in the CTA language, sharing the
// row (Pay, Get paid; Vault when it is on in this build).
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ArrowDownLeft, ArrowUpRight, Vault, type LucideIcon } from 'lucide-react-native'
import { font, usePalette } from '../theme'
import { PressFeedback } from '../ui/PressFeedback'
import { tourTarget } from '../tour/targets'

export interface QuickAction {
  key: string
  label: string
  icon: LucideIcon
  onPress: () => void
}

export const ACTION_ICONS = { pay: ArrowUpRight, receive: ArrowDownLeft, vault: Vault }

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  const palette = usePalette()
  return (
    <View ref={tourTarget('actions')} collapsable={false} style={styles.row}>
      {actions.map(({ key, label, icon: Icon, onPress }) => (
        <View key={key} style={styles.cell}>
          <PressFeedback
            onPress={onPress}
            accessibilityLabel={label}
            rippleColor={palette.foreground + '24'}
            style={[styles.tile, { backgroundColor: palette.secondary }]}
          >
            <Icon size={24} color={palette.foreground} />
            <Text style={[font(700), styles.label, { color: palette.foreground }]}>{label}</Text>
          </PressFeedback>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, minWidth: 0 },
  tile: { borderRadius: 20, paddingTop: 16, paddingBottom: 10 },
  label: { fontSize: 15, lineHeight: 22 }
})
