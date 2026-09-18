/**
 * New Contact — reached only via a scanned or deep-linked identity key (QR
 * scan on the Contacts header, or `bsv-wallet://contact/add?identityKey=`).
 * There is no blank manual-entry path (2026-09-18 ruling): the identifier is
 * always pre-filled and read-only, and the user only ever supplies the name.
 */
import React, { useCallback, useMemo, useState } from 'react'
import { I18nManager, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../components/ui/PressableScale'
import { showToast } from '../components/ui/Toast'
import ContactSigil from '../components/wallet/ContactSigil'
import { useContactsStore } from '../hooks/useContactsStore'
import { abbreviateKey } from '../../core/pay/counterparty'

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

export function NewContactScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const { walletUserId } = useWallet()
  const store = useContactsStore()
  const params = useLocalSearchParams<{ identityKey?: string | string[] }>()
  const identityKey = (firstParam(params.identityKey) ?? '').toLowerCase()

  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const nameValid = name.trim().length > 0

  const onSave = useCallback(async () => {
    if (!store || walletUserId === null || !identityKey || !nameValid) return
    setSaving(true)
    try {
      await store.createContact({ userId: walletUserId, identityKey, name: name.trim(), source: 'qr' })
      showToast(t('contact_saved'), { type: 'success' })
      router.replace({ pathname: '/contact', params: { identityKey } } as never)
    } finally {
      setSaving(false)
    }
  }, [store, walletUserId, identityKey, name, nameValid, router])

  const identifierDisplay = useMemo(() => (identityKey ? abbreviateKey(identityKey) : ''), [identityKey])

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

      <View style={styles.hero}>
        <ContactSigil identityKey={identityKey || '0'.repeat(66)} size={72} radius={24} />
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textTertiary }]}>{t('contact_edit_name')}</Text>
        <View style={[styles.inputRow, { backgroundColor: colors.backgroundSecondary }]}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t('contact_new_title')}
            placeholderTextColor={colors.textTertiary}
            autoFocus
            style={[styles.input, { color: colors.textPrimary }]}
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textTertiary }]}>{t('contact_identifier')}</Text>
        <Text style={[styles.identifier, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
          {identifierDisplay}
        </Text>
      </View>

      <PressableScale
        onPress={onSave}
        disabled={!nameValid || saving || !identityKey}
        haptic="confirm"
        style={[styles.cta, { backgroundColor: nameValid && identityKey ? colors.accent : colors.fill }]}
      >
        <Text style={[styles.ctaText, { color: nameValid && identityKey ? colors.textOnAccent : colors.textTertiary }]}>
          {t('contact_save')}
        </Text>
      </PressableScale>
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
  hero: { alignItems: 'center', paddingVertical: spacing.xl },
  field: { paddingHorizontal: spacing.lg, marginBottom: spacing.lg },
  label: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.3,
    marginBottom: spacing.sm
  },
  inputRow: { borderRadius: radii.md, paddingHorizontal: spacing.md },
  input: { ...typography.body, paddingVertical: spacing.md },
  identifier: { ...typography.footnote, fontFamily: 'monospace' },
  cta: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md,
    alignItems: 'center'
  },
  ctaText: { ...typography.subhead, fontWeight: '600' }
})
