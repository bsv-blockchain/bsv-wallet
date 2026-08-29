/**
 * The Vault screen.
 *
 * Not enrolled → a hero explainer and the enrollment wizard.
 * Enrolled → the vault balance, deposit/withdraw actions, the key card, and a
 * recovery/disable overflow.
 *
 * Feature-gated: when no YubiKey-capable driver is present (and not a dev
 * build) the screen explains the requirement rather than offering enrollment.
 */
import React, { useEffect, useState, useCallback } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GroupedSection } from '../components/ui/GroupedList'
import { ListRow } from '../components/ui/ListRow'
import PressableScale from '../components/ui/PressableScale'
import AmountDisplay from '../components/wallet/AmountDisplay'
import { showAlert } from '../components/ui/AlertCard'
import { showToast } from '../components/ui/Toast'
import { EnrollWizard } from '../components/vault/EnrollWizard'
import { VaultBackdrop } from '../components/vault/VaultBackdrop'
import { useVaultBalance } from '../hooks/useVaultBalance'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  reclaimStagingOutputs,
  type VaultWallet,
  vaultStore,
  type VaultMeta,
  getVaultDriver,
  disableVault,
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

export function VaultScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router } = loadExpoRouter()
  const Ionicons = loadIonicons()
  const { balance, loading, refresh } = useVaultBalance()
  const { managers, adminOriginator, storage } = useWallet()
  const [enrolled, setEnrolled] = useState<boolean | null>(null)
  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [enrolling, setEnrolling] = useState(false)

  const supported = getVaultDriver()?.isSupported() ?? false

  const reload = useCallback(async () => {
    const [e, m] = await Promise.all([vaultStore.isEnrolled(), vaultStore.getMeta()])
    setEnrolled(e)
    setMeta(m)
  }, [])

  useEffect(() => {
    reload()
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

  const onEnrolled = useCallback(async () => {
    setEnrolling(false)
    await reload()
    refresh()
  }, [reload, refresh])

  const confirmDisable = useCallback(async () => {
    // Refuse to disable while funds remain: there IS a seal (disableVault's
    // vaultStore.clear deletes it along with the meta), and disabling before
    // a sweep would leave any vault UTXO reachable only the slow way — the
    // main mnemonic + vault passphrase, via the recovery sweep — with no more
    // in-app YubiKey ceremony to reach it directly. Force a withdrawal (or
    // recovery sweep) first.
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

  const Header = (
    <View style={[styles.header, { borderBottomColor: colors.separator }]}>
      {/* Mid-enrolment, back means "leave setup", not "leave the vault" — the
          wizard's own Cancel button is gone, so this is the only way out and it
          has to land on the screen the user came from inside this flow. */}
      <TouchableOpacity
        onPress={() => (enrolling ? setEnrolling(false) : router.back())}
        style={styles.iconBtn}
      >
        <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('vault_title')}</Text>
      <View style={styles.iconBtn} />
    </View>
  )

  if (enrolled === null) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    )
  }

  // ── enrollment wizard ────────────────────────────────────────────────
  if (enrolling) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <EnrollWizard onDone={onEnrolled} onCancel={() => setEnrolling(false)} />
      </View>
    )
  }

  // ── not enrolled ─────────────────────────────────────────────────────
  if (!enrolled) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        {/* Backdrop is clipped to the area below the header rather than laid over
            the whole screen, so the line work never crosses the title bar. */}
        <View style={styles.heroArea}>
          {/* Copy on top, drawing beneath it. They do not overlap: when they
              did, the artwork had to be faded almost to nothing to keep the
              body text readable, which wasted it. */}
          <View style={styles.heroArt}>
            <VaultBackdrop color={colors.textPrimary} />
          </View>
          <ScrollView contentContainerStyle={styles.heroScroll}>
            {/* 1:4 spacers sit the copy block high, just under the header,
                clear of the drawing — a ratio rather than a magic padding, so
                it holds on every screen height. */}
            <View style={styles.heroSpacerTop} />
            <View style={styles.heroCopy}>
            <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_hero_title')}</Text>
            <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_hero_body')}</Text>
            <PressableScale
              haptic="confirm"
              onPress={supported ? () => setEnrolling(true) : undefined}
              style={[
                styles.primary,
                supported
                  ? { backgroundColor: colors.accent }
                  : {
                      backgroundColor: 'transparent',
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: colors.separator
                    }
              ]}
            >
              <Text
                style={[
                  styles.primaryLabel,
                  { color: supported ? colors.textOnAccent : colors.textTertiary }
                ]}
              >
                {t('vault_enroll_begin')}
              </Text>
            </PressableScale>
            {/* Said here, before the user picks a passphrase — it used to
                surface as a red line under that form at the end of the
                ceremony, which is the app taking someone through setup before
                mentioning their phone cannot do it. Turning on the DEV mock
                YubiKey swaps the driver in, so this clears by itself. */}
            {!supported && (
              <View style={styles.heroNotice}>
                <Text style={[styles.heroNoticeTitle, { color: colors.error }]}>
                  {t('vault_unsupported_title')}
                </Text>
                <Text style={[styles.heroNoticeBody, { color: colors.textSecondary }]}>
                  {t('vault_unsupported_body')}
                </Text>
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
            onPress={() => router.push('/vault-transfer?direction=deposit')}
            style={[styles.actionBtn, { backgroundColor: colors.accent }]}
          >
            <Ionicons name="arrow-down" size={18} color={colors.textOnAccent} />
            <Text style={[styles.actionLabel, { color: colors.textOnAccent }]}>{t('vault_deposit_cta')}</Text>
          </PressableScale>
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/vault-transfer?direction=withdraw')}
            style={[
              styles.actionBtn,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.separator,
                borderWidth: StyleSheet.hairlineWidth
              }
            ]}
          >
            <Ionicons name="arrow-up" size={18} color={colors.accent} />
            <Text style={[styles.actionLabel, { color: colors.accent }]}>{t('vault_withdraw_cta')}</Text>
          </PressableScale>
        </View>

        <GroupedSection header={t('vault_key_section')}>
          <ListRow
            label={t('vault_key_serial')}
            value={meta?.yubiSerial}
            icon="finger-print"
            iconColor={colors.permissionSpending}
            showChevron={false}
            isLast
          />
        </GroupedSection>

        <GroupedSection header={t('vault_manage_section')}>
          <ListRow
            label={t('vault_recover_row')}
            icon="medkit-outline"
            iconColor={colors.info ?? colors.accent}
            onPress={() => router.push('/vault-recover')}
          />
          <ListRow
            label={t('vault_disable_row')}
            icon="lock-open"
            iconColor={colors.error}
            destructive
            onPress={confirmDisable}
            isLast
          />
        </GroupedSection>
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
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  // Same centring as `centered`, biased up by half the extra bottom padding
  // (~38pt). Geometric centre reads low here: the header is a solid band at the
  // top, so an empty state centred in the remaining box looks like it sank.
  // Optical centre sits above the true one. The spinner state keeps `centered`.
  heroCentered: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxxl * 3,
    gap: spacing.lg
  },
  // NO horizontal padding here. GroupedSection insets itself (its card carries
  // marginHorizontal: spacing.lg, its header paddingHorizontal: spacing.xl), so
  // padding this container double-inset every grouped card to 32pt while the
  // balance and action row sat at 16pt — three different left edges on one
  // screen. Direct children now carry their own gutter instead, matching the
  // house pattern in app/settings.tsx and app/wallet-config.tsx.
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl },
  gutter: { paddingHorizontal: spacing.lg },
  heroArea: { flex: 1, overflow: 'hidden' },
  heroArt: { position: 'absolute', bottom: '7%', left: 0, right: 0, height: '56%' },
  heroScroll: { flexGrow: 1 },
  heroNotice: { alignItems: 'center', gap: spacing.xs },
  heroNoticeTitle: { ...typography.subhead, fontWeight: '600', textAlign: 'center' },
  heroNoticeBody: { ...typography.footnote, textAlign: 'center' },
  heroSpacerTop: { flex: 1 },
  heroSpacerBottom: { flex: 4 },
  heroCopy: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.lg
  },
  h1: { ...typography.title1, textAlign: 'center' },
  h2: { ...typography.title3, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  balanceBlock: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg
  },
  // No textTransform, matching the wallet screen: "Vault holds" is a phrase
  // leading into the amount, and casing belongs to the translation.
  balanceLabel: { ...typography.footnote },
  // tabular-nums so the balance does not jitter as digits change — the repo
  // convention (NearbyFlow, AmountInput).
  balance: { ...typography.display, fontVariant: ['tabular-nums'] },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xxl
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingVertical: spacing.lg
  },
  actionLabel: { ...typography.headline }
})
