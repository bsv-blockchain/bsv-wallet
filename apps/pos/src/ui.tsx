import React from 'react'
import { Pressable, ScrollView, Text, TextInput, View, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, usePathname } from 'expo-router'
export const colors = {
  background: '#0b0c10',
  surface: '#18191f',
  raised: '#24252d',
  line: '#34353e',
  text: '#f5f5f7',
  muted: '#a7a9b4',
  accent: '#d9ecaf',
  error: '#ffaaa1'
}
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 22, paddingBottom: 36, gap: 20, maxWidth: 760, width: '100%', alignSelf: 'center', flexGrow: 1 },
  title: { fontSize: 34, fontWeight: '700', letterSpacing: -1.2, color: colors.text },
  heading: { fontSize: 21, fontWeight: '600', letterSpacing: -0.4, color: colors.text },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 1.6, color: colors.muted, textTransform: 'uppercase' },
  body: { fontSize: 15, lineHeight: 23, color: colors.muted },
  caption: { fontSize: 12, lineHeight: 18, color: colors.muted },
  card: { padding: 22, borderRadius: 22, backgroundColor: colors.surface, gap: 16 },
  field: {
    color: colors.text,
    backgroundColor: colors.raised,
    padding: 17,
    borderRadius: 14,
    fontSize: 17,
    borderWidth: 1,
    borderColor: colors.line,
    minHeight: 56
  },
  button: { backgroundColor: colors.text, padding: 18, borderRadius: 28, minHeight: 58, justifyContent: 'center' },
  buttonText: { color: colors.background, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  secondary: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.line },
  secondaryText: { color: colors.text },
  error: { color: colors.error, fontSize: 14, lineHeight: 22 },
  paid: { color: colors.accent, fontWeight: '700', fontSize: 32 },
  amount: { fontSize: 48, fontWeight: '700', letterSpacing: -1.5, color: colors.text, fontVariant: ['tabular-nums'] },
  amountHero: {
    fontSize: 64,
    fontWeight: '600',
    letterSpacing: -2.5,
    textAlign: 'center',
    color: colors.text,
    fontVariant: ['tabular-nums']
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  divider: { height: 1, backgroundColor: colors.line },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { backgroundColor: colors.surface, borderRadius: 20, padding: 20, gap: 8, flexGrow: 1, flexBasis: 130 },
  metricValue: {
    color: colors.text,
    fontSize: 29,
    fontWeight: '600',
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums']
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    minHeight: 44,
    borderRadius: 24,
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center'
  },
  chipSelected: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.muted },
  chipSelectedText: { color: colors.background },
  tag: { fontSize: 11, fontWeight: '600', color: colors.accent, letterSpacing: 0.6 },
  nav: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.background,
    paddingVertical: 9,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center'
  },
  navItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 3 },
  navText: { color: colors.muted, fontSize: 12, fontWeight: '600' }
})
export function Page({
  title,
  children,
  back = true,
  footer
}: {
  title: string
  children: React.ReactNode
  back?: boolean
  footer?: React.ReactNode
}) {
  const router = useRouter()
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.row}>
          <Text style={styles.label}>BSV Merchant</Text>
          {back && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Go back"
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              style={{ padding: 8 }}
            >
              <Text style={styles.body}>← Back</Text>
            </Pressable>
          )}
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {children}
      </ScrollView>
      {footer}
    </SafeAreaView>
  )
}
export function Button({
  title,
  onPress,
  disabled = false,
  secondary = false
}: {
  title: string
  onPress(): void
  disabled?: boolean
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        (disabled || pressed) && { opacity: disabled ? 0.4 : 0.75 }
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text>
    </Pressable>
  )
}
export function Field({
  label,
  value,
  onChange,
  secret = false,
  numeric = false
}: {
  label: string
  value: string
  onChange(v: string): void
  secret?: boolean
  numeric?: boolean
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.body}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={numeric ? 'number-pad' : 'default'}
        style={styles.field}
        selectionColor={colors.accent}
      />
    </View>
  )
}
export function Chip({ title, selected, onPress }: { title: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipSelectedText]}>{title}</Text>
    </Pressable>
  )
}
export function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.label}>{label}</Text>
      <Text adjustsFontSizeToFit numberOfLines={1} style={styles.metricValue}>
        {value}
      </Text>
      {detail && <Text style={styles.caption}>{detail}</Text>}
    </View>
  )
}
export function Navigation({ role }: { role: 'merchant' | 'cashier' }) {
  const router = useRouter(),
    path = usePathname()
  const items = [
    { title: 'Overview', path: '/' as const, icon: '◫' },
    ...(role === 'cashier' ? [{ title: 'Counter', path: '/sale' as const, icon: '⊞' }] : []),
    { title: 'Sales', path: '/receipts' as const, icon: '↗' },
    ...(role === 'merchant' ? [{ title: 'Team', path: '/merchant' as const, icon: '◎' }] : [])
  ]
  return (
    <View style={styles.nav}>
      {items.map(item => (
        <Pressable
          key={item.path}
          accessibilityRole="button"
          accessibilityState={{ selected: path === item.path }}
          onPress={() => router.replace(item.path)}
          style={styles.navItem}
        >
          <Text style={{ color: path === item.path ? colors.text : colors.muted, fontSize: 19 }}>{item.icon}</Text>
          <Text style={[styles.navText, path === item.path && { color: colors.text }]}>{item.title}</Text>
        </Pressable>
      ))}
    </View>
  )
}
