// Development builds only: the shared core's software YubiKeys (devMock), so
// the vault can be set up and used on a simulator. Which key is "held to the
// phone" switches between its three.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { getMockPresentKey, setMockDriverEnabled, setMockPresentKey, type MockPresentKey } from '@bsv/expo-wallet-toolbox/core/services/vault/devMock'
import { font, usePalette } from '../theme'
import { Switch } from '../ui/Switch'

/** the software keys stay installed while the app runs */
let mockOn = false

export function DevKeys() {
  const palette = usePalette()
  const [on, setOn] = useState(mockOn)
  const [present, setPresent] = useState<MockPresentKey>(getMockPresentKey())
  return (
    <View style={[styles.dev, { borderColor: palette.border }]}>
      <View style={styles.devRow}>
        <Text style={[font(500), styles.small, styles.flex, { color: palette.mutedForeground }]}>Simulated YubiKey (development)</Text>
        <Switch
          value={on}
          label="Simulated YubiKey"
          onValueChange={v => {
            setMockDriverEnabled(v)
            mockOn = v
            setOn(v)
          }}
        />
      </View>
      {on && (
        <View style={styles.devRow}>
          {(['MOCK-DEV-1', 'MOCK-DEV-2', 'MOCK-DEV-3'] as const).map((k, i) => (
            <Pressable
              key={k}
              onPress={() => {
                setMockPresentKey(k)
                setPresent(k)
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: present === k }}
              accessibilityLabel={`Hold key ${i + 1}`}
              style={[styles.chip, { backgroundColor: present === k ? palette.ink : palette.secondary }]}
            >
              <Text style={[font(600), styles.small, { color: present === k ? palette.inkForeground : palette.foreground }]}>Key {i + 1}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  dev: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 16, padding: 12, gap: 10, marginTop: 8 },
  devRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  small: { fontSize: 13, lineHeight: 18 },
  flex: { flex: 1 },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 }
})
