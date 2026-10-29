import React, { useContext, useState, useCallback, useMemo, useEffect, useRef, useSyncExternalStore } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, AppState } from 'react-native'
import type { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import type { SigningPolicyPermissionsManager } from '../../../core/services/signingPermissionPolicy'
import Sheet from './Sheet'
import PressableScale from './PressableScale'
import { useTranslation } from 'react-i18next'
import AmountDisplay from '../wallet/AmountDisplay'
import { describeProtocolPrompt } from './protocolPrompt'
import type { PendingConsent } from '../../../core/bridge/consent'
import {
  answerConnection,
  connectionFlags,
  getPendingConnections,
  subscribeConsentRequests
} from '../../../core/bridge/consentSheetSource'
import { SEEK_FLAG_DISCLOSURE, SEEK_FLAG_KEYS, type SeekFlags } from '../../../core/bridge/permissionPolicy'
import { getSheetBackdropDismisses, onSheetBackdropDismissesChange } from './sheetResumeSignal'
import { hostnameOfUnattested, isUnattestedOriginator } from '../../../core/bridge/unverifiedOriginator'
import {
  spacing,
  radii,
  typography,
  useTheme,
  WalletContext,
  UserContext,
  ExchangeRateContext,
  formatAmountParts,
  haptics
} from '@bsv/expo-wallet-toolbox'

// ---------------------------------------------------------------------------
// Dev preview — set to true to keep the BTMS spend sheet visible for design work
// ---------------------------------------------------------------------------
const DEV_BTMS_PREVIEW = false

/** How long Authorize stays inert when a connection or unverified prompt reaches the head (spec 6.4). */
const managerTokens = new WeakMap<object, number>()
let managerTokenCount = 0
/** A stable small number per manager object, '-' for a prompt that has none. */
function managerToken(manager: unknown): string {
  if (manager === null || typeof manager !== 'object') return '-'
  let n = managerTokens.get(manager)
  if (n === undefined) {
    n = ++managerTokenCount
    managerTokens.set(manager, n)
  }
  return String(n)
}

const TAP_PROTECTION_MS = 700

// ---------------------------------------------------------------------------
// @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
// etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
// that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
// Loaded lazily, only when actually rendering, same pattern as this
// package's other native-module-boundary fixes (expo-router, expo-blur).
// ---------------------------------------------------------------------------
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PermissionKind = 'protocol' | 'basket' | 'certificate' | 'spending' | 'group' | 'btms' | 'mandala' | 'connection'

interface GroupProtocol {
  protocolID: [number, string]
  counterparty?: string
  description?: string
}
interface GroupBasket {
  basket: string
  description?: string
}
interface GroupCertificate {
  type: string
  verifierPublicKey?: string
  fields?: string[]
  description?: string
}
interface GroupSpending {
  amount: number
  description?: string
}
interface GroupPermissions {
  protocolPermissions?: GroupProtocol[]
  basketAccess?: GroupBasket[]
  certificateAccess?: GroupCertificate[]
  spendingAuthorization?: GroupSpending
}

type GrantedGroupPermissions = Parameters<WalletPermissionsManager['grantGroupedPermission']>[0]['granted']

/** Common shape derived from the four existing modals. */
export interface ActivePermission {
  kind: PermissionKind
  requestID: string
  /** The manager that raised the request: the one the answer goes to. */
  manager?: SigningPolicyPermissionsManager
  originator: string
  title: string
  description: string
  /** `unit` is split out so amounts can set the figure and its unit at
   * different sizes; rows whose value is not an amount simply omit it. */
  details: { label: string; value: string; unit?: string }[]
  /** Certificate-specific list of required fields. */
  fields?: string[]
  /** Spending-specific authorization amount (satoshis). */
  amount?: number
  /** Whether this is a renewal rather than a first-time request. */
  renewal?: boolean
  /** Group-specific sub-permissions. */
  groupPermissions?: GroupPermissions
  /**
   * XR-040: set when a `mandala_spend`/`mandala_credit` prompt's per-asset
   * `lines` could not be trusted to be the WHOLE request (absent, malformed,
   * empty, or past `MANDALA_MAX_PROMPT_LINES`) — every asset a single
   * approval would release has to be shown, and a request this sheet cannot
   * fully enumerate must never be approvable. `handleDeny` is unaffected;
   * only the Allow control reads this.
   */
  approvalBlocked?: boolean
  /**
   * The prompt came from a website the wallet could not verify (spec 6.5). `originator` then holds
   * the plain hostname, with the `.<grantTag>.unverified.invalid` suffix already stripped.
   */
  unverified?: boolean
  /** Text the website supplied about itself (a manifest). Shown quoted, after the wallet's own words. */
  siteSays?: string
  /** `connection` only: what the sheet tells the user connecting allows (spec 6.4). */
  connection?: {
    transportId: string
    connectedBefore: boolean
    /** i18n keys, in `SEEK_FLAG_KEYS` order. */
    allows: string[]
    asksFirst: string[]
    /** i18n key of the payments line, absent when the payment flag is off and listed under `allows`. */
    payments?: string
  }
}

/** One line of a `mandala_spend`/`mandala_credit` prompt's `lines[]` array,
 * as loosely as a JSON.parse of counterparty-adjacent data should be trusted. */
interface MandalaPromptLine {
  assetId?: unknown
  sendAmount?: unknown
  changeAmount?: unknown
  creditAmount?: unknown
  tokenName?: unknown
  /** Pre-formatted, e.g. "25.00 USDX" — see `MandalaSpendLine`/`MandalaCreditLine`. */
  display?: unknown
}

/**
 * A sane display ceiling for a multi-asset Mandala prompt. Every real prompt
 * this app's own `MandalaTokenModule` builds groups by assetId — a handful at
 * most — so a `lines` array past this is either a bug or a bad-faith caller,
 * either way not something to enumerate as if it were the whole request.
 */
const MANDALA_MAX_PROMPT_LINES = 25

/**
 * `promptData.lines`, validated into a bounded array of loosely-typed line
 * objects — or `null` for anything this sheet cannot enumerate in full
 * (absent, not an array, empty, oversized, or containing a non-object entry).
 * `null` is the caller's signal to block approval rather than silently fall
 * back to the primary-only view (XR-040).
 */
function sanitizedMandalaLines(raw: unknown): MandalaPromptLine[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MANDALA_MAX_PROMPT_LINES) return null
  const lines: MandalaPromptLine[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null
    lines.push(entry as MandalaPromptLine)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The originator a prompt shows. An unverified site reaches the wallet as
 * `<hostname>.<grantTag>.unverified.invalid`; the user sees the hostname and the badge, never the suffix.
 */
function presentOriginator(raw: string): { originator: string; unverified: boolean } {
  return isUnattestedOriginator(raw)
    ? { originator: hostnameOfUnattested(raw), unverified: true }
    : { originator: raw, unverified: false }
}

/**
 * What a site said about itself, kept apart from the wallet's own wording for an unverified site.
 * A verified site's text keeps the old inline treatment.
 */
function siteWords(
  unverified: boolean,
  text: string | undefined,
  own: string
): { description: string; siteSays?: string } {
  if (!unverified) return { description: text || own }
  return { description: own, siteSays: text || undefined }
}

/** Builds the `connection` prompt from a pending consent request and the flags that apply to it. */
function deriveConnection(c: PendingConsent, flags: SeekFlags): ActivePermission {
  const unverified = c.attestation === 'unattested'
  const allows: string[] = []
  const asksFirst: string[] = []
  for (const key of SEEK_FLAG_KEYS) {
    // Payments have their own line below; only a payment flag that is off needs listing.
    if (key === 'seekSpendingPermissions' && flags[key]) continue
    ;(flags[key] ? asksFirst : allows).push(SEEK_FLAG_DISCLOSURE[key][flags[key] ? 'on' : 'off'])
  }
  return {
    kind: 'connection',
    requestID: c.requestId,
    originator: c.origin,
    unverified,
    title: 'Connect Website',
    description: 'wants to connect to your wallet',
    details: [],
    // The manifest group previewed before the sheet (spec 6.12); Connect mints exactly this.
    groupPermissions: c.groupPermissions ?? undefined,
    connection: {
      transportId: c.transportId,
      connectedBefore: c.connectedBefore,
      allows,
      asksFirst,
      payments: flags.seekSpendingPermissions
        ? unverified
          ? 'bridge_payments_unverified'
          : 'bridge_payments_verified'
        : undefined
    }
  }
}

/**
 * Derive the human-friendly "what is being asked" description for each
 * permission type. Technical specifics go into the expandable Details section.
 */
// Exported so the mandala prompt's own display-building logic (XR-040) is
// unit-testable without rendering the whole sheet's component tree.
export function deriveActive(
  ctx: {
    protocolRequests: any[]
    basketRequests: any[]
    certificateRequests: any[]
    spendingRequests: any[]
    groupRequests?: any[]
    /** Pending site-connection requests, with the flags that describe each one. */
    connectionRequests?: PendingConsent[]
    connectionFlags?: (attestation: PendingConsent['attestation']) => SeekFlags
    btmsRequests: any[]
    mandalaRequests: any[]
    protocolAccessModalOpen: boolean
    basketAccessModalOpen: boolean
    certificateAccessModalOpen: boolean
    spendingAuthorizationModalOpen: boolean
  },
  formatSats: (satoshis: number) => { value: string; unit: string }
): ActivePermission | null {
  // Dev preview — override ctx with real captured data so the description
  // logic below is exercised exactly as it would be in production.
  if (DEV_BTMS_PREVIEW) {
    ctx = {
      ...ctx,
      btmsRequests: [
        {
          originator: 'btms.metanet.app',
          message: JSON.stringify({
            type: 'btms_spend',
            sendAmount: 23,
            tokenName: 'Goose',
            assetId: '615a06abf1b0eeac9ff1f8ac438bb1de830f70144e94b9868cad55f47d08f924.0',
            changeAmount: 17,
            totalInputAmount: 40
          }),
          resolve: () => {}
        }
      ]
    }
  }

  // Priority: spending > certificate > protocol > basket > btms > mandala (spending
  // is most time-sensitive). We show only one at a time — exactly like the originals.

  if (ctx.spendingAuthorizationModalOpen && ctx.spendingRequests.length > 0) {
    const r = ctx.spendingRequests[0]
    // Map lineItems [{type, satoshis, description}] to detail rows
    const lineItemDetails: { label: string; value: string; unit?: string }[] = (r.lineItems ?? []).map(
      (item: { description?: string; satoshis: number }) => ({
        label: item.description || 'Payment',
        ...formatSats(item.satoshis)
      })
    )
    const who = presentOriginator(r.originator || 'Unknown app')
    return {
      kind: 'spending',
      requestID: r.requestID,
      manager: r.manager,
      originator: who.originator,
      unverified: who.unverified,
      title: 'Spending Authorization',
      ...siteWords(who.unverified, r.description, 'wants to spend from your wallet'),
      amount: r.authorizationAmount,
      renewal: r.renewal,
      details: lineItemDetails
    }
  }

  // A website asking to connect. Core-owned, so it is not one of the manager queues above.
  if (ctx.connectionRequests && ctx.connectionRequests.length > 0 && ctx.connectionFlags) {
    const c = ctx.connectionRequests[0]
    return deriveConnection(c, ctx.connectionFlags(c.attestation))
  }

  // A site's grouped request (its manifest's metanet.groupPermissions) is the
  // whole set it will use, asked once when it connects.
  if (ctx.groupRequests && ctx.groupRequests.length > 0) {
    const r = ctx.groupRequests[0]
    const who = presentOriginator(r.originator)
    return {
      kind: 'group',
      requestID: r.requestID,
      manager: r.manager,
      originator: who.originator,
      unverified: who.unverified,
      title: 'Permissions',
      description: 'wants these permissions',
      details: [],
      groupPermissions: r.permissions
    }
  }

  if (ctx.certificateAccessModalOpen && ctx.certificateRequests.length > 0) {
    const r = ctx.certificateRequests[0]
    const certType = r.certificate?.certType ?? r.certificateType
    const verifier = r.certificate?.verifier ?? r.verifierPublicKey
    const fieldsArray: string[] = r.fieldsArray ?? (r.certificate?.fields ? Object.keys(r.certificate.fields) : [])

    const details: { label: string; value: string }[] = []
    if (certType) details.push({ label: 'Certificate type', value: certType })
    if (verifier) details.push({ label: 'Verifier', value: truncate(verifier, 20) })

    const who = presentOriginator(r.originator || 'Unknown app')
    return {
      kind: 'certificate',
      requestID: r.requestID,
      manager: r.manager,
      originator: who.originator,
      unverified: who.unverified,
      title: r.renewal ? 'Certificate Access Renewal' : 'Certificate Access',
      ...siteWords(who.unverified, r.description, 'wants to access certificate information'),
      renewal: r.renewal,
      fields: fieldsArray.length > 0 ? fieldsArray : undefined,
      details
    }
  }

  if (ctx.protocolAccessModalOpen && ctx.protocolRequests.length > 0) {
    const r = ctx.protocolRequests[0]
    const prompt = describeProtocolPrompt(r.protocolID ?? '', r.counterparty, r.keyID)
    const details: { label: string; value: string }[] = [
      { label: 'Protocol', value: truncate(prompt.protocolLabel, 40) },
      { label: 'Security level', value: String(r.protocolSecurityLevel) }
    ]
    if (prompt.counterpartyLabel) details.push({ label: 'Shared with', value: prompt.counterpartyLabel })
    if (prompt.keyIDLabel) details.push({ label: 'Key ID', value: truncate(prompt.keyIDLabel, 40) })
    if (prompt.askEveryTime) details.push({ label: 'Approval', value: 'This signature only' })
    const who = presentOriginator(r.originator || 'Unknown app')
    return {
      kind: 'protocol',
      requestID: r.requestID,
      manager: r.manager,
      originator: who.originator,
      unverified: who.unverified,
      title: r.renewal ? `${prompt.title} Renewal` : prompt.title,
      // The wallet's own wording for a known protocol; otherwise whatever the site said.
      ...(prompt.description !== undefined
        ? { description: prompt.description, siteSays: who.unverified ? r.description || undefined : undefined }
        : siteWords(who.unverified, r.description, 'wants to use a cryptographic protocol')),
      renewal: r.renewal,
      details
    }
  }

  if (ctx.basketAccessModalOpen && ctx.basketRequests.length > 0) {
    const r = ctx.basketRequests[0]
    const who = presentOriginator(r.originator || 'Unknown app')
    return {
      kind: 'basket',
      requestID: r.requestID,
      manager: r.manager,
      originator: who.originator,
      unverified: who.unverified,
      title: r.renewal ? 'Basket Access Renewal' : 'Basket Access',
      ...siteWords(who.unverified, r.reason, 'wants to access a transaction basket'),
      renewal: r.renewal,
      details: r.basket ? [{ label: 'Basket', value: r.basket }] : []
    }
  }

  // btms: driven purely by queue length — no separate modal-open flag needed
  if (ctx.btmsRequests.length > 0) {
    const r = ctx.btmsRequests[0]
    let promptData: {
      type?: string
      action?: string
      assetId?: string
      sendAmount?: number
      tokenName?: string
      changeAmount?: number
      totalInputAmount?: number
      burnAmount?: number
      burnAll?: boolean
    } = {}
    try {
      promptData = JSON.parse(r.message)
    } catch {
      // message not valid JSON — ignore, use defaults
    }

    // Build a human-readable description using amount + token name where available
    let description: string
    if (promptData.type === 'btms_spend' && promptData.sendAmount != null && promptData.tokenName) {
      description = `wants to spend ${promptData.sendAmount} ${promptData.tokenName} tokens`
    } else if (promptData.type === 'btms_burn' && promptData.burnAmount != null && promptData.tokenName) {
      description = `wants to burn ${promptData.burnAmount} ${promptData.tokenName} tokens`
    } else {
      description = `wants to ${promptData.action || 'access BTMS tokens'}`
    }

    const details: { label: string; value: string }[] = []
    if (promptData.tokenName) details.push({ label: 'Token', value: promptData.tokenName })
    if (promptData.sendAmount != null) details.push({ label: 'Send amount', value: String(promptData.sendAmount) })
    if (promptData.changeAmount != null) details.push({ label: 'Change', value: String(promptData.changeAmount) })
    if (promptData.totalInputAmount != null)
      details.push({ label: 'Total input', value: String(promptData.totalInputAmount) })
    if (promptData.assetId) details.push({ label: 'Asset ID', value: truncate(promptData.assetId, 28) })

    return {
      kind: 'btms',
      // btms requests are resolved via advanceBtmsQueue, not permissionsManager — use a sentinel requestID
      requestID: '',
      ...presentOriginator(r.originator || 'Unknown app'),
      title: 'Token Spend Request',
      description,
      details
    }
  }

  // mandala: same shape as btms above — driven purely by queue length, resolved via advanceMandalaQueue
  if (ctx.mandalaRequests.length > 0) {
    const r = ctx.mandalaRequests[0]
    let promptData: {
      type?: string
      action?: string
      assetId?: string
      tokenName?: string
      sendAmount?: number
      changeAmount?: number
      creditAmount?: number
      lines?: unknown
      // XR-041: relinquishOutput's own resolved-target fields.
      amount?: number
      display?: string
      outpoint?: string
    } = {}
    try {
      promptData = JSON.parse(r.message)
    } catch {
      // message not valid JSON — ignore, use defaults
    }

    const isRelinquish = promptData.type === 'mandala_access' && promptData.action === 'relinquishOutput'
    // XR-041: `display` is pre-formatted ("25.00 USDX"); fall back to the raw
    // base-unit amount + token name when it is not a string, same convention
    // as the spend/credit lines below.
    const relinquishAmount =
      typeof promptData.display === 'string'
        ? promptData.display
        : promptData.amount != null
          ? `${promptData.amount} ${promptData.tokenName || 'Mandala tokens'}`
          : undefined

    let description: string
    if (promptData.type === 'mandala_spend' && promptData.sendAmount != null) {
      description = `wants to spend ${promptData.sendAmount} ${promptData.tokenName || 'Mandala tokens'}`
    } else if (promptData.type === 'mandala_credit' && promptData.creditAmount != null) {
      description = `wants to credit ${promptData.creditAmount} ${promptData.tokenName || 'Mandala tokens'} to your wallet`
    } else if (isRelinquish && relinquishAmount) {
      // Named, not generic (XR-041): which holding, not just that "a" holding
      // is being removed.
      description = `wants to remove ${relinquishAmount} from your wallet`
    } else if (isRelinquish) {
      description = 'wants to remove a Mandala token holding from your wallet'
    } else if (promptData.type === 'mandala_access') {
      description = 'wants to see your Mandala token balance'
    } else if (promptData.type === 'mandala_signature') {
      description = 'wants to sign with one of your token keys. Only approve if you just asked this app to move tokens'
    } else {
      description = 'wants to access Mandala tokens'
    }

    const details: { label: string; value: string }[] = []
    let approvalBlocked = false

    if (promptData.type === 'mandala_spend' || promptData.type === 'mandala_credit') {
      // XR-040: `lines` carries EVERY asset this request touches — rendering
      // only the primary (back-compat) fields below is how a single approval
      // silently released a second, unshown asset. Every sanitized line is
      // rendered; an unsanitizable `lines` blocks approval instead of falling
      // back to a primary-only view that looks complete but is not.
      const lines = sanitizedMandalaLines(promptData.lines)
      if (lines === null) {
        approvalBlocked = true
        details.push({
          label: 'Warning',
          value: 'Could not verify this is the full request — deny and try again.'
        })
      } else {
        const numbered = lines.length > 1
        lines.forEach((line, i) => {
          const suffix = numbered ? ` ${i + 1}` : ''
          if (typeof line.tokenName === 'string' && line.tokenName) {
            details.push({ label: `Token${suffix}`, value: line.tokenName })
          }
          if (typeof line.sendAmount === 'number') {
            details.push({
              label: `Send amount${suffix}`,
              value: typeof line.display === 'string' ? line.display : String(line.sendAmount)
            })
          }
          if (typeof line.changeAmount === 'number' && line.changeAmount !== 0) {
            details.push({ label: `Change${suffix}`, value: String(line.changeAmount) })
          }
          if (typeof line.creditAmount === 'number') {
            details.push({
              label: `Credit amount${suffix}`,
              value: typeof line.display === 'string' ? line.display : String(line.creditAmount)
            })
          }
          if (typeof line.assetId === 'string' && line.assetId) {
            details.push({ label: `Asset ID${suffix}`, value: truncate(line.assetId, 28) })
          }
        })
      }
    } else if (isRelinquish) {
      // XR-041: identify the target the same way mandala_spend/mandala_credit
      // already identify theirs — token, amount, and the exact outpoint.
      if (promptData.tokenName) details.push({ label: 'Token', value: promptData.tokenName })
      if (relinquishAmount) details.push({ label: 'Amount', value: relinquishAmount })
      if (promptData.assetId) details.push({ label: 'Asset ID', value: truncate(promptData.assetId, 28) })
      if (promptData.outpoint) details.push({ label: 'Outpoint', value: truncate(promptData.outpoint, 28) })
    } else {
      if (promptData.assetId) details.push({ label: 'Asset ID', value: truncate(promptData.assetId, 28) })
    }

    // Said in the ALWAYS-VISIBLE description, not only the collapsed Details
    // section — the whole point is that this cannot be missed on the way to
    // an (already-disabled) Allow button.
    if (approvalBlocked) {
      description =
        'wants to spend or credit Mandala tokens, but the full request could not be verified — deny and try again.'
    }

    return {
      kind: 'mandala',
      // mandala requests are resolved via advanceMandalaQueue, not permissionsManager — use a sentinel requestID
      requestID: '',
      ...presentOriginator(r.originator || 'Unknown app'),
      title: 'Token Spend Request',
      description,
      details,
      approvalBlocked
    }
  }

  return null
}

/** The browser named on a verified connection. Only Safari attests today; anything else is generic. */
function browserName(transportId: string, t: (key: string) => string): string {
  return /^safari/i.test(transportId) ? 'Safari' : t('bridge_browser_generic')
}

function truncate(str: string, max: number): string {
  if (!str) return ''
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

/**
 * The permissions a site asks for as read-only sections (spending with its amount, protocols, baskets,
 * certificates). No checkbox and no switch: the set is granted or refused as a whole. Shared by the
 * group sheet and the merged Connect sheet (spec 6.12).
 */
function GroupPermissionSections({ group, unverified }: { group: GroupPermissions; unverified?: boolean }) {
  const { t } = useTranslation()
  const { colors } = useTheme()
  // A manifest's own words for an unverified site are shown as the site's quote (spec 6.5).
  const quoted = (text: string) => (unverified ? `\u201C${text}\u201D` : text)
  return (
    <>
      {group.spendingAuthorization && (
        <View style={[styles.groupSection, { borderColor: colors.separator }]}>
          <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>{t('spending_section')}</Text>
          <View style={styles.groupRow}>
            <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>
              <AmountDisplay>{group.spendingAuthorization.amount}</AmountDisplay>
            </Text>
            {group.spendingAuthorization.description && (
              <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>
                {quoted(group.spendingAuthorization.description)}
              </Text>
            )}
          </View>
        </View>
      )}
      {group.protocolPermissions && group.protocolPermissions.length > 0 && (
        <View style={[styles.groupSection, { borderColor: colors.separator }]}>
          <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>{t('protocols_section')}</Text>
          {group.protocolPermissions.map((p, i) => (
            <View key={i} style={styles.groupRow}>
              <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>
                {describeProtocolPrompt(p.protocolID[1], p.counterparty).protocolLabel}
              </Text>
              {p.description && (
                <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>{quoted(p.description)}</Text>
              )}
            </View>
          ))}
        </View>
      )}
      {group.basketAccess && group.basketAccess.length > 0 && (
        <View style={[styles.groupSection, { borderColor: colors.separator }]}>
          <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>{t('baskets_section')}</Text>
          {group.basketAccess.map((b, i) => (
            <View key={i} style={styles.groupRow}>
              <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>{b.basket}</Text>
              {b.description && (
                <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>{quoted(b.description)}</Text>
              )}
            </View>
          ))}
        </View>
      )}
      {group.certificateAccess && group.certificateAccess.length > 0 && (
        <View style={[styles.groupSection, { borderColor: colors.separator }]}>
          <Text style={[styles.groupSectionTitle, { color: colors.textSecondary }]}>{t('certificates_section')}</Text>
          {group.certificateAccess.map((c, i) => (
            <View key={i} style={styles.groupRow}>
              <Text style={[styles.groupRowLabel, { color: colors.textPrimary }]}>{c.type}</Text>
              {c.description && (
                <Text style={[styles.groupRowDesc, { color: colors.textSecondary }]}>{quoted(c.description)}</Text>
              )}
              {c.fields && c.fields.length > 0 && (
                <Text style={[styles.groupRowDesc, { color: colors.textTertiary }]}>Fields: {c.fields.join(', ')}</Text>
              )}
            </View>
          ))}
        </View>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * True while any permission sheet is open or queued (every manager queue, the BTMS and mandala queues and
 * the website connection requests). The Safari bridge's done screen stays hidden while this is true, and a
 * later sheet replaces it (spec 6.12).
 */
export function usePermissionSheetBusy(): boolean {
  const {
    protocolRequests,
    basketRequests,
    certificateRequests,
    spendingRequests,
    groupRequests,
    btmsRequests,
    mandalaRequests
  } = useContext(WalletContext)
  const connections = useSyncExternalStore(subscribeConsentRequests, getPendingConnections, getPendingConnections)
  return (
    (protocolRequests?.length ?? 0) +
      (basketRequests?.length ?? 0) +
      (certificateRequests?.length ?? 0) +
      (spendingRequests?.length ?? 0) +
      (groupRequests?.length ?? 0) +
      (btmsRequests?.length ?? 0) +
      (mandalaRequests?.length ?? 0) +
      connections.length >
    0
  )
}

const PermissionSheet: React.FC = () => {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const Ionicons = loadIonicons()

  const {
    protocolRequests,
    basketRequests,
    certificateRequests,
    spendingRequests,
    groupRequests,
    btmsRequests,
    mandalaRequests,
    advanceProtocolQueue,
    advanceBasketQueue,
    advanceCertificateQueue,
    advanceSpendingQueue,
    advanceGroupQueue,
    advanceBtmsQueue,
    advanceMandalaQueue,
    settings
  } = useContext(WalletContext)

  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const currency = settings?.currency || 'BSV'
  const formatSats = useCallback(
    (satoshis: number) => formatAmountParts(satoshis, currency, satoshisPerUSD, { abbreviate: true, usdToFiat }),
    [currency, satoshisPerUSD, usdToFiat]
  )

  const {
    protocolAccessModalOpen,
    setProtocolAccessModalOpen,
    basketAccessModalOpen,
    setBasketAccessModalOpen,
    certificateAccessModalOpen,
    setCertificateAccessModalOpen,
    spendingAuthorizationModalOpen,
    setSpendingAuthorizationModalOpen
  } = useContext(UserContext)

  const connectionRequests = useSyncExternalStore(
    subscribeConsentRequests,
    getPendingConnections,
    getPendingConnections
  )

  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [granted, setGranted] = useState(false)
  const grantTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Stores the executeGrant closure that is scheduled but not yet fired, so it
  // can be flushed synchronously if a higher-priority request preempts.
  const pendingGrantRef = useRef<(() => void) | null>(null)

  // Whether the request a pending answer was meant for is still in its queue.
  // A withdrawal (profile switch, logout) empties the queues, and the new
  // wallet's manager can then raise a request with the very same ID, so a
  // request is the same one only if it also came from the same manager.
  const queuesRef = useRef({ protocolRequests, basketRequests, certificateRequests, spendingRequests, groupRequests })
  queuesRef.current = { protocolRequests, basketRequests, certificateRequests, spendingRequests, groupRequests }
  const stillQueued = useCallback((request: ActivePermission): boolean => {
    // Connection requests live in the consent store; ids there are never reused.
    if (request.kind === 'connection') return getPendingConnections().some(c => c.requestId === request.requestID)
    const q = queuesRef.current
    const list: any[] | undefined = {
      protocol: q.protocolRequests,
      basket: q.basketRequests,
      certificate: q.certificateRequests,
      spending: q.spendingRequests,
      group: q.groupRequests
    }[request.kind as 'protocol' | 'basket' | 'certificate' | 'spending' | 'group']
    return !!list?.some(r => r.requestID === request.requestID && r.manager === request.manager)
  }, [])

  // Closes a queue's modal flag after its head was answered, unless another request is still queued behind it: the
  // sheet shows a head only while the flag is set, so closing it would hide the next request (its queue only opens the
  // flag when it goes from empty to non-empty). An emptied queue closes the flag itself; this is for the same step.
  const closeUnlessQueued = useCallback(
    (kind: 'protocol' | 'basket' | 'certificate' | 'spending', answeredID: string, close: (open: boolean) => void) => {
      const q = queuesRef.current
      const list: any[] | undefined = {
        protocol: q.protocolRequests,
        basket: q.basketRequests,
        certificate: q.certificateRequests,
        spending: q.spendingRequests
      }[kind]
      if (list?.some(r => r.requestID !== answeredID)) return
      close(false)
    },
    []
  )

  // Clear the pending grant timer (or flush it) on unmount to prevent stale handler calls.
  useEffect(() => {
    return () => {
      if (grantTimerRef.current !== null) {
        clearTimeout(grantTimerRef.current)
        grantTimerRef.current = null
      }
      if (pendingGrantRef.current !== null) {
        pendingGrantRef.current()
        pendingGrantRef.current = null
      }
    }
  }, [])

  // React Native pauses JS timers while the app is backgrounded, so a grant waiting out its 400 ms would
  // leave the page's call hanging if the user leaves right after tapping. Answer at once instead.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' || pendingGrantRef.current === null) return
      if (grantTimerRef.current !== null) {
        clearTimeout(grantTimerRef.current)
        grantTimerRef.current = null
      }
      pendingGrantRef.current()
      pendingGrantRef.current = null
    })
    return () => sub.remove()
  }, [])

  // Derive what (if anything) we should show.
  const active = useMemo(
    () =>
      deriveActive(
        {
          protocolRequests,
          basketRequests,
          certificateRequests,
          spendingRequests,
          groupRequests,
          connectionRequests,
          connectionFlags,
          btmsRequests,
          mandalaRequests,
          protocolAccessModalOpen,
          basketAccessModalOpen,
          certificateAccessModalOpen,
          spendingAuthorizationModalOpen
        },
        formatSats
      ),
    [
      protocolRequests,
      basketRequests,
      certificateRequests,
      spendingRequests,
      groupRequests,
      connectionRequests,
      btmsRequests,
      mandalaRequests,
      protocolAccessModalOpen,
      basketAccessModalOpen,
      certificateAccessModalOpen,
      spendingAuthorizationModalOpen,
      formatSats
    ]
  )

  const visible = active !== null

  // Figure and unit are set at different sizes, so they have to be formatted
  // apart — same treatment as the wallet balance.
  const amountParts = useMemo(
    () =>
      active?.kind === 'spending' && active.amount != null
        ? formatAmountParts(active.amount, currency, satoshisPerUSD, { abbreviate: true, usdToFiat })
        : { value: '', unit: '' },
    [active, currency, satoshisPerUSD, usdToFiat]
  )

  // Reset granted morph whenever a new permission request arrives.
  // Keyed on requestID so repeated requests (even same kind) each start fresh.
  // If a grant was pending (400 ms timer still running), flush it synchronously
  // before switching to the new request so the user's confirmation is honoured.
  const activeRequestID = active?.requestID
  useEffect(() => {
    if (grantTimerRef.current !== null) {
      clearTimeout(grantTimerRef.current)
      grantTimerRef.current = null
    }
    if (pendingGrantRef.current !== null) {
      pendingGrantRef.current()
      pendingGrantRef.current = null
    }
    setGranted(false)
  }, [activeRequestID])

  // Tap protection (spec 6.4): a connection or unverified prompt cannot be approved for the first
  // 700 ms it is at the head of the queue, so a tap aimed at the previous sheet cannot land on it.
  // Keyed on the head's identity, so a request queueing behind it does not restart the window.
  const needsTapDelay = active !== null && (active.kind === 'connection' || active.unverified === true)
  // The manager is part of the identity: a replacement manager restarts its request counters, so a
  // re-raised prompt can repeat the kind, id, originator and description of the one before it.
  const headKey = active
    ? `${active.kind}|${managerToken(active.manager)}|${active.requestID}|${active.originator}|${active.description}`
    : ''
  const [armedKey, setArmedKey] = useState('')
  useEffect(() => {
    // A new head, or none, is never armed from an earlier head's window.
    setArmedKey('')
    if (!needsTapDelay) return
    const timer = setTimeout(() => setArmedKey(headKey), TAP_PROTECTION_MS)
    return () => clearTimeout(timer)
  }, [needsTapDelay, headKey])
  const tapLocked = needsTapDelay && armedKey !== headKey

  // ---- Deny ----
  const handleDeny = useCallback(async () => {
    if (granted) return
    if (!active) return
    haptics.warning()
    if (active.kind === 'connection') {
      await answerConnection(active.requestID, false).catch((e: unknown) =>
        console.warn('[bridge] connection decline failed', e)
      )
    } else if (active.kind === 'btms') {
      // BTMS uses its own promise-based resolution — no permissionsManager.denyPermission
      advanceBtmsQueue(false)
    } else if (active.kind === 'mandala') {
      // Mandala uses its own promise-based resolution too — no permissionsManager.denyPermission
      advanceMandalaQueue(false)
    } else if (active.kind === 'group') {
      // Grant none of the set, but let the site carry on: each permission is
      // then asked for on its own when used. A hard deny would make the
      // site's waitForAuthentication throw.
      try {
        await active.manager?.dismissGroupedPermission(active.requestID)
      } catch {
        // Already settled (e.g. the site went away) -- nothing left to answer.
      }
      if (stillQueued(active)) advanceGroupQueue(active.requestID)
    } else {
      try {
        await active.manager?.denyPermission(active.requestID)
      } catch {
        // User denial is expected -- not an error condition
      }
      // The answer went to the manager that raised the request; the queue
      // loses it only if it is still the same one (see stillQueued).
      if (stillQueued(active)) {
        switch (active.kind) {
          case 'protocol':
            advanceProtocolQueue(active.requestID)
            closeUnlessQueued('protocol', active.requestID, setProtocolAccessModalOpen)
            break
          case 'basket':
            advanceBasketQueue(active.requestID)
            closeUnlessQueued('basket', active.requestID, setBasketAccessModalOpen)
            break
          case 'certificate':
            advanceCertificateQueue(active.requestID)
            closeUnlessQueued('certificate', active.requestID, setCertificateAccessModalOpen)
            break
          case 'spending':
            advanceSpendingQueue(active.requestID)
            closeUnlessQueued('spending', active.requestID, setSpendingAuthorizationModalOpen)
            break
        }
      }
    }
    setDetailsExpanded(false)
  }, [
    granted,
    active,
    stillQueued,
    closeUnlessQueued,
    advanceProtocolQueue,
    advanceBasketQueue,
    advanceCertificateQueue,
    advanceSpendingQueue,
    advanceGroupQueue,
    advanceBtmsQueue,
    advanceMandalaQueue,
    setProtocolAccessModalOpen,
    setBasketAccessModalOpen,
    setCertificateAccessModalOpen,
    setSpendingAuthorizationModalOpen
  ])

  // ---- Grant ----
  // Runs the actual grant logic (queue advance + modal close). Separated so
  // the UI can show the checkmark morph for 400 ms before dismissal.
  // Takes an explicit snapshot of the request to act on so it is safe to call
  // from the flush-on-preempt path where `active` may have already changed.
  const executeGrant = useCallback(
    (request: ActivePermission) => {
      // Clear the pending ref so flush-on-preempt guards don't double-fire.
      pendingGrantRef.current = null

      if (request.kind === 'connection') {
        // The store drops the answer if the request is gone or the wallet has changed.
        answerConnection(request.requestID, true).catch((e: unknown) =>
          console.warn('[bridge] connection approval failed', e)
        )
      } else if (request.kind === 'btms') {
        advanceBtmsQueue(true)
      } else if (request.kind === 'mandala') {
        advanceMandalaQueue(true)
      } else if (!stillQueued(request)) {
        // Withdrawn while the checkmark showed (a profile switch or logout
        // emptied the queue): the manager that raised it is gone and what is
        // queued now is not this request. Answer nothing, drop nothing.
      } else if (request.kind === 'group') {
        // Grants exactly the set shown. The manager mints the permission
        // tokens, then resolves the site's waitForAuthentication; if minting
        // fails it rejects that call itself.
        request.manager
          ?.grantGroupedPermission({
            requestID: request.requestID,
            // The manager's own request object, passed back unchanged.
            granted: (request.groupPermissions ?? {}) as GrantedGroupPermissions
          })
          .catch((error: unknown) => console.warn('[permissions] grouped grant failed', error))
        advanceGroupQueue(request.requestID)
      } else if (request.kind === 'spending') {
        request.manager
          ?.grantPermission({
            requestID: request.requestID,
            ephemeral: true,
            amount: request.amount
          })
          .catch((error: unknown) => console.warn('[permissions] grant failed', error))
        advanceSpendingQueue(request.requestID)
        closeUnlessQueued('spending', request.requestID, setSpendingAuthorizationModalOpen)
      } else {
        request.manager
          ?.grantPermission({
            requestID: request.requestID
          })
          .catch((error: unknown) => console.warn('[permissions] grant failed', error))
        switch (request.kind) {
          case 'protocol':
            advanceProtocolQueue(request.requestID)
            closeUnlessQueued('protocol', request.requestID, setProtocolAccessModalOpen)
            break
          case 'basket':
            advanceBasketQueue(request.requestID)
            closeUnlessQueued('basket', request.requestID, setBasketAccessModalOpen)
            break
          case 'certificate':
            advanceCertificateQueue(request.requestID)
            closeUnlessQueued('certificate', request.requestID, setCertificateAccessModalOpen)
            break
        }
      }
      setDetailsExpanded(false)
      // Reset granted so that consecutive BTMS/Mandala requests (sharing sentinel requestID '')
      // don't leave the sheet permanently in granted state / deadlocked.
      setGranted(false)
    },
    [
      stillQueued,
      closeUnlessQueued,
      advanceProtocolQueue,
      advanceBasketQueue,
      advanceCertificateQueue,
      advanceSpendingQueue,
      advanceGroupQueue,
      advanceBtmsQueue,
      advanceMandalaQueue,
      setProtocolAccessModalOpen,
      setBasketAccessModalOpen,
      setCertificateAccessModalOpen,
      setSpendingAuthorizationModalOpen
    ]
  )

  const backdropDismisses = useSyncExternalStore(onSheetBackdropDismissesChange, getSheetBackdropDismisses)
  const noop = useCallback(() => {}, [])

  const handleGrant = useCallback(() => {
    // XR-040: belt-and-braces alongside the Allow button's own `disabled` —
    // a mandala_spend/mandala_credit prompt whose `lines` this sheet could
    // not fully enumerate must never be approvable, from any call path.
    if (!active || granted || active.approvalBlocked || tapLocked) return
    haptics.success()
    setGranted(true)
    if (grantTimerRef.current !== null) {
      clearTimeout(grantTimerRef.current)
    }
    // Capture the request at grant time — executeGrant now takes it explicitly.
    const requestSnapshot = active
    const pendingFn = () => executeGrant(requestSnapshot)
    pendingGrantRef.current = pendingFn
    grantTimerRef.current = setTimeout(() => {
      grantTimerRef.current = null
      pendingFn()
    }, 400)
  }, [active, granted, tapLocked, executeGrant])

  return (
    <Sheet visible={visible} onClose={backdropDismisses ? handleDeny : noop} heightPercent={0.92} fitContent>
      {active && (
        <View>
          <View style={styles.content}>
            {/* -------- Originator / domain -------- */}
            <View style={styles.originatorRow}>
              <View
                style={[
                  styles.faviconPlaceholder,
                  { backgroundColor: colors.surfaceSunken, borderColor: colors.surfaceSunkenBorder }
                ]}
              >
                <Text style={[styles.faviconLetter, { color: colors.successStrong }]}>
                  {(active.originator[0] ?? '?').toUpperCase()}
                </Text>
              </View>
              <View style={styles.originatorText}>
                <Text
                  style={[
                    styles.originator,
                    active.unverified || active.kind === 'connection' ? styles.originatorMono : null,
                    { color: colors.textPrimary }
                  ]}
                  numberOfLines={1}
                  testID="bridge-connect-origin"
                >
                  {active.originator}
                </Text>
                {active.kind === 'connection' && active.connection && !active.unverified && (
                  <Text style={[styles.originatorSub, { color: colors.textSecondary }]} numberOfLines={1}>
                    {t('bridge_verified_by', { browser: browserName(active.connection.transportId, t) })}
                  </Text>
                )}
              </View>
              {active.unverified && (
                <View style={[styles.unverifiedBadge, { backgroundColor: colors.warning + '26' }]}>
                  <Text style={[styles.unverifiedBadgeText, { color: colors.warning }]}>
                    {t('bridge_badge_unverified')}
                  </Text>
                </View>
              )}
            </View>
            {active.unverified && (
              <Text style={[styles.channelNote, { color: colors.textSecondary }]}>
                {t('bridge_unverified_channel')}
              </Text>
            )}

            {/* -------- Renewal badge -------- */}
            {active.renewal && (
              <View style={[styles.renewalBadge, { backgroundColor: colors.accentSecondary + '1A' }]}>
                <Text style={[styles.renewalText, { color: colors.accentSecondary }]}>{t('renewal')}</Text>
              </View>
            )}

            {/* -------- Site connection: what connecting allows, in the wallet's words -------- */}
            {active.kind === 'connection' && active.connection && (
              <ScrollView style={styles.groupScroll} bounces={false}>
                <Text style={[styles.connectHeader, { color: colors.textSecondary }]}>{t('bridge_allows_header')}</Text>
                {['bridge_allows_sign_in', ...active.connection.allows].map(key => (
                  <Text key={key} style={[styles.connectItem, { color: colors.textPrimary }]}>
                    {'\u2022'} {t(key)}
                  </Text>
                ))}
                {active.connection.asksFirst.length > 0 && (
                  <>
                    <Text style={[styles.connectHeader, { color: colors.textSecondary }]}>
                      {t('bridge_asks_header')}
                    </Text>
                    {active.connection.asksFirst.map(key => (
                      <Text key={key} style={[styles.connectItem, { color: colors.textPrimary }]}>
                        {'\u2022'} {t(key)}
                      </Text>
                    ))}
                  </>
                )}
                {active.connection.payments && (
                  <Text style={[styles.connectNote, { color: colors.textPrimary }]}>
                    {t(active.connection.payments)}
                  </Text>
                )}
                <Text style={[styles.connectNote, { color: colors.textSecondary }]}>
                  {t(active.unverified ? 'bridge_remember_unverified' : 'bridge_remember_verified')}
                </Text>
                {active.unverified && active.connection.connectedBefore && (
                  <Text style={[styles.connectNote, { color: colors.textPrimary }]}>
                    {t('bridge_connected_before')}
                  </Text>
                )}
                {active.groupPermissions && (
                  <GroupPermissionSections group={active.groupPermissions} unverified={active.unverified} />
                )}
              </ScrollView>
            )}

            {/* -------- Group permissions list -------- */}
            {active.kind === 'group' && active.groupPermissions && (
              <ScrollView style={styles.groupScroll} bounces={false}>
                <GroupPermissionSections group={active.groupPermissions} unverified={active.unverified} />
              </ScrollView>
            )}

            {/* -------- Expandable details (scrollable if tall) -------- */}
            {active.kind !== 'group' && (active.details.length > 0 || (active.fields && active.fields.length > 0)) && (
              <View style={styles.detailsSection}>
                <TouchableOpacity
                  onPress={() => setDetailsExpanded(prev => !prev)}
                  style={styles.detailsToggle}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.detailsToggleText, { color: colors.textSecondary }]}>
                    {detailsExpanded ? t('hide_details') : t('details')}
                  </Text>
                  <Ionicons
                    name={detailsExpanded ? 'chevron-up' : 'chevron-down'}
                    size={12}
                    color={colors.textSecondary}
                    style={styles.chevron}
                  />
                </TouchableOpacity>

                {detailsExpanded && (
                  <ScrollView
                    style={[
                      styles.detailsCard,
                      { backgroundColor: colors.surfaceRowExpanded, borderColor: colors.surfaceRaisedBorder }
                    ]}
                    bounces={false}
                  >
                    {active.details.map((d, i) => (
                      <View key={i} style={styles.detailRow}>
                        <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{d.label}</Text>
                        <Text style={[styles.detailValue, { color: colors.textPrimary }]} numberOfLines={1}>
                          {d.value}
                          {d.unit ? (
                            <Text style={[styles.detailUnit, { color: colors.textSecondary }]}> {d.unit}</Text>
                          ) : null}
                        </Text>
                      </View>
                    ))}
                    {active.fields && active.fields.length > 0 && (
                      <>
                        <Text style={[styles.detailLabel, { color: colors.textSecondary, marginTop: spacing.sm }]}>
                          {t('requested_fields')}
                        </Text>
                        {active.fields.map((f, i) => (
                          <Text key={i} style={[styles.fieldItem, { color: colors.textPrimary }]}>
                            {'\u2022'} {f}
                          </Text>
                        ))}
                      </>
                    )}
                  </ScrollView>
                )}
              </View>
            )}

            {/* -------- The ask, then the figure. The sentence is the quiet
                     half: it says what for, the amount says how much. -------- */}
            <View style={styles.askBlock}>
              <Text style={[styles.description, { color: colors.textSecondary }]}>{active.description}</Text>

              {active.siteSays ? (
                <View style={[styles.siteSays, { borderColor: colors.separator }]}>
                  <Text style={[styles.siteSaysLabel, { color: colors.textTertiary }]}>{t('bridge_site_says')}</Text>
                  <Text style={[styles.siteSaysText, { color: colors.textSecondary }]}>
                    {'\u201C'}
                    {active.siteSays}
                    {'\u201D'}
                  </Text>
                </View>
              ) : null}

              {active.kind === 'spending' && active.amount != null && (
                <Text style={[styles.amountValue, { color: colors.textPrimary }]}>
                  {amountParts.value}
                  {amountParts.unit ? (
                    <Text style={[styles.amountUnit, { color: colors.textSecondary }]}> {amountParts.unit}</Text>
                  ) : null}
                </Text>
              )}
            </View>
          </View>

          {/* -------- Action buttons — pinned at bottom, never move -------- */}
          <View style={styles.buttonRow}>
            <PressableScale
              style={[
                styles.buttonDeny,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }
              ]}
              onPress={handleDeny}
              disabled={granted}
              testID="bridge-deny"
            >
              <Text style={[styles.buttonDenyText, { color: colors.textPrimary }]}>
                {t(active.kind === 'connection' ? 'bridge_dont_connect' : 'reject')}
              </Text>
            </PressableScale>

            {/* Accent-filled and the only shadowed element in the drawer, so the
                confirming action is unmistakable without being coloured green —
                chroma here would read as "safe" before the user has read it. */}
            <PressableScale
              style={[styles.buttonAllow, { backgroundColor: colors.accent }]}
              onPress={handleGrant}
              disabled={granted || active.approvalBlocked || tapLocked}
              testID="bridge-approve"
            >
              {granted ? (
                <Ionicons name="checkmark" size={22} color={colors.textOnAccent} />
              ) : (
                <Text style={[styles.buttonAllowText, { color: colors.textOnAccent }]}>
                  {t(active.kind === 'connection' ? 'bridge_connect' : 'authorize')}
                </Text>
              )}
            </PressableScale>
          </View>
        </View>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm
  },

  // Originator
  originatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  faviconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md
  },
  faviconLetter: {
    fontSize: 17,
    fontWeight: '700'
  },
  originatorText: {
    flex: 1
  },
  originator: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.1
  },
  // The raw origin is the identity being asked about, so it is set in a face where lookalike
  // characters stay distinct.
  originatorMono: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 14,
    letterSpacing: 0
  },
  originatorSub: {
    ...typography.caption1,
    marginTop: 1
  },
  unverifiedBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    marginLeft: spacing.sm
  },
  unverifiedBadgeText: {
    ...typography.caption1,
    fontWeight: '700'
  },
  channelNote: {
    ...typography.footnote,
    marginBottom: spacing.md
  },
  connectHeader: {
    ...typography.caption1,
    fontWeight: '600',
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  },
  connectItem: {
    ...typography.footnote,
    marginLeft: spacing.sm,
    marginTop: 2
  },
  connectNote: {
    ...typography.footnote,
    marginTop: spacing.md
  },
  siteSays: {
    borderLeftWidth: 2,
    paddingLeft: spacing.md,
    marginTop: spacing.lg,
    alignSelf: 'stretch'
  },
  siteSaysLabel: {
    ...typography.caption1,
    fontWeight: '600',
    marginBottom: 2
  },
  siteSaysText: {
    ...typography.footnote,
    fontStyle: 'italic'
  },

  // Renewal badge
  renewalBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    marginBottom: spacing.md
  },
  renewalText: {
    ...typography.caption1,
    fontWeight: '600'
  },

  // The ask
  askBlock: {
    alignItems: 'center',
    paddingTop: spacing.xxl
  },
  description: {
    fontSize: 13.5,
    lineHeight: 18,
    textAlign: 'center'
  },
  amountValue: {
    fontSize: 42,
    fontWeight: '700',
    lineHeight: 44,
    letterSpacing: -1.1,
    marginTop: 9,
    fontVariant: ['tabular-nums']
  },
  amountUnit: {
    fontSize: 19,
    fontWeight: '600',
    letterSpacing: 0
  },

  // Details
  detailsSection: {
    marginBottom: 0
  },
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs
  },
  detailsToggleText: {
    fontSize: 12.5,
    fontWeight: '600'
  },
  chevron: {
    marginLeft: 6
  },
  detailsCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: 5,
    marginTop: spacing.md,
    maxHeight: 180
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10
  },
  detailLabel: {
    fontSize: 13,
    flexShrink: 1
  },
  detailValue: {
    fontSize: 13.5,
    fontWeight: '600',
    textAlign: 'right',
    fontVariant: ['tabular-nums']
  },
  detailUnit: {
    fontSize: 11.5,
    fontWeight: '500'
  },
  fieldItem: {
    ...typography.footnote,
    marginLeft: spacing.md,
    marginTop: spacing.xs
  },

  // Group permissions
  // Sized to its rows like every other prompt; a long set scrolls instead
  // of pushing the buttons off screen.
  groupScroll: {
    maxHeight: 420
  },
  groupSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    marginBottom: spacing.sm
  },
  groupSectionTitle: {
    ...typography.caption1,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs
  },
  groupRow: {
    paddingVertical: spacing.xs
  },
  groupRowLabel: {
    ...typography.subhead,
    fontWeight: '500'
  },
  groupRowDesc: {
    ...typography.footnote,
    marginTop: 1
  },

  // Buttons — pinned outside ScrollView so they never move. No rule above them:
  // the whitespace under the amount already separates reading from acting, and
  // a hairline there boxed the figure in.
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: spacing.xl,
    paddingTop: 22,
    paddingBottom: 40
  },
  buttonDeny: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonDenyText: {
    fontSize: 15,
    fontWeight: '600'
  },
  buttonAllow: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4
  },
  buttonAllowText: {
    fontSize: 15,
    fontWeight: '700'
  }
})

export default PermissionSheet
