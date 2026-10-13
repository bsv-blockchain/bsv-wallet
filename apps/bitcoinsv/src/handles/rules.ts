// Handles for this app (decision 7, 9 Oct 2026): 1–32 characters in the
// registry's character set (a-z 0-9 . _ -, starting and ending with a letter
// or digit), under bitcoinsv.com. Generated handles are free; your own is
// paid monthly by length (the prototype's lib/handle-rules.ts tiers), two
// months free when paid for the year. Whether a name is free to take is the
// registry's answer, not a local list.
import { isGeneratedPattern } from './generator'

export const MIN_LENGTH = 1
export const MAX_LENGTH = 32

/** Monthly price by length; 7 and up share the last tier. */
const TIERS: { length: number; monthly: number }[] = [
  { length: 1, monthly: 36.9 },
  { length: 2, monthly: 21.8 },
  { length: 3, monthly: 6.9 },
  { length: 4, monthly: 3.69 },
  { length: 5, monthly: 2.18 },
  { length: 6, monthly: 0.69 },
  { length: 7, monthly: 0.218 }
]

export function priceFor(handle: string): { monthly: number; yearly: number } {
  const n = Math.max(MIN_LENGTH, handle.length)
  const tier = TIERS.find(t => t.length === n) ?? TIERS[TIERS.length - 1]
  // a year costs ten months: two free
  return { monthly: tier.monthly, yearly: Math.round(tier.monthly * 10 * 1000) / 1000 }
}

/** $0.218 keeps its third decimal; everything else is plain cents. */
export const formatPrice = (n: number) => `$${Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? n.toFixed(2) : n.toFixed(3)}`

/** Names the service keeps: the brand, roles people might impersonate. */
const RESERVED = new Set([
  'admin', 'administrator', 'support', 'help', 'helpdesk', 'security', 'official', 'team', 'staff',
  'bitcoin', 'bitcoinsv', 'bsv', 'bsva', 'satoshi', 'wallet', 'payments', 'pay', 'billing', 'root',
  'system', 'moderator', 'mod', 'null', 'undefined', 'everyone', 'here'
])

/** A basic filter; the registry applies its own. */
const BLOCKED = /(fuck|shit|cunt|nigg|fag|rape|nazi|hitler|porn|whore|slut|bitch|dick|cock|pussy)/

export type HandleCheck =
  | { ok: true; kind: 'generated' }
  | { ok: true; kind: 'custom'; monthly: number; yearly: number }
  | { ok: false; error: string }

/** What this device can say before asking the registry. */
export function checkHandle(raw: string, { generated }: { generated: string }): HandleCheck {
  const h = raw.toLowerCase()
  if (h === generated.toLowerCase()) return { ok: true, kind: 'generated' }
  if (h.length < MIN_LENGTH) return { ok: false, error: 'Type a handle' }
  if (h.length > MAX_LENGTH) return { ok: false, error: `At most ${MAX_LENGTH} characters` }
  if (!/^[a-z0-9._-]+$/.test(h)) return { ok: false, error: 'Letters, numbers, . _ and - only' }
  if (!/^[a-z0-9]/.test(h) || !/[a-z0-9]$/.test(h)) return { ok: false, error: 'Start and end with a letter or number' }
  if (/^[0-9._-]+$/.test(h)) return { ok: false, error: 'Needs at least one letter' }
  if (BLOCKED.test(h)) return { ok: false, error: "That handle isn't allowed" }
  if (RESERVED.has(h)) return { ok: false, error: 'That handle is reserved' }
  // the free namespace stays free: nobody buys a generated-looking name
  if (isGeneratedPattern(h)) return { ok: false, error: 'That looks like a free handle. Reroll for one, or pick another name.' }
  return { ok: true, kind: 'custom', ...priceFor(h) }
}

/**
 * A taken handle's nearby alternatives (the prototype's lib/handle-rules.ts):
 * the first of the<h>, <h>hq, real<h> that this device would accept. Only a
 * suggestion: tapping it fills the field, and the registry is asked again.
 */
export function suggestFor(taken: string, { generated }: { generated: string }): string | undefined {
  const h = taken.toLowerCase()
  return [`the${h}`, `${h}hq`, `real${h}`].find(s => {
    const c = checkHandle(s, { generated })
    return c.ok && c.kind === 'custom'
  })
}

/** Input as typed: lower-case, only the characters a handle can hold. */
export const cleanHandleInput = (text: string) => text.toLowerCase().replace(/[^a-z0-9._-]/g, '')
