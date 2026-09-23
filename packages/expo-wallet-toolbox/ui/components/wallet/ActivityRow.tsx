/**
 * One row of the wallet's activity list.
 *
 * Reading order is who (a sigil avatar for the counterparty, with direction on
 * the tile edge) → what it was → how much, then status and time underneath.
 * The per-transaction utilities (status, explorer, resend, cancel)
 * are NOT on the row: they used to sit permanently on the right, four icons
 * deep, which made every row look equally busy whether or not anything needed
 * doing. They now live behind a tap, and the expanded row lifts onto its own
 * surface so it is obvious which transaction the chips belong to.
 *
 * The chips are what someone can DO about a payment. Copying raw BEEF or a
 * txid to a clipboard is not that — it is debugging, and it used to crowd out
 * the two chips that actually resolve a stuck payment.
 */
import React, { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { WalletAction } from '@bsv/sdk'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  ExchangeRateContext,
  formatAmount,
  formatAmountParts,
  counterpartyOf,
  counterpartyHue,
  sigilPointOf,
  sigilPalette,
  type Counterparty
} from '@bsv/expo-wallet-toolbox'
import { txStatusView, toneColor, type TxStatusView } from '../../txStatus'
import PressableScale from '../ui/PressableScale'
import Sigil from '../ui/Sigil'
import type { ContactsStore } from '../../../core/contacts/contactsStore'

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source, which Jest cannot parse for any consumer of the barrel, even one
 * that never navigates. Same pattern as every other screen/component in this
 * package that needs the router.
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
    materialCommunityIconsComponent = // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@expo/vector-icons').MaterialCommunityIcons as MaterialCommunityIconsComponent
  }
  return materialCommunityIconsComponent
}

/** A row as storage actually returns it: `reference`, `created_at` and
 * `senderIdentityKey` are real columns the SDK's WalletAction type does not
 * declare. The sender key is what an inbound peer payment records about who
 * paid, since nothing else on the row does. */
export type ActivityAction = WalletAction & {
  reference?: string
  created_at?: string | number | Date
  senderIdentityKey?: string
}

interface Props {
  /** Pass the screen currency to avoid subscribing every row to wallet updates. */
  currency?: string
  /**
   * Pass this alongside `currency` for the same reason: without it the row
   * would call `useWallet()` itself just to scope the contact lookup below,
   * subscribing every row to wallet updates again. `undefined`/`null` simply
   * means the tappable-contact-face feature never activates for this row.
   */
  walletUserId?: number | null
  /**
   * Same reason as `walletUserId`: built once at the screen and passed down
   * rather than resolved per row via `useContactsStore()`, which reaches
   * `useWallet()` internally — exactly the subscription `currency` above
   * already exists to avoid.
   */
  contactsStore?: ContactsStore | null
  action: ActivityAction
  /** Identity of this row in the list's expanded/busy bookkeeping. Passed back
   * to `onToggle` so the handler can stay referentially stable across renders —
   * an inline closure here would defeat the memo below on every poll. */
  rowKey: string
  /** Live offline-queue state for this txid, when it has one. */
  offlineStatus?: string
  expanded: boolean
  busy: boolean
  /** What the spinner is waiting on. A bare spinner on a money row is a
   * question ("is it sending? cancelling?") the row can answer. */
  busyLabel?: string
  onToggle: (rowKey: string) => void
  /**
   * Open this row's detail view. When present it REPLACES the expand-in-place
   * tap: a row means one thing, and the utilities that used to unfold
   * underneath it are the detail screen's overflow menu.
   */
  onOpen?: (action: ActivityAction) => void
  onExplorer: (txid: string) => void
  onRefreshTx: (txid: string) => void
  onAbort: (reference: string) => void
  /** Rebuild and re-deliver a PeerPay token without waiting for a NACK. */
  onSendPaymentDetails?: (txid: string) => void
  /** Start a new payment (or retryDelivery) for a failed outbound row. */
  onSendAgain?: (action: ActivityAction) => void
  /** Cancel a parked payment: abort the action and retire its queue row. */
  onCancelParked?: (txid: string) => void
  /**
   * Token denomination for a `'mandala'`-labelled action.
   *
   * Absent, this row is byte-identical to the row it has always been. Present,
   * it overrides three things and only those three:
   *
   *  · the DESCRIPTION, because the lib writes a developer string containing a
   *    raw 36-byte token id and this row renders `action.description` verbatim;
   *  · the AMOUNT, because `action.satoshis` for a token send is the net BSV
   *    spent — printing "−64 sats" for a payment of 25.00 USDX would be a
   *    plausible wrong number, which is worse than a blank. When the figure
   *    cannot be recovered the row says so rather than falling through;
   *  · the FACE, because the wallet action's own labels/senderIdentityKey are
   *    meaningless for a token transfer (they describe the BSV coin-selection
   *    tx, not the counterparty) — `counterpartyKey` is the row's own word for
   *    who was on the other side, and the row draws the same generative sigil
   *    a BSV row does, keyed on it directly rather than on `counterpartyOf`.
   */
  token?: {
    title: string
    /** The figure and its unit, or undefined when it could not be recovered. */
    amount?: { value: string; unit: string }
    incoming: boolean
    /**
     * The counterparty's identity key — a received row's sender (the
     * blinded, per-payment A′; deliberately a different key on every payment
     * from the same payer, spec D2) or a sent row's payee. Undefined draws
     * the plain direction arrow instead, the same fallback a BSV row gets for
     * a counterparty it cannot name.
     */
    counterpartyKey?: string
    /** Settlement status line, in place of the chain-status words. */
    statusText?: string
    /** Settlement status as a tone + label; drives the dot as a BSV row's does. */
    status?: TxStatusView
  }
}

