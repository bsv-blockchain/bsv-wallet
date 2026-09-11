/**
 * Vault deposit / withdraw — full screen, not a drawer. Spec §4.1 / §4.2.
 *
 * Direction comes from the `direction` search param ('deposit' | 'withdraw').
 *
 * Deposit needs no hardware: the wallet builds an R1C output committed to every
 * enrolled key and broadcasts it (depositToVault). The screen shows the floor
 * and the fee inline, confirms the FIRST deposit into an empty vault, and
 * refuses while the encrypted backup is off — every deposit's salt lives only
 * in this wallet's database (D13).
 *
 * Withdraw asks which key will be tapped BEFORE anything runs (the NFC sheet is
 * modal), confirms when the remainder would fall under the vault floor, and
 * reports what did NOT move afterwards as alerts rather than toasts: outputs
 * the chosen key cannot open, and outputs left behind by the input cap.
 *
 * Lazy wallet creation is the Vault screen's job (its Deposit button); with no
 * built wallet the CTA here is simply inert.
 */
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, TouchableOpacity } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AmountInput, SEND_MAX_VALUE } from '../components/wallet/AmountInput'
import PressableScale from '../components/ui/PressableScale'
import AmountDisplay from '../components/wallet/AmountDisplay'
import { showToast } from '../components/ui/Toast'
import { showAlert } from '../components/ui/AlertCard'
import { KeyChooser, vaultKeyLabel } from '../components/vault/KeyChooser'
import { vaultErrorCopy, type VaultErrorParams } from '../components/vault/vaultErrorCopy'
import { useVaultBalance } from '../hooks/useVaultBalance'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  ExchangeRateContext,
  formatAmount,
  vaultStore,
  depositToVault,
  withdrawFromVault,
  VAULT_DEPOSIT_MIN,
  VAULT_MAX_KEYS,
  estimateRelockFee,
  R1C_LOCK_LEN,
  isVaultEnabled,
  isBackupPushEnabled,
  type VaultWallet,
  type VaultMeta,
  type VaultSpendResult,
  getOnline,
  VaultError,
  haptics,
  i18n
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

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
 * barrel, even one that never navigates. `useLocalSearchParams` is a hook, but
 * calling it via `loadExpoRouter().useLocalSearchParams()` is the exact same
 * function reference on every render, which is what the rules of hooks
 * actually require (a stable, unconditional call per render).
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

/**
 * Optional structured details services attach to a VaultError per the
 * DECISION: `key-cannot-cover` → `{ reachable, total }` (what the chosen key
 * can reach and the vault's total); `serial-mismatch` → `{ tapped, chosen }`
 * (both serials, so the sheet can say "That's X — you chose Y"). Read
 * structurally so this file depends on no service type; when absent the copy
 * degrades per vaultErrorCopy.
 */
function readErrorDetails(e: unknown): { reachable?: number; total?: number; tapped?: string; chosen?: string } {
  const details = (e as { details?: unknown } | null)?.details
  if (!details || typeof details !== 'object') return {}
  const d = details as Record<string, unknown>
  return {
    reachable: typeof d.reachable === 'number' ? d.reachable : undefined,
    total: typeof d.total === 'number' ? d.total : undefined,
    tapped: typeof d.tapped === 'string' ? d.tapped : undefined,
    chosen: typeof d.chosen === 'string' ? d.chosen : undefined
  }
}

