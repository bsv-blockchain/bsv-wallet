/**
 * Consent copy for the BRC-207 color module's `requestTokenAccess` messages
 * (IC §2.5). Field names are the module 0.2.0's own (`actionConsent` /
 * `transactionConsent` for `color_send` / `color_signature`). Every amount on
 * the wire is a canonical decimal string (IC §0) and is shown exactly, never
 * through a JS number. Asset metadata (ticker, decimals) is host-resolved and
 * untrusted, so the full asset id is always shown beside it.
 *
 * Anything this file cannot read in full returns `null`: the sheet then shows
 * a deny-only prompt, because a request it cannot enumerate must never be
 * approvable (XR-040 carried forward).
 */
import { formatAmount, parseDecimalAmount } from '@bsv/mandala'
import { COLOR_PROMPT_TYPES, type ColorPromptType } from '../../../core/mandala/accessPolicy'

export type { ColorPromptType } from '../../../core/mandala/accessPolicy'

export interface ColorPromptView {
  type: ColorPromptType
  title: string
  lines: { label: string; value: string }[]
  warning?: string
}

type AssetInfo = (assetId: string) => { ticker: string; decimals: number } | undefined
type Translate = (key: string, o?: object) => string

/** A display ceiling: real requests carry a handful of legs; past this the request is not enumerated. */
const MAX_ASSETS = 25
const MAX_DESTINATIONS = 100
const MAX_OUTPUTS = 1000
const MAX_SIGNERS = 100
const MAX_SIGNATURES = 1000

const ASSET_ID = /^[0-9a-f]{64}_(0|[1-9][0-9]*)$/
const OUTPOINT = /^[0-9a-f]{64}\.(0|[1-9][0-9]*)$/
const ISSUE = 'ISSUE'

const TITLE_KEYS: Record<ColorPromptType, string> = {
  color_send: 'color_prompt_send_title',
  color_signature: 'color_prompt_signature_title',
  color_access: 'color_prompt_access_title',
  color_relinquish: 'color_prompt_relinquish_title'
}

/** Thrown inside this file only: the message is not fully readable. */
class Unreadable extends Error {}

function fail(): never {
  throw new Unreadable()
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function amountOf(v: unknown): bigint {
  const units = parseDecimalAmount(v)
  return units === null ? fail() : units
}

function countOf(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail()
}

function assetIdOf(v: unknown, allowIssue = false): string {
  if (typeof v !== 'string') fail()
  if (allowIssue && v === ISSUE) return v
  return ASSET_ID.test(v) ? v : fail()
}

function listOf(v: unknown, max: number, allowEmpty = false): unknown[] {
  if (!Array.isArray(v) || v.length > max || (!allowEmpty && v.length === 0)) fail()
  return v
}

function stringsOf(v: unknown, max: number): string[] {
  const list = listOf(v, max, true)
  return list.every(s => typeof s === 'string') ? (list as string[]) : fail()
}

/** `units` of `assetId` for a person: `<decimal> <ticker>` when the asset's
 * metadata is usable, otherwise the exact base units. */
function unitsText(units: bigint, assetId: string, assetInfo: AssetInfo): string {
  let meta: { ticker: string; decimals: number } | undefined
  try {
    meta = assetId === ISSUE ? undefined : assetInfo(assetId)
  } catch {
    meta = undefined
  }
  const ticker = typeof meta?.ticker === 'string' ? meta.ticker.trim() : ''
  if (meta !== undefined && ticker.length > 0) {
    try {
      return `${formatAmount(units, meta.decimals)} ${ticker}`
    } catch {
      // decimals outside 0..18: fall through to exact base units
    }
  }
  return `${units.toString()} units`
}

function describeTransaction(
  m: Record<string, unknown>,
  type: 'color_send' | 'color_signature',
  assetInfo: AssetInfo
): ColorPromptView['lines'] {
  const lines: ColorPromptView['lines'] = []
  const push = (label: string, value: string): void => {
    lines.push({ label, value })
  }
  const assets = listOf(m.assets, MAX_ASSETS, true)
  const destinations = listOf(m.destinations, MAX_DESTINATIONS, true)
  const satoshis = isRecord(m.satoshis) ? m.satoshis : fail()
  const fee = satoshis.fee
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee)) fail()
  const lockTime = countOf(m.lockTime)
  listOf(m.signatures, MAX_SIGNATURES, true)
  if (assets.length === 0 && m.deploy === undefined) fail()

  if (type === 'color_signature') push('Signs input', String(countOf(m.inputIndex)))
  if (type === 'color_send' && m.handoff === true) push('Delivery', 'Recipient completes it (hand-over)')

  if (m.deploy !== undefined) {
    const deploy = isRecord(m.deploy) ? m.deploy : fail()
    push('Issues new asset', `${amountOf(deploy.amount).toString()} units`)
  }

  for (const raw of assets) {
    const a = isRecord(raw) ? raw : fail()
    const assetId = assetIdOf(a.assetId)
    const show = (units: bigint): string => unitsText(units, assetId, assetInfo)
    const outgoing = amountOf(a.outgoingAmount)
    const kept = amountOf(a.keptAmount)
    const input = amountOf(a.inputAmount)
    const foreign = amountOf(a.foreignAmount)
    const burned = amountOf(a.burned)
    const minted = amountOf(a.minted)
    amountOf(a.transferred)
    const outgoingAuthorities = countOf(a.outgoingAuthorities)
    const keptAuthorities = countOf(a.keptAuthorities)
    const authorityInputs = countOf(a.authorityInputs)
    countOf(a.foreignAuthorityInputs)
    if (a.operations !== undefined) stringsOf(a.operations, 16)

    push('Asset ID', assetId)
    push('Sending', show(outgoing))
    if (kept !== 0n) push('Kept as change', show(kept))
    if (input !== 0n) push('Spent from this wallet', show(input))
    if (foreign !== 0n) push('From another wallet', show(foreign))
    if (burned !== 0n) push('Burned', show(burned))
    if (minted !== 0n) push('Minted', show(minted))
    if (authorityInputs > 0) push('Authorities spent', String(authorityInputs))
    if (outgoingAuthorities > 0) push('Authorities sent', String(outgoingAuthorities))
    if (keptAuthorities > 0) push('Authorities kept', String(keptAuthorities))
  }

  for (const raw of destinations) {
    const d = isRecord(raw) ? raw : fail()
    const index = countOf(d.outputIndex)
    if (d.assetId !== undefined) {
      const assetId = assetIdOf(d.assetId, true)
      const units = amountOf(d.amount)
      const what = d.role === 'authority' ? 'authority' : unitsText(units, assetId, assetInfo)
      push(`Output ${index}`, what)
    } else {
      push(`Output ${index}`, `${countOf(d.satoshis)} sats`)
    }
  }

  push('Network fee', `${fee} sats`)
  if (lockTime !== 0) push('Lock time', String(lockTime))
  return lines
}

