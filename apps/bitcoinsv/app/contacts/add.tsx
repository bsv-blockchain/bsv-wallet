// Add a contact: by @handle, found in the handle registry (a bare @name means
// @name on this build's handle domain, decision 8), or straight from a
// payment's identity key (?identityKey=, from a payment's detail). The name
// is yours to choose; adding someone you'd taken out puts them back.
import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { TextInput } from '../../src/ui/TextInput'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Search } from 'lucide-react-native'
import { getHandleRegistryConfig, useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../../src/ui/Toast'
import { useOwnDomains } from '../../src/ui/Handle'
import { handleLabel } from '../../src/contacts/handles'
import { createHandleRegistryClient } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/client'
import type { RegistryProfile } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileCert'
import { font, usePalette } from '../../src/theme'
import { Face } from '../../src/ui/Face'
import { GlassButton } from '../../src/ui/GlassButton'
import { PageHeader } from '../../src/ui/PageHeader'
import { BalancedText } from '../../src/ui/BalancedText'
import { useContacts } from '../../src/contacts/useContacts'
import { registryQuery } from '../../src/contacts/registryQuery'

type Picked = { identityKey: string; name: string; handle?: string }

export default function AddContact() {
  const palette = usePalette()
  const own = useOwnDomains()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const params = useLocalSearchParams<{ identityKey?: string }>()
  const { selectedNetwork } = useWallet()
  const contacts = useContacts()
  const registry = getHandleRegistryConfig(selectedNetwork)
  const client = useMemo(
    () => (registry?.domain && registry?.url ? createHandleRegistryClient({ pinned: { domain: registry.domain, url: registry.url } }) : null),
    [registry?.domain, registry?.url]
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistryProfile[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(params.identityKey ? { identityKey: params.identityKey, name: '' } : null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  // the registry, a moment after typing stops
  useEffect(() => {
    const q = registryQuery(query, registry?.domain)
    if (!q || !client) {
      setResults(null)
      return
    }
    let live = true
    setSearching(true)
    setFailed(false)
    const t = setTimeout(() => {
      client
        .search(q)
        .then(r => live && setResults(r))
        .catch(() => live && (setFailed(true), setResults([])))
        .finally(() => live && setSearching(false))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, client, registry?.domain])

  const pick = (p: RegistryProfile) => {
    setPicked({ identityKey: p.identityKey, name: p.displayName ?? p.handle, handle: p.paymail })
    setName(p.displayName ?? p.handle)
  }

  const save = async () => {
    if (!picked || saving) return
    const label = name.trim() || picked.handle || `${picked.identityKey.slice(0, 8)}…${picked.identityKey.slice(-8)}`
    setSaving(true)
    try {
      await contacts.add({ identityKey: picked.identityKey, name: label, cachedHandle: picked.handle, source: picked.handle ? 'search' : 'pay' })
      showToast(`${label} added to contacts`, { type: 'success' })
      router.back()
    } catch {
      showToast('They couldn’t be added. Try again in a moment.', { type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Add contact" onBack={picked && !params.identityKey ? () => setPicked(null) : undefined} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {picked ? (
          <>
            <View style={styles.who}>
              <Face counterparty={{ kind: 'identityKey', value: picked.identityKey }} size={64} />
              <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
                {picked.handle ?? `Identity key · ${picked.identityKey.slice(0, 8)}…${picked.identityKey.slice(-8)}`}
              </Text>
            </View>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={picked.handle ? 'Name' : 'Label (optional)'}
              placeholderTextColor={palette.mutedForeground}
              autoFocus
              accessibilityLabel="Name"
              onSubmitEditing={() => void save()}
              style={[font(400), styles.input, { color: palette.foreground, backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}
            />
            <Text style={[font(400), styles.xs, styles.center, { color: palette.mutedForeground }]}>Only you see this name.</Text>
            <GlassButton size="lg" label={saving ? 'Adding…' : 'Add contact'} disabled={saving} onPress={() => void save()} />
          </>
        ) : (
          <>
            <View style={[styles.search, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}>
              <Search size={16} color={palette.mutedForeground} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={registry?.domain ? `@name or name@${registry.domain}` : '@handle'}
                placeholderTextColor={palette.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                accessibilityLabel="Search handles"
                style={[font(400), styles.searchInput, { color: palette.foreground }]}
              />
              {searching && <ActivityIndicator size="small" color={palette.mutedForeground} />}
            </View>
            {!client && (
              <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>Handles aren’t available in this build yet.</BalancedText>
            )}
            {failed && (
              <BalancedText style={[font(400), styles.small, styles.center, { color: palette.destructive }]}>
                The handle directory couldn’t be reached. Check your connection.
              </BalancedText>
            )}
            {results?.length === 0 && !failed && !searching && (
              <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>No one has that handle.</Text>
            )}
            {results?.map(p => {
              const have = contacts.byKey.get(p.identityKey.toLowerCase())
              return (
                <Pressable
                  key={p.identityKey + p.paymail}
                  onPress={() => (have ? router.replace({ pathname: '/contacts/[key]', params: { key: have.identityKey } }) : pick(p))}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.result, pressed && { backgroundColor: palette.secondary + '99' }]}
                >
                  <Face counterparty={{ kind: 'identityKey', value: p.identityKey }} size={40} />
                  <View style={styles.flex}>
                    <Text numberOfLines={1} style={[font(500), styles.small, { color: palette.foreground }]}>
                      {p.displayName ?? p.handle}
                    </Text>
                    <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                      {handleLabel(p.paymail, own)}
                      {have ? ' · in your contacts' : ''}
                    </Text>
                  </View>
                </Pressable>
              )
            })}
          </>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  content: { paddingHorizontal: 16, gap: 16, paddingTop: 8 },
  flex: { flex: 1, minWidth: 0 },
  who: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  center: { textAlign: 'center', alignSelf: 'stretch' },
  input: { height: 48, borderRadius: 16, paddingHorizontal: 16, fontSize: 15 },
  search: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, paddingHorizontal: 14 },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 10 }
})
