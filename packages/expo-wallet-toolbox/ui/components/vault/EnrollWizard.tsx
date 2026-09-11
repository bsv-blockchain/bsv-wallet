/**
 * Vault enrollment wizard — spec §3.3.
 *
 *   enroll mode:  intro → key (× k; sub-states pin · tap · name · error) → more → done
 *   add-key mode: key → done
 *
 * Nothing is persisted until Finish (enroll) or until the single key step
 * completes (add-key). `pending` holds public records only — serial, slot,
 * pubkey, nickname, enrolledAt — in component state, so it survives
 * backgrounding but not leaving. Every prompt (the PIN, and a new PIN when the
 * card still carries the factory default) is gathered BEFORE the tap, because
 * the iOS NFC sheet covers the app for the whole card session. The PIN lives
 * in input state only while its key step is open: it is kept across an
 * error → Try again (a re-tap needs it) and cleared the moment the step is
 * left, the card is swapped, or the PIN turns out to be wrong.
 *
 * The host screen hides its own back chevron while this is mounted: leaving
 * goes through `leave()` — the leave-confirm alert when at least one key is
 * unsaved — which is also wired to Android's hardware back button.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ScrollView, ActivityIndicator, BackHandler } from 'react-native'
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
  finalizeEnrollment,
  addVaultKey,
  vaultStore,
  VAULT_MIN_KEYS,
  VAULT_MAX_KEYS,
  VaultError,
  isBackupPushEnabled,
  sounds,
  haptics,
  i18n,
  type VaultKeyRecord,
  type VaultErrorCode,
  type EnrollPhase
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as this
 * package's other native-module-boundary fixes (expo-router, expo-blur).
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

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as VaultScreen.tsx.
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

type Step = 'intro' | 'key' | 'more' | 'done'
type KeySub = 'pin' | 'tap' | 'name' | 'error'

/** The PIV factory PIN. Typing it means the card was never personalised, so a new PIN is demanded before the tap. */
const DEFAULT_PIV_PIN = '123456'
const PIN_MIN = 6
const PIN_MAX = 8
const pinLengthOk = (p: string) => p.length >= PIN_MIN && p.length <= PIN_MAX

interface KeyStepError {
  code: VaultErrorCode | undefined
  copy: string
  /** Serial of a key pending in THIS run that the tapped card duplicates — offers "Set it up again". */
  pendingDuplicate?: string
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
  const { router } = loadExpoRouter()

