/**
 * A contact: name (editable), their read-only registered handle, every
 * interaction with them across every asset (2026-09-17 ruling), and delete.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { I18nManager, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import { showAlert } from '../components/ui/AlertCard'
import { PencilEditField } from '../components/ui/PencilEditField'
import AmountDisplay from '../components/wallet/AmountDisplay'
import { formatTokenAmountWithUnit } from '../tokenFormat'
import { useMandala } from '../hooks/useMandala'
import PressableScale from '../components/ui/PressableScale'
import ContactSigil from '../components/wallet/ContactSigil'
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

function ActivityItemRow({ item, isLast }: { item: ContactActivityItem; isLast: boolean }) {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const Ionicons = loadIonicons()
  const mandala = useMandala()

  if (item.kind === 'bsv') {
    const incoming = item.satoshis >= 0
    return (
      <View
        style={[
          styles.activityRow,
          !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
        ]}
      >
        <Ionicons
          name={incoming ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'}
          size={20}
          color={incoming ? colors.successStrong : colors.textSecondary}
        />
        <Text style={[styles.activityDesc, { color: colors.textPrimary }]} numberOfLines={1}>
          {item.description || t('transactions')}
        </Text>
        <Text style={[styles.activityAmount, { color: incoming ? colors.successAmount : colors.textPrimary }]}>
          <AmountDisplay>{item.satoshis}</AmountDisplay>
        </Text>
      </View>
    )
  }

  const holding = (mandala.balances ?? []).find(b => b.asset.assetId === item.assetId)
  const amountText =
    item.amountBaseUnits !== undefined && holding
      ? formatTokenAmountWithUnit(item.amountBaseUnits, holding.asset)
      : undefined
  const incoming = item.role === 'received'
  return (
    <View
      style={[
        styles.activityRow,
        !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
      ]}
    >
      <Ionicons
        name={incoming ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'}
        size={20}
        color={incoming ? colors.successStrong : colors.textSecondary}
      />
      <Text style={[styles.activityDesc, { color: colors.textPrimary }]} numberOfLines={1}>
        {t(incoming ? 'token_row_received' : 'token_row_sent', {
          ticker: holding?.asset.ticker ?? item.assetId.slice(0, 8)
        })}
      </Text>
      <Text style={[styles.activityAmount, { color: incoming ? colors.successAmount : colors.textPrimary }]}>
        {amountText ?? t('token_row_amount_pending')}
      </Text>
    </View>
  )
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
        <View style={styles.headerBtn} />
      </View>

      <View style={styles.hero}>
        <ContactSigil identityKey={identityKey} avatarUrl={contact.cachedAvatarUrl} size={72} radius={24} />
        <View style={styles.heroName}>
          <PencilEditField
            value={contact.name}
            onSave={async next => {
              if (walletUserId === null) return
              await store?.renameContact(walletUserId, identityKey, next)
              void reload()
            }}
            editAccessibilityLabel={t('contact_edit_name')}
            saveAccessibilityLabel={t('contact_save_name')}
            textStyle={[typography.title2, { fontWeight: '700' } as const]}
          />
        </View>
        {!!contact.cachedHandle && (
          <>
            <Text style={[styles.handle, { color: colors.textSecondary }]}>@{contact.cachedHandle}</Text>
            <Text style={[styles.handleCaption, { color: colors.textTertiary }]}>{t('contact_handle_caption')}</Text>
          </>
        )}
      </View>

      <Text style={[styles.sectionTitle, { color: colors.textTertiary }]}>{t('contact_activity').toUpperCase()}</Text>
      {activity.length === 0 ? (
        <Text style={[styles.activityEmpty, { color: colors.textSecondary }]}>{t('contact_activity_empty')}</Text>
      ) : (
        <View style={styles.activityList}>
          {activity.map((item, idx) => (
            <ActivityItemRow key={`${item.kind}:${item.txid}`} item={item} isLast={idx === activity.length - 1} />
          ))}
        </View>
      )}

      <PressableScale onPress={onDelete} haptic="tap" style={styles.deleteRow}>
        <Text style={[styles.deleteText, { color: colors.error }]}>{t('contact_delete')}</Text>
      </PressableScale>
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
  hero: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.xs },
  heroName: { minWidth: 160, marginTop: spacing.md },
  handle: { ...typography.body, fontWeight: '500' },
  handleCaption: { ...typography.caption1 },
  sectionTitle: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.3,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm
  },
  activityEmpty: { ...typography.footnote, paddingHorizontal: spacing.xl },
  activityList: { paddingHorizontal: spacing.xl },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm + 2 },
  activityDesc: { ...typography.subhead, flex: 1 },
  activityAmount: { ...typography.subhead, fontWeight: '600', fontVariant: ['tabular-nums'] },
  deleteRow: { alignItems: 'center', paddingVertical: spacing.xl, marginTop: 'auto' },
  deleteText: { ...typography.body, fontWeight: '600' }
})
