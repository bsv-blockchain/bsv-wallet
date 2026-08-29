/**
 * Vault enrollment wizard — backup gate → passphrase → PIN → tap → done.
 *
 * The vault key is derived from the wallet's EXISTING mnemonic plus a vault
 * passphrase, so there is no second phrase to write down and no confirmation
 * quiz. What replaces them is the passphrase step: a strength meter, because
 * the KDF is only 2048 rounds, and a confirm field, because BIP39 passphrases
 * have no checksum and a typo silently opens a different, empty vault.
 *
 * enrollVault() drives the YubiKey (getKeyInfo → PIN → generate). Every prompt
 * is gathered BEFORE the tap, since the NFC sheet covers the app.
 *
 * The adopt step exists because slot occupancy is only knowable ON the card:
 * enrollVault refuses an occupied slot with 'slot-occupied', this wizard turns
 * that refusal into an explicit choice, and a second run with adoptExisting
 * enrolls against the key already there. That costs a second tap only in the
 * occupied case, which is what keeps the one-tap rule intact for the normal
 * one.
 */
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ScrollView, ActivityIndicator } from 'react-native'
import { PassphraseField } from './PassphraseField'
import PressableScale from '../ui/PressableScale'
import { showToast } from '../ui/Toast'
import { printRecoveryShares } from '../../printRecoveryShares'
import { PhraseBackupSheet } from './PhraseBackupSheet'
import {
  useTheme,
  spacing,
  radii,
  typography,
  enrollVault,
  finalizeEnrollment,
  VaultError,
  useLocalStorage,
  sounds,
  haptics,
  i18n,
  readBackupAttestation,
  recordBackupAttestation,
  type BackupMedium,
  useWallet,
  UserContext
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Both icon sets are loaded lazily, only when actually rendering, same
 * pattern as this package's other native-module-boundary fixes (expo-router,
 * expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
type MaterialCommunityIconsComponent = typeof import('@expo/vector-icons').MaterialCommunityIcons
let ioniconsComponent: IoniconsComponent | undefined
let materialCommunityIconsComponent: MaterialCommunityIconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}
function loadMaterialCommunityIcons(): MaterialCommunityIconsComponent {
  if (!materialCommunityIconsComponent) {
    materialCommunityIconsComponent = require('@expo/vector-icons')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .MaterialCommunityIcons as MaterialCommunityIconsComponent
  }
  return materialCommunityIconsComponent
}

type Step = 'backup' | 'phrase' | 'passphrase' | 'adopt' | 'running' | 'done'

interface PinRequest {
  kind: 'pin' | 'change'
  retries?: number
  resolve: (v: any) => void
  reject: (e: unknown) => void
}

