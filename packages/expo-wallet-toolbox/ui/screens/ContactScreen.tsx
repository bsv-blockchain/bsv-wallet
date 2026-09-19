/**
 * A contact: their face, name and read-only registered handle up top; your
 * own name for them (editable, pencil → confirm); their Identifier with a
 * copy button; delete; and every interaction with them across every asset
 * (2026-09-17 ruling), drawn with the same rows Home uses.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
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
import { mergeContactCache } from '../../core/contacts/contactCache'
import { makeIdentityClient, resolveIdentity } from '../resolveIdentity'
import { getHandleRegistryConfig } from '../../core/toolboxConfig'
import { parsePaymail } from '../../core/identity/handleRegistry/rules'
import { createHandleRegistryClient } from '../../core/identity/handleRegistry/client'
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
  const { managers, adminOriginator, storage, walletUserId, selectedNetwork } = useWallet()
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

  /**
   * Best-effort background cache refresh: the overlay's avatar and the
   * registry's handle, in ONE write. `refreshContactCache` replaces all three
   * cache columns, so two separate calls would each blank what the other just
   * stored. Once per visit — the write feeds `reload`, and re-running on the
   * contact it produced would be a loop.
   *
   * `name` is never touched: it is the user's own label for this person.
   */
  const refreshedKeyRef = useRef('')
  useEffect(() => {
    if (!identityKey || !store || walletUserId === null || !contact) return
    if (refreshedKeyRef.current === identityKey) return
    const idClient = makeIdentityClient(managers?.permissionsManager as never, adminOriginator)
    const registry = getHandleRegistryConfig(selectedNetwork)
    const client = registry ? createHandleRegistryClient({ pinned: registry }) : null
    // Claimed only once there is something to claim it for. A screen drawn
    // before the wallet finished building has no identity client (and, on a
    // chain with no registry, no client at all); `managers` is a dependency so
    // that pass can happen when they arrive, and spending the visit on the
    // empty one would skip the refresh for the whole visit.
    if (!idClient && !client) return
    refreshedKeyRef.current = identityKey
    let cancelled = false
    // A pass that never reaches its decision hands the guard back, so a
    // `contact` that changes mid-lookup (a rename, whose `reload` is a new
    // row) is re-checked instead of losing this visit's refresh. It cannot
    // reopen the loop the guard is for: that path is exactly the one this is
    // true on. Set BEFORE the write, not after: a cancellation landing while
    // the UPDATE is in flight would otherwise repeat both lookups to send the
    // same three columns again.
    let decided = false
    void (async () => {
      const [identity, lookup] = await Promise.all([
        idClient ? resolveIdentity(idClient, identityKey).then(([, found]) => found) : null,
        // A contact whose cached handle names another domain is looked up
        // there; everyone else on the registry this build is configured for.
        client ? client.lookupProfile(identityKey, parsePaymail(contact.cachedHandle ?? '')?.domain) : null
      ])
      if (cancelled) return
      // `lookupProfile`, not `lookupIdentityKey`: a `failed` lookup is the
      // registry not having answered, and writing `''` for it would blank a
      // contact's handle every time this screen is opened offline. Only an
      // answer — `found` or `none` — may change the column.
      const learnedHandle = lookup?.kind === 'found' ? lookup.profile.paymail : lookup?.kind === 'none' ? '' : undefined
      const next = mergeContactCache(contact, {
        ...(identity?.avatarURL ? { cachedAvatarUrl: identity.avatarURL } : {}),
        ...(learnedHandle === undefined ? {} : { cachedHandle: learnedHandle })
      })
      decided = true
      if (!next) return
      await store.refreshContactCache(walletUserId, identityKey, next)
      if (!cancelled) void reload().catch(() => {})
    })().catch(() => {})
    return () => {
      cancelled = true
      if (!decided) refreshedKeyRef.current = ''
    }
  }, [identityKey, store, walletUserId, managers, adminOriginator, selectedNetwork, contact, reload])

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
              <Text style={[styles.handle, { color: colors.textSecondary }]}>{contact.cachedHandle}</Text>
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
