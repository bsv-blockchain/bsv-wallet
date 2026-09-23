/**
 * One transaction, on its own screen.
 *
 * Replaces the expand-in-place row: a tap on an activity row now means exactly
 * one thing, and the utilities that used to unfold underneath it live in the
 * overflow menu here.
 *
 * Presented full-screen by `WalletHomeScreen` rather than as its own route,
 * deliberately: the utilities in the overflow menu are the list's own
 * handlers, entangled with its busy-row state and its storage/permissions
 * managers, and a route could only have reached them by duplicating logic
 * that includes the overlay-authoritative cancel (FIX J). Same appearance,
 * none of that risk.
 *
 * Works for all four combinations the list can produce — money in or out, BSV
 * or a stablecoin — because everything it draws comes from the row that opened
 * it rather than from a second query. The counterparty is drawn as the same
 * generative sigil the list uses, never as a raw identity key: a 66-character
 * hex string is not an answer to "who was this".
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  useWalletManagers,
  formatAmount,
  formatSatoshisExact,
  isFiatCurrency,
  ExchangeRateContext
} from '@bsv/expo-wallet-toolbox'
import type { ContactRow } from '../../core/contacts/contactsStore'
import CustomSafeArea from '../components/ui/CustomSafeArea'
import ContactSigil from '../components/wallet/ContactSigil'
import { showToast } from '../components/ui/Toast'
import { useContactsStore } from '../hooks/useContactsStore'

type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default
let clipboardModule: ClipboardModule | undefined
function loadClipboard(): ClipboardModule {
  if (!clipboardModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('@react-native-clipboard/clipboard').default as ClipboardModule
  }
  return clipboardModule
}

/**
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (see AdmissionNotice.tsx):
 * @expo/vector-icons reaches expo-font, untransformed ESM that breaks every
 * Jest suite importing the `ui` barrel. `Icon` is one module-level component
 * rather than `const Ionicons = loadIonicons()` per render site, which
 * react-hooks/static-components reports as a component created during render.
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
type IoniconsProps = React.ComponentProps<IoniconsComponent>
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}
function Icon(props: IoniconsProps) {
  return React.createElement(loadIonicons(), props)
}

/**
 * Everything the screen draws, handed over by the row that opened it.
 *
 * Passed as one JSON route param rather than a dozen loose ones: the shape is
 * the row's own, so a new field on the row never means a new param to thread
 * through expo-router's string-typed `params`.
 */
export interface TransactionDetailParams {
  txid: string
  /** Signed satoshis. Ignored for a token row, which carries its own figure. */
  satoshis: number
  status: string
  description?: string
  isOutgoing: boolean
  createdAt?: string
  counterpartyKey?: string
  /** Present only for a stablecoin row. */
  token?: {
    title: string
    amount?: { value: string; unit: string }
    incoming: boolean
    statusText?: string
  }
}

/** One action in the overflow menu. */
export interface TransactionAction {
  key: string
  label: string
  icon: string
  danger?: boolean
  onPress: () => void
}

function formatFullDate(value?: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return d.toISOString()
  }
}

/** `a1b2c3…d4e5f6` — a txid you can eyeball against an explorer without it
 * taking the whole row. */
