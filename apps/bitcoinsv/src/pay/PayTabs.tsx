// The prototype's SendPayTabs (components/send-pay-tabs.tsx): the full-width
// switch between the two ways of paying someone, each its own route.
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ScanQrCode, Send } from 'lucide-react-native'
import { font, usePalette } from '../theme'

const TABS = [
  { href: '/send', label: 'Pay to contact', icon: Send },
  { href: '/pay', label: 'Scan & pay', icon: ScanQrCode }
] as const

export function PayTabs({ active }: { active: '/send' | '/pay' }) {
  const palette = usePalette()
  const router = useRouter()
  return (
    <View accessibilityRole="tablist" accessibilityLabel="Payment method" style={[styles.tabs, { backgroundColor: palette.secondary }]}>
      {TABS.map(({ href, label, icon: Icon }) => {
        const on = href === active
        return (
          <Pressable
            key={href}
            onPress={() => !on && router.replace(href)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.tab, on && { backgroundColor: palette.ink }]}
          >
            <Icon size={16} color={on ? palette.inkForeground : palette.mutedForeground} />
            <Text style={[font(600), styles.text, { color: on ? palette.inkForeground : palette.mutedForeground }]}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 4, borderRadius: 999, padding: 4 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  text: { fontSize: 13, lineHeight: 18 }
})
