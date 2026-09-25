/**
 * Token money, formatted so the wallet never prints a number it cannot stand
 * behind (ux §1 principle 4).
 *
 * Two rules the BSV helpers do not enforce and cannot be bent to:
 *
 *  1. FIXED decimals, never trimmed. `1,240.00 USDX` is money; `1,240 USDX` is
 *     a quantity, and the difference is what a holder reads as "cents exist
 *     here". The lib's own `formatAmount` right-trims, so every figure in the
 *     design is unreachable through it.
 *  2. Integer arithmetic only. A balance is base units; dividing by 10^decimals
 *     in floating point and then rounding is how a wallet prints 1,239.99 for
 *     124000 at 2 dp. The split below is string surgery on the integer, so the
 *     printed digits are exactly the digits that are owned.
 *
 * There is deliberately no fiat path and no currency symbol: the wallet has no
 * price for a token and a `$` beside a USD-ticker balance would be the wallet
 * vouching for someone else's peg (ux §6.1).
 */

/** Grouping separators for the integer part, in the device's own locale. */
function groupInteger(digits: string): string {
  const n = Number(digits)
  if (!Number.isFinite(n)) return digits
  // Safe: the integer part of a base-unit figure is always smaller than the
  // figure itself, and anything past 2^53 is already unrepresentable upstream.
  return n.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })
}

/**
 * `1240000` at 2 dp → `"1,240.00"`. Negative inputs keep their sign; a
 * non-finite input is refused with `null` rather than rendered as `NaN`, so a
 * caller that forgot to guard prints nothing instead of nonsense.
 */
export function formatTokenAmount(
  baseUnits: number,
  decimals: number,
  opts: { showPlus?: boolean } = {}
): string | null {
  if (!Number.isFinite(baseUnits) || !Number.isFinite(decimals) || decimals < 0) return null
  const d = Math.floor(decimals)
  const rounded = Math.round(Math.abs(baseUnits))
  const digits = String(rounded).padStart(d + 1, '0')
  const intPart = d === 0 ? digits : digits.slice(0, digits.length - d)
  const fracPart = d === 0 ? '' : digits.slice(digits.length - d)
  const body = d === 0 ? groupInteger(intPart) : `${groupInteger(intPart)}.${fracPart}`
  const sign = baseUnits < 0 ? '−' : opts.showPlus ? '+' : ''
  return `${sign}${body}`
}

/** `"1,240.00"` + `"USDX"` — the two halves a money figure is drawn from. */
export function tokenAmountParts(
  baseUnits: number,
  asset: { decimals: number; ticker: string },
  opts: { showPlus?: boolean } = {}
): { value: string; unit: string } | null {
  const value = formatTokenAmount(baseUnits, asset.decimals, opts)
  if (value === null) return null
  return { value, unit: asset.ticker }
}

/** `"1,240.00 USDX"` — the one string VoiceOver reads for a token figure. */
export function formatTokenAmountWithUnit(
  baseUnits: number,
  asset: { decimals: number; ticker: string },
  opts: { showPlus?: boolean } = {}
): string | null {
  const parts = tokenAmountParts(baseUnits, asset, opts)
  return parts && `${parts.value} ${parts.unit}`
}

/**
 * A typed display figure back to base units, for the amount field.
 *
 * Returns `null` for anything that is not a whole number of base units — blank,
 * junk, or more decimal places than the asset has. The field never emits a
 * fraction: the wire takes integers, and a rounded one would silently pay a
 * different amount than the one on screen.
 */
export function parseTokenAmount(text: string, decimals: number): number | null {
  if (!Number.isFinite(decimals) || decimals < 0) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  const d = Math.floor(decimals)
  const match = new RegExp(`^(\\d*)(?:\\.(\\d{0,${d}}))?$`).exec(trimmed)
  if (!match) return null
  const intPart = match[1] ?? ''
  const fracPart = (match[2] ?? '').padEnd(d, '0')
  if (!intPart && !match[2]) return null
  const combined = `${intPart || '0'}${fracPart}`
  const value = Number(combined)
  return Number.isSafeInteger(value) ? value : null
}

/** The input mask for an asset's decimals: digits, one point, at most N places. */
export function tokenAmountMask(decimals: number): RegExp {
  const d = Math.max(0, Math.floor(decimals))
  return d === 0 ? /^\d*$/ : new RegExp(`^\\d*\\.?\\d{0,${d}}$`)
}

/** Base units → the exact display string the amount field should hold. */
export function tokenAmountInputText(baseUnits: number, decimals: number): string {
  const formatted = formatTokenAmount(baseUnits, decimals)
  if (formatted === null) return ''
  // The field is typed, not read: no grouping separators, which a decimal-pad
  // cannot produce and `parseTokenAmount` would refuse on the next keystroke.
  return formatted.replace(/[^\d.]/g, '')
}

/**
 * A short, human-scannable form of a long `'<64-hex>.<vout>'` assetId —
 * `"a1b2c3d4…ef01.0"`. Same truncation `core/mandala/permissionModule.ts`'s
 * own (unexported) `shortAssetId` uses for prompt copy, kept as a small
 * separate copy here rather than an import so the UI layer does not reach
 * into `core/mandala` for a pure string helper.
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
