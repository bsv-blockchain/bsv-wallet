/**
 * Profile — your display name (pencil → confirm), your handle (registered
 * state, or the claim flow), and your Identifier with a way to show it as a
 * QR (its own screen) or copy it.
 *
 * Handle checking/registering has one real backend fact available today: no
 * certifier is deployed (`getHandleCertifierConfig` — see
 * core/identity/handleCertificate.ts). Absent one, the Handle card says so
 * (`profile_handle_unavailable`) rather than pretending a check or a claim
 * can succeed.
 *
 * No avatar uploader in this pass (spec: avatar is display-only), so the hero
 * is the plain profile disc rather than a dead "Add photo" control.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, I18nManager, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'
import PressableScale from '../components/ui/PressableScale'
import { GroupedSection } from '../components/ui/GroupedList'
import { ListRow } from '../components/ui/ListRow'
import { PencilEditField } from '../components/ui/PencilEditField'
import { showToast } from '../components/ui/Toast'
import IdentifierRow from '../components/wallet/IdentifierRow'
import { makeIdentityClient, resolveIdentity } from '../resolveIdentity'
import { getHandleCertifierConfig } from '../../core/toolboxConfig'
import { checkHandleAvailability, registerHandle, type HandleAvailability } from '../../core/identity/handleCertificate'

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

const HANDLE_KV_KEY = 'profile_registered_handle'
/**
 * The display name lives here, on this device, and nowhere public. It is sent
 * to the handle registry as a private certificate field when a handle is
 * registered (see `registerHandle`) — never revealed on chain. The identity
 * overlay's `name` is only a fallback for a wallet that has never set one.
 */
const DISPLAY_NAME_KV_KEY = 'profile_display_name'
const HANDLE_CHECK_DEBOUNCE_MS = 400

