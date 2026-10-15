import React from 'react'
import { Pressable, ScrollView, Text, TextInput, View, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f4f3f0' },
  content: { padding: 24, gap: 20, maxWidth: 600, width: '100%', alignSelf: 'center' },
  title: { fontSize: 32, fontWeight: '700', color: '#151719' },
  body: { fontSize: 16, lineHeight: 24, color: '#54585e' },
  card: { padding: 24, borderRadius: 20, backgroundColor: '#fff', gap: 16 },
  field: { backgroundColor: '#fff', padding: 16, borderRadius: 12, fontSize: 18, borderWidth: 1, borderColor: '#ddd' },
  button: { backgroundColor: '#172c3f', padding: 18, borderRadius: 14, minHeight: 56 },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600', textAlign: 'center' },
  error: { color: '#a02b28', fontSize: 15, lineHeight: 22 },
  paid: { color: '#167048', fontWeight: '700', fontSize: 32 },
  amount: { fontSize: 48, fontWeight: '700', color: '#172c3f' }
})
export function Page({ title, children, back = true }: { title: string; children: React.ReactNode; back?: boolean }) {
  const router = useRouter()
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {back && (
          <Pressable accessibilityRole="button" onPress={() => router.back()}>
            <Text style={styles.body}>‹ Back</Text>
          </Pressable>
        )}
        <Text style={styles.title}>{title}</Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  )
}
export function Button({ title, onPress, disabled = false }: { title: string; onPress(): void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.45 }]}
    >
      <Text style={styles.buttonText}>{title}</Text>
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
      />
    </View>
  )
}
