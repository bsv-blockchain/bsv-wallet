/**
 * Profile — your display name (pencil → confirm), your handle (registered
 * state, or the claim flow), and your Identifier with a way to show it as a
 * QR (its own screen) or copy it.
 *
 * The registry, not this device, is the source of truth for which handle this
 * key holds: `profile_registered_handle` is only an offline cache, shown at
 * once and corrected the moment the reverse lookup answers, so a restored
 * wallet on a new device shows the right handle without having claimed
 * anything. A build with no registry configured for the selected chain says so
 * (`profile_handle_unavailable`) rather than pretending a check can succeed.
 *
 * No avatar uploader in this pass (spec: avatar is display-only), so the hero
 * is the plain profile disc rather than a dead "Add photo" control.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { getHandleRegistryConfig } from '../../core/toolboxConfig'
import { bindOriginator } from '../../core/mandala/createRuntime'
import { isValidHandleFormat, parsePaymail } from '../../core/identity/handleRegistry/rules'
import type { ProfileSigner } from '../../core/identity/handleRegistry/profileCert'
import { createHandleRegistryClient, type AvailabilityReason } from '../../core/identity/handleRegistry/client'
import {
  changeHandle,
  registerHandle,
  resumePending,
  updateProfile,
  type RegistrationResult
} from '../../core/identity/handleRegistry/registration'

/** What the claim field can be saying. `checking` and `failed` are this
 * screen's own; the rest are the registry's own reasons. */
type HandleAvailability = 'checking' | 'available' | 'failed' | AvailabilityReason

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

