/**
 * A contact: their face, name and read-only registered handle up top; your
 * own name for them (editable, pencil → confirm); their Identifier with a
 * copy button; delete; and every interaction with them across every asset
 * (2026-09-17 ruling), drawn with the same rows Home uses.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { I18nManager, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import { showAlert } from '../components/ui/AlertCard'
import { GroupedSection } from '../components/ui/GroupedList'
import { ListRow } from '../components/ui/ListRow'
import { PencilEditField } from '../components/ui/PencilEditField'
import PressableScale from '../components/ui/PressableScale'
import ContactSigil from '../components/wallet/ContactSigil'
import ContactActivityList from '../components/wallet/ContactActivityList'
import IdentifierRow from '../components/wallet/IdentifierRow'
import { useContactsStore } from '../hooks/useContactsStore'
import { getContactActivity, type ContactActivityItem } from '../../core/contacts/contactActivity'
import { makeIdentityClient, resolveIdentity } from '../resolveIdentity'
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

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

export function ContactScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const { managers, adminOriginator, storage, walletUserId } = useWallet()
  const store = useContactsStore()
  const params = useLocalSearchParams<{ identityKey?: string | string[] }>()
  const identityKey = firstParam(params.identityKey) ?? ''

  const [contact, setContact] = useState<ContactRow | undefined>(undefined)
  const [activity, setActivity] = useState<ContactActivityItem[]>([])

  const reload = useCallback(async () => {
    if (!store || walletUserId === null || !identityKey) return
    setContact(await store.getContact(walletUserId, identityKey))
  }, [store, walletUserId, identityKey])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!identityKey) return
    const wallet = managers?.permissionsManager
    void getContactActivity({
      wallet: wallet as never,
      adminOriginator,
      settlementsDb: storage?.sqliteDb as never,
      identityKey
    }).then(setActivity)
  }, [identityKey, managers, adminOriginator, storage])

  // Best-effort background cache refresh — avatar only (see spec: no reliable
  // way yet to recover a "handle" field generically off a resolved identity).
  useEffect(() => {
    if (!identityKey || !store || walletUserId === null) return
    const idClient = makeIdentityClient(managers?.permissionsManager as never, adminOriginator)
    if (!idClient) return
    let cancelled = false
    void resolveIdentity(idClient, identityKey).then(([, identity]) => {
      if (cancelled || !identity?.avatarURL) return
      void store.refreshContactCache(walletUserId, identityKey, { cachedAvatarUrl: identity.avatarURL })
    })
    return () => {
      cancelled = true
    }
  }, [identityKey, store, walletUserId, managers, adminOriginator])

  const onDelete = useCallback(async () => {
    if (!store || walletUserId === null || !contact) return
    const choice = await showAlert({
      title: t('contact_delete'),
      message: t('contact_delete_body', { name: contact.name }),
      buttons: [
        { text: t('cancel'), style: 'cancel', key: 'cancel' },
        { text: t('contact_delete'), style: 'destructive', key: 'delete' }
      ]
    })
    if (choice !== 'delete') return
    await store.deleteContact(walletUserId, identityKey)
    router.back()
  }, [store, walletUserId, contact, identityKey, t, router])

  if (!contact) return <View style={[styles.container, { backgroundColor: colors.background }]} />

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
          {contact.name}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <ContactSigil identityKey={identityKey} avatarUrl={contact.cachedAvatarUrl} size={72} radius={24} />
          <Text style={[styles.heroName, { color: colors.textPrimary }]} numberOfLines={1}>
            {contact.name}
          </Text>
          {!!contact.cachedHandle && (
            <>
              <Text style={[styles.handle, { color: colors.textSecondary }]}>@{contact.cachedHandle}</Text>
              <View style={styles.captionRow}>
                <Ionicons name="shield-checkmark-outline" size={12} color={colors.textTertiary} />
                <Text style={[styles.handleCaption, { color: colors.textTertiary }]}>
                  {t('contact_handle_caption')}
                </Text>
              </View>
            </>
          )}
        </View>

        <GroupedSection header={t('contact_name_section')} footer={t('contact_name_hint')}>
          <PencilEditField
            value={contact.name}
            placeholder={t('contact_new_title')}
            onSave={async next => {
              if (walletUserId === null) return
              await store?.renameContact(walletUserId, identityKey, next)
              void reload()
            }}
            editAccessibilityLabel={t('contact_edit_name')}
            saveAccessibilityLabel={t('contact_save_name')}
          />
        </GroupedSection>

        <GroupedSection header={t('contact_identifier')}>
          <IdentifierRow identityKey={identityKey} />
        </GroupedSection>

        <GroupedSection>
          <ListRow
            label={t('contact_delete')}
            icon="trash-outline"
            iconColor={colors.error}
            destructive
            showChevron={false}
            onPress={onDelete}
            isLast
          />
        </GroupedSection>

        <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>{t('contact_activity').toUpperCase()}</Text>
        <ContactActivityList items={activity} identityKey={identityKey} />
      </ScrollView>
    </View>
  )
}

export default ContactScreen

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
  content: { paddingTop: spacing.lg },
  hero: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl
  },
  heroName: { ...typography.title2, fontWeight: '700', marginTop: spacing.xs },
  handle: { ...typography.body, fontWeight: '500' },
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  handleCaption: { ...typography.caption1 },
  // Tracked small caps, matching GroupedSection's own header.
  sectionTitle: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.3,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm
  }
})
