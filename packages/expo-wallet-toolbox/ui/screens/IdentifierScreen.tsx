/**
 * Your Identifier as a QR: a deep link straight to another wallet's
 * add-contact screen (`bsv-wallet://contact/add?identityKey=…`, 2026-09-18
 * ruling), never the bare key and never a payment request. Copy and Share
 * carry the same link; the callout says what scanning it does and does not do.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { I18nManager, Share, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../components/ui/PressableScale'
import { showToast } from '../components/ui/Toast'
import { contactAddLinkFor } from '../../core/identity/contactLink'
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

type QRCodeComponent = typeof import('react-native-qrcode-svg').default
let qrCodeComponent: QRCodeComponent | undefined
function loadQRCode(): QRCodeComponent {
  if (!qrCodeComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-qrcode-svg')
    qrCodeComponent = (mod?.default ?? mod) as QRCodeComponent
  }
  return qrCodeComponent
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

type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default
let clipboardModule: ClipboardModule | undefined
function loadClipboard(): ClipboardModule {
  if (!clipboardModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('@react-native-clipboard/clipboard').default as ClipboardModule
  }
  return clipboardModule
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

const QR_SIZE = 240

export function IdentifierScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const QRCode = loadQRCode()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const { managers, adminOriginator } = useWallet()
  const params = useLocalSearchParams<{
    identityKey?: string | string[]
    name?: string | string[]
    handle?: string | string[]
  }>()
  const [identityKey, setIdentityKey] = useState(firstParam(params.identityKey) ?? '')
  const name = firstParam(params.name) ?? ''
  const handle = firstParam(params.handle) ?? ''

  // Profile passes the key along; a cold deep link into this screen fetches it.
  useEffect(() => {
    if (identityKey) return
    const wallet = managers?.permissionsManager
    if (!wallet) return
    void wallet.getPublicKey({ identityKey: true }, adminOriginator).then(r => {
      if (r?.publicKey) setIdentityKey(r.publicKey)
    })
  }, [identityKey, managers, adminOriginator])

  const link = identityKey ? contactAddLinkFor(identityKey) : ''

  const onCopy = useCallback(() => {
    if (!link) return
    loadClipboard().setString(link)
    showToast(t('copied'), { type: 'success' })
  }, [link, t])

  const onShare = useCallback(async () => {
    if (!link) return
    try {
      await Share.share({ message: link })
    } catch {
      // The sheet was dismissed; nothing to report.
    }
  }, [link])

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
          {t('profile_identifier_section')}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <View style={styles.body}>
        <View style={styles.who}>
          <View style={[styles.whoDisc, { backgroundColor: colors.accent }]}>
            <Ionicons name="person" size={20} color={colors.textOnAccent} />
          </View>
          <View>
            <Text style={[styles.whoName, { color: colors.textPrimary }]} numberOfLines={1}>
              {name || abbreviateKey(identityKey)}
            </Text>
            {!!handle && <Text style={[styles.whoHandle, { color: colors.textSecondary }]}>@{handle}</Text>}
          </View>
        </View>

        <View style={[styles.plate, { borderColor: colors.separator }]}>
          {!!link && <QRCode value={link} size={QR_SIZE} color="#000" backgroundColor="#fff" />}
        </View>

        <Text style={[styles.link, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
          {link}
        </Text>

        <View style={styles.actions}>
          <PressableScale
            onPress={onCopy}
            haptic="tap"
            style={[styles.actionBtn, { backgroundColor: colors.fillTertiary }]}
            accessibilityRole="button"
          >
            <Ionicons name="copy-outline" size={18} color={colors.textPrimary} />
            <Text style={[styles.actionLabel, { color: colors.textPrimary }]}>{t('copy')}</Text>
          </PressableScale>
          <PressableScale
            onPress={onShare}
            haptic="tap"
            style={[styles.actionBtn, { backgroundColor: colors.fillTertiary }]}
            accessibilityRole="button"
          >
            <Ionicons name="share-outline" size={18} color={colors.textPrimary} />
            <Text style={[styles.actionLabel, { color: colors.textPrimary }]}>{t('share')}</Text>
          </PressableScale>
        </View>

        <View style={[styles.callout, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
          <Text style={[styles.calloutText, { color: colors.textSecondary }]}>{t('profile_qr_callout')}</Text>
        </View>
      </View>
    </View>
  )
}

export default IdentifierScreen

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
  body: { alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  who: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  whoDisc: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  whoName: { ...typography.headline, fontWeight: '600' },
  whoHandle: { ...typography.footnote },
  // The plate stays white in both themes: a QR is read by a camera, not by a person.
  plate: {
    padding: spacing.lg,
    borderRadius: radii.xl,
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    width: QR_SIZE + spacing.lg * 2,
    height: QR_SIZE + spacing.lg * 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  link: { ...typography.caption1, fontFamily: 'monospace', textAlign: 'center', maxWidth: '100%' },
  actions: { flexDirection: 'row', gap: spacing.sm, alignSelf: 'stretch' },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: 44,
    borderRadius: radii.md
  },
  actionLabel: { ...typography.subhead, fontWeight: '500' },
  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md
  },
  calloutText: { ...typography.footnote, flex: 1 }
})
