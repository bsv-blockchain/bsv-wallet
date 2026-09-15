/**
 * The Asset sheet — the one new surface this feature adds.
 *
 * Raised only by tapping a Balances row, never automatically: an unprompted
 * sheet on the most-used screen is modality the user did not ask for, and its
 * coverage would depend on where they happened to be standing when a payment
 * landed. Disclosure instead lands where the user is provably looking — the
 * arrival overlay on first hold, and this sheet on demand.
 *
 * What it says about trust is stated as CAPABILITY, not as a category: four
 * things the issuer can actually do, each a real gate in the overlay, plus the
 * limit of those powers. No "Verified" chip, no shield, no trust score — a
 * badge the wallet cannot earn from data is decoration with the authority of
 * evidence. If the issuer's identity resolves to a name, that name IS the
 * badge, and it was earned.
 *
 * There is no backing/peg/reserve copy anywhere, because the wallet has no
 * evidence for any of it.
 */
import React, { useCallback } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { abbreviateKey, radii, spacing, typography, useTheme } from '@bsv/expo-wallet-toolbox'
import { GroupedSection } from '../ui/GroupedList'
import { ListRow } from '../ui/ListRow'
import Sheet from '../ui/Sheet'
import { showToast } from '../ui/Toast'
import type { TokenActivityRow, TokenBalance } from '../../../core/mandala/runtime'
import AssetAmount from './AssetAmount'
import PressableScale from '../ui/PressableScale'
import { tokenStatusDetailKey, tokenStatusKey } from '../../tokenStatus'
import { formatTokenAmountWithUnit, formatTokenAmount } from '../../tokenFormat'
import { useAssetStatus } from '../../hooks/useMandala'

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

type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default
let clipboardModule: ClipboardModule | undefined
function loadClipboard(): ClipboardModule {
  if (!clipboardModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('@react-native-clipboard/clipboard').default as ClipboardModule
  }
  return clipboardModule
}

/** How many recent movements of this asset the sheet shows before it stops. */
const RECENT_LIMIT = 5

export interface AssetSheetProps {
  visible: boolean
  /** The asset and its figures. `null` closes the sheet's content, not the sheet. */
  balance: TokenBalance | null
  /** Recent token activity, already filtered to this wallet (any asset). */
  activity?: TokenActivityRow[] | null
  onClose: () => void
  onPay: (assetId: string) => void
  onGetPaid: (assetId: string) => void
}

