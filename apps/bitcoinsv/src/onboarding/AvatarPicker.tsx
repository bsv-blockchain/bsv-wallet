// The prototype's AvatarPicker (components/avatar-picker.tsx): upload your own
// image, or pick an animal and its background. The first animal you pick gets
// a random colour; switching animals keeps the colour you have.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import * as DocumentPicker from 'expo-document-picker'
import { Check, ImagePlus } from 'lucide-react-native'
import { showToast } from '../ui/Toast'
import { font, usePalette } from '../theme'
import { AVATAR_BACKGROUNDS, Avatar, PORTRAIT_NAMES, randomAvatarBg, type AvatarBg, type Portrait } from '../ui/Avatar'

export interface AvatarChoice {
  portrait: Portrait
  bg: AvatarBg
  uri: string | null
}

export function AvatarPicker({ value, onChange }: { value: AvatarChoice; onChange: (next: AvatarChoice) => void }) {
  const palette = usePalette()
  const ring = { boxShadow: `0 0 0 2px ${palette.ink}` }
  // grid-cols-5 gap-3: five square cells filling the width
  const [cell, setCell] = useState(56)
  const size = { width: cell, height: cell, borderRadius: cell / 2 }

  const upload = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true })
      if (picked.canceled || !picked.assets?.[0]) return
      onChange({ ...value, uri: picked.assets[0].uri })
    } catch {
      showToast("That file isn't an image", { type: 'error' })
    }
  }

  return (
    <View style={styles.wrap}>
      <View
        style={styles.grid}
        onLayout={e => {
          const next = Math.floor(((e.nativeEvent.layout.width - 4 * GAP) / 5) * 100) / 100
          if (next > 0 && Math.abs(next - cell) > 0.5) setCell(next)
        }}
      >
        {/* upload: shows your image once there is one */}
        <Pressable
          onPress={upload}
          accessibilityRole="button"
          accessibilityLabel="Upload image"
          accessibilityState={{ selected: !!value.uri }}
          style={[styles.cell, size, styles.upload, { backgroundColor: palette.secondary }, value.uri ? ring : null]}
        >
          {value.uri ? (
            <Image source={{ uri: value.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
          ) : (
            <ImagePlus size={20} color={palette.mutedForeground} />
          )}
        </Pressable>
        {PORTRAIT_NAMES.map(p => {
          const active = !value.uri && value.portrait === p
          return (
            <Pressable
              key={p}
              onPress={() => onChange({ portrait: p, bg: value.bg ?? randomAvatarBg(), uri: null })}
              accessibilityRole="button"
              accessibilityLabel={`Choose the ${p}`}
              accessibilityState={{ selected: active }}
              style={[styles.cell, size, { opacity: active ? 1 : 0.85 }]}
            >
              <View style={[{ borderRadius: cell / 2 }, active ? ring : null]}>
                <Avatar portrait={p} bg={value.bg} size={cell} />
              </View>
            </Pressable>
          )
        })}
      </View>

      {!value.uri && (
        <View>
          <Text style={[font(600), styles.label, { color: palette.mutedForeground }]}>BACKGROUND</Text>
          <View style={styles.colours}>
            {(Object.keys(AVATAR_BACKGROUNDS) as AvatarBg[]).map(b => {
              const active = value.bg === b
              return (
                <Pressable
                  key={b}
                  onPress={() => onChange({ ...value, bg: b })}
                  accessibilityRole="button"
                  accessibilityLabel={b}
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => [
                    styles.colour,
                    { backgroundColor: AVATAR_BACKGROUNDS[b], boxShadow: active ? `0 0 0 2px ${palette.ink}` : '0 0 0 1px rgba(0,0,0,0.1)' },
                    pressed && { transform: [{ scale: 0.95 }] }
                  ]}
                >
                  {active && <Check size={16} color="rgba(0,0,0,0.7)" strokeWidth={3} />}
                </Pressable>
              )
            })}
          </View>
        </View>
      )}
    </View>
  )
}

const GAP = 12

const styles = StyleSheet.create({
  wrap: { gap: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  cell: { alignItems: 'center', justifyContent: 'center' },
  upload: { overflow: 'hidden' },
  label: { paddingBottom: 8, paddingLeft: 4, fontSize: 11, lineHeight: 16, letterSpacing: 1.1 },
  colours: { flexDirection: 'row', gap: 12 },
  colour: { flex: 1, aspectRatio: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center' }
})
