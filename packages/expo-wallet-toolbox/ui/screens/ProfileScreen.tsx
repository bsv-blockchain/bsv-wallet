/**
 * Profile — your own avatar, handle (register/status), display name, and a QR
 * that deep-links straight to another wallet's add-contact screen.
 *
 * Handle checking/registering has one real backend fact available today: no
 * certifier is deployed (`getHandleCertifierConfig` — see
 * core/identity/handleCertificate.ts). Absent one, this screen shows
 * `profile_handle_unavailable` rather than pretending a check or a register
 * can succeed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { I18nManager, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../components/ui/PressableScale'
import { PencilEditField } from '../components/ui/PencilEditField'
import { showToast } from '../components/ui/Toast'
import { makeIdentityClient, resolveIdentity } from '../resolveIdentity'
import { getHandleCertifierConfig } from '../../core/toolboxConfig'
import { checkHandleAvailability, registerHandle, type HandleAvailability } from '../../core/identity/handleCertificate'
import { publishDisplayName } from '../../core/identity/profileCertificate'
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

const HANDLE_KV_KEY = 'profile_registered_handle'
const HANDLE_CHECK_DEBOUNCE_MS = 400

export function ProfileScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const QRCode = loadQRCode()
  const { router } = loadExpoRouter()
  const { managers, adminOriginator, selectedNetwork, storage } = useWallet()
  const wallet = managers?.permissionsManager || null

  const [identityKey, setIdentityKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [registeredHandle, setRegisteredHandle] = useState<string | null>(null)
  const [handleInput, setHandleInput] = useState('')
  const [availability, setAvailability] = useState<HandleAvailability | 'idle'>('idle')
  const [registering, setRegistering] = useState(false)

  const certifier = getHandleCertifierConfig(selectedNetwork)

  useEffect(() => {
    if (!wallet) return
    void wallet.getPublicKey({ identityKey: true }, adminOriginator).then(r => {
      if (r?.publicKey) setIdentityKey(r.publicKey)
    })
    void storage?.getKeyValue(HANDLE_KV_KEY).then(v => {
      if (v) setRegisteredHandle(v)
    })
  }, [wallet, adminOriginator, storage])

  useEffect(() => {
    if (!wallet || !identityKey) return
    const idClient = makeIdentityClient(wallet as never, adminOriginator)
    if (!idClient) return
    let cancelled = false
    void resolveIdentity(idClient, identityKey).then(([, identity]) => {
      if (!cancelled && identity?.name) setDisplayName(identity.name)
    })
    return () => {
      cancelled = true
    }
  }, [wallet, identityKey, adminOriginator])

  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChangeHandle = useCallback(
    (text: string) => {
      setHandleInput(text)
      if (checkTimer.current) clearTimeout(checkTimer.current)
      if (!certifier) {
        setAvailability('idle')
        return
      }
      if (text.trim() === '') {
        setAvailability('idle')
        return
      }
      setAvailability('checking')
      checkTimer.current = setTimeout(async () => {
        const idClient = wallet ? makeIdentityClient(wallet as never, adminOriginator) : null
        if (!idClient) {
          setAvailability('failed')
          return
        }
        setAvailability(await checkHandleAvailability(idClient, text.trim()))
      }, HANDLE_CHECK_DEBOUNCE_MS)
    },
    [certifier, wallet, adminOriginator]
  )

  const onRegister = useCallback(async () => {
    if (!wallet || availability !== 'available') return
    const idClient = makeIdentityClient(wallet as never, adminOriginator)
    if (!idClient) return
    setRegistering(true)
    try {
      const result = await registerHandle({
        wallet: wallet as never,
        idClient,
        adminOriginator,
        certifier,
        handle: handleInput.trim()
      })
      if (result.kind === 'registered') {
        setRegisteredHandle(handleInput.trim())
        void storage?.setKeyValue(HANDLE_KV_KEY, handleInput.trim())
        showToast(t('profile_handle_registered'), { type: 'success' })
      } else if (result.kind === 'unavailable') {
        showToast(t('profile_handle_unavailable'), { type: 'error' })
      } else if (result.kind === 'failed') {
        showToast(result.message, { type: 'error' })
      }
    } finally {
      setRegistering(false)
    }
  }, [wallet, availability, adminOriginator, certifier, handleInput, storage, t])

  const onSaveDisplayName = useCallback(
    async (next: string) => {
      setDisplayName(next)
      if (!wallet) return
      const idClient = makeIdentityClient(wallet as never, adminOriginator)
      if (!idClient) return
      const result = await publishDisplayName({ wallet: wallet as never, idClient, adminOriginator, displayName: next })
      if (result.kind === 'failed') showToast(result.message, { type: 'error' })
    },
    [wallet, adminOriginator]
  )

  const availabilityText: Record<HandleAvailability, string> = {
    checking: t('profile_handle_checking'),
    available: t('profile_handle_available', { handle: handleInput.trim() }),
    taken: t('profile_handle_taken', { handle: handleInput.trim() }),
    invalid: t('profile_handle_invalid'),
    failed: t('profile_handle_failed')
  }
  const availabilityColor =
    availability === 'available' ? colors.success : availability === 'checking' ? colors.textSecondary : colors.warning

  const link = identityKey ? contactAddLinkFor(identityKey) : ''

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
          <Ionicons name={I18nManager.isRTL ? 'chevron-forward' : 'chevron-back'} size={24} color={colors.textSecondary} />
        </PressableScale>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {t('profile')}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textTertiary }]}>{t('profile_display_name')}</Text>
        <PencilEditField
          value={displayName || abbreviateKey(identityKey)}
          onSave={onSaveDisplayName}
          editAccessibilityLabel={t('contact_edit_name')}
          saveAccessibilityLabel={t('contact_save_name')}
          textStyle={typography.body}
        />
        <Text style={[styles.hint, { color: colors.textTertiary }]}>{t('profile_display_name_hint')}</Text>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textTertiary }]}>{t('profile_handle')}</Text>
        {registeredHandle ? (
          <Text style={[styles.handleRegistered, { color: colors.textPrimary }]}>@{registeredHandle}</Text>
        ) : !certifier ? (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('profile_handle_unavailable')}</Text>
        ) : (
          <>
            <View style={[styles.inputRow, { backgroundColor: colors.backgroundSecondary }]}>
              <TextInput
                value={handleInput}
                onChangeText={onChangeHandle}
                placeholder={t('profile_handle_placeholder')}
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, { color: colors.textPrimary }]}
              />
            </View>
            {availability !== 'idle' && (
              <Text style={[styles.hint, { color: availabilityColor }]}>{availabilityText[availability]}</Text>
            )}
            <PressableScale
              onPress={onRegister}
              disabled={availability !== 'available' || registering}
              haptic="confirm"
              style={[
                styles.registerBtn,
                { backgroundColor: availability === 'available' && !registering ? colors.accent : colors.fill }
              ]}
            >
              <Text
                style={[
                  styles.registerText,
                  { color: availability === 'available' && !registering ? colors.textOnAccent : colors.textTertiary }
                ]}
              >
                {t('profile_handle_register_action')}
              </Text>
            </PressableScale>
          </>
        )}
      </View>

      {!!link && (
        <View style={styles.qrWrap}>
          <View style={styles.qrPlate}>
            <QRCode value={link} size={200} color="#000" backgroundColor="#fff" />
          </View>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('profile_qr_hint')}</Text>
        </View>
      )}
    </View>
  )
}

export default ProfileScreen

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
  field: { paddingHorizontal: spacing.lg, marginBottom: spacing.xl },
  label: { fontSize: 10.5, fontWeight: '700', letterSpacing: 1.3, marginBottom: spacing.sm },
  hint: { ...typography.footnote, marginTop: spacing.xs },
  inputRow: { borderRadius: radii.md, paddingHorizontal: spacing.md },
  input: { ...typography.body, paddingVertical: spacing.md },
  handleRegistered: { ...typography.body, fontWeight: '600' },
  registerBtn: { marginTop: spacing.md, paddingVertical: spacing.sm + 2, borderRadius: radii.md, alignItems: 'center' },
  registerText: { ...typography.subhead, fontWeight: '600' },
  qrWrap: { alignItems: 'center', gap: spacing.sm, paddingTop: spacing.lg },
  qrPlate: { padding: spacing.lg, borderRadius: radii.xl, backgroundColor: '#fff' }
})