export default function AssetSheet({ visible, balance, activity, onClose, onPay, onGetPaid }: AssetSheetProps) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const Ionicons = loadIonicons()

  const asset = balance?.asset
  const copyAssetId = useCallback(() => {
    if (!asset) return
    loadClipboard().setString(asset.assetId)
    showToast(t('copied'), { type: 'success' })
  }, [asset, t])
  // Regulatory/registry facts for THIS asset — paused, frozen — from the
  // runtime's own ~10s cache. `null` (unknown/loading) renders nothing extra:
  // this is advisory copy layered on top of the sheet, never a gate.
  const { status } = useAssetStatus(asset?.assetId ?? null)

  if (!asset || !balance) {
    return <Sheet visible={visible} onClose={onClose} fitContent />
  }

  const issuer = asset.issuerName || t('token_issuer_fallback')
  const rows = (activity ?? []).filter(r => r.asset.assetId === asset.assetId).slice(0, RECENT_LIMIT)

  return (
    <Sheet visible={visible} onClose={onClose} title={asset.label || asset.ticker} fitContent>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.headline}>
          <AssetAmount baseUnits={balance.baseUnits} asset={asset} size="sheet" />
          {balance.unsettledBaseUnits > 0 && (
            <Text style={[styles.qualifier, { color: colors.textSecondary }]}>
              {t('local_pay_token_not_cleared', { issuer })}
            </Text>
          )}
          {!!status?.frozenBaseUnits && status.frozenBaseUnits > 0 && (
            <Text style={[styles.qualifier, { color: colors.warning }]}>
              {t('token_frozen_sub', {
                issuer,
                ticker: asset.ticker,
                amount: formatTokenAmount(status.frozenBaseUnits, asset.decimals) ?? ''
              })}
            </Text>
          )}
        </View>

        <GroupedSection>
          <ListRow
            label={t('token_sheet_issuer')}
            value={asset.issuerName || t('token_sheet_issuer_unknown')}
            showChevron={false}
          />
          <ListRow
            label={t('token_sheet_asset_id')}
            value={abbreviateKey(asset.assetId)}
            showChevron={false}
            isLast
            onPress={copyAssetId}
          />
        </GroupedSection>

        {/* Paused variant: inserted above the powers group, per ux design §2.2.
            Get paid stays enabled below — refusing to receive on the issuer's
            behalf is not this wallet's call to make. */}
        {status?.paused && (
          <GroupedSection>
            <ListRow
              label={t('token_paused_short')}
              subtitle={t('pay_asset_paused', { issuer, ticker: asset.ticker })}
              icon="pause-circle-outline"
              iconColor={colors.warning}
              showChevron={false}
              isLast
            />
          </GroupedSection>
        )}

        {/* Four powers, each a real gate in the overlay, stated as capability —
            and then the limit of them, which is the part that makes the list
            readable rather than frightening. */}
        <GroupedSection
          header={t('token_sheet_powers_header', { issuer })}
          footer={t('token_powers_limit', { ticker: asset.ticker })}
        >
          <ListRow label={t('token_power_pause', { ticker: asset.ticker })} showChevron={false} />
          <ListRow label={t('token_power_freeze')} showChevron={false} />
          <ListRow label={t('token_power_admit', { ticker: asset.ticker })} showChevron={false} />
          <ListRow label={t('token_power_replace')} showChevron={false} isLast />
        </GroupedSection>

        {rows.length > 0 && (
          <GroupedSection header={t('wallet_activity')}>
            {rows.map((row, i) => (
              <ListRow
                key={row.txid}
                label={t(row.role === 'sent' ? 'token_row_sent' : 'token_row_received', { ticker: asset.ticker })}
                subtitle={
                  // A finished-but-unhappy row explains itself; every other
                  // status is just its plain word, exactly as before.
                  (() => {
                    const detailKey = tokenStatusDetailKey(row.status, row.role, row.refusedCode)
                    return detailKey ? t(detailKey, { issuer, ticker: asset.ticker }) : t(tokenStatusKey(row.status))
                  })()
                }
                showChevron={false}
                isLast={i === rows.length - 1}
                trailing={
                  <Text
                    style={[
                      styles.rowFigure,
                      { color: row.role === 'received' ? colors.successAmount : colors.textPrimary }
                    ]}
                  >
                    {formatTokenAmountWithUnit(row.baseUnits, asset, { showPlus: row.role === 'received' }) ??
                      t('token_row_amount_pending')}
                  </Text>
                }
              />
            ))}
          </GroupedSection>
        )}

        <View style={styles.actions}>
          <PressableScale
            onPress={() => onPay(asset.assetId)}
            haptic="confirm"
            style={[styles.action, { backgroundColor: colors.accent }]}
            accessibilityRole="button"
            accessibilityLabel={t('pay')}
          >
            <Ionicons name="arrow-up" size={18} color={colors.textOnAccent} />
            <Text style={[styles.actionLabel, { color: colors.textOnAccent }]}>{t('pay')}</Text>
          </PressableScale>
          <PressableScale
            onPress={() => onGetPaid(asset.assetId)}
            haptic="confirm"
            style={[styles.action, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
            accessibilityRole="button"
            accessibilityLabel={t('pay_direction_receive')}
          >
            <Ionicons name="arrow-down" size={18} color={colors.textPrimary} />
            <Text style={[styles.actionLabel, { color: colors.textPrimary }]}>{t('pay_direction_receive')}</Text>
          </PressableScale>
        </View>
      </ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  headline: { alignItems: 'center', paddingVertical: spacing.lg, gap: spacing.xs },
  qualifier: { ...typography.footnote, textAlign: 'center', paddingHorizontal: spacing.lg },
  rowFigure: { ...typography.subhead, fontWeight: '600', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent'
  },
  actionLabel: { ...typography.subhead, fontWeight: '600' }
})
