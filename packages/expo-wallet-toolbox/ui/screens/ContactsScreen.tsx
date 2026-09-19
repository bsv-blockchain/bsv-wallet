/**
 * Contacts — your saved counterparties in a grouped card, a second "Other
 * people" card of network search hits once you type, a scanner for someone's
 * profile code (header, top right) and a New Contact button at the bottom.
 * Reached from the bottom of Pay step "who" (never from Home); back returns
 * there.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  I18nManager,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import type { DisplayableIdentity } from '@bsv/sdk'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import QRScanner from '../components/QRScanner'
import PressableScale from '../components/ui/PressableScale'
import { GroupedSection } from '../components/ui/GroupedList'
import ContactSigil from '../components/wallet/ContactSigil'
import { useContactsStore } from '../hooks/useContactsStore'
import { makeIdentityClient, searchIdentities } from '../resolveIdentity'
import { parseIdentityKeyFromScan } from '../../core/identity/contactLink'
import { abbreviateKey } from '../../core/pay/counterparty'
import type { ContactRow } from '../../core/contacts/contactsStore'

type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

/** Same debounce as Pay's recipient search; the overlay is not free. */
const SEARCH_DEBOUNCE_MS = 400
const SEARCH_MIN_CHARS = 2

export function ContactsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router } = loadExpoRouter()
  const { walletUserId, managers, adminOriginator } = useWallet()
  const store = useContactsStore()

  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ContactRow[]>([])
  const [scannerVisible, setScannerVisible] = useState(false)
  const [networkHits, setNetworkHits] = useState<DisplayableIdentity[]>([])
  const [searching, setSearching] = useState(false)

  const reload = useCallback(async () => {
    if (!store || walletUserId === null) return
    setRows(await store.searchContacts(walletUserId, query))
  }, [store, walletUserId, query])

  useEffect(() => {
    void reload()
  }, [reload])

  // The network tier: people you have not saved, found by name on the
  // identity overlay. Decorative relative to the local list — a client that
  // will not build, or a lookup that throws, simply leaves the card out.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const text = query.trim()
    if (text.length < SEARCH_MIN_CHARS) {
      setNetworkHits([])
      setSearching(false)
      return
    }
    const idClient = makeIdentityClient(managers?.permissionsManager as never, adminOriginator)
    if (!idClient) return
    let cancelled = false
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        const hits = await searchIdentities(idClient, text)
        if (!cancelled) setNetworkHits(hits)
      } catch {
        if (!cancelled) setNetworkHits([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
    }
  }, [query, managers, adminOriginator])

  const savedKeys = new Set(rows.map(r => r.identityKey))
  const otherPeople = networkHits.filter(h => !savedKeys.has(h.identityKey))

  const onScan = useCallback(
    (data: string) => {
      const identityKey = parseIdentityKeyFromScan(data)
      if (!identityKey) return
      setScannerVisible(false)
      router.push({ pathname: '/contact/add', params: { identityKey } } as never)
    },
    [router]
  )

  const openNew = useCallback(
    (identity: DisplayableIdentity) => {
      router.push({
        pathname: '/contact/add',
        params: { identityKey: identity.identityKey, name: identity.name ?? '', source: 'search' }
      } as never)
    },
    [router]
  )

  const showEmpty = rows.length === 0 && otherPeople.length === 0 && !searching

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <PressableScale
          onPress={() => router.back()}
          haptic="tap"
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('go_back')}
        >
          <Ionicons
            name={I18nManager.isRTL ? 'chevron-forward' : 'chevron-back'}
            size={24}
            color={colors.textSecondary}
          />
        </PressableScale>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {t('contacts')}
        </Text>
        <PressableScale
          onPress={() => setScannerVisible(true)}
          haptic="tap"
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('contact_scan_hint')}
        >
          <Ionicons name="qr-code-outline" size={22} color={colors.textPrimary} />
        </PressableScale>
      </View>

      <View style={styles.searchWrap}>
        <View style={[styles.searchRow, { backgroundColor: colors.fillTertiary }]}>
          <Ionicons name="search" size={16} color={colors.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('contacts_search_placeholder')}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={[styles.searchInput, { color: colors.textPrimary }]}
          />
          {query.length > 0 && (
            <TouchableOpacity
              onPress={() => setQuery('')}
              style={styles.clearBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('cancel')}
            >
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {showEmpty ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('contacts_empty_title')}</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{t('contacts_empty_body')}</Text>
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          {rows.length > 0 && (
            <GroupedSection header={t('contacts_your_contacts')}>
              {rows.map((row, idx) => (
                <PressableScale
                  key={row.identityKey}
                  onPress={() =>
                    router.push({ pathname: '/contact', params: { identityKey: row.identityKey } } as never)
                  }
                  scaleTo={0.98}
                  haptic="tap"
                  accessibilityRole="button"
                >
                  <View
                    style={[
                      styles.row,
                      idx < rows.length - 1 && {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.separator
                      }
                    ]}
                  >
                    <ContactSigil identityKey={row.identityKey} avatarUrl={row.cachedAvatarUrl} />
                    <View style={styles.rowText}>
                      <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {row.name}
                      </Text>
                      <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                        {row.cachedHandle ? row.cachedHandle : t('contact_no_handle')}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textQuaternary} />
                  </View>
                </PressableScale>
              ))}
            </GroupedSection>
          )}

          {(otherPeople.length > 0 || searching) && (
            <GroupedSection
              header={t('contacts_other_people')}
              footer={otherPeople.length > 0 ? t('contacts_network_footer') : undefined}
            >
              {otherPeople.map((hit, idx) => (
                <PressableScale
                  key={hit.identityKey}
                  onPress={() => openNew(hit)}
                  scaleTo={0.98}
                  haptic="tap"
                  accessibilityRole="button"
                >
                  <View
                    style={[
                      styles.row,
                      (idx < otherPeople.length - 1 || searching) && {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.separator
                      }
                    ]}
                  >
                    <ContactSigil identityKey={hit.identityKey} avatarUrl={hit.avatarURL || undefined} />
                    <View style={styles.rowText}>
                      <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {hit.name || t('unknown')}
                      </Text>
                      <Text style={[styles.rowSub, styles.mono, { color: colors.textSecondary }]} numberOfLines={1}>
                        {hit.abbreviatedKey || abbreviateKey(hit.identityKey)}
                      </Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: colors.fill }]}>
                      <Text style={[styles.badgeText, { color: colors.textPrimary }]}>{t('contacts_not_saved')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textQuaternary} />
                  </View>
                </PressableScale>
              ))}
              {searching && (
                <View style={styles.searchingRow}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                  <Text style={[styles.searchingText, { color: colors.textSecondary }]}>{t('searching')}</Text>
                </View>
              )}
            </GroupedSection>
          )}
        </ScrollView>
      )}

      {/* The one manual-entry door into Contacts (2026-09-18) — every other
          path (scan, deep link, search, a payment's success screen) already
          knows the identity key. */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <PressableScale
          onPress={() => router.push('/contact/add' as never)}
          haptic="tap"
          style={[styles.newContactBtn, { backgroundColor: colors.accent }]}
          accessibilityRole="button"
        >
          <Ionicons name="person-add-outline" size={18} color={colors.textOnAccent} />
          <Text style={[styles.newContactText, { color: colors.textOnAccent }]}>{t('contact_new_title')}</Text>
        </PressableScale>
      </View>

      <Modal visible={scannerVisible} animationType="slide" onRequestClose={() => setScannerVisible(false)}>
        <QRScanner onScan={onScan} onClose={() => setScannerVisible(false)} hintText={t('contact_scan_hint')} />
      </Modal>
    </View>
  )
}

export default ContactsScreen

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline, fontWeight: '600', flex: 1, textAlign: 'center' },
  searchWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    minHeight: 40
  },
  searchInput: { ...typography.body, flex: 1, paddingVertical: spacing.sm, paddingHorizontal: 0 },
  clearBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  listContent: { paddingBottom: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 58,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { ...typography.body },
  rowSub: { ...typography.footnote },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  badge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  badgeText: { ...typography.caption2, fontWeight: '600' },
  searchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md
  },
  searchingText: { ...typography.subhead },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.xxl },
  emptyTitle: { ...typography.headline, fontWeight: '600', marginTop: spacing.sm },
  emptyBody: { ...typography.footnote, textAlign: 'center' },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  newContactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  newContactText: { ...typography.subhead, fontWeight: '600' }
})
