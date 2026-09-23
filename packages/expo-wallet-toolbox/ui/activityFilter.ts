/**
 * Narrowing the activity list: by the word a row says (Sent, Received, Spent,
 * Transferred) and by a search over what the row shows plus who it was with.
 *
 * The search only ever reads what this device already holds: the row's own
 * title (the sender's note, or the name recorded when the payment was made)
 * and, when the counterparty is a saved contact, that contact's name and
 * handle. It never asks the network who a key belongs to.
 *
 * Every typed word has to appear somewhere, in any order, ignoring case and
 * accents. That is "fuzzy" in the forgiving sense, not a ranked or
 * typo-tolerant one: a row either says what was typed or it does not.
 */
import { counterpartyOf } from '../core/pay/counterparty'
import type { ContactRow } from '../core/contacts/contactsStore'
import type { ActivityAction } from './components/wallet/ActivityRow'
import { activityKind, type ActivityKind } from './txStatus'

export type ActivityKindFilter = 'all' | ActivityKind

/** The chips, in the order they are drawn. */
export const ACTIVITY_KIND_FILTERS: readonly ActivityKindFilter[] = ['all', 'sent', 'received', 'spent', 'transferred']

/** A chip names its kind with the row's own status key, so the two always read the same word. */
export function kindFilterLabelKey(kind: ActivityKindFilter): string {
  return kind === 'all' ? 'activity_filter_all' : `tx_status_${kind}`
}

export interface ActivityFilter {
  kind: ActivityKindFilter
  /** Already normalised by `searchTerms`. */
  terms: readonly string[]
}

export function isActivityFilterActive(filter: ActivityFilter): boolean {
  return filter.kind !== 'all' || filter.terms.length > 0
}

/** Only the Latin combining marks: Indic vowel signs are letters, not accents. */
const COMBINING_DIACRITICS = /[̀-ͯ]/g

function normalise(text: string): string {
  let folded = text
  try {
    folded = text.normalize('NFKD').replace(COMBINING_DIACRITICS, '')
  } catch {
    // An engine without normalisation still gets a case-insensitive search.
  }
  return folded.toLowerCase()
}

/**
 * The words to look for. A leading `@` is dropped because handles are stored
 * without one; an `@` further in (a paymail) is part of what was typed.
 */
export function searchTerms(query: string): string[] {
  return normalise(query)
    .split(/\s+/)
    .map(word => word.replace(/^@+/, ''))
    .filter(word => word.length > 0)
}

export interface ContactNames {
  name: string
  cachedHandle?: string
}

/** Contacts keyed by lower-cased identity key: the wallet lower-cases every label it stores. */
export function contactNamesByKey(
  contacts: readonly Pick<ContactRow, 'identityKey' | 'name' | 'cachedHandle'>[]
): Map<string, ContactNames> {
  return new Map(contacts.map(c => [c.identityKey.toLowerCase(), { name: c.name, cachedHandle: c.cachedHandle }]))
}

/** The part of a token row this cares about: see `ActivityRow`'s `token` prop. */
export interface ActivityRowToken {
  title: string
  incoming: boolean
  counterpartyKey?: string
}

/**
 * Whether a row survives the filter.
 *
 * `token` is the row's token half when it has one, exactly as the list draws
 * it: a token row is read by its own title and direction, never by the wallet
 * action underneath (whose description is a library string carrying a raw
 * token id, and whose satoshis are the BSV the transfer cost).
 */
export function matchesActivity(
  action: ActivityAction,
  token: ActivityRowToken | undefined,
  filter: ActivityFilter,
  contacts: ReadonlyMap<string, ContactNames>
): boolean {
  if (filter.kind !== 'all') {
    // Same direction rule the row itself uses to pick its word.
    const incoming = token ? token.incoming : action.satoshis >= 0
    if (activityKind(incoming, action.labels) !== filter.kind) return false
  }
  if (filter.terms.length === 0) return true

  const counterpartyKey = token
    ? token.counterpartyKey
    : (() => {
        const cp = counterpartyOf(action)
        return cp?.kind === 'identityKey' ? cp.value : undefined
      })()
  const contact = counterpartyKey ? contacts.get(counterpartyKey.toLowerCase()) : undefined
  // One field per line, so no word can match across the seam of two fields.
  const haystack = normalise(
    [token ? token.title : action.description, contact?.name, contact?.cachedHandle].filter(Boolean).join('\n')
  )
  return filter.terms.every(term => haystack.includes(term))
}