export const EnrollWizard: React.FC<{ onDone: () => void; onCancel: () => void }> = ({
  onDone,
  onCancel
}) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const MaterialCommunityIcons = loadMaterialCommunityIcons()
  const { getMnemonic, getRecoveredKey } = useLocalStorage()
  const { appName } = useContext(UserContext)
  const [step, setStep] = useState<Step>('backup')
  const [medium, setMedium] = useState<BackupMedium | null>(null)
  const [wordCount, setWordCount] = useState<number | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passphraseOk, setPassphraseOk] = useState(false)
  const [phaseLabel, setPhaseLabel] = useState('')
  const [pinReq, setPinReq] = useState<PinRequest | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [newPinInput, setNewPinInput] = useState('')
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { managers, adminOriginator } = useWallet()

  const wallet = managers?.permissionsManager

  // A user who already backed up should not be asked twice — including the
  // user who wrote their phrase down during wallet creation minutes ago, which
  // now records an attestation of its own. Skipping the step outright rather
  // than showing it pre-ticked: a screen full of green ticks is still a
  // checkpoint to read and clear.
  useEffect(() => {
    let alive = true
    void (async () => {
      const existing = await readBackupAttestation(wallet, adminOriginator)
      if (!alive || !existing) return
      setMedium(existing.medium)
      // Straight to the passphrase. The mnemonic guard that toPassphrase runs
      // is skipped on this path on purpose — it calls getMnemonic(), which is
      // biometric-gated, and prompting for Face ID on mount would be worse than
      // surfacing 'requires mnemonic' when enrolment actually starts.
      setStep(current => (current === 'backup' ? 'passphrase' : current))
    })()
    return () => {
      alive = false
    }
  }, [wallet, adminOriginator])

  /**
   * Only a persisted attestation may unlock Continue. A wallet that ticks the
   * row without a written flag would enrol into a vault the deposit gate then
   * refuses forever, since the gate would find nothing recorded.
   */
  const attest = useCallback(
    async (m: BackupMedium): Promise<boolean> => {
      if (!(await recordBackupAttestation(wallet, adminOriginator, m))) {
        setError(t('vault_backup_attest_failed'))
        return false
      }
      setError(null)
      setMedium(m)
      return true
    },
    [wallet, adminOriginator]
  )

  const requestPin = useCallback(
    () => new Promise<string>((resolve, reject) => setPinReq({ kind: 'pin', resolve, reject })),
    []
  )
  const requestPinChange = useCallback(
    (retries: number) =>
      new Promise<{ oldPin: string; newPin: string }>((resolve, reject) =>
        setPinReq({ kind: 'change', retries, resolve, reject })
      ),
    []
  )

  const onPrintShares = useCallback(async () => {
    if (printing) return
    setPrinting(true)
    try {
      const result = await printRecoveryShares({
        mnemonic: await getMnemonic(),
        recoveredKeyWif: await getRecoveredKey?.(),
        appName
      })
      if (result.ok) {
        // Only a resolved print sheet counts. A cancelled one produced no paper.
        await attest('shares')
      } else if (result.reason === 'unsupported-word-count') {
        showToast(t('vault_shares_word_count'), { type: 'error' })
      } else {
        showToast(t('vault_shares_unavailable'), { type: 'error' })
      }
    } catch {
      // Print sheet dismissed or unavailable — not an error worth blocking on.
    } finally {
      setPrinting(false)
    }
  }, [printing, getMnemonic, getRecoveredKey, attest])

  const onRevealPhrase = useCallback(async () => {
    setError(null)
    // getMnemonic() is behind the biometric latch, so the reveal is
    // re-authenticated without a second prompt of our own.
    const mnemonic = await getMnemonic()
    if (!mnemonic) {
      setError(t('vault_requires_mnemonic'))
      haptics.error()
      return
    }
    setWordCount(mnemonic.trim().split(/\s+/).length)
    setRevealed(mnemonic)
    setStep('phrase')
  }, [getMnemonic])

  // Gate: a wallet restored from backup shares has no mnemonic, so it can
  // neither enroll nor ever recover a vault. Refuse rather than create a vault
  // with only one recovery path.
  const toPassphrase = useCallback(async () => {
    setError(null)
    const mnemonic = await getMnemonic()
    if (!mnemonic) {
      setError(t('vault_requires_mnemonic'))
      haptics.error()
      return
    }
    setStep('passphrase')
  }, [getMnemonic])

  /** Set to `start` below; the wrong-PIN path re-enters the ceremony. */
  const startRef = useRef<((adoptExisting?: boolean) => Promise<void>) | null>(null)

  const start = useCallback(async (adoptExisting = false) => {
    setStep('running')
    setError(null)
    try {
      const mnemonic = await getMnemonic()
      if (!mnemonic) throw new VaultError('bad-mnemonic', t('vault_requires_mnemonic'))
      const { pending } = await enrollVault({
        // Empty by design: the vault screen identifies the key by its serial,
        // which the key itself reports. A nickname field was one more thing to
        // fill in during setup and named nothing the user could not already see.
        nickname: '',
        mnemonic,
        passphrase,
        adoptExisting,
        onPhase: p => setPhaseLabel(t(`vault_enroll_phase_${p}`)),
        getPin: requestPin,
        requestPinChange
      })
      await finalizeEnrollment(pending)
      setPassphrase('')
      setConfirm('')
      sounds.vaultOpen()
      haptics.success()
      showToast(t('vault_enrolled_toast'), { type: 'success' })
      setStep('done')
      onDone()
    } catch (e) {
      // An occupied slot is a fork in the road, not a failure: the key already
      // there is exactly what a second device needs. Offer it instead of
      // dropping the user back to the passphrase step with a dead-end error.
      if (e instanceof VaultError && e.code === 'slot-occupied' && !adoptExisting) {
        setStep('adopt')
        return
      }
      haptics.error()

      // A wrong PIN is feedback on the PIN, so it belongs on the PIN prompt.
      // Dropping back to the passphrase screen with "Wrong PIN." underneath it
      // asked the user to re-confirm a passphrase that was never the problem.
      // Nothing has been written to the key at this point — verifyPin runs
      // before generateVaultKey — so re-entering the ceremony is safe, and it
      // is what puts the PIN sheet back on screen.
      if (e instanceof VaultError && e.code === 'pin-invalid') {
        setPinError(
          e.retriesLeft !== undefined
            ? `${t('vault_err_pin_invalid')} ${t('vault_pin_retries', { count: e.retriesLeft })}`
            : t('vault_err_pin_invalid')
        )
        void startRef.current?.(adoptExisting)
        return
      }

      const msg =
        e instanceof VaultError ? t(`vault_err_${e.code.replace(/-/g, '_')}`, {}) : String(e)
      setError(msg || t('vault_err_generic'))
      setStep('passphrase')
    }
  }, [passphrase, getMnemonic, requestPin, requestPinChange, onDone])

  startRef.current = start

  const submitPin = useCallback(() => {
    if (!pinReq) return
    if (pinReq.kind === 'change') {
      if (newPinInput.length < 6) return
      pinReq.resolve({ oldPin: '123456', newPin: newPinInput })
    } else {
      if (pinInput.length < 4) return
      pinReq.resolve(pinInput)
    }
    setPinReq(null)
    setPinInput('')
    setNewPinInput('')
  }, [pinReq, pinInput, newPinInput])

  // ── backup (prerequisite) ───────────────────────────────────────────
  if (step === 'backup') {
    return (
      <ScrollView contentContainerStyle={styles.gateBody}>
        {/* No hero glyph here. A shield-with-a-tick says "you are protected",
            which is the opposite of this screen's message — it is asking for
            work, not confirming it is done. The two rows below are the
            instruction, so nothing should out-shout them. */}
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_backup_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_backup_intro')}</Text>

        <BackupRow
          icon="document-text-outline"
          title={t('vault_backup_phrase_title')}
          // The actual count is only known once the phrase has been
          // revealed (getMnemonic() is biometric-gated, so it isn't read
          // just to label this row). 12 is the count for every wallet this
          // app generates; imported 24-word wallets get the correct number
          // here as soon as they reveal once.
          subtitle={t('vault_backup_phrase_sub', { count: wordCount ?? 12 })}
          done={medium === 'phrase'}
          busy={false}
          onPress={onRevealPhrase}
        />
        <BackupRow
          icon="print-outline"
          title={t('vault_backup_shares_title')}
          subtitle={t('vault_backup_shares_sub')}
          done={medium === 'shares'}
          busy={printing}
          onPress={onPrintShares}
        />


        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={medium ? toPassphrase : undefined}
          style={[
            styles.primary,
            // Outlined while it is not yet armed. Filled with the secondary
            // background it was indistinguishable from the page in dark mode,
            // so the disabled CTA read as a stray line of grey text rather
            // than as a button waiting on the rows above it.
            {
              backgroundColor: medium ? colors.accent : 'transparent',
              borderWidth: medium ? 0 : StyleSheet.hairlineWidth,
              borderColor: colors.separator
            }
          ]}
        >
          <Text
            style={[
              styles.primaryLabel,
              { color: medium ? colors.textOnAccent : colors.textTertiary }
            ]}
          >
            {t('vault_continue')}
          </Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── phrase reveal ───────────────────────────────────────────────────
  if (step === 'phrase' && revealed) {
    return (
      <PhraseBackupSheet
        mnemonic={revealed}
        onAttest={async () => {
          // Whatever attest() decides, the phrase should not linger on
          // screen: on success the row ticks; on failure the backup step's
          // inline error tells the user to retry rather than stranding them
          // here with no feedback.
          await attest('phrase')
          setRevealed(null)
          setStep('backup')
        }}
        onCancel={() => {
          setRevealed(null)
          setStep('backup')
        }}
      />
    )
  }

  // ── passphrase ──────────────────────────────────────────────────────
  if (step === 'passphrase') {
    return (
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_enroll_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_enroll_intro')}</Text>

        <PassphraseField
          value={passphrase}
          onChangeText={setPassphrase}
          confirm={confirm}
          onChangeConfirm={setConfirm}
          onValidityChange={setPassphraseOk}
        />

        <View style={[styles.warnBox, { backgroundColor: colors.warning + '14' }]}>
          <Ionicons name="warning-outline" size={16} color={colors.warning} />
          <Text style={[styles.warnText, { color: colors.textSecondary }]}>
            {t('vault_passphrase_no_reset')}
          </Text>
        </View>

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}
        <PressableScale
          haptic="confirm"
          onPress={passphraseOk ? () => start() : undefined}
          style={[
            styles.primary,
            {
              backgroundColor: passphraseOk ? colors.accent : 'transparent',
              borderWidth: passphraseOk ? 0 : StyleSheet.hairlineWidth,
              borderColor: colors.separator
            }
          ]}
        >
          <Text
            style={[
              styles.primaryLabel,
              { color: passphraseOk ? colors.textOnAccent : colors.textTertiary }
            ]}
          >
            {t('vault_enroll_begin')}
          </Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── adopt (slot already holds a key) ────────────────────────────────
  if (step === 'adopt') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Ionicons
          name="hardware-chip-outline"
          size={48}
          color={colors.textPrimary}
          style={styles.hero}
        />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_slot_in_use_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_slot_in_use_body')}</Text>

        <PressableScale
          haptic="confirm"
          onPress={() => start(true)}
          style={[styles.primary, { backgroundColor: colors.accent }]}
        >
          <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>
            {t('vault_use_existing_key')}
          </Text>
        </PressableScale>
        <PressableScale onPress={onCancel} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
            {t('vault_cancel')}
          </Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── running (PIN prompts + tap) ─────────────────────────────────────
  if (step === 'running') {
    return (
      <View style={styles.body}>
        {pinReq ? (
          <>
            <Ionicons name="keypad-outline" size={40} color={colors.textPrimary} style={styles.hero} />
            <Text style={[styles.h1, { color: colors.textPrimary }]}>
              {pinReq.kind === 'change' ? t('vault_set_new_pin') : t('vault_enter_pin')}
            </Text>
            {/* Which PIN, and what it is if they have never set one. Without
                this the prompt is ambiguous with the phone's own passcode, and
                a factory key's PIN is not something users know they have. */}
            <Text style={[styles.p, { color: colors.textSecondary }]}>
              {pinReq.kind === 'change' ? t('vault_default_pin_warning') : t('vault_enter_pin_sub')}
            </Text>
            {pinError && <Text style={[styles.err, { color: colors.error }]}>{pinError}</Text>}
            <TextInput
              style={[
                styles.pin,
                { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }
              ]}
              value={pinReq.kind === 'change' ? newPinInput : pinInput}
              onChangeText={text => {
                setPinError(null)
                ;(pinReq.kind === 'change' ? setNewPinInput : setPinInput)(text)
              }}
              placeholder="••••••"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              // Masking only once there is something to mask: iOS renders a
              // secure field's PLACEHOLDER with masked-glyph metrics, which is
              // what stretches the bullets apart before any digit is typed.
              secureTextEntry={(pinReq.kind === 'change' ? newPinInput : pinInput).length > 0}
              maxLength={8}
              autoFocus
            />
            <PressableScale
              haptic="confirm"
              onPress={submitPin}
              style={[styles.primary, { backgroundColor: colors.accent }]}
            >
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>
                {t('vault_continue')}
              </Text>
            </PressableScale>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.textPrimary} size="large" style={styles.hero} />
            <Text style={[styles.h1, { color: colors.textPrimary }]}>
              {phaseLabel || t('vault_reading_key')}
            </Text>
            <Text style={[styles.p, { color: colors.textSecondary }]}>
              {t('vault_touch_when_blinks')}
            </Text>
          </>
        )}
      </View>
    )
  }

  return null
}

/** One backup route: tappable, ticks when satisfied, stays tappable after. */
const BackupRow: React.FC<{
  icon: React.ComponentProps<IoniconsComponent>['name']
  title: string
  subtitle: string
  done: boolean
  busy: boolean
  onPress: () => void
}> = ({ icon, title, subtitle, done, busy, onPress }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  return (
    <PressableScale
      onPress={busy ? undefined : onPress}
      style={[styles.backupRow, { borderColor: done ? colors.success : colors.separator }]}
    >
      {busy ? (
        <ActivityIndicator color={colors.info} size="small" />
      ) : (
        <Ionicons name={icon} size={22} color={done ? colors.success : colors.info} />
      )}
      <View style={styles.backupRowText}>
        <Text style={[styles.backupRowTitle, { color: colors.textPrimary }]}>{title}</Text>
        <Text style={[styles.backupRowSub, { color: colors.textSecondary }]}>{subtitle}</Text>
      </View>
      {done && <Ionicons name="checkmark-circle" size={20} color={colors.success} />}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg },
  // The gate is three short blocks; top-aligned they sat in the upper third
  // with half a screen of nothing under them.
  gateBody: { padding: spacing.xl, gap: spacing.lg, flexGrow: 1, justifyContent: 'center' },
  hero: { marginTop: spacing.lg, alignSelf: 'center' },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
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
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  err: { ...typography.footnote, textAlign: 'center' },
  fine: { ...typography.caption2, textAlign: 'center' },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md
  },
  ghostLabel: { ...typography.footnote, fontWeight: '600' },
  backupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  backupRowText: { flex: 1, gap: spacing.xs },
  backupRowTitle: { ...typography.headline },
  backupRowSub: { ...typography.footnote },
  paths: {
    width: '100%',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  pathsTitle: { ...typography.footnote, fontWeight: '600' },
  pathRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  pathText: { ...typography.footnote, flex: 1 },
  pathsFine: { ...typography.caption2 },
  warnBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md
  },
  warnText: { ...typography.footnote, flex: 1 }
})