  const [step, setStep] = useState<Step>(mode === 'enroll' ? 'intro' : 'key')
  const [sub, setSub] = useState<KeySub>('pin')
  const [ack, setAck] = useState(false)
  /** Keys already in meta — add-key mode only. A fresh enrollment has no meta
   * to honour: Finish replaces whatever is stored, so nothing stored may shift
   * the ordinal or refuse a card. */
  const [enrolled, setEnrolled] = useState<VaultKeyRecord[]>([])
  /** Keys set up in this run and not yet persisted. Public data only. */
  const [pending, setPending] = useState<VaultKeyRecord[]>([])
  const [pin, setPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [phase, setPhase] = useState<EnrollPhase | null>(null)
  /** The record the card just produced, awaiting its nickname. */
  const [fresh, setFresh] = useState<VaultKeyRecord | null>(null)
  const [name, setName] = useState('')
  /** Index in `pending` the record being named replaces ("Set it up again"); null = append. */
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null)
  const [keyError, setKeyError] = useState<KeyStepError | null>(null)
  /** A write (finalizeEnrollment / addVaultKey) or the backup check is in flight. */
  const [busy, setBusy] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)
  const [addedNickname, setAddedNickname] = useState('')
  /** One card session at a time: a double-tapped Continue must not open two. */
  const tapInFlight = useRef(false)
  /** One leave-confirm at a time. */
  const leaving = useRef(false)

  useEffect(() => {
    if (mode !== 'add-key') return
    let alive = true
    vaultStore
      .getMeta()
      .then(m => {
        if (alive && m) setEnrolled(m.keys)
      })
      .catch(() => {
        /* addVaultKey reports 'not-enrolled' if meta is truly unreadable */
      })
    return () => {
      alive = false
    }
  }, [mode])

  const total = enrolled.length + pending.length
  /** Ordinal of the key on screen: the next slot, or the pending slot being redone. */
  const k = replaceIndex === null ? total + 1 : enrolled.length + replaceIndex + 1
  const needsNewPin = pin === DEFAULT_PIV_PIN
  const pinOk = pinLengthOk(pin) && (!needsNewPin || (pinLengthOk(newPin) && newPin !== DEFAULT_PIV_PIN))
  /** Keys that would be lost by leaving: pending ones plus a just-generated, not-yet-named one. */
  const unsaved = pending.length + (fresh ? 1 : 0)

  /** Everything the key step gathered: the PIN(s) and the fresh record. */
  const clearKeyInputs = () => {
    setPin('')
    setNewPin('')
    setPinError(null)
    setFresh(null)
    setName('')
  }

  // ── leaving ─────────────────────────────────────────────────────────
  const leave = useCallback(async () => {
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
  }, [busy, unsaved, onCancel])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void leave()
      return true
    })
    return () => subscription.remove()
  }, [leave])

  // ── intro → key 1 ───────────────────────────────────────────────────
  const begin = useCallback(async () => {
    if (!ack || busy) return
    setBusy(true)
    try {
      // D13: the salts of every future deposit live only in this wallet's
      // database, so enrolment refuses to start while the encrypted backup is
      // off. Settings is where it is switched on; push keeps this screen behind.
      if (!(await isBackupPushEnabled())) {
        const choice = await showAlert({
          title: t('vault_backup_off_title'),
          message: t('vault_backup_off_body'),
          buttons: [
            { text: t('vault_backup_off_cta'), key: 'settings' },
            { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
          ]
        })
        if (choice === 'settings') router.push('/wallet-config')
        return
      }
      setStep('key')
      setSub('pin')
    } finally {
      setBusy(false)
    }
  }, [ack, busy, router])

  // ── the card session ────────────────────────────────────────────────
  const runTap = useCallback(
    async (replaceSerial?: string) => {
      if (tapInFlight.current) return
      tapInFlight.current = true
      setSub('tap')
      setPhase(null)
      setKeyError(null)
      setStepError(null)
      const known = [...enrolled.map(r => r.serial), ...pending.map(r => r.serial)]
      try {
        const record = await enrollKey({
          // "Set it up again" drops the duplicate's own serial so the service
          // regenerates on that card instead of refusing it a second time.
          pendingSerials: replaceSerial === undefined ? known : known.filter(s => s !== replaceSerial),
          onPhase: setPhase,
          getPin: async () => pin,
          ...(needsNewPin ? { requestPinChange: async () => ({ oldPin: pin, newPin }) } : {}),
          // Localised iOS NFC sheet text for this tap (enrollKey forwards it to
          // withKeySession → driver.start). Omitting it would fall back to the
          // native default wording.
          nfcMessage: t('vault_nfc_enroll_message')
        })
        haptics.success()
        setReplaceIndex(replaceSerial === undefined ? null : pending.findIndex(p => p.serial === replaceSerial))
        setFresh(record)
        setName('')
        setSub('name')
      } catch (e) {
        haptics.error()
        const err = e instanceof VaultError ? e : undefined
        // A wrong PIN is feedback on the PIN, so it belongs on the PIN field,
        // and the wrong digits must not linger in it. Nothing has been written
        // to the card (verifyPin runs before generateVaultKey), so re-entering
        // is safe. On NFC it costs a re-tap.
        if (err?.code === 'pin-invalid') {
          setPin('')
          setNewPin('')
          setPinError(vaultErrorCopy('pin-invalid', { count: err.retriesLeft }))
          setSub('pin')
          return
        }
        // The user dismissed the system NFC sheet: not an error to explain.
        // The PIN stays so Continue can simply be pressed again.
        if (err?.code === 'user-cancelled') {
          setSub('pin')
          return
        }
        const tapped = duplicateSerial(err)
        const dupPending = tapped ? pending.find(p => p.serial === tapped) : undefined
        const dupEnrolled = tapped ? enrolled.find(p => p.serial === tapped) : undefined
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
        } else {
          copy = vaultErrorCopy(err?.code)
        }
        setKeyError({ code: err?.code, copy, pendingDuplicate: dupPending?.serial })
        setSub('error')
      } finally {
        tapInFlight.current = false
      }
    },
    [enrolled, pending, pin, newPin, needsNewPin]
  )

  // ── naming → more / addVaultKey ─────────────────────────────────────
  const saveName = useCallback(async () => {
    if (!fresh || busy) return
    const record: VaultKeyRecord = { ...fresh, nickname: name.trim() || t('vault_name_default', { k }) }
    if (mode === 'add-key') {
      setBusy(true)
      setStepError(null)
      try {
        await addVaultKey(record)
        clearKeyInputs()
        haptics.success()
        showToast(t('vault_key_added_toast'), { type: 'success' })
        setAddedNickname(record.nickname)
        setStep('done')
      } catch (e) {
        // The record is dropped with the inputs: the remedy is a fresh tap.
        haptics.error()
        clearKeyInputs()
        setStepError(vaultErrorCopy(e instanceof VaultError ? e.code : undefined))
        setSub('pin')
      } finally {
        setBusy(false)
      }
      return
    }
    setPending(prev => (replaceIndex === null ? [...prev, record] : prev.map((p, i) => (i === replaceIndex ? record : p))))
    setReplaceIndex(null)
    clearKeyInputs()
    setStep('more')
  }, [fresh, busy, name, k, mode, replaceIndex])

  // ── finish (enroll mode) ────────────────────────────────────────────
  const finish = useCallback(async () => {
    if (pending.length < VAULT_MIN_KEYS || busy) return
    setBusy(true)
    setStepError(null)
    try {
      await finalizeEnrollment(pending)
      sounds.vaultOpen()
      haptics.success()
      showToast(t('vault_enrolled_toast'), { type: 'success' })
      setStep('done')
    } catch (e) {
      haptics.error()
      setStepError(vaultErrorCopy(e instanceof VaultError ? e.code : undefined))
    } finally {
      setBusy(false)
    }
  }, [pending, busy])

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
        <ActionButton label={t('vault_intro_begin')} enabled={ack} busy={busy} onPress={() => void begin()} />
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
          {pinError && <Text style={[styles.err, { color: colors.error }]}>{pinError}</Text>}
          {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
          <ActionButton label={t('vault_continue')} enabled={pinOk && !busy} onPress={() => void runTap()} />
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
    const setupAgain = keyError?.pendingDuplicate
    return (
      <View style={styles.body}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.error} style={styles.hero} />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{keyError?.copy ?? t('vault_err_generic')}</Text>
        {code === 'pin-locked' ? (
          <>
            <ActionButton label={t('vault_key_use_different')} onPress={useDifferentKey} />
            <ActionButton label={t('vault_retry')} variant="outline" onPress={() => void runTap()} />
          </>
        ) : code === 'key-already-enrolled' ? (
          <>
            {setupAgain !== undefined && (
              <ActionButton label={t('vault_key_setup_again')} onPress={() => void runTap(setupAgain)} />
            )}
            <ActionButton
              label={t('vault_key_use_different')}
              variant={setupAgain !== undefined ? 'outline' : 'primary'}
              onPress={useDifferentKey}
            />
          </>
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
