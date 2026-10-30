/**
 * Pure checks the dispatcher applies to a request or an answer (spec 6.5, 6.6). No wallet,
 * runtime or React imports, so they are unit-testable on their own.
 */

/**
 * The names an unverified origin must never reach: anything the wallet underneath would treat as a
 * token-module name. `trim().toLowerCase()` is what the wallet applies, and whitespace runs are
 * collapsed as well, which the wallet does not do: refusing them here costs nothing and keeps the
 * rule independent of that detail.
 *
 * Exact-case `p btms ...` / `p color ...` names are refused here too. The permissions manager
 * sends them to the refusing stub module only for the methods that call `delegateToPModuleIfNeeded`;
 * `revealSpecificKeyLinkage` does not, and with the linkage-revelation flag off it would answer
 * without a prompt. So the pre-scan, not the stub, is what keeps the namespace closed.
 */
function isTokenModuleVariant(name: string): boolean {
  const folded = name.trim().toLowerCase().replace(/\s+/g, ' ')
  return folded.startsWith('p btms') || folded.startsWith('p color')
}

const MAX_DEPTH = 8

/**
 * Walks the argument tree for the three kinds of name the manager inspects: baskets (any `basket`
 * key, which covers `listOutputs`, `relinquishOutput`, `outputs[].basket` and
 * `insertionRemittance.basket`), labels (any `labels` array) and protocol names
 * (`protocolID[1]`). Returns the first offending name, or undefined.
 *
 * Applied to unattested bindings only; an attested binding's calls are not pre-scanned.
 */
export function findTokenModuleVariant(args: unknown): string | undefined {
  const visit = (v: unknown, depth: number): string | undefined => {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return undefined
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = visit(item, depth + 1)
        if (hit !== undefined) return hit
      }
      return undefined
    }
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (key === 'basket' && typeof value === 'string' && isTokenModuleVariant(value)) return value
      if (key === 'labels' && Array.isArray(value)) {
        for (const label of value) if (typeof label === 'string' && isTokenModuleVariant(label)) return label
      }
      if (key === 'protocolID' && Array.isArray(value) && typeof value[1] === 'string') {
        if (isTokenModuleVariant(value[1])) return value[1]
      }
      const hit = visit(value, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return visit(args, 0)
}

const BASE_MIN = 7
const BASE_MAX = 30
const VERSION_MAX_BYTES = 2048

/**
 * `getVersion` result check (BRC-205): a base of 7 to 30 bytes, optionally followed by extension
 * attributes, at most 2048 ASCII bytes in all. The SDK's own check caps the whole string at 30,
 * which would refuse every extended string, so the dispatcher uses this one. The base is the text
 * before the first space or semicolon.
 */
export function isValidVersionString(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > VERSION_MAX_BYTES || !/^[\x20-\x7e]+$/.test(v)) return false
  const base = v.split(/[ ;]/, 1)[0]
  return base.length >= BASE_MIN && base.length <= BASE_MAX
}