/** Statuses whose transaction is still local and therefore abortable: nothing
 * has been (successfully) broadcast, so releasing it is safe and frees the
 * inputs it reserved. `failed` is included because a failed action still holds
 * its input reservations until it is cleared. */
const ABORTABLE_STATUSES = new Set(['unsigned', 'nosend', 'nonfinal', 'failed'])

/** Local time of day, e.g. "14:32". Empty when storage gave us no timestamp. */
export function formatRowTime(value?: string | number | Date): string {
  if (value === undefined || value === null) return ''
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

function ActivityRowBase({
  currency,
  walletUserId,
  contactsStore,
  action,
  rowKey,
  offlineStatus,
  expanded,
  busy,
  busyLabel,
  onToggle,
  onOpen,
  onExplorer,
  onRefreshTx,
  onAbort,
  onSendPaymentDetails,
  onSendAgain,
  onCancelParked,
  token
}: Props & { currency: string }) {
  const { t } = useTranslation()
  const { colors, isDark } = useTheme()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const MaterialCommunityIcons = loadMaterialCommunityIcons()

  const incoming = token ? token.incoming : action.satoshis >= 0
  // Direction decides the settled wording ("Received" vs "Sent"), so it has to
  // be known before the status view is built.
  const view = token?.status ?? txStatusView(action.status, offlineStatus, incoming)
  const settled = view.tone === 'settled'
  const tone = toneColor(view.tone, colors as unknown as Record<string, string>)

  const { value, unit } = formatAmountParts(action.satoshis, currency, satoshisPerUSD, {
    abbreviate: true,
    compact: true,
    showPlus: true,
    usdToFiat
  })
  // The second denomination — the one the user is NOT currently displaying. It
  // is the answer to "yes, but how much is that really", which is the whole
  // reason a sats-denominated wallet needs a fiat line at all.
  const secondary = formatAmount(action.satoshis, currency === 'BSV' ? 'USD' : 'BSV', satoshisPerUSD, {
    abbreviate: true,
    compact: true,
    showPlus: true,
    usdToFiat
  })

  const time = formatRowTime(action.created_at)
  const amountColor = incoming ? colors.successAmount : colors.textPrimary
  const unitColor = incoming ? colors.successAmount : colors.textSecondary

  // Keyed on the label contents rather than on `action` or `labels`: every
  // poll hands the row a fresh action object with a fresh labels array for the
  // same transaction, so only a scalar key keeps the @p derivation from
  // re-running per poll. Newline cannot appear in a stored label, so the join
  // is unambiguous.
  const { labels, senderIdentityKey, txid } = action
  const labelsKey = labels?.join('\n') ?? ''
  // Scalars, not the `token` object itself: a fresh `token` reference every
  // poll must not re-derive the face when nothing about it actually changed.
  const isTokenRow = token !== undefined
  const tokenCounterpartyKey = token?.counterpartyKey
  const face = useMemo(() => {
    // A token row is identified by its OWN counterparty key, never by
    // `counterpartyOf(action)`: the action's labels/senderIdentityKey belong
    // to the underlying BSV coin-selection transaction, not to who the token
    // moved with. No key (an unresolvable/blinded counterparty) draws the
    // plain arrow, same as any other row this hook cannot name.
    if (isTokenRow) {
      if (!tokenCounterpartyKey) return null
      const cp: Counterparty = { kind: 'identityKey', value: tokenCounterpartyKey }
      return { point: sigilPointOf(cp), hue: counterpartyHue(cp) }
    }
    const cp = counterpartyOf({ labels: labelsKey === '' ? undefined : labelsKey.split('\n'), senderIdentityKey, txid })
    return cp ? { point: sigilPointOf(cp), hue: counterpartyHue(cp) } : null
  }, [labelsKey, senderIdentityKey, txid, isTokenRow, tokenCounterpartyKey])
  // Resolved outside the memo: the hue is a property of the counterparty, the
  // colours it maps to are a property of the theme, and the theme can flip
  // under a mounted row. Two HSL conversions per render are not worth a dep.
  const palette = face ? sigilPalette(face.hue, !!isDark) : null

  // The counterparty's own identity key, when the row can name one at all —
  // an address or a bare txid (the other two `counterpartyOf` kinds) can
  // never be a saved contact. Recomputed independently of `face` above: that
  // memo only keeps what the sigil needs (point/hue), and duplicating the
  // (pure, cheap) `counterpartyOf` call here is simpler than threading a
  // second value out of it.
  const counterpartyIdentityKey = useMemo(() => {
    if (isTokenRow) return tokenCounterpartyKey
    const cp = counterpartyOf({ labels: labelsKey === '' ? undefined : labelsKey.split('\n'), senderIdentityKey, txid })
    return cp?.kind === 'identityKey' ? cp.value : undefined
  }, [labelsKey, senderIdentityKey, txid, isTokenRow, tokenCounterpartyKey])

  // Whether the face is tappable, expanded or not (2026-09-18) — only for a
  // counterparty already saved as a contact; nobody this row cannot name a
  // saved contact for gets a tap that opens nothing.
  const [isContact, setIsContact] = useState(false)
  useEffect(() => {
    if (!counterpartyIdentityKey || !contactsStore || walletUserId == null) {
      setIsContact(false)
      return
    }
    let cancelled = false
    void contactsStore.getContact(walletUserId, counterpartyIdentityKey).then(c => {
      if (!cancelled) setIsContact(!!c)
    })
    return () => {
      cancelled = true
    }
  }, [counterpartyIdentityKey, contactsStore, walletUserId])
  const faceTappable = isContact && !!counterpartyIdentityKey
  const onPressFace = useCallback(() => {
    if (!counterpartyIdentityKey) return
    loadExpoRouter().router.push({ pathname: '/contact', params: { identityKey: counterpartyIdentityKey } } as never)
  }, [counterpartyIdentityKey])

  // A parked payment was built and shown as a code, but never released: it is
  // not on chain and no task will put it there. An explorer link would 404 and
  // a Refresh would ask the network about a transaction it has never seen, so
  // the row offers only the two things that apply. Resend goes out over the
  // message box rather than re-showing the code: if the payee is still standing
  // there, cancelling and starting again is both quicker and honest, and if
  // they are not, the remote rail is the only one that can still reach them.
  const parked = offlineStatus === 'parked'
  const canCancelParked = parked && !!action.txid && !!onCancelParked
  const canAbort = !parked && ABORTABLE_STATUSES.has(action.status) && !!action.reference
  // Any outgoing payment this wallet can re-deliver over the message box: both
  // rails write the payee's identity key as a label and the derivation data as
  // customInstructions, so the details can be sent again whether the payment
  // went out through a message box or a nearby code that may never have been
  // scanned. A token row qualifies too — the home screen routes it to the
  // Mandala runtime's own re-delivery rather than a BRC-29 rebuild.
  const resendableOutbound =
    !!action.txid &&
    (action.isOutgoing ?? !incoming) &&
    !!action.labels?.some(l => l === 'peerpay' || l === 'localpay' || l === 'mandala')
  const canResendDetails = resendableOutbound && !!onSendPaymentDetails
  const canSendAgain = !parked && !incoming && action.status === 'failed' && !!onSendAgain
  const hasUtilities = parked
    ? canResendDetails || canCancelParked
    : !!action.txid || canAbort || canResendDetails || canSendAgain

  return (
    <View
      style={[
        expanded && {
          backgroundColor: colors.surfaceRowExpanded,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline
        }
      ]}
    >
      <View style={styles.row}>
        {/* The sigil fills the tile, so direction moves to the border tint
            alone: the same tints as the arrow tile, so a mixed list still
            reads consistently down the left edge. The tile takes the
            counterparty's own colour, and the sigil is drawn in exactly that
            pair: sigil-js cuts its glyph lines in the background colour, so
            the fill must be the same solid or the cuts show as a halo.

            A separate pressable from the row below it (2026-09-18), expanded
            or not: tapping a face that names a saved contact opens their
            contact page, while tapping the rest of the row still toggles the
            chips — two touch targets, not one nested inside the other. No
            visual affordance on the tile itself (a highlight ring was tried
            and dropped) — the row already reads as tappable as a whole. */}
        {(() => {
          const tile =
            face !== null && palette !== null ? (
              <View
                style={[
                  styles.glyph,
                  styles.avatar,
                  {
                    backgroundColor: palette.background,
                    borderColor: incoming ? colors.successStrong + '2E' : colors.surfaceSunkenBorder
                  }
                ]}
              >
                <Sigil
                  point={face.point}
                  size={38}
                  foreground={palette.foreground}
                  background={palette.background}
                  detail="default"
                />
              </View>
            ) : (
              <View
                style={[
                  styles.glyph,
                  incoming
                    ? {
                        backgroundColor: colors.successStrong + '1A',
                        borderColor: colors.successStrong + '2E'
                      }
                    : { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }
                ]}
              >
                <MaterialCommunityIcons
                  name={incoming ? 'arrow-bottom-left' : 'arrow-top-right'}
                  size={16}
                  color={incoming ? colors.successStrong : colors.textSecondary}
                />
              </View>
            )
          return faceTappable ? (
            <PressableScale
              onPress={onPressFace}
              scaleTo={0.92}
              accessibilityRole="button"
              accessibilityLabel={t('activity_view_contact')}
            >
              {tile}
            </PressableScale>
          ) : (
            tile
          )
        })()}

        <PressableScale
          scaleTo={0.99}
          onPress={onOpen ? () => onOpen(action) : hasUtilities ? () => onToggle(rowKey) : undefined}
          style={styles.rowRest}
          accessibilityRole="button"
          accessibilityState={onOpen ? undefined : { expanded }}
          accessibilityLabel={
            token
              ? // Never the lib's developer description, which carries a raw
                // 36-byte token id, and never silence for a figure we could not
                // recover: "Sent USDX, amount unavailable" is the honest read.
                `${token.title}, ${
                  token.amount ? `${token.amount.value} ${token.amount.unit}` : t('token_row_amount_pending')
                }`
              : action.description || t('transactions')
          }
        >
          <View style={styles.middle}>
            <Text style={[styles.description, { color: colors.textPrimary }]} numberOfLines={1}>
              {token ? token.title : action.description || t('transactions')}
            </Text>
            <View style={styles.statusLine}>
              {/* A dot only where the tone carries a warning. A settled row is
                  the normal case, and marking every normal row green made the
                  list a wall of confirmation the eye had to read past. */}
              {settled ? null : <View style={[styles.dot, { backgroundColor: tone }]} />}
              <Text style={[styles.statusText, { color: settled ? colors.textSecondary : tone }]} numberOfLines={1}>
                {(() => {
                  const words = token?.status ? t(view.key) : (token?.statusText ?? t(view.key))
                  return time ? `${words} · ${time}` : words
                })()}
              </Text>
            </View>
          </View>

          <View style={styles.amounts}>
            {token ? (
              token.amount ? (
                // No secondary denomination line: this wallet has no price for a
                // token, and a converted figure would be invented.
                <Text
                  style={[styles.amount, { color: amountColor }]}
                  accessibilityLabel={`${token.amount.value} ${token.amount.unit}`}
                >
                  {token.amount.value}
                  <Text style={[styles.amountUnit, { color: unitColor }]}> {token.amount.unit}</Text>
                </Text>
              ) : (
                <Text style={[styles.amountSecondary, { color: colors.textTertiary }]}>
                  {t('token_row_amount_pending')}
                </Text>
              )
            ) : (
              <>
                <Text style={[styles.amount, { color: amountColor }]}>
                  {value}
                  {unit ? <Text style={[styles.amountUnit, { color: unitColor }]}> {unit}</Text> : null}
                </Text>
                <Text style={[styles.amountSecondary, { color: colors.textTertiary }]}>{secondary}</Text>
              </>
            )}
          </View>
        </PressableScale>
      </View>

      {!onOpen && expanded && hasUtilities ? (
        <View style={styles.chips}>
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
              {busyLabel ? (
                <Text style={[styles.busyLabel, { color: colors.textSecondary }]} numberOfLines={1}>
                  {busyLabel}
                </Text>
              ) : null}
            </View>
          ) : (
            <>
              {action.txid && !parked && offlineStatus !== 'queued' && offlineStatus !== 'posting' ? (
                <Chip
                  icon="refresh-outline"
                  label={t('tx_action_refresh_short')}
                  accessibilityLabel={t('tx_action_refresh')}
                  onPress={() => onRefreshTx(action.txid)}
                />
              ) : null}
              {action.txid && !parked ? (
                <Chip
                  icon="link-outline"
                  label="Explorer"
                  accessibilityLabel={t('tx_action_explorer')}
                  onPress={() => onExplorer(action.txid)}
                />
              ) : null}
              {canAbort ? (
                <Chip
                  icon="close-circle-outline"
                  label={t('cancel')}
                  accessibilityLabel={t('tx_action_abort')}
                  danger
                  onPress={() => onAbort(action.reference!)}
                />
              ) : null}
              {canResendDetails ? (
                <Chip
                  icon="send-outline"
                  label={t('tx_action_resend_short')}
                  accessibilityLabel={t('send_payment_details_again')}
                  onPress={() => onSendPaymentDetails!(action.txid)}
                />
              ) : null}
              {canCancelParked ? (
                <Chip
                  icon="close-circle-outline"
                  label={t('cancel')}
                  accessibilityLabel={t('pay_parked_cancel')}
                  danger
                  onPress={() => onCancelParked!(action.txid)}
                />
              ) : null}
              {canSendAgain ? (
                <Chip
                  icon="arrow-redo-outline"
                  label={t('send_again')}
                  accessibilityLabel={t('send_again')}
                  onPress={() => onSendAgain!(action)}
                />
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {/* Inset to the description, not the screen edge: the rule separates the
          text columns, and the glyph tiles already read as separate objects. An
          expanded row is bounded by its own surface, so it needs no rule. */}
      {expanded ? null : <View style={[styles.separator, { backgroundColor: colors.hairline }]} />}
    </View>
  )
}

function Chip({
  icon,
  label,
  accessibilityLabel,
  onPress,
  danger
}: {
  icon: keyof IoniconsComponent['glyphMap']
  label: string
  accessibilityLabel: string
  onPress: () => void
  danger?: boolean
}) {
  const { colors } = useTheme()
  const color = danger ? colors.error : colors.textSecondary
  const Ionicons = loadIonicons()
  return (
    <PressableScale
      onPress={onPress}
      haptic="tap"
      style={[styles.chip, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Ionicons name={icon} size={12} color={color} />
      <Text style={[styles.chipLabel, { color }]}>{label}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: 13,
    paddingBottom: 11
  },
  // The face's touch target and the rest of the row's are two separate
  // pressables side by side; `rowRest` reproduces `row`'s own inner spacing
  // for the middle/amounts pair so splitting them changes no spacing.
  rowRest: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  glyph: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  // Clips the square sigil to the tile's rounded corners.
  avatar: { overflow: 'hidden' },
  middle: { flex: 1, minWidth: 0 },
  // 14.5/500 rather than body 17/400: the row is scanned, not read, and at 17pt
  // the description crowds the amount on narrow phones.
  description: { fontSize: 14.5, fontWeight: '500', letterSpacing: -0.1, lineHeight: 19 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  statusText: { fontSize: 12, lineHeight: 16, flexShrink: 1 },
  amounts: { alignItems: 'flex-end' },
  amount: { fontSize: 14.5, fontWeight: '600', lineHeight: 19, fontVariant: ['tabular-nums'] },
  amountUnit: { fontSize: 12, fontWeight: '500' },
  amountSecondary: { fontSize: 11.5, lineHeight: 15, marginTop: 2, fontVariant: ['tabular-nums'] },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingLeft: 70, // aligns the chip row with the description, past the glyph
    paddingRight: spacing.xl,
    paddingTop: 2,
    paddingBottom: 14
  },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 8 },
  busyLabel: { ...typography.subhead },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 70 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth
  },
  chipLabel: { fontSize: 12, fontWeight: '600' }
})

// Compare every prop: callbacks and busyLabel must also update, otherwise a
// retained row can invoke a previous network's handler or show stale progress.
const MemoActivityRow = memo(ActivityRowBase)

function ConnectedActivityRow(props: Props) {
  const { settings } = useWallet()
  return <MemoActivityRow {...props} currency={settings?.currency || 'BSV'} />
}

/** Preserve the existing package API for hosts that omit currency; the home
 * screen supplies it so background wallet updates cannot invalidate each row. */
export default function ActivityRow(props: Props) {
  return props.currency === undefined ? (
    <ConnectedActivityRow {...props} />
  ) : (
    <MemoActivityRow {...props} currency={props.currency} />
  )
}
