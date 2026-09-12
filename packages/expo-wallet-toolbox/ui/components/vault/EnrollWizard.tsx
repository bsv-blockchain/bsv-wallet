/**
 * Vault enrollment wizard — spec §3.3.
 *
 *   enroll mode:  intro → key (× k; sub-states pin · tap · name · error) → more → done
 *   add-key mode: key → done
 *
 * Public, non-authoritative recovery handles are persisted in wallet-scoped
 * SecureStore as soon as a slot key exists. Ready handles are restored into
 * this wizard after a crash; protected handles repeat only a live possession
 * challenge. PINs and PUKs are never stored. Every credential prompt is
 * gathered BEFORE the tap, because
 * the iOS NFC sheet covers the app for the whole card session. The PIN lives
 * in input state only while its key step is open: it is kept across an
 * error → Try again (a re-tap needs it) and cleared the moment the step is
 * left, the card is swapped, or the PIN turns out to be wrong.
 *
 * The host screen hides its own back chevron while this is mounted: leaving
 * goes through `leave()` — the leave-confirm alert when at least one key is
 * unsaved — which is also wired to Android's hardware back button. On the
 * `done` step back completes the wizard (`onDone`) instead, and while a card
 * session is open it is swallowed: the tap's outcome must land somewhere.
 *
 * Whatever meta is stored is loaded in BOTH modes and its serials are always
 * passed to `enrollKey` as `pendingSerials` (spec §3.3 step 2). The service
 * probes the slot and refuses any occupied token; enrollment never overwrites
 * an existing PIV key. In enroll mode a stored meta is a host-state anomaly — its keys are
 * refused (loud, safe) but never counted toward the ordinal or the cap, since
 * Finish replaces whatever is stored.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ScrollView, ActivityIndicator, BackHandler, Platform } from 'react-native'
import PressableScale from '../ui/PressableScale'
import { showAlert } from '../ui/AlertCard'
import { showToast } from '../ui/Toast'
import { vaultErrorCopy } from './vaultErrorCopy'
import { vaultKeyLabel } from './KeyChooser'
import {
  useTheme,
  spacing,
  radii,
  typography,
  enrollKey,
  resumeEnrollmentDraft,
  finalizeEnrollment,
  addVaultKey,
  vaultStore,
  VAULT_MIN_KEYS,
  VAULT_MAX_KEYS,
  VaultError,
  VaultEnrollmentPartialError,
  haptics,
  i18n,
  type VaultKeyRecord,
  type VaultEnrollmentDraftEntry,
  type VaultEnrollmentQuarantine,
  type VaultScopeToken,
  type VaultErrorCode,
  type EnrollPhase
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as this
 * package's other native-module-boundary fixes.
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

type Step = 'intro' | 'key' | 'more' | 'done'
type KeySub = 'pin' | 'tap' | 'name' | 'error'

/** The PIV factory PIN. Typing it means the card was never personalised, so a new PIN is demanded before the tap. */
const DEFAULT_PIV_PIN = '123456'
const DEFAULT_PIV_PUK = '12345678'
const PIN_MAX = 8
const pivCodeOk = (p: string) => /^[0-9]{6,8}$/.test(p)

interface KeyStepError {
  code: VaultErrorCode | undefined
  copy: string
  /** Generation may have completed, so retrying on this token must not reach
   * another enrollment attempt. The service will also refuse its occupied
   * slot; the UI sends the user straight to a fresh token. */
  mustUseDifferent?: boolean
}

/**
 * The duplicate's serial from a key-already-enrolled rejection. The services
 * attach it as `details.serial` (VaultKeyService.enrollKey, vaultStore.addKey);
 * the message is never parsed for it.
 */
function duplicateSerial(err: VaultError | undefined): string | undefined {
  const s = err?.details?.serial
  return typeof s === 'string' ? s : undefined
}

export interface EnrollWizardProps {
  mode: 'enroll' | 'add-key'
  onDone: () => void
  onCancel: () => void
}