export function ProfileScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Ionicons = loadIonicons()
  const { router } = loadExpoRouter()
  const { managers, adminOriginator, selectedNetwork, storage } = useWallet()
  const wallet = managers?.permissionsManager || null

  const [identityKey, setIdentityKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [displayNameLoaded, setDisplayNameLoaded] = useState(false)
  const [registeredHandle, setRegisteredHandle] = useState<string | null>(null)
  const [changingHandle, setChangingHandle] = useState(false)
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
    void storage?.getKeyValue(DISPLAY_NAME_KV_KEY).then(v => {
      if (v) {
        setDisplayName(v)
        setDisplayNameLoaded(true)
      } else {
        setDisplayNameLoaded(true)
      }
    })
  }, [wallet, adminOriginator, storage])

  // Fallback only: a name the overlay already has for this key, used when no
  // local display name was ever saved. Never overwrites a saved one.
  useEffect(() => {
    if (!wallet || !identityKey || !displayNameLoaded || displayName !== '') return
    const idClient = makeIdentityClient(wallet as never, adminOriginator)
    if (!idClient) return
    let cancelled = false
    void resolveIdentity(idClient, identityKey).then(([, identity]) => {
      if (!cancelled && identity?.name) setDisplayName(identity.name)
    })
    return () => {
      cancelled = true
    }
    // displayName deliberately omitted: this runs once the local read settles,
    // not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, identityKey, adminOriginator, displayNameLoaded])

  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runCheck = useCallback(
    (text: string) => {
      if (checkTimer.current) clearTimeout(checkTimer.current)
      if (!certifier || text.trim() === '') {
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
  const onChangeHandle = useCallback(
    (text: string) => {
      setHandleInput(text)
      runCheck(text)
    },
    [runCheck]
  )

  const onRegister = useCallback(async () => {
    if (!wallet || availability !== 'available') return
    const idClient = makeIdentityClient(wallet as never, adminOriginator)
    if (!idClient) return
    setRegistering(true)
    try {
      const handle = handleInput.trim()
      const result = await registerHandle({
        wallet: wallet as never,
        idClient,
        adminOriginator,
        certifier,
        handle,
        displayName
      })
      if (result.kind === 'registered') {
        setRegisteredHandle(handle)
        void storage?.setKeyValue(HANDLE_KV_KEY, handle)
        setChangingHandle(false)
        setHandleInput('')
        setAvailability('idle')
        showToast(t('profile_handle_registered'), { type: 'success' })
      } else if (result.kind === 'unavailable') {
        showToast(t('profile_handle_unavailable'), { type: 'error' })
      } else if (result.kind === 'failed') {
        showToast(result.message, { type: 'error' })
      }
    } finally {
      setRegistering(false)
    }
  }, [wallet, availability, adminOriginator, certifier, handleInput, displayName, storage, t])

  // Local only. The registry learns it on the next handle registration.
  const onSaveDisplayName = useCallback(
    async (next: string) => {
      const trimmed = next.trim()
      setDisplayName(trimmed)
      try {
        await storage?.setKeyValue(DISPLAY_NAME_KV_KEY, trimmed)
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { type: 'error' })
      }
    },
    [storage]
  )

  const handle = handleInput.trim()
  const editingHandle = !!certifier && (!registeredHandle || changingHandle)
  const statusLine: Partial<Record<HandleAvailability, { text: string; color: string; icon: string }>> = {
    checking: { text: t('profile_handle_checking'), color: colors.textSecondary, icon: 'time-outline' },
    available: {
      text: t('profile_handle_available', { handle: `@${handle}` }),
      color: colors.success,
      icon: 'checkmark-circle'
    },
    taken: { text: t('profile_handle_taken', { handle: `@${handle}` }), color: colors.error, icon: 'close-circle' },
    invalid: { text: t('profile_handle_invalid'), color: colors.warning, icon: 'alert-circle' }
  }
  const status = availability === 'idle' ? undefined : statusLine[availability]
  const canClaim = availability === 'available' && !registering

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
          {t('profile')}
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={[styles.heroDisc, { backgroundColor: colors.accent }]}>
            <Ionicons name="person" size={44} color={colors.textOnAccent} />
          </View>
        </View>

        <GroupedSection header={t('profile_display_name')} footer={t('profile_display_name_hint')}>
          <PencilEditField
            value={displayName}
            placeholder={t('profile_display_name')}
            onSave={onSaveDisplayName}
            editAccessibilityLabel={t('contact_edit_name')}
            saveAccessibilityLabel={t('contact_save_name')}
          />
        </GroupedSection>

        <GroupedSection
          header={t('profile_handle')}
          footer={registeredHandle && !changingHandle ? t('profile_handle_registered_hint') : undefined}
        >
          {!certifier && !registeredHandle ? (
            <Text style={[styles.unavailable, { color: colors.textSecondary }]}>{t('profile_handle_unavailable')}</Text>
          ) : !editingHandle ? (
            <View style={styles.registeredRow}>
              <Text style={[styles.registeredHandle, { color: colors.textPrimary }]} numberOfLines={1}>
                @{registeredHandle}
              </Text>
              <Ionicons name="checkmark-circle" size={14} color={colors.success} />
              <Text style={[styles.registeredCaption, { color: colors.textSecondary }]}>
                {t('pay_trust_handle_attested')}
              </Text>
              <View style={styles.flexSpacer} />
              {!!certifier && (
                <PressableScale
                  onPress={() => setChangingHandle(true)}
                  haptic="tap"
                  style={styles.textBtn}
                  accessibilityRole="button"
                >
                  <Text style={[styles.textBtnLabel, { color: colors.accent }]}>{t('profile_handle_change')}</Text>
                </PressableScale>
              )}
            </View>
          ) : (
            <>
              <View style={styles.handleRow}>
                <Text style={[styles.atSign, { color: colors.textTertiary }]}>@</Text>
                <TextInput
                  value={handleInput}
                  onChangeText={onChangeHandle}
                  placeholder={t('profile_handle_placeholder')}
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus={changingHandle}
                  style={[styles.handleInput, { color: colors.textPrimary }]}
                />
                {availability === 'checking' ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : status ? (
                  <Ionicons name={status.icon as never} size={18} color={status.color} />
                ) : null}
                {registeredHandle && (
                  <PressableScale
                    onPress={() => {
                      setChangingHandle(false)
                      setHandleInput('')
                      setAvailability('idle')
                    }}
                    haptic="tap"
                    style={styles.textBtn}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.textBtnLabel, { color: colors.textSecondary }]}>{t('cancel')}</Text>
                  </PressableScale>
                )}
              </View>
              {availability === 'failed' ? (
                <View style={[styles.failedWrap]}>
                  <View
                    style={[styles.failedCard, { borderColor: colors.error, backgroundColor: colors.error + '15' }]}
                  >
                    <Ionicons name="alert-circle-outline" size={18} color={colors.error} />
                    <View style={styles.failedText}>
                      <Text style={[styles.failedTitle, { color: colors.textPrimary }]}>
                        {t('profile_handle_failed')}
                      </Text>
                      <PressableScale
                        onPress={() => runCheck(handleInput)}
                        haptic="tap"
                        style={styles.retryBtn}
                        accessibilityRole="button"
                      >
                        <Text style={[styles.retryLabel, { color: colors.accent }]}>{t('retry')}</Text>
                      </PressableScale>
                    </View>
                  </View>
                </View>
              ) : status ? (
                <View style={styles.statusRow}>
                  <Ionicons name={status.icon as never} size={12} color={status.color} />
                  <Text style={[styles.statusText, { color: status.color }]}>{status.text}</Text>
                </View>
              ) : null}
            </>
          )}
        </GroupedSection>

        {editingHandle && registeredHandle && (
          <View style={[styles.callout, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
            <Text style={[styles.calloutText, { color: colors.textSecondary }]}>
              {t('profile_handle_replace_warning', { handle: registeredHandle })}
            </Text>
          </View>
        )}

        <GroupedSection header={t('profile_identifier_section')}>
          <ListRow
            label={t('profile_show_qr')}
            subtitle={t('profile_show_qr_hint')}
            icon="qr-code-outline"
            onPress={() =>
              router.push({
                pathname: '/identifier',
                params: { identityKey, name: displayName, handle: registeredHandle ?? '' }
              } as never)
            }
          />
          {!!identityKey && <IdentifierRow identityKey={identityKey} />}
        </GroupedSection>
      </ScrollView>

      {editingHandle && (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <PressableScale
            onPress={onRegister}
            disabled={!canClaim}
            haptic="confirm"
            style={[styles.cta, { backgroundColor: canClaim ? colors.accent : colors.fill }]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canClaim }}
          >
            {registering ? (
              <ActivityIndicator size="small" color={colors.textTertiary} />
            ) : (
              <Text style={[styles.ctaText, { color: canClaim ? colors.textOnAccent : colors.textTertiary }]}>
                {handle ? t('profile_handle_claim', { handle }) : t('profile_handle_register_action')}
              </Text>
            )}
          </PressableScale>
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
  content: { paddingTop: spacing.lg },
  hero: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.xl },
  heroDisc: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  unavailable: { ...typography.footnote, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  registeredRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 48,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs
  },
  registeredHandle: { ...typography.body, fontWeight: '600', flexShrink: 1 },
  registeredCaption: { ...typography.footnote },
  flexSpacer: { flex: 1 },
  textBtn: { minHeight: 44, paddingHorizontal: spacing.md, justifyContent: 'center' },
  textBtnLabel: { ...typography.footnote, fontWeight: '600' },
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs
  },
  atSign: { ...typography.body },
  handleInput: { ...typography.body, flex: 1, minWidth: 0, paddingVertical: spacing.md, paddingHorizontal: 0 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md
  },
  statusText: { ...typography.caption1, fontWeight: '500' },
  failedWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  failedCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1
  },
  failedText: { flex: 1, gap: spacing.xs },
  failedTitle: { ...typography.subhead },
  retryBtn: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  retryLabel: { ...typography.subhead, fontWeight: '700' },
  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: -spacing.md,
    marginBottom: spacing.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md
  },
  calloutText: { ...typography.footnote, flex: 1 },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  cta: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: spacing.md + 2,
    borderRadius: radii.md
  },
  ctaText: { ...typography.subhead, fontWeight: '600' }
})
