/**
 * Token money, formatted so the wallet never prints a number it cannot stand
 * behind (ux §1 principle 4).
 *
 * Amounts are exact `bigint` token units on every hop (IC §0, 0162:143): a
 * per-output amount reaches 2^64-1 and a balance is an unbounded sum, both far
 * past 2^53, where a JS number silently rounds. Nothing in this file turns a
 * token amount into a number — not for the digits, not for the grouping.
 *
 * Two rules the lib's helpers do not enforce and cannot be bent to:
 *
 *  1. FIXED decimals, never trimmed. `1,240.00 USDX` is money; `1,240 USDX` is
 *     a quantity, and the difference is what a holder reads as "cents exist
 *     here". The lib's own `formatAmount` right-trims, so every figure in the
 *     design is unreachable through it; the split below pads instead.
 *  2. Integer arithmetic only. The split is string surgery on the integer's
 *     decimal digits, so the printed digits are exactly the digits that are
 *     owned.
 *
 * Parsing is the lib's `parseAmount` (the uint64 bound, the decimals bound and
 * the display grammar live there once), wrapped so a bad keystroke is `null`
 * rather than a throw.
 *
 * There is deliberately no fiat path and no currency symbol: the wallet has no
 * price for a token and a `$` beside a USD-ticker balance would be the wallet
 * vouching for someone else's peg (ux §6.1).
 */
import { parseAmount } from '@bsv/mandala'

/**
 * XR-043: mirrored at every other boundary that ever reads a token's
 * decimals — `core/localpay/session.ts`'s session codec and the runtime's
 * asset-metadata resolution enforce the same bound at THEIR boundaries; this
 * is the last line of defense inside the formatters themselves, since a
 * decimals value can reach here from a path neither of those touches (a stale
 * cached asset, a test double, a future caller). It is also BRC-162's own
 * `dec` bound (0..18), the one the lib's `parseAmount` enforces.
 */
const MAX_TOKEN_DECIMALS = 18

function decimalsOk(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_TOKEN_DECIMALS
}

/**
 * The device locale's grouping separator, read off a formatted sample number
 * (the device's default locale, as the wallet always grouped token figures).
 * Only the separator comes from the locale; a token amount's digits never
 * pass through a number. Falls back to `,` when the platform's Intl cannot
 * answer, and to none for a locale that does not group.
 */
function groupSeparator(): string {
  try {
    const part = new Intl.NumberFormat(undefined, { useGrouping: true })
      .formatToParts(1000000)
      .find(p => p.type === 'group')
    return part ? part.value : ''
  } catch {
    return ','
  }
}

/** `'1240'` → `'1,240'`, in threes from the right, on the digit string itself. */
function groupInteger(digits: string): string {
  const sep = groupSeparator()
  if (!sep || digits.length <= 3) return digits
  let out = ''
  for (let i = digits.length; i > 0; i -= 3) {
    const chunk = digits.slice(Math.max(0, i - 3), i)
    out = out ? `${chunk}${sep}${out}` : chunk
  }
  return out
}

/**
 * `124000n` at 2 dp → `"1,240.00"`. Negative inputs keep their sign (a sent
 * row); anything that is not a `bigint`, or a decimals value outside 0..18, is
 * refused with `null` rather than rendered as a rounded or `NaN` figure, so a
 * caller that forgot to guard prints nothing instead of nonsense.
 */
export function formatTokenAmount(units: bigint, decimals: number, opts: { showPlus?: boolean } = {}): string | null {
  if (typeof units !== 'bigint' || !decimalsOk(decimals)) return null
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0')
  const intPart = digits.slice(0, digits.length - decimals)
  const fracPart = digits.slice(digits.length - decimals)
  const body = decimals === 0 ? groupInteger(intPart) : `${groupInteger(intPart)}.${fracPart}`
  const sign = negative ? '−' : opts.showPlus ? '+' : ''
  return `${sign}${body}`
}

/** `"1,240.00"` + `"USDX"` — the two halves a money figure is drawn from. */
export function tokenAmountParts(
  units: bigint,
  asset: { decimals: number; ticker: string },
  opts: { showPlus?: boolean } = {}
): { value: string; unit: string } | null {
  const value = formatTokenAmount(units, asset.decimals, opts)
  if (value === null) return null
  return { value, unit: asset.ticker }
}

/** `"1,240.00 USDX"` — the one string VoiceOver reads for a token figure. */
export function formatTokenAmountWithUnit(
  units: bigint,
  asset: { decimals: number; ticker: string },
  opts: { showPlus?: boolean } = {}
): string | null {
  const parts = tokenAmountParts(units, asset, opts)
  return parts && `${parts.value} ${parts.unit}`
}

