/**
 * The Vault screen — spec §3.4 / §5.4.
 *
 * Four states:
 *   • vaultEnabled off, not enrolled   → hero, "Not available yet" notice, inert CTA
 *   • driver unsupported, not enrolled → hero, "Needs a YubiKey" notice, inert CTA
 *   • not enrolled                     → hero; "Set up vault" opens the EnrollWizard
 *   • enrolled                         → balance, deposit / withdraw, the key list with
 *                                        coverage badges, add / rename / remove / re-lock,
 *                                        export wallet data, disable
 *
 * An ENROLLED vault with the flag off keeps the enrolled view — withdrawals of
 * pre-existing outputs are never gated (spec §5.5) — with deposit, add-key and
 * re-lock inert and the same "Not available yet" notice under the actions.
 *
 * Enrolment needs no built wallet. The Deposit button (not the Vault button)
 * runs the same lazy wallet-creation path as WalletHomeScreen; its
 * ensureWalletExists (ui/screens/WalletHomeScreen.tsx:268–298) is repeated
 * here rather than shared because this is the only other place that needs it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GroupedSection } from '../components/ui/GroupedList'
import { ListRow } from '../components/ui/ListRow'
import PressableScale from '../components/ui/PressableScale'
import Sheet from '../components/ui/Sheet'
import AmountDisplay from '../components/wallet/AmountDisplay'
import { BiometricAdvisoryModal } from '../components/wallet/BiometricAdvisoryModal'
import { showAlert } from '../components/ui/AlertCard'
import { showToast } from '../components/ui/Toast'
import { EnrollWizard } from '../components/vault/EnrollWizard'
import { KeyChooser, vaultKeyLabel } from '../components/vault/KeyChooser'
import { VaultBackdrop } from '../components/vault/VaultBackdrop'
import { vaultErrorCopy } from '../components/vault/vaultErrorCopy'
import { useVaultBalance } from '../hooks/useVaultBalance'
import { useVaultCoverage } from '../hooks/useVaultCoverage'
import { useExportWalletData } from '../hooks/useExportWalletData'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  useLocalStorage,
  reclaimStagingOutputs,
  relockVault,
  orphanedIfRemoved,
  estimateRelockFee,
  R1C_LOCK_LEN,
  type VaultWallet,
  type VaultSpendResult,
  vaultStore,
  type VaultMeta,
  type VaultKeyRecord,
  VAULT_MIN_KEYS,
  VAULT_MAX_KEYS,
  getVaultDriver,
  isVaultEnabled,
  disableVault,
  getOnline,
  generateMnemonicWallet,
  backupAttestation,
  VaultError,
  haptics,
  i18n
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
 * barrel, even one that never navigates. Same pattern as
 * core/context/WalletContext.tsx's and WalletHomeScreen.tsx's lazy
 * expo-router load.
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
 * Upper bound on re-lock passes in one go. Each pass moves at least one and at
 * most VAULT_MAX_INPUTS (32) outputs, and listOutputs is capped at 1000, so
 * 32 passes covers the largest vault the transfer layer can see.
 */
const MAX_RELOCK_PASSES = 32

/** Swallows the sheet's dismiss while a re-lock is in flight. */
const noop = (): void => {}

interface RelockRequest {
  /** The reason line the ceremony sheet shows and relockVault records. */
  reason: string
  /** A serial to leave out of the chooser — the key just added, which cannot open the old outputs. */
  exclude?: string
}

