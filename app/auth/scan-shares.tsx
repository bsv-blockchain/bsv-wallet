import React, { useCallback, useRef, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useTranslation } from 'react-i18next'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  useRecoveryDeps,
  haptics,
  collectShare,
  emptyShareCollection,
  secretFromShares,
  recoverWallet,
  type ShareCollection,
  type ShareCompatibilityIssue
} from '@bsv/expo-wallet-toolbox'
import { showAlert, Celebration, QRScanner, restorePrompts } from '@bsv/expo-wallet-toolbox/ui'

// Which translated string explains why a scanned share could not join the
// ones collected so far. The codes themselves come from
// core/recovery/shareParsing.ts's checkShareCompatibility.
const ISSUE_KEY: Record<ShareCompatibilityIssue, string> = {
  'threshold-mismatch': 'scan_shares_threshold_mismatch',
  'integrity-mismatch': 'scan_shares_integrity_mismatch',
  duplicate: 'scan_shares_duplicate'
}

export default function ScanSharesScreen() {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const { backupRestore } = useWallet()
  const deps = useRecoveryDeps()

  const [collection, setCollectionState] = useState<ShareCollection>(emptyShareCollection)
  const [recovering, setRecovering] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [celebrating, setCelebrating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `collection` mirrored in a ref so `handleBarCodeScanned` (a stable
  // useCallback firing off the camera's own frame loop) and `reset` always
  // see the latest value instead of whatever was captured at mount.
  const collectionRef = useRef<ShareCollection>(emptyShareCollection)
  const setCollection = useCallback((next: ShareCollection) => {
    collectionRef.current = next
    setCollectionState(next)
  }, [])

  const reset = useCallback(() => setCollection(emptyShareCollection), [setCollection])

  const fail = useCallback(
    (message: string) => {
      setError(message)
      haptics.error()
      setRecovered(false)
      reset()
    },
    [reset]
  )

  /**
   * Recombine the completed share set and hand it to the one retry policy —
   * `recoverWallet` (core/recovery/recoverWallet.ts) — which drives the
   * biometric-refused / restore-failed prompts itself (via `restorePrompts`,
   * ui/recoveryPrompts.ts) and never loops on a server failure without a
   * human choosing to retry. This function's only job left is translating
   * the outcome into what the user sees.
   */
  const handleRecovery = useCallback(
    async (shareStrings: string[]) => {
      setRecovering(true)
      try {
        let parsed: ReturnType<typeof secretFromShares>
        try {
          parsed = secretFromShares(shareStrings)
        } catch (err) {
          fail(err instanceof Error ? err.message : t('scan_shares_recovery_failed'))
          return
        }

        const outcome = await recoverWallet(deps, parsed.secret, { medium: 'shares', prompts: restorePrompts(t) })

        switch (outcome.kind) {
          case 'ok':
            // Legacy shares recombine to a raw primary key, not a phrase —
            // secretFromShares is the only place that still knows which
            // shape the shares started as, so it is told here, once.
            if (parsed.legacy) {
              await showAlert({
                title: t('scan_shares_legacy_title'),
                message: t('scan_shares_legacy_message'),
                buttons: [{ text: t('scan_shares_legacy_ack'), key: 'ok' }]
              })
            }
            setError(null)
            setRecovered(true)
            setCelebrating(true)
            break
          case 'cancelled':
            reset()
            break
          case 'retry-later':
            fail(t('restore_backup_failed_title'))
            break
          case 'failed':
            console.error('[ScanShares] Recovery failed:', outcome.error)
            fail(outcome.error)
            break
        }
      } finally {
        setRecovering(false)
      }
    },
    [deps, fail, reset, t]
  )

  const handleBarCodeScanned = useCallback(
    (raw: string) => {
      // Ignore while a previous complete set is being recovered, or once one
      // already has been — the scanner keeps firing frames until unmounted.
      if (recovered || recovering) return

      const { collection: next, event } = collectShare(collectionRef.current, raw)
      setCollection(next)

      switch (event.kind) {
        case 'ignored':
          break
        case 'invalid':
          setError(t('scan_shares_invalid_format'))
          break
        case 'incompatible':
          setError(t(ISSUE_KEY[event.issue]))
          haptics.error()
          break
        case 'added':
          setError(null)
          // Haptic for intermediate shares only — Celebration fires
          // haptics.success() on completion.
          haptics.success()
          break
        case 'complete':
          setError(null)
          void handleRecovery(event.shareStrings)
          break
      }
    },
    [recovered, recovering, setCollection, handleRecovery, t]
  )

  // ── Recovering state ───────────────────────────────────────────────────
  if (recovering) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.recoveringText, { color: colors.textPrimary }]}>
          {backupRestore.phase === 'checking' || (backupRestore.phase === 'restoring' && backupRestore.total === 0)
            ? t('restore_backup_checking')
            : backupRestore.phase === 'restoring'
              ? t('restore_backup_progress', { chunks: backupRestore.chunks, total: backupRestore.total })
              : t('scan_shares_recovering')}
        </Text>
      </View>
    )
  }

  // ── Celebration overlay (backup verified) ─────────────────────────────
  if (celebrating) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <Celebration
          onDone={() => {
            // dismissAll() targets a modally-presented navigator being dismissed
            // back to whatever pushed it; this screen sits in the same flat,
            // non-modal Stack as the Wallet (app/_layout.tsx), so React
            // Navigation has no modal to dismiss and silently no-ops, stranding
            // the user here. dismissTo('/') pops the stack back to the existing
            // root `index` screen instead — see app/auth/mnemonic.tsx.
            router.dismissTo('/')
          }}
        />
      </View>
    )
  }

  // ── Scanner ────────────────────────────────────────────────────────────
  const sharesNeeded = collection.threshold ?? 2
  const scanned = collection.shares.length
  const sharesRemaining = sharesNeeded - scanned

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <QRScanner
        multiScan
        onScan={handleBarCodeScanned}
        onClose={() => router.back()}
        hintText={
          scanned === 0
            ? t('scan_shares_scan_first')
            : t('scan_shares_progress', {
                scanned,
                needed: sharesNeeded
              })
        }
        renderBottom={() => (
          <>
            {/* Progress indicators */}
            <View style={styles.progressRow}>
              {Array.from({ length: sharesNeeded }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.progressDot,
                    {
                      backgroundColor: i < scanned ? '#34C759' : 'rgba(255,255,255,0.3)'
                    }
                  ]}
                />
              ))}
            </View>

            <Text style={styles.statusHint}>
              {sharesRemaining > 0 ? t('scan_shares_remaining', { count: sharesRemaining }) : t('scan_shares_complete')}
            </Text>

            {error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={18} color="#FF453A" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000'
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxxl
  },

  // ── Recovering ─────────────────────────────────────────────────────────
  recoveringText: {
    ...typography.headline,
    marginTop: spacing.lg
  },

  // ── Progress & status (rendered via QRScanner's renderBottom) ──────────
  progressRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: spacing.lg,
    marginTop: spacing.md
  },
  progressDot: {
    width: 12,
    height: 12,
    borderRadius: 6
  },
  statusHint: {
    ...typography.subhead,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center'
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.lg,
    gap: spacing.sm
  },
  errorText: {
    ...typography.footnote,
    color: '#FF453A',
    flex: 1
  }
})