function shortTxid(txid: string): string {
  if (txid.length <= 16) return txid
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`
}

export default function TransactionDetailScreen({
  tx,
  getActions,
  onBack
}: {
  tx: TransactionDetailParams
  /**
   * The overflow menu's contents, built when the menu is OPENED rather than
   * handed over as an array. The list's handlers read refs, and calling them
   * — even indirectly — while this screen renders is a render-phase ref read.
   * Building on press also means the menu reflects the row's state now, not
   * its state when the screen was first drawn.
   */
  getActions?: () => TransactionAction[]
  onBack: () => void
}) {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const { settings, walletUserId } = useWallet()
  const contactsStore = useContactsStore()
  const { satoshisPerUSD, usdToFiat } = React.useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'
  const [menuActions, setMenuActions] = useState<TransactionAction[] | null>(null)
  const [contact, setContact] = useState<ContactRow | undefined>(undefined)

  const { storage } = useWalletManagers()
  /** undefined while looking, null when the transaction is not in a block yet. */
  const [blockHeight, setBlockHeight] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    if (!tx.txid || !storage) return
    let cancelled = false
    storage
      .getProvenTxHeight(tx.txid)
      .then(h => {
        if (!cancelled) setBlockHeight(h)
      })
      .catch(() => {
        if (!cancelled) setBlockHeight(null)
      })
    return () => {
      cancelled = true
    }
  }, [tx.txid, storage])

  const counterpartyKey = tx.counterpartyKey
  useEffect(() => {
    // No clear on the way out: this screen shows ONE transaction, so the
    // counterparty never changes under it, and `contact` is already undefined
    // until a lookup succeeds.
    if (!counterpartyKey || !contactsStore || walletUserId == null) return
    let cancelled = false
    void contactsStore
      .getContact(walletUserId, counterpartyKey)
      .then(c => {
        if (!cancelled) setContact(c)
      })
      .catch(() => {
        // A failed lookup reads as "not a saved contact", which is what the
        // screen already shows.
      })
    return () => {
      cancelled = true
    }
  }, [counterpartyKey, contactsStore, walletUserId])

  const incoming = tx.token ? tx.token.incoming : !tx.isOutgoing

  /** What the transaction actually moved, in exact sats — never BSV or fiat. */
  const hero = useMemo(() => {
    if (tx.token) return tx.token.amount ?? null
    return formatSatoshisExact(tx.satoshis, true)
  }, [tx])

  const exact = hero ? `${hero.value} ${hero.unit}` : ''

  /** The same money in the display currency; none when that currency is BSV. */
  const fiat = useMemo(() => {
    if (tx.token || !isFiatCurrency(currency)) return null
    return formatAmount(tx.satoshis, currency, satoshisPerUSD, { showPlus: true, usdToFiat })
  }, [tx, currency, satoshisPerUSD, usdToFiat])

  /**
   * Who this was with. A saved contact's own label wins, then the handle the
   * registry cached for them, then the direction — never the identity key.
   */
  const title = tx.token
    ? contact?.name || contact?.cachedHandle || tx.token.title
    : contact?.name ||
      contact?.cachedHandle ||
      tx.description ||
      (incoming ? t('tx_received', { defaultValue: 'Received' }) : t('tx_sent', { defaultValue: 'Sent' }))

  const statusText = tx.token?.statusText || tx.status

  const copyTxid = useCallback(() => {
    if (!tx.txid) return
    loadClipboard().setString(tx.txid)
    showToast(t('copied', { defaultValue: 'Copied' }), { type: 'success' })
  }, [tx.txid, t])

  // Same pair the activity row uses, so a figure does not change colour
  // between the list and this screen.
  const amountColor = incoming ? colors.successAmount : colors.textPrimary

  return (
    <CustomSafeArea style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={t('go_back')}
        >
          <Icon name="chevron-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        {getActions ? (
          <TouchableOpacity
            onPress={() => {
              const next = getActions()
              // An empty menu is not a menu; leave the tap inert rather than
              // opening an empty sheet.
              if (next.length > 0) setMenuActions(next)
            }}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel={t('more', { defaultValue: 'More' })}
          >
            <Icon name="ellipsis-horizontal" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerBtn} />
        )}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* The face, at portrait size. Falls back to the direction arrow only
            when there is no counterparty key at all — a received token payment
            carries a per-payment blinded key, which still draws a stable face
            for THAT payment. */}
        {counterpartyKey ? (
          <ContactSigil identityKey={counterpartyKey} avatarUrl={contact?.cachedAvatarUrl} size={84} radius={42} />
        ) : (
          <View style={[styles.fallbackFace, { backgroundColor: colors.fill }]}>
            <Icon name={incoming ? 'arrow-down' : 'arrow-up'} size={34} color={colors.textSecondary} />
          </View>
        )}

        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={2}>
          {title}
        </Text>
        {/* The handle only when it is not already what the title says. */}
        {contact?.cachedHandle && contact.cachedHandle !== title ? (
          <Text style={[styles.handle, { color: colors.textSecondary }]}>{contact.cachedHandle}</Text>
        ) : null}

        {hero ? (
          <Text style={[styles.hero, { color: amountColor }]} numberOfLines={1} adjustsFontSizeToFit>
            {hero.value}
            {hero.unit ? <Text style={[styles.heroUnit, { color: colors.textSecondary }]}> {hero.unit}</Text> : null}
          </Text>
        ) : (
          <Text style={[styles.hero, { color: colors.textSecondary }]}>—</Text>
        )}
        {fiat ? <Text style={[styles.fiat, { color: colors.textSecondary }]}>{fiat}</Text> : null}

        <View style={[styles.divider, { borderColor: colors.hairline }]} />

        <DetailRow label={t('tx_detail_status', { defaultValue: 'Status' })} value={statusText} />
        <DetailRow label={t('tx_detail_date', { defaultValue: 'Date' })} value={formatFullDate(tx.createdAt) || '—'} />
        <DetailRow label={t('tx_detail_amount', { defaultValue: 'Amount' })} value={exact || '—'} />
        {tx.txid ? (
          <DetailRow
            label={t('tx_detail_block')}
            value={
              blockHeight === undefined
                ? '—'
                : blockHeight === null
                  ? t('tx_detail_block_pending')
                  : String(blockHeight)
            }
          />
        ) : null}
        {tx.txid ? (
          <DetailRow
            label={t('tx_detail_txid', { defaultValue: 'Transaction ID' })}
            value={shortTxid(tx.txid)}
            onCopy={copyTxid}
          />
        ) : null}
      </ScrollView>

      {/* The utilities that used to unfold inside the row. */}
      <Modal
        visible={menuActions !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuActions(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setMenuActions(null)}>
          <View style={[styles.menu, { backgroundColor: colors.surfaceRaised, borderColor: colors.hairline }]}>
            {(menuActions ?? []).map(a => (
              <TouchableOpacity
                key={a.key}
                style={styles.menuItem}
                onPress={() => {
                  setMenuActions(null)
                  a.onPress()
                }}
              >
                <Icon
                  name={a.icon as never}
                  size={18}
                  color={a.danger ? colors.error : colors.textSecondary}
                  style={styles.menuIcon}
                />
                <Text style={[styles.menuLabel, { color: a.danger ? colors.error : colors.textPrimary }]}>
                  {a.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    </CustomSafeArea>
  )
}

function DetailRow({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  const { colors } = useTheme()
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>{label}</Text>
      <View style={styles.rowValueGroup}>
        <Text style={[styles.rowValue, { color: colors.textPrimary }]} numberOfLines={1}>
          {value}
        </Text>
        {onCopy ? (
          <TouchableOpacity onPress={onCopy} style={styles.copyBtn} accessibilityRole="button">
            <Icon name="copy-outline" size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  fallbackFace: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
  title: { ...typography.title1, fontWeight: '700', marginTop: spacing.lg },
  handle: { ...typography.body, marginTop: spacing.xs },
  hero: { ...typography.largeTitle, fontSize: 48, lineHeight: 56, fontWeight: '700', marginTop: spacing.lg },
  heroUnit: { ...typography.title3, fontWeight: '600' },
  fiat: { ...typography.body, marginTop: spacing.xs },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed', marginVertical: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md
  },
  rowLabel: { ...typography.body, flexShrink: 0, marginRight: spacing.md },
  rowValueGroup: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  rowValue: { ...typography.body, fontWeight: '600', flexShrink: 1 },
  copyBtn: { marginLeft: spacing.sm, padding: spacing.xs },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  menu: {
    position: 'absolute',
    top: 56,
    right: spacing.md,
    minWidth: 200,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.md },
  menuIcon: { marginRight: spacing.md },
  menuLabel: { ...typography.body }
})