/**
 * W10: what part of a held balance is pending and what part is settled, as
 * the two lines a balance row adds under its figure — or `null` when nothing
 * is pending (the figure alone is the whole story) or a figure cannot be
 * formatted.
 *
 * `units` is everything spendable (the `p color balance` view, offline credits
 * included) and `offlineUnits` the part tagged `color_offline`; the settled
 * part is the difference, never a sum. The runtime already clamps
 * `offlineUnits` to `units`; it is clamped again here so a stale or mocked
 * figure can never print a negative settled amount.
 */
export function tokenBalanceSplit(
  balance: { asset: { decimals: number; ticker: string }; units: bigint; offlineUnits: bigint },
  t: (key: string, values?: Record<string, unknown>) => string
): { pending: string; settled: string } | null {
  const { asset, units, offlineUnits } = balance
  if (typeof units !== 'bigint' || typeof offlineUnits !== 'bigint' || offlineUnits <= 0n) return null
  const pendingUnits = offlineUnits > units ? units : offlineUnits
  const pending = formatTokenAmountWithUnit(pendingUnits, asset)
  const settled = formatTokenAmountWithUnit(units - pendingUnits, asset)
  if (pending === null || settled === null) return null
  return {
    pending: t('token_balance_pending', { amount: pending }),
    settled: t('token_balance_settled', { amount: settled })
  }
}

/**
 * A typed display figure back to token units, for the amount field.
 *
 * Returns `null` for anything that is not a payable per-output amount: blank,
 * junk, a sign, more decimal places than the asset has, zero, or more than
 * `MAX_UINT64` (0162:143). The field never emits a fraction or a rounded
 * figure: the wire takes exact integers, and a rounded one would silently pay
 * a different amount than the one on screen.
 */
export function parseTokenAmount(text: string, decimals: number): bigint | null {
  if (typeof text !== 'string' || !decimalsOk(decimals)) return null
  let units: bigint
  try {
    units = parseAmount(text, decimals)
  } catch {
    return null
  }
  return units > 0n ? units : null
}

/**
 * Exact token units from an amount field's emitted value — the plain digit
 * string `AmountInput` writes in token mode — or `undefined` when it is not a
 * positive figure (blank, junk, a fraction, a sign, zero). Never through a
 * number, and never rounded into a figure.
 */
export function tokenUnitsFromField(text: string): bigint | undefined {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!/^[0-9]+$/.test(trimmed)) return undefined
  const units = BigInt(trimmed)
  return units > 0n ? units : undefined
}

/**
 * The input mask for an asset's decimals: digits, one point, at most N places.
 *
 * XR-043: clamped rather than refused (unlike the formatters above) — this
 * always has to return SOME usable mask for the field to render with, so an
 * out-of-range `decimals` is treated as `MAX_TOKEN_DECIMALS` instead of
 * reaching an unbounded regex quantifier.
 */
export function tokenAmountMask(decimals: number): RegExp {
  const bounded = Number.isFinite(decimals) ? decimals : 0
  const d = Math.min(MAX_TOKEN_DECIMALS, Math.max(0, Math.floor(bounded)))
  return d === 0 ? /^\d*$/ : new RegExp(`^\\d*\\.?\\d{0,${d}}$`)
}

/** Token units → the exact display string the amount field should hold. */
export function tokenAmountInputText(units: bigint, decimals: number): string {
  const formatted = formatTokenAmount(units, decimals)
  if (formatted === null) return ''
  // The field is typed, not read: no grouping separators or sign, which a
  // decimal-pad cannot produce and `parseTokenAmount` would refuse on the next
  // keystroke.
  return formatted.replace(/[^0-9.]/g, '')
}

/**
 * A short, human-scannable form of a long `'<64-hex>_<vout>'` assetId —
 * `"a1b2c3d4…ef01_0"`. A pure string helper kept here so the UI layer does
 * not reach into `core/mandala` for it.
 *
 * XR-044: an issuer-chosen ticker/label is not unique — a look-alike asset
 * from a different issuer can share both. `assetId` is the one thing that
 * cannot collide, so every asset-selection row and the final send
 * confirmation show this fingerprint alongside the ticker/label, not instead
 * of it.
 */
export function shortAssetId(assetId: string): string {
  if (!assetId || assetId.length <= 16) return assetId
  return `${assetId.slice(0, 8)}…${assetId.slice(-6)}`
}
