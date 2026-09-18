/**
 * An editable label row for a grouped card (contact name, profile display
 * name): the field is always a live text input, a pencil sits at rest in the
 * leading slot, and once the text has actually changed that slot becomes a
 * filled confirm button (2026-09-17 design ruling). Tapping the pencil only
 * focuses the field; nothing is saved until the check is tapped or the
 * keyboard's return key is pressed with a real change.
 */
import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View, type StyleProp, type TextStyle } from 'react-native'
import { useTheme, spacing, typography } from '@bsv/expo-wallet-toolbox'
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
  const inputRef = useRef<TextInput>(null)
  const [text, setText] = useState(value)
  // A save that lands from outside (a cache refresh, the parent reloading)
  // re-seeds the field; an in-progress edit is never clobbered, because the
  // parent's value only changes once our own save has gone through.
  useEffect(() => setText(value), [value])
  const changed = text.trim() !== '' && text.trim() !== value.trim()

  const save = async () => {
    if (!changed) return
    await onSave(text.trim())
    inputRef.current?.blur()
  }

  return (
    <View style={styles.row}>
      {changed ? (
        <PressableScale
          onPress={save}
          haptic="confirm"
          style={styles.leading}
          accessibilityRole="button"
          accessibilityLabel={saveAccessibilityLabel}
        >
          <View style={[styles.confirmDisc, { backgroundColor: colors.accent }]}>
            <Ionicons name="checkmark" size={16} color={colors.textOnAccent} />
          </View>
        </PressableScale>
      ) : (
        <PressableScale
          onPress={() => inputRef.current?.focus()}
          style={styles.leading}
          accessibilityRole="button"
          accessibilityLabel={editAccessibilityLabel}
        >
          <Ionicons name="pencil-outline" size={17} color={colors.textSecondary} />
        </PressableScale>
      )}
      <TextInput
        ref={inputRef}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        maxLength={maxLength}
        returnKeyType="done"
        onSubmitEditing={save}
        style={[styles.input, { color: colors.textPrimary }, textStyle]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingLeft: spacing.xs, paddingRight: spacing.lg },
  // A 44pt target around a 17pt glyph / 28pt disc, flush with the card's
  // left padding once the disc's own inset is counted.
  leading: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  confirmDisc: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  input: { ...typography.body, flex: 1, minWidth: 0, paddingVertical: spacing.md, paddingHorizontal: 0 }
})
