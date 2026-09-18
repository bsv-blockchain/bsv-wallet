/**
 * A label with a pencil at rest that becomes a filled confirm button once its
 * text has actually changed (2026-09-17 design ruling — applied to the
 * contact name, a new contact's name, and the profile display name).
 */
import React, { useState } from 'react'
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle } from 'react-native'
import { useTheme, spacing, radii } from '@bsv/expo-wallet-toolbox'
import PressableScale from './PressableScale'

type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

export interface PencilEditFieldProps {
  value: string
  onSave: (next: string) => void | Promise<void>
  placeholder?: string
  textStyle?: StyleProp<TextStyle>
  editAccessibilityLabel: string
  saveAccessibilityLabel: string
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'
  maxLength?: number
}

export function PencilEditField({
  value,
  onSave,
  placeholder,
  textStyle,
  editAccessibilityLabel,
  saveAccessibilityLabel,
  autoCapitalize = 'words',
  maxLength
}: PencilEditFieldProps) {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const changed = text.trim() !== '' && text.trim() !== value.trim()

  if (!editing) {
    return (
      <View style={styles.row}>
        <Text style={[styles.value, { color: colors.textPrimary }, textStyle]} numberOfLines={1}>
          {value}
        </Text>
        <PressableScale
          onPress={() => {
            setText(value)
            setEditing(true)
          }}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={editAccessibilityLabel}
        >
          <Ionicons name="pencil-outline" size={17} color={colors.textSecondary} />
        </PressableScale>
      </View>
    )
  }

  return (
    <View style={styles.row}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        maxLength={maxLength}
        autoFocus
        style={[styles.input, { color: colors.textPrimary, borderColor: colors.separator }, textStyle]}
        onBlur={() => {
          if (!changed) setEditing(false)
        }}
      />
      <PressableScale
        onPress={async () => {
          if (changed) await onSave(text.trim())
          setEditing(false)
        }}
        disabled={!changed}
        style={[styles.confirmBtn, { backgroundColor: changed ? colors.accent : colors.fill }]}
        accessibilityRole="button"
        accessibilityLabel={saveAccessibilityLabel}
        accessibilityState={{ disabled: !changed }}
      >
        <Ionicons name="checkmark" size={18} color={changed ? colors.textOnAccent : colors.textTertiary} />
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  value: { flex: 1 },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs
  },
  confirmBtn: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
