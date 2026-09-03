import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Linking
} from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useTranslation } from 'react-i18next'
import { PrivateKey } from '@bsv/sdk'
import * as Clipboard from 'expo-clipboard'
import { Paths, File as ExpoFile } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import {
  CustomSafeArea,
  showAlert,
  showToast,
  Celebration,
  PressableScale,
  printRecoveryShares
} from '@bsv/expo-wallet-toolbox/ui'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  generateMnemonicWallet,
  validateMnemonic,
  useLocalStorage,
  recordBackupAttestation,
  type BackupMedium
} from '@bsv/expo-wallet-toolbox'

type MnemonicMode = 'choose' | 'generate' | 'import'

export default function MnemonicScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const {
    buildWalletFromMnemonic,
    buildWalletFromRecoveredKey,
    rebuildWallet,
    backupRestore,
    getBackupRestore,
    managers,
    adminOriginator,
    walletBuilt
  } = useWallet()
  const { setMnemonic: storeMnemonic, setRecoveredKey, getMnemonic: readStoredMnemonic } = useLocalStorage()

  /** 'backup': onboarding's reminder sheet, over an already-built (auto-created)
   *  wallet — show the existing phrase rather than generating a new one.
   *  'import': same reminder sheet's other button — open straight into import,
   *  replacing the auto-created wallet on completion. */
  const { flow } = useLocalSearchParams<{ flow?: 'backup' | 'import' }>()

  const initialMode: MnemonicMode = flow === 'import' ? 'import' : flow === 'backup' ? 'generate' : 'choose'
  const [mode, setMode] = useState<MnemonicMode>(initialMode)
  const [mnemonic, setMnemonic] = useState<string>('')
  const [importedMnemonic, setImportedMnemonic] = useState<string>('')

  const [hasAcknowledged, setHasAcknowledged] = useState(false)
  /** Which route this user actually took, so the attestation records the truth. */
  const [backupMedium, setBackupMedium] = useState<BackupMedium | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isPrinting, setIsPrinting] = useState(false)
  const [celebrating, setCelebrating] = useState(false)

  // Onboarding's backup reminder: the wallet already exists (auto-created at
  // root mount), so show its real phrase instead of generating a new one.
  useEffect(() => {
    if (flow !== 'backup') return
    ;(async () => {
      const existing = await readStoredMnemonic()
      if (!existing) {
        showToast('Failed to load recovery phrase. Please try again.', { type: 'error' })
        router.back()
        return
      }
      setMnemonic(existing)
      setMode('generate')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow])

  // Generate a new mnemonic and immediately build the wallet
  const handleGenerateNew = async () => {
    try {
      const wallet = generateMnemonicWallet()
      setMnemonic(wallet.mnemonic)
      setMode('generate')

      // Store and build the wallet immediately so it is ready by the time the
      // user finishes the save screen. (Print Recovery Shares no longer needs
      // this — it derives the identity key from the mnemonic itself.)
      console.log('[Mnemonic] Building wallet eagerly after mnemonic generation')
      const stored = await storeMnemonic(wallet.mnemonic)
      if (!stored) {
        const choice = await showAlert({
          title: 'Biometric Access Required',
          message: 'Biometric access is needed to protect your wallet keys. Please try again.',
          buttons: [
            { text: 'Cancel', style: 'cancel', key: 'cancel' },
            { text: 'Try Again', key: 'retry' },
          ],
        })
        if (choice === 'cancel') setMode('choose')
        else handleGenerateNew()
        return
      }
      await buildWalletFromMnemonic(wallet.mnemonic)
      console.log('[Mnemonic] Wallet built successfully during generate flow')
    } catch (error: any) {
      console.error('Error generating mnemonic:', error)
      showToast('Failed to generate mnemonic. Please try again.', { type: 'error' })
    }
  }

  // Share mnemonic as text file via system share dialog
  const handleShareMnemonic = async () => {
    const timestamp = Math.floor(Date.now() / 1000)
    const filename = `wallet-recovery-phrase-${timestamp}.txt`
    const file = new ExpoFile(Paths.cache, filename)
    try {
      file.write(mnemonic)
      await Sharing.shareAsync(file.uri, {
        mimeType: 'text/plain',
        UTI: 'public.plain-text',
        dialogTitle: 'Save Your Recovery Phrase'
      })
      setHasAcknowledged(true)
    } catch (error) {
      console.error('Error sharing mnemonic:', error)
    } finally {
      if (file.exists) {
        file.delete()
      }
    }
  }

  // Copy mnemonic to clipboard
  const handleCopyMnemonic = async () => {
    await Clipboard.setStringAsync(mnemonic)
    showToast('Copied', { type: 'success' })
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
      setHasAcknowledged(true)
    }, 3000)
  }

  // Print recovery shares (same as Settings page)
  const handlePrintRecoveryShares = async () => {
    if (isPrinting) return
    setIsPrinting(true)
    try {
      const result = await printRecoveryShares({ mnemonic, recoveredKeyWif: null, appName: 'BSV Wallet' })
      if (!result.ok) {
        showToast(
          result.reason === 'unsupported-word-count'
            ? t('vault_shares_word_count')
            : t('vault_shares_unavailable'),
          { type: 'error' }
        )
      } else {
        setBackupMedium('shares')
        setHasAcknowledged(true)
      }
    } catch (error: any) {
      console.info('[Mnemonic] Print recovery shares did not complete:', error?.message)
    } finally {
      setIsPrinting(false)
    }
  }

  // Validate and continue with imported mnemonic or hex private key
  const handleContinueWithImported = async () => {
    const trimmed = importedMnemonic.trim()

    // Detect 64-char hex string as a raw private key
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      setLoading(true)
      try {
        const wif = PrivateKey.fromHex(trimmed).toWif()
        const stored = await setRecoveredKey(wif)
        if (!stored) {
          const choice = await showAlert({
            title: 'Biometric Access Required',
            message: 'Biometric access is needed to protect your wallet keys. Please try again.',
            buttons: [
              { text: 'Cancel', style: 'cancel', key: 'cancel' },
              { text: 'Try Again', key: 'retry' },
            ],
          })
          if (choice === 'retry') await handleContinueWithImported()
          return
        }
        if (walletBuilt) {
          // Replacing the auto-created wallet from onboarding's backup
          // reminder — buildWalletFromRecoveredKey no-ops once a wallet is
          // already built, so tear it down and re-trigger the build instead.
          await rebuildWallet({ restoreFromBackup: true })
        } else {
          await buildWalletFromRecoveredKey(wif, { restoreFromBackup: true })
        }
        if (await handledRestoreFailure(() => handleContinueWithImported())) return
        setCelebrating(true)
      } catch (error: any) {
        console.error('[Mnemonic] Error importing hex key:', error)
        showToast(`Invalid private key: ${error.message}`, { type: 'error' })
      } finally {
        setLoading(false)
      }
      return
    }

    if (!validateMnemonic(trimmed)) {
      await showAlert({
        title: 'Invalid Input',
        message: 'Please enter a valid recovery phrase (12–24 words) or a 64-character hex private key.',
      })
      return
    }

    await initializeWallet(trimmed, { restore: true })
  }

  /**
   * Deal with an import whose backup replay failed.
   *
   * Returns true when the failure was handled and the caller must NOT proceed to the
   * celebration: the wallet was deliberately not built, because a half-replayed database
   * presented as a working wallet is the one outcome worth blocking. `retry` re-runs the
   * same import; the alternative rebuilds without a restore, which yields a usable wallet
   * with no history.
   *
   * Reads getBackupRestore() rather than the `backupRestore` render value: this runs
   * immediately after the build's own await, where the captured value is still the
   * pre-build one.
   */
  const handledRestoreFailure = async (retry: () => Promise<void>): Promise<boolean> => {
    const state = getBackupRestore()
    if (state.phase !== 'failed') return false

    setLoading(false)
    const choice = await showAlert({
      title: t('restore_backup_failed_title'),
      message: `${t('restore_backup_failed_message')}${state.error ? `\n\n${state.error}` : ''}`,
      buttons: [
        { text: t('restore_backup_retry'), key: 'retry' },
        // Destructive, not cancel: abandoning the history forfeits past change
        // outputs whose derivation data only existed in the backup.
        { text: t('restore_backup_skip'), key: 'skip', style: 'destructive' }
      ]
    })

    if (choice === 'retry') {
      await retry()
      return true
    }

    // Without a restore: a working wallet, no past transactions, and past change outputs
    // that stay unspendable because their derivation data only ever existed in the backup.
    const trimmed = importedMnemonic.trim()
    if (validateMnemonic(trimmed)) await initializeWallet(trimmed, { restore: false })
    return true
  }

  // Initialize wallet with mnemonic
  const initializeWallet = async (mnemonicPhrase: string, opts?: { restore?: boolean }) => {
    setLoading(true)
    try {
      console.log('[Mnemonic] Starting wallet initialization with mnemonic')
      const stored = await storeMnemonic(mnemonicPhrase)
      if (!stored) {
        const choice = await showAlert({
          title: 'Biometric Access Required',
          message: 'Biometric access is needed to protect your wallet keys. Please try again.',
          buttons: [
            { text: 'Cancel', style: 'cancel', key: 'cancel' },
            { text: 'Try Again', key: 'retry' },
          ],
        })
        if (choice === 'retry') await initializeWallet(mnemonicPhrase, opts)
        return
      }
      // An imported phrase replays the encrypted backup log BEFORE the wallet becomes
      // usable — the phrase alone cannot rebuild change-output derivation data. A freshly
      // generated wallet passes no options and skips this entirely, since there is
      // nothing on the server under a brand-new seed.
      if (walletBuilt) {
        // Replacing the auto-created wallet from onboarding's backup reminder —
        // buildWalletFromMnemonic no-ops once a wallet is already built, so tear
        // it down and re-trigger the build instead.
        await rebuildWallet({ restoreFromBackup: opts?.restore === true })
      } else {
        await buildWalletFromMnemonic(mnemonicPhrase, { restoreFromBackup: opts?.restore === true })
      }
      if (opts?.restore === true && (await handledRestoreFailure(() => initializeWallet(mnemonicPhrase, opts)))) {
        return
      }
      setCelebrating(true)
    } catch (error: any) {
      console.error('[Mnemonic] Error setting up wallet:', error)
      showToast(`Failed to set up wallet: ${error.message}`, { type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  // ─── Celebration overlay (wallet created) ────────────────────────────
  if (celebrating) {
    return (
      <View style={[s.screen, s.celebrationScreen, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Celebration
          onDone={() => {
            // dismissAll() targets a modally-presented navigator being dismissed
            // back to whatever pushed it; this screen sits in the same flat,
            // non-modal Stack as the Wallet (app/_layout.tsx), so React
            // Navigation has no modal to dismiss and silently no-ops (logs
            // "action 'POP_TO_TOP' was not handled"), stranding the user here.
            // dismissTo('/'), the same idiom PaymentSuccessOverlay uses to
            // return to the wallet, pops the stack back to the existing root
            // `index` screen instead of pushing a second one on top of it.
            router.dismissTo('/')
          }}
        />
      </View>
    )
  }

  // ─── Choose mode ──────────────────────────────────────────────────────
  if (mode === 'choose') {
    return (
      <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <View style={s.centeredContent}>
          {/* Hero icon */}
          <View style={[s.heroIcon, { backgroundColor: colors.fillTertiary }]}>
            <Ionicons name="key-outline" size={40} color={colors.accent} />
          </View>

          <Text style={[s.largeTitle, { color: colors.textPrimary }]}>{t('wallet_data')}</Text>
          <Text style={[s.subtitle, { color: colors.textSecondary }]}>
            Your keys and transactions are stored on this device{' '}
            <Text style={{ fontWeight: 'bold', fontStyle: 'italic' }}>only</Text>. Expect occasional loss.{'\n\n'}
            Designed for p2p electronic cash.{'\n'}
            <Text style={{ fontWeight: 'bold' }}>Not life savings</Text>.
          </Text>

          {/* Actions */}
          <View style={s.actionArea}>
            <PressableScale
              style={[s.primaryButton, { backgroundColor: colors.accent }]}
              onPress={handleGenerateNew}
              haptic="confirm"
            >
              <Ionicons name="add-circle-outline" size={22} color={colors.textOnAccent} style={s.btnIcon} />
              <View style={s.btnTextGroup}>
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('create_new_wallet')}</Text>
                <Text style={[s.btnCaption, { color: colors.textOnAccent, opacity: 0.75 }]}>
                  {t('generate_recovery_phrase_caption')}
                </Text>
              </View>
            </PressableScale>

            <PressableScale
              style={[
                s.secondaryButton,
                {
                  backgroundColor: colors.fillTertiary,
                  borderColor: colors.separator
                }
              ]}
              onPress={() => setMode('import')}
              haptic="tap"
            >
              <Ionicons name="download-outline" size={22} color={colors.accent} style={s.btnIcon} />
              <View style={s.btnTextGroup}>
                <Text style={[s.btnLabel, { color: colors.textPrimary }]}>{t('import_existing_wallet')}</Text>
                <Text style={[s.btnCaption, { color: colors.textSecondary }]}>{t('paste_recovery_phrase')}</Text>
              </View>
            </PressableScale>
          </View>

          {/* Legal disclaimer */}
          <Text style={[s.legalText, { color: colors.textTertiary }]}>
            By continuing, you agree to our{' '}
            <Text
              style={[s.legalLink, { color: colors.textTertiary }]}
              onPress={() => Linking.openURL('https://bsv-blockchain.github.io/bsv-wallet/privacy.html')}
            >
              privacy
            </Text>{' '}
            and{' '}
            <Text
              style={[s.legalLink, { color: colors.textTertiary }]}
              onPress={() => Linking.openURL('https://bsv-blockchain.github.io/bsv-wallet/usage.html')}
            >
              usage
            </Text>{' '}
            policies.
          </Text>

          {/* Cancel */}
          <PressableScale style={s.textButton} onPress={() => router.back()} haptic="tap">
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>{t('cancel')}</Text>
          </PressableScale>
        </View>
      </CustomSafeArea>
    )
  }

  // ─── Generate mode ────────────────────────────────────────────────────
  if (mode === 'generate') {
    return (
      <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <ScrollView contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={[s.largeTitle, { color: colors.textPrimary, textAlign: 'left', marginTop: spacing.xl }]}>
            Save these words
          </Text>

          {/* Mnemonic display — compact selectable block. White fill with a
              warning-colored border rather than the page's ordinary card
              styling: this is the one block of content the user actually
              has to act on, so it needs to read as distinct from the
              surrounding chrome, not blend into it. */}
          <View
            style={[
              s.mnemonicDisplay,
              {
                backgroundColor: colors.background,
                borderColor: colors.warning,
                borderWidth: 2
              }
            ]}
          >
            <Text style={[s.mnemonicDisplayText, { color: colors.textPrimary }]} selectable>
              {mnemonic}
            </Text>
          </View>

          {/* Action buttons */}
          <View style={s.generateActions}>
            <View style={s.inlineButtonRow}>
              <PressableScale
                style={[s.inlineButton, { backgroundColor: colors.accent }]}
                onPress={handleShareMnemonic}
                haptic="confirm"
              >
                <Ionicons name="share-outline" size={20} color={colors.textOnAccent} style={s.btnIcon} />
                <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('save')}</Text>
              </PressableScale>

              <PressableScale
                style={[s.inlineButton, { backgroundColor: colors.fillTertiary }]}
                onPress={handleCopyMnemonic}
                haptic="tap"
              >
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={20}
                  color={colors.accent}
                  style={s.btnIcon}
                />
                <Text style={[s.btnLabel, { color: colors.accent }]}>{copied ? t('copied') : t('copy')}</Text>
              </PressableScale>
            </View>

            {/* Print recovery shares is a distinct backup medium, not a step
                in saving the words above — a divider keeps it from reading
                as part of the same action. */}
            <View style={[s.divider, { backgroundColor: colors.separator }]} />

            <Text style={[s.printSectionTitle, { color: colors.textPrimary }]}>Distribute shares</Text>
            <Text style={[s.printExplainer, { color: colors.textSecondary }]}>
              Any 2 of the 3 pages can be used to recover your wallet.
            </Text>

            <PressableScale
              style={[s.primaryButton, { backgroundColor: colors.warning }]}
              onPress={handlePrintRecoveryShares}
              disabled={isPrinting}
              haptic="confirm"
            >
              {isPrinting ? (
                <ActivityIndicator color={colors.textOnAccent} style={s.btnIcon} />
              ) : (
                <Ionicons name="print-outline" size={20} color={colors.textOnAccent} style={s.btnIcon} />
              )}
              <Text style={[s.btnLabel, { color: colors.textOnAccent }]}>{t('print_recovery_shares')}</Text>
            </PressableScale>
          </View>

          {/* Go back. No separate Continue button: this is the one exit from
              the screen, so it carries what Continue used to do — recording
              the backup attestation — before actually leaving. Only recorded
              if the user actually hit Save, Copy, or Print Recovery Shares
              (hasAcknowledged) — leaving without touching any of them must
              not mark the wallet as backed up. flow === 'backup' means the
              wallet already exists, so leaving means returning to the root
              screen; otherwise this is a fresh wallet and leaving means the
              celebration screen. */}
          <PressableScale
            style={s.textButton}
            onPress={async () => {
              if (hasAcknowledged) {
                const recorded = await recordBackupAttestation(
                  managers?.permissionsManager,
                  adminOriginator,
                  backupMedium ?? 'phrase'
                )
                if (!recorded) console.warn('[Mnemonic] backup attestation not recorded')
              }
              if (flow === 'backup') {
                router.back()
                return
              }
              setCelebrating(true)
            }}
            haptic="tap"
          >
            <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>{t('go_back')}</Text>
          </PressableScale>
        </ScrollView>
      </CustomSafeArea>
    )
  }

  // ─── Import mode ──────────────────────────────────────────────────────
  return (
    <CustomSafeArea style={[s.screen, { backgroundColor: colors.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hero icon */}
        <View style={[s.heroIcon, { backgroundColor: colors.fillTertiary, alignSelf: 'flex-start' }]}>
          <Ionicons name="download-outline" size={36} color={colors.accent} />
        </View>

        <Text style={[s.largeTitle, { color: colors.textPrimary, textAlign: 'left' }]}>{t('import_wallet')}</Text>
        <Text style={[s.bodyText, { color: colors.textSecondary, marginBottom: spacing.xxl }]}>
          {t('restore_wallet_description')}
        </Text>

        <TextInput
          style={[
            s.mnemonicInput,
            {
              backgroundColor: colors.fillTertiary,
              borderColor: colors.separator,
              color: colors.textPrimary
            }
          ]}
          value={importedMnemonic}
          onChangeText={setImportedMnemonic}
          placeholder={t('enter_recovery_words')}
          placeholderTextColor={colors.textTertiary}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />

        <PressableScale
          style={[
            s.primaryButton,
            {
              backgroundColor: importedMnemonic.trim() ? colors.accent : colors.fillSecondary,
              opacity: loading ? 0.6 : 1,
              marginTop: spacing.xxl
            }
          ]}
          onPress={handleContinueWithImported}
          disabled={!importedMnemonic.trim() || loading}
          haptic="confirm"
        >
          {loading ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text
              style={[
                s.btnLabel,
                {
                  color: importedMnemonic.trim() ? colors.textOnAccent : colors.textTertiary
                }
              ]}
            >
              {t('import_wallet')}
            </Text>
          )}
        </PressableScale>

        {/* Restore progress. The import blocks on replaying the encrypted backup log, and
            a large history takes many chunks — a bare spinner would read as a hang. */}
        {(backupRestore.phase === 'checking' || backupRestore.phase === 'restoring') && (
          <Text
            style={[s.bodyText, { color: colors.textSecondary, marginTop: spacing.md, textAlign: 'center' }]}
          >
            {backupRestore.phase === 'checking' || backupRestore.total === 0
              ? t('restore_backup_checking')
              : t('restore_backup_progress', {
                  chunks: backupRestore.chunks,
                  total: backupRestore.total
                })}
          </Text>
        )}

        {/* ── Divider ── */}
        <View style={[s.orDivider, { marginTop: spacing.xl }]}>
          <View style={[s.orDividerLine, { backgroundColor: colors.separator }]} />
          <Text style={[s.orDividerText, { color: colors.textTertiary }]}>{t('or')}</Text>
          <View style={[s.orDividerLine, { backgroundColor: colors.separator }]} />
        </View>

        {/* ── Scan Backup Shares ── */}
        <PressableScale
          style={[
            s.secondaryButton,
            {
              backgroundColor: colors.fillTertiary,
              borderColor: colors.separator,
              marginTop: spacing.xl
            }
          ]}
          onPress={() => router.push('/auth/scan-shares')}
          haptic="tap"
        >
          <Ionicons name="scan-outline" size={22} color={colors.accent} style={s.btnIcon} />
          <View style={s.btnTextGroup}>
            <Text style={[s.btnLabel, { color: colors.textPrimary }]}>{t('scan_backup_shares')}</Text>
            <Text style={[s.btnCaption, { color: colors.textSecondary }]}>{t('scan_backup_shares_caption')}</Text>
          </View>
        </PressableScale>

        <PressableScale
          style={s.textButton}
          onPress={() => (flow === 'import' ? router.back() : setMode('choose'))}
          haptic="tap"
        >
          <Text style={[s.textButtonLabel, { color: colors.textSecondary }]}>Go Back</Text>
        </PressableScale>
      </ScrollView>
    </CustomSafeArea>
  )
}

// ─── Static Styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1
  },
  celebrationScreen: {
    alignItems: 'center',
    justifyContent: 'center'
  },

  // Centered layout for the choose screen
  centeredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxxl
  },

  // Scrollable layout for generate / import
  scrollContent: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxxl + spacing.xl,
    paddingBottom: 60
  },

  // ─── Hero icon ──────────────────────────────────────────────────────
  heroIcon: {
    width: 80,
    height: 80,
    borderRadius: radii.xl,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xxl
  },

  // ─── Typography ─────────────────────────────────────────────────────
  largeTitle: {
    ...typography.largeTitle,
    marginBottom: spacing.md,
    textAlign: 'center',
    marginTop: spacing.xl
  },
  subtitle: {
    ...typography.subhead,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xxxl + spacing.sm
  },
  bodyText: {
    ...typography.body,
    lineHeight: 24
  },

  // ─── Mnemonic display ──────────────────────────────────────────────
  mnemonicDisplay: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.xxl
  },
  mnemonicDisplayText: {
    ...typography.callout,
    fontFamily: 'monospace',
    lineHeight: 24,
    textAlign: 'center'
  },

  // ─── Buttons ────────────────────────────────────────────────────────
  actionArea: {
    width: '100%',
    gap: spacing.md,
    marginBottom: spacing.xxl
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.lg,
    minHeight: 50
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 50
  },
  tertiaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    minHeight: 50
  },
  generateActions: {
    gap: spacing.sm,
    marginBottom: spacing.xxl
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 20
  },
  printSectionTitle: {
    ...typography.largeTitle
  },
  printExplainer: {
    ...typography.footnote,
    lineHeight: 18,
    marginBottom: spacing.xs
  },
  inlineButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  inlineButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    minHeight: 50
  },
  btnIcon: {
    marginRight: spacing.sm
  },
  btnTextGroup: {
    flex: 1
  },
  btnLabel: {
    ...typography.headline
  },
  btnCaption: {
    ...typography.footnote,
    marginTop: 2
  },
  legalText: {
    ...typography.caption2,
    textAlign: 'center',
    lineHeight: 16
  },
  legalLink: {
    ...typography.caption2,
    textDecorationLine: 'underline'
  },
  textButton: {
    alignSelf: 'center',
    marginTop: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl
  },
  textButtonLabel: {
    ...typography.subhead
  },

  // ─── Import text input ─────────────────────────────────────────────
  mnemonicInput: {
    ...typography.body,
    minHeight: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.lg,
    paddingTop: spacing.lg,
    lineHeight: 26
  },

  // ─── Or divider ───────────────────────────────────────────────────
  orDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%'
  },
  orDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth
  },
  orDividerText: {
    ...typography.footnote,
    marginHorizontal: spacing.md,
    textTransform: 'uppercase'
  }
})
