/**
 * New Contact — four ways in: a scanned or deep-linked identity key (QR scan
 * on the Contacts header, or `bsv-wallet://contact/add?identityKey=`), a
 * network search hit on Contacts (`?source=search`), the "Save as a contact"
 * offer on a payment's success screen (`?identityKey=` and `?name=` both
 * prefilled, `?source=pay`), or the plain "New Contact" button at the bottom
 * of the Contacts list (2026-09-18) — the only path with no identity key
 * yet, where the Identifier row itself becomes an editable paste field.
 *
 * Any past activity with the key is shown below the form, so you can see who
 * you are about to save.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { I18nManager, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import { GroupedSection } from '../components/ui/GroupedList'
import PressableScale from '../components/ui/PressableScale'
import { showToast } from '../components/ui/Toast'
import ContactSigil from '../components/wallet/ContactSigil'
import ContactActivityList from '../components/wallet/ContactActivityList'
import IdentifierRow from '../components/wallet/IdentifierRow'
import { useContactsStore } from '../hooks/useContactsStore'
import { abbreviateKey } from '../../core/pay/counterparty'
import { isCompressedIdentityKey } from '../../core/identity/contactLink'
import { getContactActivity, type ContactActivityItem } from '../../core/contacts/contactActivity'
import type { ContactSource } from '../../core/contacts/contactsStore'

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

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

const SOURCES: ReadonlySet<string> = new Set<ContactSource>(['manual', 'qr', 'pay', 'search'])

export function NewContactScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const { walletUserId, managers, adminOriginator, storage } = useWallet()
  const store = useContactsStore()
  const params = useLocalSearchParams<{
    identityKey?: string | string[]
    name?: string | string[]
    source?: string | string[]
  }>()
  const prefilledIdentityKey = (firstParam(params.identityKey) ?? '').toLowerCase()
  const sourceParam = firstParam(params.source)
  const source: ContactSource = sourceParam && SOURCES.has(sourceParam) ? (sourceParam as ContactSource) : 'qr'
  // The only path with no identity key yet: the plain "New Contact" button on
  // the Contacts list. Everywhere else (scan, deep link, search, the payment
  // success screen) arrives with one already known, and the row stays read-only.
  const manualEntry = prefilledIdentityKey === ''

  const [name, setName] = useState(firstParam(params.name) ?? '')
  const [identifierInput, setIdentifierInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [activity, setActivity] = useState<ContactActivityItem[]>([])

  const identityKey = manualEntry ? identifierInput.trim().toLowerCase() : prefilledIdentityKey
  const identityKeyValid = isCompressedIdentityKey(identityKey)
  const nameValid = name.trim().length > 0

  useEffect(() => {
    if (!identityKeyValid) {
      setActivity([])
      return
    }
    let cancelled = false
    void getContactActivity({
      wallet: managers?.permissionsManager as never,
      adminOriginator,
      settlementsDb: storage?.sqliteDb as never,
      identityKey
    }).then(items => {
      if (!cancelled) setActivity(items)
    })
    return () => {
      cancelled = true
    }
  }, [identityKey, identityKeyValid, managers, adminOriginator, storage])

  const onSave = useCallback(async () => {
    if (!store || walletUserId === null || !identityKeyValid || !nameValid) return
    setSaving(true)
    try {
      await store.createContact({
        userId: walletUserId,
        identityKey,
        name: name.trim(),
        source: manualEntry ? 'manual' : source
      })
      showToast(t('contact_saved'), { type: 'success' })
      router.replace({ pathname: '/contact', params: { identityKey } } as never)
    } finally {
      setSaving(false)
    }
  }, [store, walletUserId, identityKey, identityKeyValid, name, nameValid, manualEntry, source, router, t])

  const canSave = nameValid && identityKeyValid && !saving
  const showIdentifierError = manualEntry && identifierInput.trim().length > 0 && !identityKeyValid

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
          {t('contact_new_title')}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <ContactSigil identityKey={identityKeyValid ? identityKey : '0'.repeat(66)} size={72} radius={24} />
          <Text style={[styles.heroKey, { color: identityKeyValid ? colors.textPrimary : colors.textTertiary }]}>
            {identityKeyValid ? abbreviateKey(identityKey) : t('contact_identifier')}
          </Text>
          <Text style={[styles.heroCaption, { color: colors.textTertiary }]}>{t('contact_no_handle_registered')}</Text>
        </View>

        <GroupedSection header={t('contact_name_section')} footer={t('contact_new_name_hint')}>
          <View style={styles.nameRow}>
            <View style={styles.nameLeading}>
              <Ionicons name="pencil-outline" size={17} color={colors.textSecondary} />
            </View>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t('contact_new_title')}
              placeholderTextColor={colors.textTertiary}
              autoFocus={!manualEntry}
              returnKeyType="done"
              style={[styles.nameInput, { color: colors.textPrimary }]}
            />
          </View>
        </GroupedSection>

        <GroupedSection
          header={t('contact_identifier')}
          footer={showIdentifierError ? t('contact_identifier_invalid') : undefined}
        >
          {manualEntry ? (
            <TextInput
              value={identifierInput}
              onChangeText={setIdentifierInput}
              placeholder={t('contact_identifier_placeholder')}
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              style={[styles.identifierInput, { color: showIdentifierError ? colors.error : colors.textPrimary }]}
            />
          ) : (
            <IdentifierRow identityKey={identityKey} />
          )}
        </GroupedSection>

        {activity.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>
              {t('contact_activity').toUpperCase()}
            </Text>
            <ContactActivityList items={activity} identityKey={identityKey} />
          </>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <PressableScale
          onPress={onSave}
          disabled={!canSave}
          haptic="confirm"
          style={[styles.cta, { backgroundColor: canSave ? colors.accent : colors.fill }]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSave }}
        >
          <Ionicons name="person-add-outline" size={18} color={canSave ? colors.textOnAccent : colors.textTertiary} />
          <Text style={[styles.ctaText, { color: canSave ? colors.textOnAccent : colors.textTertiary }]}>
            {t('contact_save')}
          </Text>
        </PressableScale>
      </View>
    </View>
  )
}

export default NewContactScreen

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
  content: { paddingTop: spacing.lg, paddingBottom: spacing.lg },
  hero: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl
  },
  heroKey: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontFamily: 'monospace', marginTop: spacing.xs },
  heroCaption: { ...typography.footnote },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingLeft: spacing.xs,
    paddingRight: spacing.lg
  },
  nameLeading: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  nameInput: { ...typography.body, flex: 1, minWidth: 0, paddingVertical: spacing.md, paddingHorizontal: 0 },
  identifierInput: {
    ...typography.subhead,
    fontFamily: 'monospace',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  sectionTitle: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.3,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm
  },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: { ...typography.subhead, fontWeight: '600' }
})