export function VaultTransferScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const Ionicons = loadIonicons()
  const { direction } = useLocalSearchParams<{ direction?: string }>()
  const { managers, adminOriginator, storage, settings } = useWallet()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const { balance, refresh } = useVaultBalance()
  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [amount, setAmount] = useState('')
  const [chosenSerial, setChosenSerial] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards run()'s whole lifetime, not just the `busy` render state: without
  // it a second tap that lands before the first `await` (e.g. the
  // isBackupPushEnabled read below, which precedes setBusy(true)) re-enters
  // run() while canRun is still true and busy is still false.
  const runningRef = useRef(false)

  const isDeposit = direction !== 'withdraw'
  const isMax = amount === SEND_MAX_VALUE
  const released = isVaultEnabled()
  const pm = managers?.permissionsManager
  const currency = settings?.currency || 'BSV'
  // The same formatter AmountDisplay wraps; a component cannot be interpolated
  // into i18n.t, so the alerts and the floor line take the string form.
  const fmt = useCallback(
    (sats: number) => formatAmount(sats, currency, satoshisPerUSD, { usdToFiat }),
    [currency, satoshisPerUSD, usdToFiat]
  )

  useEffect(() => {
    let alive = true
    void vaultStore.getMeta().then(m => {
      if (!alive) return
      setMeta(m)
      if (!m || m.keys.length === 0) return
      // Default to the key used last; a removed serial falls back to the first.
      const lastUsed = m.keys.find(k => k.serial === m.lastUsedSerial)
      setChosenSerial((lastUsed ?? m.keys[0]).serial)
    })
    return () => {
      alive = false
    }
  }, [])

  const keys = meta?.keys ?? []
  const chosen = keys.find(k => k.serial === chosenSerial)
  const allNames = keys.map(vaultKeyLabel).join(', ')

  // The lock's own size at the toolbox rate, plus its 10 % margin. The funding
  // input adds ~15 sat on top; "about" is the right word for the copy.
  const depositFee = estimateRelockFee(0, R1C_LOCK_LEN(Math.min(VAULT_MAX_KEYS, Math.max(1, keys.length))))

  const sats = parseInt(amount, 10)
  const validAmount = isDeposit
    ? Number.isFinite(sats) && sats >= VAULT_DEPOSIT_MIN
    : isMax || (Number.isFinite(sats) && sats > 0)
  const canRun = validAmount && !busy && !!pm && balance !== null && (isDeposit ? released : chosen !== undefined)

  /** `nickname · …tail4` for each referenced key; a key no longer in meta shows its pubkey tail. */
  const namesFor = useCallback(
    (refs: { serial?: string; pubkey: string }[]): string =>
      refs
        .map(r => {
          const rec = keys.find(k => (r.serial !== undefined && k.serial === r.serial) || k.pubkey === r.pubkey)
          return rec ? vaultKeyLabel(rec) : `…${r.pubkey.slice(-4)}`
        })
        .join(', '),
    [keys]
  )

  const backupOffAlert = useCallback(async () => {
    haptics.error()
    const choice = await showAlert({
      title: t('vault_backup_off_title'),
      message: t('vault_backup_off_body'),
      buttons: [
        { text: t('vault_backup_off_cta'), key: 'settings' },
        { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
      ]
    })
    // push (not replace) keeps this screen on the stack so the user can come
    // back and retry the deposit after switching backup on.
    if (choice === 'settings') router.push('/wallet-config')
  }, [router])

  /** Everything vaultErrorCopy can name for this screen's errors. */
  const errorParams = useCallback(
    (e: unknown): VaultErrorParams => {
      const details = readErrorDetails(e)
      // The DECISION: serial-mismatch carries { tapped, chosen } in
      // VaultError.details, not in message — details.tapped is only ever an
      // enrolled serial (or absent), so a lookup miss degrades to undefined
      // exactly like every other missing param. The chosen key is read from
      // details first (the serial the service actually ran with) and falls
      // back to the in-app choice when a service attaches none.
      const tapped = details.tapped ? keys.find(k => k.serial === details.tapped) : undefined
      const chosenRec = (details.chosen ? keys.find(k => k.serial === details.chosen) : undefined) ?? chosen
      const others = keys.filter(k => k.serial !== chosenRec?.serial)
      return {
        nickname: chosenRec ? vaultKeyLabel(chosenRec) : undefined,
        chosenName: chosenRec ? vaultKeyLabel(chosenRec) : undefined,
        tappedName: tapped ? vaultKeyLabel(tapped) : undefined,
        otherNames: others.length ? others.map(vaultKeyLabel).join(', ') : undefined,
        names: allNames || undefined,
        reachable: details.reachable !== undefined ? fmt(details.reachable) : undefined,
        total: details.total !== undefined ? fmt(details.total) : undefined,
        count: e instanceof VaultError ? e.retriesLeft : undefined
      }
    },
    [keys, chosen, allNames, fmt]
  )

  const run = useCallback(async () => {
    if (!pm || !canRun) return
    // Whole-lifetime re-entrancy guard (not just `busy`): a second tap that
    // lands before this function's first `await` still sees canRun true and
    // busy false, so `busy` alone cannot stop it.
    if (runningRef.current) return
    runningRef.current = true
    const w = pm as unknown as VaultWallet
    const total = balance ?? 0
    setError(null)
    try {
      if (isDeposit) {
        // D13 first: the salt of this deposit will live only in this wallet's
        // database, so an unbacked wallet must not create it.
        if (!(await isBackupPushEnabled())) {
          await backupOffAlert()
          return
        }
        // The first deposit is the moment the recovery model becomes real
        // money: say it once, with the names of the keys that hold it.
        if (total === 0) {
          const choice = await showAlert({
            title: t('vault_first_deposit_title'),
            message: t('vault_first_deposit_body', { amount: fmt(sats), count: keys.length, names: allNames }),
            buttons: [
              { text: t('vault_deposit_cta'), key: 'deposit' },
              { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
            ]
          })
          if (choice !== 'deposit') return
        }
        setBusy(true)
        await depositToVault(w, adminOriginator, sats, { isOnline: getOnline })
        // The success toast carries the success haptic (Toast.tsx).
        showToast(t('vault_deposit_done'), { type: 'success' })
      } else {
        if (!chosen) return
        let withdrawAll = isMax
        // Remainder rule (spec §4.2 step 4): a leftover under the floor cannot
        // be re-vaulted, so the whole vault would move. Say so before running.
        if (!withdrawAll && total - sats > 0 && total - sats < VAULT_DEPOSIT_MIN) {
          const choice = await showAlert({
            title: t('vault_remainder_title'),
            message: t('vault_remainder_body', { amount: fmt(sats), remainder: fmt(total - sats) }),
            buttons: [
              { text: t('vault_remainder_all'), key: 'all' },
              { text: t('vault_remainder_change'), key: 'change', style: 'cancel' }
            ]
          })
          if (choice !== 'all') return
          withdrawAll = true
        }
        setBusy(true)
        const result: VaultSpendResult = await withdrawFromVault(
          w,
          adminOriginator,
          withdrawAll ? 'all' : sats,
          // Becomes the NFC sheet's text for every tap of this withdrawal.
          t('vault_withdraw_reason', { amount: withdrawAll ? total : sats }),
          chosen.serial,
          {
            // Lets the reservation heal find the reserving transaction with one
            // indexed query instead of paging every action in the wallet.
            findSpendingReferences: storage ? outpoints => storage.findSpendingReferences(outpoints) : undefined,
            isOnline: getOnline
          }
        )
        // Alerts, not toasts, for what did NOT move (spec §4.2 step 8): the
        // user has to act on both, and a toast can be missed.
        const moved = withdrawAll ? Math.max(0, total - result.unreachable.satoshis) : sats
        let reported = false
        if (result.unreachable.count > 0) {
          reported = true
          await showAlert({
            title: t('vault_unreachable_title'),
            message: t('vault_unreachable_body', {
              moved: fmt(moved),
              count: result.unreachable.count,
              amount: fmt(result.unreachable.satoshis),
              names: namesFor(result.unreachable.keys)
            }),
            buttons: [{ text: t('vault_ok'), key: 'ok' }]
          })
        }
        if (result.cappedInputs > 0) {
          reported = true
          await showAlert({
            title: t('vault_withdraw_done'),
            message: t('vault_withdraw_partial', { count: result.cappedInputs }),
            buttons: [{ text: t('vault_ok'), key: 'ok' }]
          })
        }
        if (!reported) showToast(t('vault_withdraw_done'), { type: 'success' })
      }
      setAmount('')
      refresh()
      router.back()
    } catch (e) {
      console.error('[vault] transfer failed:', e instanceof Error ? e.message : e, e)
      const code = e instanceof VaultError ? e.code : undefined
      if (code === 'backup-off') {
        // The service's own D13 refusal lands on the same alert as the
        // pre-check, with the same way out.
        await backupOffAlert()
        return
      }
      haptics.error()
      setError(vaultErrorCopy(code, errorParams(e)))
    } finally {
      setBusy(false)
      runningRef.current = false
    }
  }, [
    pm,
    canRun,
    balance,
    isDeposit,
    isMax,
    sats,
    keys.length,
    allNames,
    chosen,
    adminOriginator,
    storage,
    fmt,
    namesFor,
    backupOffAlert,
    errorParams,
    refresh,
    router
  ])

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>
          {isDeposit ? t('vault_deposit_title') : t('vault_withdraw_title')}
        </Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.balanceBlock}>
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>{t('vault_balance_label')}</Text>
          <Text style={[styles.balance, { color: colors.textPrimary }]}>
            <AmountDisplay>{balance ?? 0}</AmountDisplay>
          </Text>
        </View>

        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {isDeposit ? t('vault_deposit_sub') : t('vault_withdraw_sub')}
        </Text>

        {!isDeposit && keys.length > 0 && (
          <View style={styles.chooser}>
            <Text style={[styles.chooserLabel, { color: colors.textPrimary }]}>{t('vault_choose_key')}</Text>
            {/* Frozen while a ceremony runs: the highlighted key must stay the
                one the NFC sheet is asking for. */}
            <KeyChooser keys={keys} selected={chosenSerial} onSelect={busy ? () => {} : setChosenSerial} />
          </View>
        )}

        <AmountInput value={amount} onChangeText={setAmount} showMax={!isDeposit} maxLabelKey="entire_vault_balance" />

        {isDeposit && (
          <Text style={[styles.floor, { color: colors.textSecondary }]}>
            {t('vault_floor_line', {
              floorDisplay: fmt(VAULT_DEPOSIT_MIN),
              floorSats: VAULT_DEPOSIT_MIN.toLocaleString('en-US'),
              feeDisplay: fmt(depositFee)
            })}
          </Text>
        )}

        {isDeposit && !released && (
          <Text style={[styles.floor, { color: colors.textSecondary }]}>{t('vault_not_released_body')}</Text>
        )}

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}

        <PressableScale
          haptic="confirm"
          onPress={canRun ? () => void run() : undefined}
          accessibilityState={{ disabled: !canRun }}
          style={[
            styles.primary,
            { backgroundColor: canRun ? colors.accent : colors.backgroundElevated, opacity: busy ? 0.6 : 1 }
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text style={[styles.primaryLabel, { color: canRun ? colors.textOnAccent : colors.textTertiary }]}>
              {isDeposit ? t('vault_deposit_cta') : t('vault_withdraw_cta')}
            </Text>
          )}
        </PressableScale>
      </ScrollView>
    </View>
  )
}

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
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline },
  body: { padding: spacing.xl, gap: spacing.lg },
  balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.md },
  balanceLabel: { ...typography.footnote, textTransform: 'uppercase' },
  balance: { ...typography.title1, fontVariant: ['tabular-nums'] },
  sub: { ...typography.subhead, textAlign: 'center' },
  chooser: { gap: spacing.sm },
  chooserLabel: { ...typography.headline },
  floor: { ...typography.footnote, textAlign: 'center' },
  err: { ...typography.footnote, textAlign: 'center' },
  primary: { borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline }
})
