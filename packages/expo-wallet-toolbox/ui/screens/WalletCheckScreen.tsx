/**
 * Check Wallet — a pushed, determinate repair destination.
 *
 * Four labeled steps, a bar plus "N of 4", never an unlabeled spinner.
 * Back always works. Done is quiet copy and a success haptic, not Celebration.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { PeerPayClient } from '@bsv/message-box-client'
import { sdk } from '@bsv/wallet-toolbox-mobile'
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
import { runWalletCheck, type WalletCheckPorts, type WalletCheckStepId } from '../../core/walletRepair/runWalletCheck'
import { userFacingPayError } from '../../core/pay/userError'
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
  { id: 'records', labelKey: 'wallet_check_step_records' },
  { id: 'coins', labelKey: 'wallet_check_step_coins' },
  { id: 'proofs', labelKey: 'wallet_check_step_proofs' },
  { id: 'missed_payments', labelKey: 'wallet_check_step_missed' }
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
    takeLastMissHeight
  } = useWallet()
  const wallet = managers?.permissionsManager

  return useMemo<WalletCheckPorts>(
    () => ({
      reviewSpendable: async () => {
        let released = 0
        let recovered = 0
        if (wallet) {
          try {
            const listed = await wallet.listOutputs(
              { basket: sdk.specOpInvalidChange, tags: ['all', 'release'] },
              adminOriginator
            )
            released += listed.outputs?.length ?? 0
          } catch {
            // Spec-op is best-effort; the WoC pass below still runs.
          }
        }
        try {
          const log = await checkUtxoSpendability()
          // Stuck-reservation releases are counted by releaseStuck, not here.
          released += parseCount(log, /(\d+) stale output\(s\) marked unspendable/)
          recovered += parseCount(log, /(\d+) spending tx\(s\) internalized/)
        } catch {
          // Port stays structured even when WoC is unreachable.
        }
        return { released, recovered }
      },
      checkProofs: async () => {
        try {
          await runMonitorTask('CheckForProofs')
        } catch {
          // Proof repair is optional for the Done copy.
        }
        return { repaired: 0 }
      },
      reviewStatus: async () => {
        if (!storage?.reviewStatus) return { failedTxs: 0, restoredInputs: 0 }
        try {
          const { log } = await storage.reviewStatus({ agedLimit: new Date() })
          return {
            failedTxs: countNeedle(log, "updated to status of 'failed'"),
            restoredInputs: countNeedle(log, 'updated to spendable because spentBy is failed')
          }
        } catch {
          return { failedTxs: 0, restoredInputs: 0 }
        }
      },
      releaseStuck: async () => {
        try {
          const log = await releaseStuckReservations()
          return { released: parseCount(log, /Released (\d+) stuck/) }
        } catch {
          return { released: 0 }
        }
      },
      creditInbox: async () => {
        if (!wallet) return { accepted: 0 }
        try {
          const saved = await AsyncStorage.getItem(MESSAGE_BOX_URL_KEY)
          const messageBoxUrl = !saved || saved === LEGACY_MESSAGE_BOX_URL ? DEFAULT_MESSAGE_BOX_URL : saved
          if (!messageBoxUrl || messageBoxUrl === NO_MESSAGE_BOX) return { accepted: 0 }
          const client = new PeerPayClient({
            messageBoxHost: messageBoxUrl,
            walletClient: wallet as never,
            originator: adminOriginator
          })
          const repairBeef = makeBeefRepair({ woc: wocConfigFor(selectedNetwork), online: getOnline })
          const classify = await makeCreditClassifier({ getOnline, takeLastMissHeight })
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
        } catch {
          return { accepted: 0 }
        }
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
      takeLastMissHeight,
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
  const [running, setRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<{ freedCoins: number; recoveredPayments: number } | null>(null)

  const run = useCallback(async () => {
    setError(null)
    setSummary(null)
    setStep('records')
    setRunning(true)
    try {
      const result = await runWalletCheck(portsRef.current, (id: WalletCheckStepId) => setStep(id))
      setSummary({ freedCoins: result.freedCoins, recoveredPayments: result.recoveredPayments })
      haptics.success()
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
  const current = stepIndex + 1
  const stepLabel = t(STEPS[stepIndex]?.labelKey ?? 'wallet_check_step_records')
  const doneCopy =
    summary == null
      ? null
      : summary.freedCoins === 0 && summary.recoveredPayments === 0
        ? t('wallet_check_ok')
        : t('wallet_check_summary', { freed: summary.freedCoins, recovered: summary.recoveredPayments })

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
        {running && (
          <View style={styles.progressBlock}>
            <Text style={[styles.progressCount, { color: colors.textSecondary }]}>
              {t('wallet_check_progress', { current, total: STEPS.length })}
            </Text>
            <Text style={[styles.stepLabel, { color: colors.textPrimary }]}>{stepLabel}</Text>
            <View style={[styles.track, { backgroundColor: colors.fillTertiary }]}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${(current / STEPS.length) * 100}%`,
                    backgroundColor: colors.accent
                  }
                ]}
              />
            </View>
          </View>
        )}
        {!running && doneCopy && <Text style={[styles.done, { color: colors.textPrimary }]}>{doneCopy}</Text>}
        {!running && error && (
          <View style={styles.errorBlock}>
            <Text style={[styles.done, { color: colors.textPrimary }]}>{error}</Text>
            <TouchableOpacity
              onPress={() => void run()}
              style={[styles.retry, { backgroundColor: colors.accent }]}
              accessibilityRole="button"
            >
              <Text style={[styles.retryLabel, { color: colors.textOnAccent }]}>{t('retry')}</Text>
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
  progressCount: {
    ...typography.subhead
  },
  stepLabel: {
    ...typography.title3
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
  errorBlock: {
    gap: spacing.lg
  },
  retry: {
    alignSelf: 'flex-start',
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  retryLabel: {
    ...typography.headline
  }
})