export function VaultScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router } = loadExpoRouter()
  const Ionicons = loadIonicons()
  const { balance, loading, refresh } = useVaultBalance()
  const { coverage, refresh: refreshCoverage } = useVaultCoverage()
  const { exportData, exporting } = useExportWalletData()
  const { managers, adminOriginator, storage, walletBuilding, buildWalletFromMnemonic } = useWallet()
  const { createMnemonic, hasStoredIdentity, secretsReady } = useLocalStorage()

  /** undefined = loading; null = not enrolled. */
  const [meta, setMeta] = useState<VaultMeta | null | undefined>(undefined)
  const metaRef = useRef<VaultMeta | null>(null)
  const [wizard, setWizard] = useState<'enroll' | 'add-key' | null>(null)
  const serialsBeforeAdd = useRef<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<VaultKeyRecord | null>(null)
  const [renameText, setRenameText] = useState('')
  const [relock, setRelock] = useState<RelockRequest | null>(null)
  const [relockSerial, setRelockSerial] = useState<string | undefined>(undefined)
  const [relocking, setRelocking] = useState(false)
  const [relockError, setRelockError] = useState<string | null>(null)
  const [showBiometricAdvisory, setShowBiometricAdvisory] = useState(false)
  const [creatingWallet, setCreatingWallet] = useState(false)

  const enabled = isVaultEnabled()
  const supported = getVaultDriver()?.isSupported() ?? false
  const enrolled = meta != null

  const reload = useCallback(async (): Promise<VaultMeta | null> => {
    const m = await vaultStore.getMeta()
    metaRef.current = m
    setMeta(m)
    return m
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Recover money the retired two-transaction deposit stranded (tx1 landed,
  // tx2 failed). Stranded coins are invisible to BOTH balances — the main
  // balance counts only the default basket, the vault balance only the vault
  // basket — so this cannot wait for the user to notice anything. One attempt
  // per screen visit; a wallet with nothing stranded returns without touching
  // anything. No ceremony: staging keys are ordinary wallet-derived keys.
  const pm = managers?.permissionsManager
  useEffect(() => {
    if (!enrolled || !pm) return
    let stale = false
    reclaimStagingOutputs(pm as unknown as VaultWallet, adminOriginator, {
      releaseStrandedStaging: storage ? () => storage.releaseVaultStagingStrandedByInvalidTx() : undefined,
      findSpendingReferences: storage ? outpoints => storage.findSpendingReferences(outpoints) : undefined
    })
      .then(r => {
        if (stale || r.reclaimed === 0) return
        console.log(`[vault] reclaimed ${r.reclaimed} staging output(s), ${r.satoshis} sats · txid=${r.txid}`)
        showToast(t('vault_reclaim_done'), { type: 'success' })
      })
      .catch(e => console.log('[vault] staging reclaim failed:', (e as Error)?.message))
    return () => {
      stale = true
    }
  }, [enrolled, pm, adminOriginator, storage])

  // ── helpers ─────────────────────────────────────────────────────────
  /** `nickname · …tail4` for each referenced key; a key no longer in meta shows its pubkey tail. */
  const namesFor = useCallback(
    (refs: { serial?: string; pubkey: string }[]): string =>
      refs
        .map(r => {
          const rec = metaRef.current?.keys.find(k => (r.serial !== undefined && k.serial === r.serial) || k.pubkey === r.pubkey)
          return rec ? vaultKeyLabel(rec) : `…${r.pubkey.slice(-4)}`
        })
        .join(', '),
    []
  )

  const transferOpts = useCallback(
    () => ({
      // Lets the reservation heal find the reserving transaction with one
      // indexed query instead of paging every action in the wallet.
      findSpendingReferences: storage ? (outpoints: string[]) => storage.findSpendingReferences(outpoints) : undefined,
      isOnline: getOnline
    }),
    [storage]
  )

  // ── re-lock ─────────────────────────────────────────────────────────
  const openRelock = useCallback((request: RelockRequest) => {
    const m = metaRef.current
    if (!m) return
    const candidates = request.exclude ? m.keys.filter(k => k.serial !== request.exclude) : m.keys
    const lastUsed = candidates.find(k => k.serial === m.lastUsedSerial)
    setRelockSerial((lastUsed ?? candidates[0])?.serial)
    setRelockError(null)
    setRelock(request)
  }, [])

  const closeRelock = useCallback(() => {
    setRelock(null)
    setRelockError(null)
  }, [])

  const runRelock = useCallback(async () => {
    if (!relock || !relockSerial || relocking) return
    if (!pm) {
      // The manage row is reachable with no built wallet (enrolment needs
      // none). Nothing can be listed or signed, so say so in the sheet rather
      // than swallow the tap.
      setRelockError(vaultErrorCopy(undefined))
      return
    }
    setRelocking(true)
    setRelockError(null)
    try {
      const w = pm as unknown as VaultWallet
      let result: VaultSpendResult
      let passes = 0
      // One pass per tap while the cap left outputs behind (spec §4.3). The
      // ceremony sheet runs each tap; this loop only re-invokes the spend.
      do {
        result = await relockVault(w, adminOriginator, relock.reason, relockSerial, transferOpts())
        passes += 1
        if (result.cappedInputs > 0) showToast(t('vault_relock_capped', { count: result.cappedInputs }), { type: 'info' })
      } while (result.cappedInputs > 0 && passes < MAX_RELOCK_PASSES)
      closeRelock()
      refresh()
      refreshCoverage()
      if (result.unreachable.count > 0) {
        // Outputs this key is NOT committed to: another key has to finish
        // the job (whatever the cap left behind, this key cannot open these).
        await showAlert({
          title: t('vault_relock_row'),
          message: t('vault_relock_unreachable', {
            count: result.unreachable.count,
            names: namesFor(result.unreachable.keys)
          }),
          buttons: [{ text: t('vault_ok'), key: 'ok' }]
        })
      } else if (result.cappedInputs === 0) {
        // Not when the pass bound tripped with outputs still behind the cap:
        // the capped toast just asked for another pass, and "done" would
        // contradict it.
        showToast(t('vault_relock_done'), { type: 'success' })
      }
    } catch (e) {
      console.error('[vault] re-lock failed:', e instanceof Error ? e.message : e, e)
      haptics.error()
      setRelockError(
        vaultErrorCopy(e instanceof VaultError ? e.code : undefined, {
          names: metaRef.current?.keys.map(vaultKeyLabel).join(', ') || undefined
        })
      )
    } finally {
      setRelocking(false)
    }
  }, [pm, relock, relockSerial, relocking, adminOriginator, transferOpts, closeRelock, refresh, refreshCoverage, namesFor])

  // ── wizard hand-offs ────────────────────────────────────────────────
  /**
   * Every way out of the wizard — done or cancel — comes through here. The
   * wizard persists keys as it goes, so meta may have changed however it
   * closed; a cancel that skipped the reload would leave a stale
   * not-enrolled hero over a persisted key list, or an add-key list missing
   * the new key. Returns the fresh meta so onKeyAdded can diff it.
   */
  const closeWizard = useCallback(async (): Promise<VaultMeta | null> => {
    setWizard(null)
    const m = await reload()
    refreshCoverage()
    return m
  }, [reload, refreshCoverage])

  const onEnrolled = useCallback(async () => {
    await closeWizard()
    refresh()
  }, [closeWizard, refresh])

  const openAddKey = useCallback(() => {
    serialsBeforeAdd.current = new Set(metaRef.current?.keys.map(k => k.serial) ?? [])
    setWizard('add-key')
  }, [])

  const onKeyAdded = useCallback(async () => {
    const m = await closeWizard()
    if (!m) return
    const before = serialsBeforeAdd.current
    const added = m.keys.filter(k => !before.has(k.serial))
    const others = m.keys.filter(k => before.has(k.serial))
    // The new key can open deposits made from now on; a re-lock makes it open
    // everything. Pointless on an empty vault, so only offered when it holds
    // something — the wizard's done step already said so either way.
    if (added.length > 0 && (balance ?? 0) > 0) {
      openRelock({
        reason: t('vault_relock_reason', { names: others.map(vaultKeyLabel).join(', ') }),
        exclude: added[0].serial
      })
    }
  }, [closeWizard, balance, openRelock])

  // ── rename / remove ─────────────────────────────────────────────────
  const saveRename = useCallback(async () => {
    if (!renaming) return
    const next = renameText.trim()
    if (next && next !== renaming.nickname) {
      try {
        await vaultStore.renameKey(renaming.serial, next)
        await reload()
      } catch (e) {
        haptics.error()
        showToast(vaultErrorCopy(e instanceof VaultError ? e.code : undefined), { type: 'error' })
      }
    }
    setRenaming(null)
  }, [renaming, renameText, reload])

  const removeKey = useCallback(
    async (rec: VaultKeyRecord) => {
      const m = metaRef.current
      if (!m) return
      const title = t('vault_remove_title', { nickname: rec.nickname })
      if (m.keys.length <= VAULT_MIN_KEYS) {
        await showAlert({ title, message: vaultErrorCopy('last-keys'), buttons: [{ text: t('vault_ok'), key: 'ok' }] })
        return
      }
      // Every output must stay committed to at least one remaining key
      // (spec §3.4) — checked exactly, against each output's real committed
      // key set, not approximated from the coverage record. Fail closed: with
      // no built wallet (fresh install, or stored but not yet built) the
      // outputs cannot be read, and an unread vault may hold some, so the
      // check is refused rather than skipped.
      const ok = [{ text: t('vault_ok'), key: 'ok' }]
      if (!pm) {
        await showAlert({ title, message: vaultErrorCopy(undefined), buttons: ok })
        return
      }
      let orphans: number
      try {
        orphans = await orphanedIfRemoved(pm as unknown as VaultWallet, adminOriginator, rec.pubkey)
      } catch (e) {
        haptics.error()
        await showAlert({ title, message: vaultErrorCopy(e instanceof VaultError ? e.code : undefined), buttons: ok })
        return
      }
      if (orphans > 0) {
        await showAlert({ title, message: vaultErrorCopy('relock-required'), buttons: [{ text: t('vault_ok'), key: 'ok' }] })
        return
      }
      const fee = estimateRelockFee(Math.max(coverage?.outputs ?? 1, 1), R1C_LOCK_LEN(m.keys.length - 1))
      const choice = await showAlert({
        title,
        message: t('vault_remove_body', { nickname: rec.nickname, fee: fee.toLocaleString('en-US') }),
        buttons: [
          { text: t('vault_remove_and_relock'), key: 'relock' },
          { text: t('vault_remove_only'), key: 'remove', style: 'destructive' },
          { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
        ]
      })
      if (choice !== 'relock' && choice !== 'remove') return
      try {
        await vaultStore.removeKey(rec.serial)
      } catch (e) {
        haptics.error()
        await showAlert({
          title,
          message: vaultErrorCopy(e instanceof VaultError ? e.code : undefined),
          buttons: [{ text: t('vault_ok'), key: 'ok' }]
        })
        return
      }
      haptics.warning()
      showToast(t('vault_key_removed_toast'), { type: 'info' })
      await reload()
      refreshCoverage()
      if (choice === 'relock') openRelock({ reason: t('vault_relock_reason_generic') })
    },
    [coverage, pm, adminOriginator, reload, refreshCoverage, openRelock]
  )

  const keyActions = useCallback(
    async (rec: VaultKeyRecord) => {
      const choice = await showAlert({
        title: vaultKeyLabel(rec),
        buttons: [
          { text: t('vault_key_action_rename'), key: 'rename' },
          { text: t('vault_key_action_remove'), key: 'remove', style: 'destructive' },
          { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
        ]
      })
      if (choice === 'rename') {
        setRenameText(rec.nickname)
        setRenaming(rec)
      } else if (choice === 'remove') {
        await removeKey(rec)
      }
    },
    [removeKey]
  )

  // ── disable ─────────────────────────────────────────────────────────
  const confirmDisable = useCallback(async () => {
    // Refuse while funds remain: disabling forgets the key list, and with it
    // the only in-app way to sign for those outputs.
    if ((balance ?? 0) > 0) {
      await showAlert({
        title: t('vault_disable_blocked_title'),
        message: t('vault_disable_blocked_message'),
        buttons: [{ text: t('vault_ok'), key: 'ok' }]
      })
      return
    }
    const choice = await showAlert({
      title: t('vault_disable_title'),
      message: t('vault_disable_message'),
      buttons: [
        { text: t('vault_disable_confirm'), key: 'confirm', style: 'destructive' },
        { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
      ]
    })
    if (choice !== 'confirm') return
    await disableVault()
    haptics.warning()
    showToast(t('vault_disabled_toast'), { type: 'info' })
    await reload()
  }, [balance, reload])

  // ── deposit: lazy wallet creation ───────────────────────────────────
  /**
   * Apple HIG: never ask for Face ID/Touch ID before the user has done
   * something that explains why. Enrolment needs no wallet, so a user can
   * reach this screen on a fresh install with none; the Deposit tap is the
   * moment that explains the prompt. Same flow as WalletHomeScreen's
   * destinationPress → BiometricAdvisoryModal → ensureWalletExists.
   */
  const creatingWalletRef = useRef(false)
  const ensureWalletExists = useCallback(async (): Promise<boolean> => {
    if (managers.permissionsManager) return true
    if (!secretsReady || walletBuilding || creatingWalletRef.current) return false
    creatingWalletRef.current = true
    try {
      // A missing manager during migration, unlock, or a failed build does
      // not mean the device has no wallet. Never replace that stored identity.
      if (await hasStoredIdentity()) return false
      const wallet = generateMnemonicWallet()
      const stored = await createMnemonic(wallet.mnemonic)
      if (!stored) {
        // Biometric access was needed and unavailable/declined — same dead
        // end onboarding's own generate flow hits. Send the user there to
        // retry explicitly rather than silently failing the tap.
        if (!(await hasStoredIdentity())) router.replace('/auth/mnemonic')
        return false
      }
      try {
        await backupAttestation.markPending(wallet.identityKey)
      } catch (error) {
        console.warn('[vault] Could not record pending backup reminder:', error)
      }
      await buildWalletFromMnemonic(wallet.mnemonic)
      return true
    } catch (error) {
      console.warn('[vault] Wallet creation did not complete:', error)
      return false
    } finally {
      creatingWalletRef.current = false
    }
  }, [managers.permissionsManager, secretsReady, walletBuilding, hasStoredIdentity, createMnemonic, buildWalletFromMnemonic, router])

  const onDeposit = useCallback(async () => {
    if (managers.permissionsManager) {
      router.push('/vault-transfer?direction=deposit')
      return
    }
    if (!secretsReady || walletBuilding) return
    try {
      if (await hasStoredIdentity()) return
    } catch {
      return
    }
    setShowBiometricAdvisory(true)
  }, [managers.permissionsManager, secretsReady, walletBuilding, hasStoredIdentity, router])

  const onAdvisoryContinue = useCallback(() => {
    // Kept up (with a spinner in place of the label) until wallet creation
    // actually settles: the mnemonic math is real, blocking JS-thread work.
    setCreatingWallet(true)
    void (async () => {
      try {
        // Yield once so the spinner paints before the blocking key math starts.
        await new Promise(resolve => setTimeout(resolve, 0))
        const created = await ensureWalletExists()
        setShowBiometricAdvisory(false)
        if (created) router.push('/vault-transfer?direction=deposit')
      } finally {
        setCreatingWallet(false)
      }
    })()
  }, [ensureWalletExists, router])

  // ── header ──────────────────────────────────────────────────────────
  // While the wizard is up, back means "leave set-up" and goes through the
  // wizard's own leave-confirm (it owns the pending keys), so the chevron is
  // replaced by a spacer and the wizard's Leave link is the only way out.
  const Header = (
    <View style={[styles.header, { borderBottomColor: colors.separator }]}>
      {wizard ? (
        <View style={styles.iconBtn} />
      ) : (
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      )}
      <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('vault_title')}</Text>
      <View style={styles.iconBtn} />
    </View>
  )

  if (meta === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    )
  }

  // ── enrollment / add-key wizard ─────────────────────────────────────
  if (wizard) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <EnrollWizard mode={wizard} onDone={wizard === 'enroll' ? onEnrolled : onKeyAdded} onCancel={() => void closeWizard()} />
      </View>
    )
  }

  // ── not enrolled ─────────────────────────────────────────────────────
  if (meta === null) {
    const canEnroll = enabled && supported
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        {/* Backdrop is clipped to the area below the header rather than laid over
            the whole screen, so the line work never crosses the title bar. */}
        <View style={styles.heroArea}>
          <View style={styles.heroArt}>
            <VaultBackdrop color={colors.textPrimary} />
          </View>
          <ScrollView contentContainerStyle={styles.heroScroll}>
            {/* 1:4 spacers sit the copy block high, just under the header,
                clear of the drawing — a ratio rather than a magic padding. */}
            <View style={styles.heroSpacerTop} />
            <View style={styles.heroCopy}>
              <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_hero_title')}</Text>
              <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_hero_body')}</Text>
              <PressableScale
                haptic="confirm"
                onPress={canEnroll ? () => setWizard('enroll') : undefined}
                accessibilityState={{ disabled: !canEnroll }}
                style={[
                  styles.primary,
                  canEnroll
                    ? { backgroundColor: colors.accent }
                    : { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }
                ]}
              >
                <Text style={[styles.primaryLabel, { color: canEnroll ? colors.textOnAccent : colors.textTertiary }]}>
                  {t('vault_enroll_begin')}
                </Text>
              </PressableScale>
              {/* Release gate first (spec §5.5): a build with the flag off says
                  so before it says anything about hardware. */}
              {!enabled && (
                <View style={styles.heroNotice}>
                  <Text style={[styles.heroNoticeBody, { color: colors.textSecondary }]}>{t('vault_not_released_body')}</Text>
                </View>
              )}
              {enabled && !supported && (
                <View style={styles.heroNotice}>
                  <Text style={[styles.heroNoticeTitle, { color: colors.error }]}>{t('vault_unsupported_title')}</Text>
                  <Text style={[styles.heroNoticeBody, { color: colors.textSecondary }]}>{t('vault_unsupported_body')}</Text>
                </View>
              )}
            </View>
            <View style={styles.heroSpacerBottom} />
          </ScrollView>
        </View>
      </View>
    )
  }

  // ── enrolled ─────────────────────────────────────────────────────────
  const canAdd = enabled && meta.keys.length < VAULT_MAX_KEYS
  const missingNames = coverage
    ? meta.keys
        .filter(k => coverage.missingKeys.includes(k.pubkey))
        .map(k => k.nickname)
        .join(', ')
    : ''
  const relockCandidates = relock?.exclude ? meta.keys.filter(k => k.serial !== relock.exclude) : meta.keys
  const openGenericRelock = enabled ? () => openRelock({ reason: t('vault_relock_reason_generic') }) : undefined

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {Header}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.balanceBlock}>
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>{t('vault_balance_label')}</Text>
          <TouchableOpacity onPress={refresh} activeOpacity={0.7}>
            {loading && balance === null ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={[styles.balance, { color: colors.textPrimary }]}>
                <AmountDisplay>{balance ?? 0}</AmountDisplay>
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.actions}>
          <PressableScale
            haptic="confirm"
            onPress={enabled ? () => void onDeposit() : undefined}
            accessibilityState={{ disabled: !enabled }}
            style={[styles.actionBtn, { backgroundColor: enabled ? colors.accent : colors.backgroundElevated }]}
          >
            <Ionicons name="arrow-down" size={18} color={enabled ? colors.textOnAccent : colors.textTertiary} />
            <Text style={[styles.actionLabel, { color: enabled ? colors.textOnAccent : colors.textTertiary }]}>
              {t('vault_deposit_cta')}
            </Text>
          </PressableScale>
          {/* Never gated (spec §5.5): what is already in the vault must always
              be withdrawable, flag or no flag. */}
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/vault-transfer?direction=withdraw')}
            style={[
              styles.actionBtn,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.separator, borderWidth: StyleSheet.hairlineWidth }
            ]}
          >
            <Ionicons name="arrow-up" size={18} color={colors.accent} />
            <Text style={[styles.actionLabel, { color: colors.accent }]}>{t('vault_withdraw_cta')}</Text>
          </PressableScale>
        </View>
        {!enabled && <Text style={[styles.notice, { color: colors.textSecondary }]}>{t('vault_not_released_body')}</Text>}

        <GroupedSection header={t('vault_key_section', { count: meta.keys.length })} footer={t('vault_footnote')}>
          {coverage && coverage.missingKeys.length > 0 && (
            <ListRow
              label={t('vault_badge_missing', { count: coverage.stale, nickname: missingNames })}
              icon="alert-circle-outline"
              iconColor={colors.warning}
              showChevron={false}
              onPress={openGenericRelock}
            />
          )}
          {coverage && coverage.removedKeyOutputs > 0 && (
            <ListRow
              label={t('vault_badge_removed', { count: coverage.removedKeyOutputs })}
              icon="alert-circle-outline"
              iconColor={colors.warning}
              showChevron={false}
              onPress={openGenericRelock}
            />
          )}
          {meta.keys.map((rec, i) => (
            <ListRow
              key={rec.serial}
              label={vaultKeyLabel(rec)}
              subtitle={new Date(rec.enrolledAt).toLocaleDateString()}
              icon="key-outline"
              iconColor={colors.permissionSpending}
              showChevron={false}
              onPress={() => void keyActions(rec)}
              isLast={i === meta.keys.length - 1 && !canAdd}
            />
          ))}
          {canAdd && (
            <ListRow label={t('vault_add_key_row')} icon="add-circle-outline" iconColor={colors.info} onPress={openAddKey} isLast />
          )}
        </GroupedSection>

        <GroupedSection header={t('vault_manage_section')} footer={t('vault_export_explainer')}>
          <ListRow
            label={t('vault_relock_row')}
            icon="refresh-outline"
            iconColor={colors.info}
            showChevron={false}
            onPress={openGenericRelock}
          />
          {/* Same action, label and styling as the Settings row (spec §3.4). */}
          <ListRow
            label={t('export_wallet_data')}
            icon="share-outline"
            iconColor="#32ADE6"
            showChevron={false}
            onPress={exporting ? undefined : () => void exportData()}
            trailing={exporting ? <ActivityIndicator size="small" /> : undefined}
            isLast
          />
        </GroupedSection>

        <GroupedSection>
          <ListRow
            label={t('vault_disable_row')}
            icon="lock-open"
            iconColor={colors.error}
            destructive
            onPress={() => void confirmDisable()}
            isLast
          />
        </GroupedSection>
      </ScrollView>

      {/* Rename — nickname only. */}
      <Sheet
        visible={renaming !== null}
        onClose={() => setRenaming(null)}
        title={renaming ? t('vault_rename_title', { nickname: renaming.nickname }) : ''}
        fitContent
      >
        <View style={styles.sheetBody}>
          <TextInput
            accessibilityLabel={renaming ? t('vault_rename_title', { nickname: renaming.nickname }) : ''}
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={renameText}
            onChangeText={setRenameText}
            placeholder={renaming?.nickname}
            placeholderTextColor={colors.textTertiary}
            maxLength={32}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => void saveRename()}
            autoFocus
          />
          <PressableScale haptic="confirm" onPress={() => void saveRename()} style={[styles.primary, { backgroundColor: colors.accent }]}>
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_rename_save')}</Text>
          </PressableScale>
          <PressableScale onPress={() => setRenaming(null)} style={styles.secondary}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
          </PressableScale>
        </View>
      </Sheet>

      {/* Re-lock — choose the key, then one ceremony tap per pass. */}
      <Sheet visible={relock !== null} onClose={relocking ? noop : closeRelock} title={t('vault_relock_row')} fitContent>
        <View style={styles.sheetBody}>
          {relock?.reason ? <Text style={[styles.p, { color: colors.textSecondary }]}>{relock.reason}</Text> : null}
          <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>{t('vault_relock_choose')}</Text>
          <KeyChooser keys={relockCandidates} selected={relockSerial} onSelect={setRelockSerial} />
          {relockError && <Text style={[styles.err, { color: colors.error }]}>{relockError}</Text>}
          <PressableScale
            haptic="confirm"
            onPress={relockSerial && !relocking ? () => void runRelock() : undefined}
            accessibilityState={{ disabled: !relockSerial || relocking }}
            style={[styles.primary, { backgroundColor: colors.accent, opacity: relockSerial && !relocking ? 1 : 0.5 }]}
          >
            {relocking ? (
              <ActivityIndicator color={colors.textOnAccent} />
            ) : (
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_relock_now')}</Text>
            )}
          </PressableScale>
          <PressableScale onPress={relocking ? undefined : closeRelock} style={styles.secondary}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
          </PressableScale>
        </View>
      </Sheet>

      <BiometricAdvisoryModal
        visible={showBiometricAdvisory}
        loading={creatingWallet}
        onCancel={() => setShowBiometricAdvisory(false)}
        onContinue={onAdvisoryContinue}
      />
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
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  // NO horizontal padding here. GroupedSection insets itself (its card carries
  // marginHorizontal: spacing.lg, its header paddingHorizontal: spacing.xl), so
  // padding this container would double-inset every grouped card. Direct
  // children carry their own gutter instead.
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl },
  heroArea: { flex: 1, overflow: 'hidden' },
  heroArt: { position: 'absolute', bottom: '7%', left: 0, right: 0, height: '56%' },
  heroScroll: { flexGrow: 1 },
  heroNotice: { alignItems: 'center', gap: spacing.xs },
  heroNoticeTitle: { ...typography.subhead, fontWeight: '600', textAlign: 'center' },
  heroNoticeBody: { ...typography.footnote, textAlign: 'center' },
  heroSpacerTop: { flex: 1 },
  heroSpacerBottom: { flex: 4 },
  heroCopy: { alignSelf: 'stretch', alignItems: 'center', paddingHorizontal: spacing.xl, gap: spacing.lg },
  h1: { ...typography.title1, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  notice: { ...typography.footnote, textAlign: 'center', paddingHorizontal: spacing.xl, marginBottom: spacing.xxl },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  err: { ...typography.footnote, textAlign: 'center' },
  balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
  // No textTransform, matching the wallet screen: "Vault holds" is a phrase
  // leading into the amount, and casing belongs to the translation.
  balanceLabel: { ...typography.footnote },
  // tabular-nums so the balance does not jitter as digits change.
  balance: { ...typography.display, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.xxl },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingVertical: spacing.lg
  },
  actionLabel: { ...typography.headline },
  sheetBody: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.lg },
  sheetLabel: { ...typography.headline },
  input: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...typography.body
  }
})