/** The full `handle@domain`, cached for a cold start. The registry decides. */
const HANDLE_KV_KEY = 'profile_registered_handle'
/**
 * The display name lives here on this device, and — once a handle is
 * registered — as a PUBLIC plaintext field of the profile certificate
 * (2026-09-18 ruling). The identity overlay's `name` is only a fallback for a
 * wallet that has never set one.
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
  const [registeredPaymail, setRegisteredPaymail] = useState<string | null>(null)
  const [changingHandle, setChangingHandle] = useState(false)
  const [handleInput, setHandleInput] = useState('')
  const [availability, setAvailability] = useState<HandleAvailability | 'idle'>('idle')
  const [registering, setRegistering] = useState(false)
  /** A journalled write that has not landed yet. Non-blocking, with a retry. */
  const [finishing, setFinishing] = useState(false)

  /**
   * Two strings, not the config object: `getHandleRegistryConfig` builds a
   * fresh `{ domain, url }` on every call, so memoising on the object would
   * hand `useMemo` a new identity every render — a new client every render, and
   * the mount effect below (which resumes a journal and asks the registry who
   * we are) re-running on every keystroke in either field.
   */
  const registry = getHandleRegistryConfig(selectedNetwork)
  const registryDomain = registry?.domain
  const registryUrl = registry?.url
  const client = useMemo(
    () =>
      registryDomain && registryUrl
        ? createHandleRegistryClient({ pinned: { domain: registryDomain, url: registryUrl } })
        : null,
    [registryDomain, registryUrl]
  )
  /** Bound to the admin originator so signing our own profile never raises a
   * permission prompt (core/mandala/createRuntime.ts). */
  const signer = useMemo(
    () => (wallet ? (bindOriginator(wallet, adminOriginator) as unknown as ProfileSigner) : null),
    [wallet, adminOriginator]
  )

  useEffect(() => {
    if (!wallet) return
    void wallet.getPublicKey({ identityKey: true }, adminOriginator).then(r => {
      if (r?.publicKey) setIdentityKey(r.publicKey)
    })
    // A cached value from before handles carried a domain names a handle on a
    // registry we cannot identify, so it is worth nothing.
    void storage?.getKeyValue(HANDLE_KV_KEY).then(v => {
      if (v && parsePaymail(v)) setRegisteredPaymail(v)
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

  /**
   * Finish anything a previous run left journalled, then ask the registry what
   * it actually holds for this key. In that order: a resumed claim is the very
   * thing the lookup would otherwise report as absent.
   *
   * `lookupProfile` rather than `lookupIdentityKey` because this screen WRITES
   * the answer into the offline cache, and only the registry saying this key
   * holds nothing may clear it (spec: "a 404 clears it"). A registry that did
   * not answer at all — no network, a timeout — leaves the cached handle
   * exactly as it was; blanking it for want of a network is the opposite of a
   * cache, and it is the one value this screen cannot mint again offline.
   */
  const [resumeNonce, setResumeNonce] = useState(0)
  useEffect(() => {
    if (!client || !signer || !storage || !identityKey) return
    let cancelled = false
    void (async () => {
      const resumed = await resumePending({ client, signer, storage })
      if (cancelled) return
      setFinishing(resumed.kind === 'pending')
      const seen = await client.lookupProfile(identityKey)
      if (cancelled || seen.kind === 'failed') return
      const paymail = seen.kind === 'found' ? seen.profile.paymail : ''
      setRegisteredPaymail(paymail === '' ? null : paymail)
      // Written only when it says something the cache does not already say: a
      // wallet that has never claimed a handle should not gain a row saying so
      // on every visit to this screen. Best effort, like the display-name write
      // below: the registry's answer is already on screen, and a store that
      // would not take the row must not become an unhandled rejection.
      try {
        const cached = (await storage.getKeyValue(HANDLE_KV_KEY)) ?? ''
        if (cached !== paymail) await storage.setKeyValue(HANDLE_KV_KEY, paymail)
      } catch {
        // Nothing to say and nothing to undo: the next mount asks again.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, signer, storage, identityKey, resumeNonce])

  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Bumped per request; a reply for a superseded input is dropped. */
  const checkNonce = useRef(0)
  // A debounce outlives the screen: leaving Profile mid-word would otherwise
  // still ask the registry, and then answer into a tree that is gone. The nonce
  // only drops superseded replies, not post-unmount ones.
  useEffect(
    () => () => {
      if (checkTimer.current) clearTimeout(checkTimer.current)
    },
    []
  )
  const runCheck = useCallback(
    (text: string) => {
      if (checkTimer.current) clearTimeout(checkTimer.current)
      checkNonce.current += 1
      const handle = text.trim().toLowerCase()
      if (!client || handle === '') {
        setAvailability('idle')
        return
      }
      setAvailability('checking')
      const nonce = checkNonce.current
      checkTimer.current = setTimeout(async () => {
        const result = await client.checkAvailability(handle)
        if (nonce !== checkNonce.current) return
        setAvailability(result.kind === 'unavailable' ? result.reason : result.kind)
      }, HANDLE_CHECK_DEBOUNCE_MS)
    },
    [client]
  )
  const onChangeHandle = useCallback(
    (text: string) => {
      setHandleInput(text)
      runCheck(text)
    },
    [runCheck]
  )

  const onRegister = useCallback(async () => {
    if (!client || !signer || !storage || availability !== 'available') return
    const handle = handleInput.trim().toLowerCase()
    if (!isValidHandleFormat(handle)) return
    setRegistering(true)
    try {
      const deps = { client, signer, storage }
      const result: RegistrationResult = registeredPaymail
        ? await changeHandle(deps, { previousPaymail: registeredPaymail, handle, displayName })
        : await registerHandle(deps, { handle, displayName })
      await applyResult(result)
    } finally {
      setRegistering(false)
    }
    async function applyResult(result: RegistrationResult) {
      if (result.kind === 'registered' || result.kind === 'changed') {
        setRegisteredPaymail(result.paymail)
        void storage?.setKeyValue(HANDLE_KV_KEY, result.paymail)
        setChangingHandle(false)
        setHandleInput('')
        setAvailability('idle')
        setFinishing(false)
        showToast(t(result.kind === 'changed' ? 'profile_handle_changed' : 'profile_handle_registered'), {
          type: 'success'
        })
      } else if (result.kind === 'rolled_back') {
        // The new handle went to somebody else between the release and the
        // claim; the old one was taken back, so say which one is still yours.
        setRegisteredPaymail(result.paymail)
        void storage?.setKeyValue(HANDLE_KV_KEY, result.paymail)
        setChangingHandle(false)
        setHandleInput('')
        setAvailability('idle')
        setFinishing(false)
        showToast(
          t('profile_handle_rolled_back', { handle: `${handle}@${registryDomain ?? ''}`, previous: result.paymail }),
          { type: 'error' }
        )
      } else if (result.kind === 'pending') {
        setFinishing(true)
      } else if (result.kind === 'unavailable') {
        showToast(t('profile_handle_unavailable'), { type: 'error' })
      } else if (result.kind === 'rejected') {
        showToast(t('profile_handle_rejected'), { type: 'error' })
      } else if (result.kind === 'failed') {
        showToast(result.message, { type: 'error' })
      } else {
        // `updated` and `idle` cannot reach a Claim press today, but a result
        // kind with no branch is a button that spins and then silently does
        // nothing — the one outcome this screen must never have.
        showToast(t('profile_handle_rejected'), { type: 'error' })
      }
    }
  }, [client, signer, storage, availability, handleInput, displayName, registeredPaymail, registryDomain, t])

  /**
   * Local first, always: the name is this device's to show even with no
   * network. When a handle is registered it is also a public field of the
   * profile certificate, so the registry gets a fresh one — best effort, and
   * never something the user has to wait on.
   */
  const onSaveDisplayName = useCallback(
    async (next: string) => {
      const trimmed = next.trim()
      setDisplayName(trimmed)
      try {
        await storage?.setKeyValue(DISPLAY_NAME_KV_KEY, trimmed)
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { type: 'error' })
      }
      if (!client || !signer || !storage || !registeredPaymail) return
      const result = await updateProfile(
        { client, signer, storage },
        { paymail: registeredPaymail, displayName: trimmed }
      )
      if (result.kind === 'pending') setFinishing(true)
    },
    [storage, client, signer, registeredPaymail]
  )

  const handle = handleInput.trim().toLowerCase()
  const paymailPreview = registryDomain ? `${handle}@${registryDomain}` : handle
  const editingHandle = !!registryDomain && (!registeredPaymail || changingHandle)
  const statusLine: Partial<Record<HandleAvailability, { text: string; color: string; icon: string }>> = {
    checking: { text: t('profile_handle_checking'), color: colors.textSecondary, icon: 'time-outline' },
    available: {
      text: t('profile_handle_available', { handle: paymailPreview }),
      color: colors.success,
      icon: 'checkmark-circle'
    },
    taken: { text: t('profile_handle_taken', { handle: paymailPreview }), color: colors.error, icon: 'close-circle' },
    too_similar: {
      text: t('profile_handle_too_similar', { handle: paymailPreview }),
      color: colors.error,
      icon: 'close-circle'
    },
    reserved: {
      text: t('profile_handle_reserved', { handle: paymailPreview }),
      color: colors.error,
      icon: 'close-circle'
    },
    cooldown: {
      text: t('profile_handle_cooldown', { handle: paymailPreview }),
      color: colors.warning,
      icon: 'time-outline'
    },
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
          footer={registeredPaymail && !changingHandle ? t('profile_handle_registered_hint') : undefined}
        >
          {!registryDomain && !registeredPaymail ? (
            <Text style={[styles.unavailable, { color: colors.textSecondary }]}>{t('profile_handle_unavailable')}</Text>
          ) : !editingHandle ? (
            <View style={styles.registeredRow}>
              <Text style={[styles.registeredHandle, { color: colors.textPrimary }]} numberOfLines={1}>
                {registeredPaymail}
              </Text>
              <Ionicons name="checkmark-circle" size={14} color={colors.success} />
              <Text style={[styles.registeredCaption, { color: colors.textSecondary }]}>
                {t('pay_trust_handle_attested')}
              </Text>
              <View style={styles.flexSpacer} />
              {!!registryDomain && (
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
                {/* Fixed, not typed: a handle is only ever claimed on the
                    domain this build is configured for. */}
                <Text style={[styles.atSign, { color: colors.textTertiary }]} numberOfLines={1}>
                  @{registryDomain}
                </Text>
                {availability === 'checking' ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : status ? (
                  <Ionicons name={status.icon as never} size={18} color={status.color} />
                ) : null}
                {registeredPaymail && (
                  <PressableScale
                    // Through `runCheck` rather than straight to `idle`: it also
                    // clears the debounce and bumps the nonce, so a check for
                    // the abandoned text cannot land on the emptied field and
                    // leave Claim enabled with nothing in it.
                    onPress={() => {
                      setChangingHandle(false)
                      setHandleInput('')
                      runCheck('')
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

        {finishing && (
          <View style={[styles.callout, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
            <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
            <Text style={[styles.calloutText, { color: colors.textSecondary }]}>{t('profile_handle_pending')}</Text>
            <PressableScale
              onPress={() => setResumeNonce(n => n + 1)}
              haptic="tap"
              style={styles.retryBtn}
              accessibilityRole="button"
            >
              <Text style={[styles.retryLabel, { color: colors.accent }]}>{t('retry')}</Text>
            </PressableScale>
          </View>
        )}

        {editingHandle && registeredPaymail && (
          <View style={[styles.callout, { backgroundColor: colors.fillTertiary, borderColor: colors.separator }]}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
            <Text style={[styles.calloutText, { color: colors.textSecondary }]}>
              {t('profile_handle_replace_warning', { handle: registeredPaymail })}
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
                params: { identityKey, name: displayName, handle: registeredPaymail ?? '' }
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
                {handle ? t('profile_handle_claim', { handle: paymailPreview }) : t('profile_handle_register_action')}
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