export const EnrollWizard: React.FC<EnrollWizardProps> = ({ mode, onDone, onCancel }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  // Every public record collected in this wizard belongs to the wallet/chain
  // scope that opened it. Holding one token for the whole lifetime prevents a
  // late enrollment result from being persisted after logout or a network
  // switch has mounted a different vault.
  const scopeTokenRef = useRef<VaultScopeToken | null>(null)
  if (!scopeTokenRef.current) scopeTokenRef.current = vaultStore.captureScopeToken()
  const scopeToken = scopeTokenRef.current

  const [step, setStep] = useState<Step>(mode === 'enroll' ? 'intro' : 'key')
  const [sub, setSub] = useState<KeySub>('pin')
  const [ack, setAck] = useState(false)
  /** Whole-PIV acknowledgement. Enrollment rotates global PIV credentials,
   * so this starts false even when the recovery-risk acknowledgement is set. */
  const [pivAck, setPivAck] = useState(false)
  /** Keys already in the stored meta, loaded in both modes. Their serials are
   * always refused; they count toward the ordinal and the cap in add-key mode
   * only (see the file comment). */
  const [metaKeys, setMetaKeys] = useState<VaultKeyRecord[]>([])
  /** Keys set up in this run and not yet persisted. Public data only. */
  const [pending, setPending] = useState<VaultKeyRecord[]>([])
  const [recoverableDrafts, setRecoverableDrafts] = useState<VaultEnrollmentDraftEntry[]>([])
  const [blockedDrafts, setBlockedDrafts] = useState<(VaultEnrollmentDraftEntry | VaultEnrollmentQuarantine)[]>([])
  const [pin, setPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [puk, setPuk] = useState('')
  const [newPuk, setNewPuk] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [phase, setPhase] = useState<EnrollPhase | null>(null)
  /** The record the card just produced, awaiting its nickname. */
  const [fresh, setFresh] = useState<VaultKeyRecord | null>(null)
  const [name, setName] = useState('')
  const [keyError, setKeyError] = useState<KeyStepError | null>(null)
  /** A write (finalizeEnrollment / addVaultKey) is in flight. */
  const [busy, setBusy] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)
  const [addedNickname, setAddedNickname] = useState('')
  /** One card session at a time: a double-tapped Continue must not open two. */
  const tapInFlight = useRef(false)
  /** One leave-confirm at a time. */
  const leaving = useRef(false)

  useEffect(() => {
    let alive = true
    Promise.all([
      vaultStore.getMeta(scopeToken),
      vaultStore.getEnrollmentDrafts(scopeToken),
      vaultStore.getEnrollmentQuarantines(scopeToken)
    ])
      .then(([m, drafts, quarantines]) => {
        if (!alive) return
        const enrolledSerials = new Set(m?.keys.map(key => key.serial) ?? [])
        const unused = drafts.filter(entry => !enrolledSerials.has(entry.record.serial))
        const ready = unused.filter(entry => entry.assurance === 'ready')
        const challenge = unused.filter(entry => entry.assurance === 'challenge-required')
        const blocked = unused.filter(entry => entry.assurance === 'management-uncertain')
        if (m) setMetaKeys(m.keys)
        setRecoverableDrafts(challenge)
        setBlockedDrafts([...blocked, ...quarantines])
        if (mode === 'enroll') {
          setPending(current => {
            const serials = new Set(current.map(key => key.serial))
            return [...current, ...ready.map(entry => entry.record).filter(record => !serials.has(record.serial))]
          })
        } else if (ready[0]) {
          setFresh(ready[0].record)
          setName(ready[0].record.nickname)
          setSub('name')
        }
      })
      .catch(e => {
        if (alive && e instanceof VaultError && e.code === 'scope-changed') onCancel()
      })
    return () => {
      alive = false
    }
  }, [mode, onCancel, scopeToken])

  /** Stored keys that count toward the ordinal and the 5-key cap: all of them
   * when adding to a vault, none while enrolling one (Finish overwrites). */
  const enrolledCount = mode === 'add-key' ? metaKeys.length : 0
  const total = enrolledCount + pending.length
  /** Ordinal of the next key on screen. Existing/occupied tokens are never overwritten. */
  const k = total + 1
  const needsNewPin = pin === DEFAULT_PIV_PIN
  const effectivePin = needsNewPin ? newPin : pin
  const pinOk =
    pivCodeOk(pin) &&
    (!needsNewPin || (pivCodeOk(newPin) && newPin !== DEFAULT_PIV_PIN)) &&
    pivCodeOk(puk) &&
    pivCodeOk(newPuk) &&
    newPuk !== DEFAULT_PIV_PUK &&
    newPuk !== puk &&
    newPuk !== effectivePin
  /** Keys that would be lost by leaving: pending ones plus a just-generated, not-yet-named one. */
  const unsaved = pending.length + (fresh ? 1 : 0)

  /** Everything the key step gathered: the PIN(s) and the fresh record. */
  const clearKeyInputs = () => {
    setPin('')
    setNewPin('')
    setPuk('')
    setNewPuk('')
    setPinError(null)
    setFresh(null)
    setName('')
  }

  // ── leaving ─────────────────────────────────────────────────────────
  const leave = useCallback(async () => {
    // Everything is saved on `done`: back means the same as the Done button —
    // hand off to the host (the re-lock prompt in add-key mode), never a
    // "won't be saved yet" alert over a persisted vault.
    if (step === 'done') {
      onDone()
      return
    }
    // A card session is open: its result must land in state, so back is
    // swallowed (the BackHandler handler still returns true) until it settles.
    if (tapInFlight.current) return
    if (busy || leaving.current) return
    leaving.current = true
    try {
      if (unsaved > 0) {
        const choice = await showAlert({
          title: t('vault_leave_title'),
          message: t('vault_leave_body', { count: unsaved }),
          buttons: [
            { text: t('vault_leave_confirm'), key: 'leave', style: 'destructive' },
            { text: t('vault_leave_stay'), key: 'stay', style: 'cancel' }
          ]
        })
        if (choice !== 'leave') return
      }
      onCancel()
    } finally {
      leaving.current = false
    }
  }, [step, busy, unsaved, onCancel, onDone])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void leave()
      return true
    })
    return () => subscription.remove()
  }, [leave])

  // ── intro → key 1 ───────────────────────────────────────────────────
  const begin = useCallback(() => {
    if (!ack || !pivAck || busy) return
    vaultStore.assertScopeToken(scopeToken)
    setStep(pending.length > 0 ? 'more' : 'key')
    if (pending.length === 0) setSub('pin')
  }, [ack, pivAck, busy, pending.length, scopeToken])

  // ── the card session ────────────────────────────────────────────────
  const runTap = useCallback(
    async () => {
      if (tapInFlight.current || !pivAck) return
      tapInFlight.current = true
      setSub('tap')
      setPhase(null)
      setKeyError(null)
      setStepError(null)
      // Stored ∪ pending, in every mode: the service refuses these BEFORE it
      // spends the PIN or regenerates the slot (spec §3.3 step 2).
      const known = [...metaKeys.map(r => r.serial), ...pending.map(r => r.serial)]
      try {
        const record = await enrollKey({
          scopeToken,
          acknowledgeDedicatedPivApplication: true,
          pendingSerials: known,
          onPhase: setPhase,
          getPin: async () => pin,
          ...(needsNewPin ? { requestPinChange: async () => ({ oldPin: pin, newPin }) } : {}),
          requestPukChange: async () => ({ oldPuk: puk, newPuk }),
          // Localised iOS NFC sheet text for this tap (enrollKey forwards it to
          // withKeySession → driver.start). Omitting it would fall back to the
          // native default wording.
          nfcMessage: t('vault_nfc_enroll_message')
        })
        haptics.success()
        setFresh(record)
        setName('')
        setSub('name')
      } catch (e) {
        haptics.error()
        try {
          vaultStore.assertScopeToken(scopeToken)
        } catch {
          clearKeyInputs()
          showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
          onCancel()
          return
        }
        const err = e instanceof VaultError ? e : undefined
        // A wrong PIN is feedback on the PIN, so it belongs on the PIN field,
        // and the wrong digits must not linger in it. Nothing has been written
        // to the card (verifyPin runs before generateVaultKey), so re-entering
        // is safe. On NFC it costs a re-tap.
        if (err?.code === 'pin-invalid') {
          setPin('')
          setNewPin('')
          setPuk('')
          setNewPuk('')
          setPinError(vaultErrorCopy('pin-invalid', { count: err.retriesLeft }))
          setSub('pin')
          return
        }
        if (err?.code === 'puk-invalid') {
          setPuk('')
          setPinError(vaultErrorCopy('puk-invalid', { count: err.retriesLeft }))
          setSub('pin')
          return
        }
        // The user dismissed the system NFC sheet: not an error to explain.
        // The PIN stays so Continue can simply be pressed again.
        if (err?.code === 'user-cancelled') {
          setSub('pin')
          return
        }
        // Every partial personalization result is represented by a durable
        // scoped draft or quarantine. Never guess which global PIV credential
        // is current and never re-enter generic enrollment on the same token;
        // a challenge-required draft is resumed through the explicit path
        // loaded above after reconnect/reopen.
        const tapped = duplicateSerial(err)
        const dupPending = tapped ? pending.find(p => p.serial === tapped) : undefined
        const dupEnrolled = tapped ? metaKeys.find(p => p.serial === tapped) : undefined
        let copy: string
        if (err?.code === 'key-already-enrolled') {
          // Name the duplicate; with no record to name, the serial tail still
          // identifies the card. Without even a serial the copy degrades to the
          // generic line inside vaultErrorCopy.
          copy = vaultErrorCopy(err.code, {
            nickname: dupPending?.nickname ?? dupEnrolled?.nickname ?? (tapped ? `…${tapped.slice(-4)}` : undefined)
          })
        } else if (err?.code === 'pin-locked') {
          // Enrolment-specific: there is no "use another of your vault keys"
          // yet, so the remedy is the PUK or a different card.
          copy = t('vault_err_pin_locked_enroll')
        } else if (err instanceof VaultEnrollmentPartialError) {
          copy = t('vault_enrollment_reset_required')
        } else {
          copy = vaultErrorCopy(err?.code)
        }
        setKeyError({
          code: err?.code,
          copy,
          mustUseDifferent: err instanceof VaultEnrollmentPartialError
        })
        setSub('error')
      } finally {
        tapInFlight.current = false
      }
    },
    [metaKeys, pending, pin, newPin, puk, newPuk, needsNewPin, onCancel, pivAck, scopeToken]
  )

  /** Resume only the non-mutating possession challenge for a protected draft.
   * The service re-reads the scoped draft and exact serial/pubkey before it
   * opens the YubiKey session. */
  const resumeDraft = useCallback(async (entry: VaultEnrollmentDraftEntry) => {
    if (tapInFlight.current || !pivAck || !pivCodeOk(pin)) return
    tapInFlight.current = true
    setSub('tap')
    setPhase(null)
    setKeyError(null)
    setStepError(null)
    try {
      const record = await resumeEnrollmentDraft({
        entry,
        scopeToken,
        onPhase: setPhase,
        getPin: async () => pin,
        nfcMessage: t('vault_nfc_enroll_message')
      })
      vaultStore.assertScopeToken(scopeToken)
      setRecoverableDrafts(current => current.filter(draft => draft.record.serial !== record.serial))
      setFresh(record)
      setName(record.nickname)
      setSub('name')
      haptics.success()
    } catch (e) {
      haptics.error()
      try {
        vaultStore.assertScopeToken(scopeToken)
      } catch {
        clearKeyInputs()
        showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
        onCancel()
        return
      }
      const err = e instanceof VaultError ? e : undefined
      if (err?.code === 'pin-invalid') {
        setPin('')
        setPinError(vaultErrorCopy('pin-invalid', { count: err.retriesLeft }))
        setSub('pin')
        return
      }
      setKeyError({
        code: err?.code,
        copy: err instanceof VaultEnrollmentPartialError ? t('vault_enrollment_reset_required') : vaultErrorCopy(err?.code),
        mustUseDifferent: err instanceof VaultEnrollmentPartialError
      })
      setSub('error')
    } finally {
      tapInFlight.current = false
    }
  }, [onCancel, pin, pivAck, scopeToken])

  // ── naming → more / addVaultKey ─────────────────────────────────────
  const saveName = useCallback(async () => {
    if (!fresh || busy) return
    const record: VaultKeyRecord = { ...fresh, nickname: name.trim() || t('vault_name_default', { k }) }
    if (mode === 'add-key') {
      setBusy(true)
      setStepError(null)
      try {
        await addVaultKey(record, scopeToken)
        clearKeyInputs()
        haptics.success()
        showToast(t('vault_key_added_toast'), { type: 'success' })
        setAddedNickname(record.nickname)
        setStep('done')
      } catch (e) {
        haptics.error()
        const err = e instanceof VaultError ? e : undefined
        if (err?.code === 'scope-changed') {
          clearKeyInputs()
          showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
          onCancel()
          return
        }
        // `fresh` is also a scoped ready draft. Keep the name screen intact so
        // a transient SecureStore write failure can be retried without
        // touching or regenerating the now-occupied token.
        setStepError(vaultErrorCopy(err?.code))
      } finally {
        setBusy(false)
      }
      return
    }
    setPending(prev => [...prev, record])
    clearKeyInputs()
    setStep('more')
  }, [fresh, busy, name, k, mode, onCancel, scopeToken])

  // ── finish (enroll mode) ────────────────────────────────────────────
  const finish = useCallback(async () => {
    if (pending.length < VAULT_MIN_KEYS || busy) return
    setBusy(true)
    setStepError(null)
    try {
      await finalizeEnrollment(pending, scopeToken)
      // No tone here (see useConfirmationSound): vaultDeposit/vaultWithdraw
      // name an actual transfer, and enrolling isn't one.
      haptics.success()
      showToast(t('vault_enrolled_toast'), { type: 'success' })
      setStep('done')
    } catch (e) {
      haptics.error()
      setStepError(vaultErrorCopy(e instanceof VaultError ? e.code : undefined))
    } finally {
      setBusy(false)
    }
  }, [pending, busy, scopeToken])

  const addAnother = useCallback(() => {
    setStepError(null)
    setStep('key')
    setSub('pin')
  }, [])

  /** A different card has a different PIN: start the step over. */
  const useDifferentKey = () => {
    setKeyError(null)
    clearKeyInputs()
    setSub('pin')
  }

  const leaveLink = (
    <PressableScale onPress={() => void leave()} style={styles.secondary}>
      <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
        {unsaved > 0 ? t('vault_leave_setup') : t('vault_cancel')}
      </Text>
    </PressableScale>
  )

  const pivAcknowledgement = (
    <PressableScale
      accessibilityRole="checkbox"
      accessibilityState={{ checked: pivAck }}
      haptic="tap"
      onPress={() => setPivAck(value => !value)}
      style={[styles.ackRow, { borderColor: pivAck ? colors.accent : colors.separator }]}
    >
      <Ionicons name={pivAck ? 'checkbox' : 'square-outline'} size={24} color={pivAck ? colors.accent : colors.textTertiary} />
      <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_intro_piv_ack')}</Text>
    </PressableScale>
  )

  // ── intro ───────────────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_intro_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_intro_what')}</Text>
        <View style={[styles.bullets, { borderColor: colors.separator }]}>
          <Bullet icon="key-outline" text={t('vault_intro_two_keys')} />
          <Bullet icon="location-outline" text={t('vault_intro_apart')} />
          <Bullet icon="cloud-upload-outline" text={t('vault_intro_backup')} />
        </View>
        <PressableScale
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ack }}
          haptic="tap"
          onPress={() => setAck(a => !a)}
          style={[styles.ackRow, { borderColor: ack ? colors.accent : colors.separator }]}
        >
          <Ionicons name={ack ? 'checkbox' : 'square-outline'} size={24} color={ack ? colors.accent : colors.textTertiary} />
          <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_intro_ack')}</Text>
        </PressableScale>
        {pivAcknowledgement}
        {blockedDrafts.length > 0 && (
          <Text style={[styles.warn, { color: colors.warning }]}>{t('vault_enrollment_reset_required')}</Text>
        )}
        <ActionButton label={t('vault_intro_begin')} enabled={ack && pivAck} busy={busy} onPress={() => void begin()} />
        <PressableScale onPress={onCancel} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── key k ───────────────────────────────────────────────────────────
  if (step === 'key') {
    if (sub === 'pin') {
      return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_key_step_title', { k })}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_key_step_replace')}</Text>
          {mode === 'add-key' && pivAcknowledgement}

          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_enter_pin')}</Text>
          {/* Which PIN, and what it is if they have never set one: the prompt
              is otherwise ambiguous with the phone's own passcode. */}
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_enter_pin_sub')}</Text>
          <TextInput
            accessibilityLabel={t('vault_enter_pin')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={pin}
            onChangeText={text => {
              setPinError(null)
              setPin(text)
            }}
            placeholder="••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            // Masking only once there is something to mask: iOS renders a
            // secure field's PLACEHOLDER with masked-glyph metrics, which
            // stretches the bullets apart before any digit is typed.
            secureTextEntry={pin.length > 0}
            maxLength={PIN_MAX}
            autoFocus
          />
          {needsNewPin && (
            <>
              <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_set_new_pin')}</Text>
              <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_default_pin_warning')}</Text>
              <TextInput
                accessibilityLabel={t('vault_set_new_pin')}
                style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
                value={newPin}
                onChangeText={setNewPin}
                placeholder="••••••"
                placeholderTextColor={colors.textTertiary}
                keyboardType="number-pad"
                secureTextEntry={newPin.length > 0}
                maxLength={PIN_MAX}
              />
            </>
          )}
          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_enter_puk')}</Text>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_enter_puk_sub')}</Text>
          <TextInput
            accessibilityLabel={t('vault_enter_puk')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={puk}
            onChangeText={setPuk}
            placeholder="••••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            secureTextEntry={puk.length > 0}
            maxLength={PIN_MAX}
          />
          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_set_new_puk')}</Text>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_default_puk_warning')}</Text>
          <TextInput
            accessibilityLabel={t('vault_set_new_puk')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={newPuk}
            onChangeText={setNewPuk}
            placeholder="••••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            secureTextEntry={newPuk.length > 0}
            maxLength={PIN_MAX}
          />
          {pinError && <Text style={[styles.err, { color: colors.error }]}>{pinError}</Text>}
          {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
          {recoverableDrafts.map(entry => (
            <ActionButton
              key={entry.record.serial}
              label={`${t('vault_enrollment_resume')} · …${entry.record.serial.slice(-4)}`}
              variant="outline"
              enabled={pivAck && pivCodeOk(pin) && !busy}
              onPress={() => void resumeDraft(entry)}
            />
          ))}
          {blockedDrafts.length > 0 && (
            <Text style={[styles.warn, { color: colors.warning }]}>{t('vault_enrollment_reset_required')}</Text>
          )}
          {/* NFC only: a brand-new YubiKey ships in restricted NFC mode (Yubico's
              anti-scan-in-transit policy) and stays that way until it is plugged
              into USB-C for a few seconds — a one-time, per-key step done outside
              this app. Shown on every key here since we cannot tell a fresh card
              from a already-activated one before the tap. */}
          {Platform.OS === 'ios' && (
            <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_nfc_activation_hint')}</Text>
          )}
          <ActionButton label={t('vault_continue')} enabled={pivAck && pinOk && !busy} onPress={() => void runTap()} />
          {leaveLink}
        </ScrollView>
      )
    }

    if (sub === 'tap') {
      return (
        <View style={styles.body}>
          <ActivityIndicator color={colors.textPrimary} size="large" style={styles.hero} />
          <Text style={[styles.h1, { color: colors.textPrimary }]}>
            {phase ? t(`vault_enroll_phase_${phase.replace(/-/g, '_')}`) : t('vault_reading_key')}
          </Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_touch_when_blinks')}</Text>
        </View>
      )
    }

    if (sub === 'name') {
      return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Ionicons name="checkmark-circle" size={48} color={colors.success} style={styles.hero} />
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_name_title')}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{fresh ? `…${fresh.serial.slice(-4)}` : ''}</Text>
          <TextInput
            accessibilityLabel={t('vault_name_title')}
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={name}
            onChangeText={setName}
            placeholder={t('vault_name_default', { k })}
            placeholderTextColor={colors.textTertiary}
            maxLength={32}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => void saveName()}
            autoFocus
          />
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_name_hint')}</Text>
          <ActionButton label={t('vault_continue')} busy={busy} onPress={() => void saveName()} />
          {leaveLink}
        </ScrollView>
      )
    }

    // sub === 'error'
    const code = keyError?.code
    return (
      <View style={styles.body}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.error} style={styles.hero} />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{keyError?.copy ?? t('vault_err_generic')}</Text>
        {code === 'pin-locked' ? (
          <>
            <ActionButton label={t('vault_key_use_different')} onPress={useDifferentKey} />
            <ActionButton label={t('vault_retry')} variant="outline" onPress={() => void runTap()} />
          </>
        ) : code === 'key-already-enrolled' || code === 'puk-locked' || keyError?.mustUseDifferent ? (
          <ActionButton label={t('vault_key_use_different')} onPress={useDifferentKey} />
        ) : code === 'enrollment-partial' ? (
          <ActionButton label={t('vault_retry')} onPress={() => setSub('pin')} />
        ) : (
          <ActionButton label={t('vault_retry')} onPress={() => void runTap()} />
        )}
        {leaveLink}
      </View>
    )
  }

  // ── more ────────────────────────────────────────────────────────────
  if (step === 'more') {
    const canAdd = total < VAULT_MAX_KEYS
    const canFinish = pending.length >= VAULT_MIN_KEYS
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_more_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_more_body')}</Text>
        <View style={[styles.list, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          {pending.map((p, i) => (
            <View
              key={p.serial}
              style={[
                styles.listRow,
                i < pending.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
              ]}
            >
              <Ionicons name="key-outline" size={20} color={colors.success} />
              <Text style={[styles.listLabel, { color: colors.textPrimary }]} numberOfLines={1}>
                {vaultKeyLabel(p)}
              </Text>
            </View>
          ))}
        </View>
        {!canFinish && <Text style={[styles.warn, { color: colors.warning }]}>{t('vault_more_need_two')}</Text>}
        {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
        {/* The filled button is whichever moves the user forward: Add while a
            second key is still required, Finish once there are enough. */}
        {canAdd && (
          <ActionButton
            label={t('vault_more_add')}
            variant={canFinish ? 'outline' : 'primary'}
            enabled={!busy}
            onPress={addAnother}
          />
        )}
        <ActionButton label={t('vault_more_finish')} enabled={canFinish} busy={busy} onPress={() => void finish()} />
        {leaveLink}
      </ScrollView>
    )
  }

  // ── done ────────────────────────────────────────────────────────────
  return (
    <View style={[styles.body, styles.doneBody]}>
      <Ionicons name="checkmark-circle" size={56} color={colors.success} style={styles.hero} />
      <Text style={[styles.h1, { color: colors.textPrimary }]}>
        {mode === 'enroll' ? t('vault_enrolled_toast') : t('vault_key_added_toast')}
      </Text>
      <Text style={[styles.p, { color: colors.textSecondary }]}>
        {mode === 'enroll'
          ? t('vault_done_body', { count: pending.length })
          : t('vault_add_key_done', { nickname: addedNickname })}
      </Text>
      <ActionButton label={mode === 'enroll' ? t('vault_done_cta') : t('vault_relock_now')} onPress={onDone} />
    </View>
  )
}

/** One intro bullet: glyph + line. */
const Bullet: React.FC<{ icon: React.ComponentProps<IoniconsComponent>['name']; text: string }> = ({ icon, text }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  return (
    <View style={styles.bulletRow}>
      <Ionicons name={icon} size={18} color={colors.info} />
      <Text style={[styles.bulletText, { color: colors.textPrimary }]}>{text}</Text>
    </View>
  )
}

/**
 * The wizard's button. Filled accent when primary and enabled; outlined when
 * disabled or `variant="outline"` — filled with the secondary background it was
 * indistinguishable from the page in dark mode.
 */
const ActionButton: React.FC<{
  label: string
  enabled?: boolean
  busy?: boolean
  variant?: 'primary' | 'outline'
  onPress: () => void
}> = ({ label, enabled = true, busy = false, variant = 'primary', onPress }) => {
  const { colors } = useTheme()
  const active = enabled && !busy
  const filled = active && variant === 'primary'
  return (
    <PressableScale
      haptic="confirm"
      // `disabled` (not only a dropped handler) so the responder itself
      // refuses the press: a11y reports it, and nothing above it in the tree
      // can pick the press up.
      disabled={!active}
      onPress={active ? onPress : undefined}
      accessibilityState={{ disabled: !active }}
      style={[
        styles.primary,
        filled
          ? { backgroundColor: colors.accent }
          : { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }
      ]}
    >
      {busy ? (
        <ActivityIndicator color={filled ? colors.textOnAccent : colors.textPrimary} />
      ) : (
        <Text
          style={[
            styles.primaryLabel,
            { color: filled ? colors.textOnAccent : active ? colors.textPrimary : colors.textTertiary }
          ]}
        >
          {label}
        </Text>
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg },
  doneBody: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  hero: { marginTop: spacing.lg, alignSelf: 'center' },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  label: { ...typography.headline },
  hint: { ...typography.footnote },
  warn: { ...typography.footnote, textAlign: 'center' },
  err: { ...typography.footnote, textAlign: 'center' },
  bullets: {
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  bulletText: { ...typography.subhead, flex: 1 },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  ackText: { ...typography.subhead, flex: 1 },
  input: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...typography.body
  },
  pin: {
    width: '70%',
    alignSelf: 'center',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 8,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  list: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg
  },
  listLabel: { ...typography.body, flex: 1 },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body }
})