function describeAccess(m: Record<string, unknown>): ColorPromptView['lines'] {
  const lines: ColorPromptView['lines'] = []
  if (typeof m.basket === 'string') lines.push({ label: 'Reads', value: m.basket })
  else if (m.labels !== undefined) {
    const labels = stringsOf(m.labels, 100)
    lines.push({ label: 'Reads', value: labels.length > 0 ? labels.join(', ') : 'token activity' })
  } else fail()
  if (m.assetId !== undefined) lines.push({ label: 'Asset ID', value: assetIdOf(m.assetId) })
  if (m.role !== undefined) {
    if (m.role !== 'value' && m.role !== 'authority') fail()
    lines.push({ label: 'Holding', value: m.role })
  }
  return lines
}

function describeRelinquish(m: Record<string, unknown>): ColorPromptView['lines'] {
  const assetId = assetIdOf(m.assetId)
  if (m.role !== 'value' && m.role !== 'authority') fail()
  const outpoint = typeof m.outpoint === 'string' && OUTPOINT.test(m.outpoint) ? m.outpoint : fail()
  return [
    { label: 'Asset ID', value: assetId },
    { label: 'Holding', value: m.role as string },
    { label: 'Outpoint', value: outpoint }
  ]
}

/**
 * What a color consent message asks, for the permission sheet. `null` when the
 * message is not fully readable (bad JSON, an unknown type, a missing member, a
 * JSON-number or non-canonical amount, an oversized list): the sheet then shows
 * a generic deny-only prompt.
 */
export function describeColorRequest(message: string, assetInfo: AssetInfo, t: Translate): ColorPromptView | null {
  let m: unknown
  try {
    m = JSON.parse(message)
  } catch {
    return null
  }
  if (!isRecord(m) || typeof m.type !== 'string') return null
  if (!(COLOR_PROMPT_TYPES as readonly string[]).includes(m.type)) return null
  const type = m.type as ColorPromptType
  try {
    let lines: ColorPromptView['lines']
    switch (type) {
      case 'color_send':
      case 'color_signature':
        lines = describeTransaction(m, type, assetInfo)
        break
      case 'color_access':
        lines = describeAccess(m)
        break
      case 'color_relinquish':
        lines = describeRelinquish(m)
        break
    }
    return { type, title: t(TITLE_KEYS[type]), lines }
  } catch {
    // Unreadable, or any other failure while building the view: fail closed to the deny-only prompt.
    return null
  }
}
