/**
 * Contacts — search your saved counterparties, or scan someone's profile code
 * to add one. Reached from the bottom of Pay step "who" (never from Home);
 * back returns there.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { I18nManager, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import QRScanner from '../components/QRScanner'
import PressableScale from '../components/ui/PressableScale'
import ContactSigil from '../components/wallet/ContactSigil'
import { useContactsStore } from '../hooks/useContactsStore'
import { parseIdentityKeyFromScan } from '../../core/identity/contactLink'
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

export function ContactsScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router } = loadExpoRouter()
  const { walletUserId } = useWallet()
  const store = useContactsStore()

  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ContactRow[]>([])
  const [scannerVisible, setScannerVisible] = useState(false)

  const reload = useCallback(async () => {
    if (!store || walletUserId === null) return
    setRows(await store.searchContacts(walletUserId, query))
  }, [store, walletUserId, query])

  useEffect(() => {
    void reload()
  }, [reload])

  const onScan = useCallback(
    (data: string) => {
      const identityKey = parseIdentityKeyFromScan(data)
      if (!identityKey) return
      setScannerVisible(false)
      router.push({ pathname: '/contact/add', params: { identityKey } } as never)
    },
    [router]
  )

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
          <Ionicons name="qr-code-outline" size={22} color={colors.accent} />
        </PressableScale>
      </View>

      <View style={styles.searchWrap}>
        <View style={[styles.searchRow, { backgroundColor: colors.backgroundSecondary }]}>
          <Ionicons name="search" size={16} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('contacts_search_placeholder')}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.searchInput, { color: colors.textPrimary }]}
          />
        </View>
      </View>

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('contacts_empty_title')}</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>{t('contacts_empty_body')}</Text>
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {rows.map((row, idx) => (
            <TouchableOpacity
              key={row.identityKey}
              onPress={() => router.push({ pathname: '/contact', params: { identityKey: row.identityKey } } as never)}
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
                {!!row.cachedHandle && (
                  <Text style={[styles.rowHandle, { color: colors.textSecondary }]} numberOfLines={1}>
                    @{row.cachedHandle}
                  </Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textQuaternary} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* The one manual-entry door into Contacts (2026-09-18) — every other
          path (scan, deep link, a payment's success screen) already knows the
          identity key. */}
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
  searchWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  searchInput: { ...typography.body, flex: 1, padding: 0 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { ...typography.body, fontWeight: '500' },
  rowHandle: { ...typography.footnote, marginTop: 1 },
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
