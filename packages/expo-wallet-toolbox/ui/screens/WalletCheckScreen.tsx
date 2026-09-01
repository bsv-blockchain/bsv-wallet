/**
 * Troubleshooting — a pushed, determinate repair destination.
 *
 * All four steps are on screen from the first frame as a checklist, each
 * ticking as it settles. A single in-progress line could not be trusted: on a
 * healthy wallet the steps resolve in one frame, so the user saw a flicker and
 * had no way to tell what had actually been checked. A list that fills in
 * leaves the evidence standing after the run.
 *
 * Back always works. Done is quiet copy and a haptic, not Celebration.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { PeerPayClient } from '@bsv/message-box-client'
import { showAlert } from '../components/ui/AlertCard'
import { makeCreditClassifier } from '../../core/pay/creditErrors'
import { creditInboxOnce, INBOX_DESCRIPTION } from '../../core/pay/creditInbox'
import { makeBeefRepair } from '../../core/pay/beefRepair'
import {
  acceptWithRetry,
  DEFAULT_MESSAGE_BOX_URL,
  internalizeIncoming,
  LEGACY_MESSAGE_BOX_URL,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX
} from '../../core/pay/rails/handle'
import {
  derivationPrefixFor,
  getCurrentDate,
  getPaymentAddress,
  MAX_RECOVERY_DAYS,
  sweepAddress,
  wocConfigFor
} from '../../core/pay/rails/address'
import {
  runWalletCheck,
  type WalletCheckPorts,
  type WalletCheckStepId,
  type WalletCheckStepStatus
} from '../../core/walletRepair/runWalletCheck'
import { userFacingPayError } from '../../core/pay/userError'
import { backupAttestation } from '../../core/services/vault/backupAttestation'
import { getBackupUploadState } from '../../core/backup/status'
import { getOnline, haptics, spacing, typography, useTheme, useWallet } from '@bsv/expo-wallet-toolbox'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
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
 * barrel, even one that never navigates.
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

const STEPS: { id: WalletCheckStepId; labelKey: string }[] = [
  { id: 'online', labelKey: 'wallet_check_step_online' },
  { id: 'records', labelKey: 'wallet_check_step_records' },
  { id: 'coins', labelKey: 'wallet_check_step_coins' },
  { id: 'proofs', labelKey: 'wallet_check_step_proofs' },
  { id: 'missed_payments', labelKey: 'wallet_check_step_missed' },
  { id: 'backup', labelKey: 'wallet_check_step_backup' },
  { id: 'phrase_backup', labelKey: 'wallet_check_step_phrase' }
]

export function isReviewActionsError(error: unknown): boolean {
  return userFacingPayError(error).offerWalletCheck
}

export async function promptCheckWallet(t: (key: string) => string): Promise<'check_wallet' | 'cancel'> {
  const choice = await showAlert({
    title: t('wallet_check_stuck_title'),
    message: t('wallet_check_stuck_message'),
    buttons: [
      { text: t('cancel'), key: 'cancel', style: 'cancel' },
      { text: t('check_wallet'), key: 'check_wallet' }
    ]
  })
  return choice === 'check_wallet' ? 'check_wallet' : 'cancel'
}

function parseCount(text: string, re: RegExp): number {
  const match = text.match(re)
  return match ? Number(match[1]) || 0 : 0
}

function countNeedle(text: string, needle: string): number {
  if (!text) return 0
  let n = 0
  let i = 0
  while ((i = text.indexOf(needle, i)) !== -1) {
    n++
    i += needle.length
  }
  return n
}

function useWalletCheckPorts(): WalletCheckPorts {
  const {
    managers,
    adminOriginator,
    storage,
    selectedNetwork,
    checkUtxoSpendability,
    releaseStuckReservations,
    runMonitorTask,
    peekLastMissHeight
  } = useWallet()
  const wallet = managers?.permissionsManager

  return useMemo<WalletCheckPorts>(
    () => ({
      checkOnline: async () => ({ online: await getOnline() }),
      checkBackup: async () => await getBackupUploadState(),
      checkPhraseBackup: async () => {
        // Advisory: it records that someone pressed "I have written these
        // down" or completed a print. Nothing verifies the paper exists — but
        // the absence of the record does mean nobody ever said they had.
        if (!wallet) return { backedUp: false }
        const { publicKey } = await wallet.getPublicKey({ identityKey: true }, adminOriginator)
        return { backedUp: (await backupAttestation.get(publicKey)) !== null }
      },
      reviewSpendable: async () => {
        const log = await checkUtxoSpendability()
        // Stuck-reservation releases are counted by releaseStuck, not here.
        return {
          released: parseCount(log, /(\d+) stale output\(s\) marked unspendable/),
          recovered: parseCount(log, /(\d+) spending tx\(s\) internalized/)
        }
      },
      checkProofs: async () => {
        await runMonitorTask('CheckForProofs')
        return { repaired: 0 }
      },
      reviewStatus: async () => {
        if (!storage?.reviewStatus) return { failedTxs: 0, restoredInputs: 0 }
        const { log } = await storage.reviewStatus({ agedLimit: new Date() })
        return {
          failedTxs: countNeedle(log, "updated to status of 'failed'"),
          restoredInputs: countNeedle(log, 'updated to spendable because spentBy is failed')
        }
      },
      releaseStuck: async () => {
        const log = await releaseStuckReservations()
        return { released: parseCount(log, /Released (\d+) stuck/) }
      },
      creditInbox: async () => {
        if (!wallet) return { accepted: 0 }
        const saved = await AsyncStorage.getItem(MESSAGE_BOX_URL_KEY)
        const messageBoxUrl = !saved || saved === LEGACY_MESSAGE_BOX_URL ? DEFAULT_MESSAGE_BOX_URL : saved
        if (!messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) return { accepted: 0 }
        const client = new PeerPayClient({
          messageBoxHost: messageBoxUrl,
          walletClient: wallet as never,
          originator: adminOriginator
        })
        const repairBeef = makeBeefRepair({ woc: wocConfigFor(selectedNetwork), online: getOnline })
        const classify = await makeCreditClassifier({ getOnline, peekLastMissHeight })
        const outcome = await creditInboxOnce({
          client,
          messageBoxUrl,
          storage: storage ?? undefined,
          classify,
          accept: payment =>
            acceptWithRetry(client, messageBoxUrl, payment, INBOX_DESCRIPTION, (p, d) =>
              internalizeIncoming(wallet as never, client, adminOriginator, p, d, repairBeef)
            )
        })
        return { accepted: outcome.accepted }
      },
      sweepAddresses: async () => {
        if (!wallet) return { imported: 0 }
        const woc = wocConfigFor(selectedNetwork)
        let imported = 0
        for (let day = 0; day < MAX_RECOVERY_DAYS; day++) {
          try {
            const prefix = derivationPrefixFor(getCurrentDate(day))
            const address = await getPaymentAddress(wallet, adminOriginator, prefix, woc.network)
            const result = await sweepAddress({
              wallet: wallet as never,
              adminOriginator,
              woc,
              address,
              derivationPrefix: prefix
            })
            if (result.importedSatoshis > 0) imported++
          } catch {
            // One day's miss must not skip the rest of the lookback.
          }
        }
        return { imported }
      }
    }),
    [
      adminOriginator,
      checkUtxoSpendability,
      releaseStuckReservations,
      runMonitorTask,
      selectedNetwork,
      storage,
      peekLastMissHeight,
      wallet
    ]
  )
}

export function WalletCheckScreen(props?: { ports?: WalletCheckPorts }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router } = loadExpoRouter()
  const Ionicons = loadIonicons()
  const contextPorts = useWalletCheckPorts()
  const ports = props?.ports ?? contextPorts
  const portsRef = useRef(ports)
  portsRef.current = ports

  const [step, setStep] = useState<WalletCheckStepId>('records')
  const [statuses, setStatuses] = useState<Partial<Record<WalletCheckStepId, WalletCheckStepStatus>>>({})
  const [running, setRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<{
    freedCoins: number
    recoveredPayments: number
    allOk: boolean
    allClear: boolean
  } | null>(null)

  const run = useCallback(async () => {
    setError(null)
    setSummary(null)
    setStep('records')
    setStatuses({})
    setRunning(true)
    try {
      const result = await runWalletCheck(
        portsRef.current,
        (id: WalletCheckStepId) => setStep(id),
        (id: WalletCheckStepId, status: WalletCheckStepStatus) =>
          setStatuses(prev => ({ ...prev, [id]: status }))
      )
      setSummary({
        freedCoins: result.freedCoins,
        recoveredPayments: result.recoveredPayments,
        allOk: result.allOk,
        allClear: result.allClear
      })
      if (result.allClear) haptics.success()
      else haptics.error()
    } catch {
      setError(t('wallet_check_failed'))
      haptics.error()
    } finally {
      setRunning(false)
    }
  }, [t])

  useEffect(() => {
    void run()
  }, [run])

  const stepIndex = Math.max(
    0,
    STEPS.findIndex(s => s.id === step)
  )
  const done = STEPS.filter(x => statuses[x.id] !== undefined).length
  const doneCopy =
    summary == null || !summary.allOk
      ? null
      : !summary.allClear
        ? // Ran end to end, but something is worth seeing: offline, no backup,
          // no phrase written down. Saying "everything looks good" over an
          // amber row would be the screen contradicting itself.
          t('wallet_check_attention')
        : summary.freedCoins === 0 && summary.recoveredPayments === 0
          ? t('wallet_check_ok')
          : t('wallet_check_summary', { freed: summary.freedCoins, recovered: summary.recoveredPayments })
  const couldntCheck = Boolean(summary && !summary.allOk)

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBack} accessibilityRole="button">
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.headerBack} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxxl }}
      >
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('check_wallet')}</Text>
        <View style={styles.progressBlock}>
          {/* Every step is listed from the first frame, so the list never
              reflows as it fills and a finished check stays on screen as its
              own evidence. */}
          {STEPS.map((s, i) => {
            const status = statuses[s.id]
            const active = running && status === undefined && i === stepIndex
            return (
              <View key={s.id} style={styles.checkRow}>
                <View style={styles.checkIcon}>
                  {active ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : status === 'ok' ? (
                    <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                  ) : status === 'attention' || status === 'error' ? (
                    <Ionicons name="alert-circle" size={22} color={colors.warning} />
                  ) : (
                    <Ionicons name="ellipse-outline" size={22} color={colors.textQuaternary} />
                  )}
                </View>
                <Text
                  style={[
                    styles.checkLabel,
                    { color: status === undefined && !active ? colors.textTertiary : colors.textPrimary }
                  ]}
                  accessibilityLabel={`${t(s.labelKey)}${status === 'ok' ? ' ✓' : ''}`}
                >
                  {t(s.labelKey)}
                </Text>
              </View>
            )
          })}
          {running && (
            <View style={[styles.track, { backgroundColor: colors.fillTertiary }]}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${(done / STEPS.length) * 100}%`,
                    backgroundColor: colors.accent
                  }
                ]}
              />
            </View>
          )}
        </View>
        {/* The verdict sits under the list it summarises, not above it: the
            checklist is the evidence, and this is what it adds up to. */}
        {!running && (doneCopy || couldntCheck || error) && (
          <View style={styles.resultBlock}>
            <Text style={[styles.done, styles.centered, { color: colors.textPrimary }]}>
              {couldntCheck ? t('wallet_check_couldnt') : error ? error : doneCopy}
            </Text>
            {couldntCheck && (
              <Text style={[styles.body, styles.centered, { color: colors.textSecondary }]}>
                {t('wallet_check_couldnt_body')}
              </Text>
            )}
            {(couldntCheck || error) && (
              // Outlined, because Done below is filled: two accent-filled
              // full-width buttons would read as equally weighted, and Done is
              // the one that ends the task.
              <TouchableOpacity
                onPress={() => void run()}
                style={[styles.retry, { borderColor: colors.separator }]}
                accessibilityRole="button"
              >
                <Text style={[styles.retryLabel, { color: colors.accent }]}>{t('retry')}</Text>
              </TouchableOpacity>
            )}
            {/* The way out, and the only thing on this screen the user still
                has to do — so it carries the accent and the full width rather
                than competing with Retry as an equal. */}
            <TouchableOpacity
              onPress={() => router.replace('/' as any)}
              style={[styles.doneButton, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
            >
              <Text style={[styles.retryLabel, { color: colors.textOnAccent }]}>{t('done')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBack: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  title: {
    ...typography.largeTitle,
    marginBottom: spacing.xl
  },
  progressBlock: {
    gap: spacing.sm
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm
  },
  checkIcon: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkLabel: {
    ...typography.body,
    flex: 1
  },
  track: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: spacing.sm
  },
  fill: {
    height: 4,
    borderRadius: 2
  },
  done: {
    ...typography.title3
  },
  body: {
    ...typography.body
  },
  resultBlock: {
    gap: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.xxl
  },
  centered: {
    textAlign: 'center'
  },
  doneButton: {
    alignSelf: 'stretch',
    minHeight: 50,
    paddingHorizontal: spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  retry: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  retryLabel: {
    ...typography.headline
  }
})
