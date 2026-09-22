/**
 * What a token row's settlement state is called, and in what colour.
 *
 * Five states reach the UI (`TokenActivityStatus`), and the mapping is here
 * rather than inside a component so the same word appears in the activity list,
 * the Asset sheet and the home badge without three chances to disagree.
 *
 * Colour follows the app's one chroma rule: green means confirmed money and
 * nothing else, so only `settled` earns it. `settling` is not a warning — it is
 * the ordinary state of an offline payment that has not yet reached the issuer,
 * and painting it amber would make the normal case look like a fault.
 */
import type { TokenActivityStatus } from '../core/mandala/runtime'
import type { TxStatusView } from './txStatus'

export type TokenStatusTone = 'neutral' | 'positive' | 'warning' | 'error'

const KEYS: Record<TokenActivityStatus, string> = {
  settling: 'token_status_settling',
  settled: 'token_status_settled',
  refused: 'token_status_refused',
  reversed: 'token_status_reversed',
  stuck: 'token_status_stuck'
}

const TONES: Record<TokenActivityStatus, TokenStatusTone> = {
  settling: 'neutral',
  settled: 'positive',
  refused: 'error',
  reversed: 'error',
  stuck: 'warning'
}

export function tokenStatusKey(status: TokenActivityStatus): string {
  return KEYS[status] ?? KEYS.settling
}

/**
 * A token row's status in an activity list, in the same words and tones a BSV
 * row uses: a finished transfer says what it did (Sent / Received), one still
 * on its way to the issuer is plain "Pending", and only the states the holder
 * may have to act on keep their own word and get colour.
 */
export function tokenRowStatusView(status: TokenActivityStatus, incoming: boolean): TxStatusView {
  switch (status) {
    case 'settled':
      return { key: incoming ? 'tx_status_received' : 'tx_status_sent', tone: 'settled' }
    case 'refused':
    case 'reversed':
      return { key: KEYS[status], tone: 'failed' }
    case 'stuck':
      return { key: KEYS.stuck, tone: 'attention' }
    default:
      return { key: 'tx_status_pending', tone: 'settled' }
  }
}

export function tokenStatusTone(status: TokenActivityStatus): TokenStatusTone {
  return TONES[status] ?? 'neutral'
}

/**
 * The sentence a finished-but-unhappy row explains itself with, or `null` when
 * the status word is the whole story. Refusal and reversal are the two states a
 * holder is owed an explanation for, because money moved back.
 *
 * `refusedCode` narrows a `stuck` or `received`-`refused` row to a more exact
 * reason, the same way `tokenSendCopy.ts` narrows a live send failure — by
 * substring match against the wire's `ERR_*` vocabulary
 * (`docs/.../mandala-wire-contract-v2.md`), because the code space spans two
 * overlay engines and the manager's own free-text reject reasons. Unmatched
 * or absent falls back to the plain status sentence, which is true for every
 * one of them.
 */
export function tokenStatusDetailKey(
  status: TokenActivityStatus,
  role: 'sent' | 'received',
  refusedCode?: string
): string | null {
  const code = (refusedCode ?? '').toLowerCase()
  const has = (...needles: string[]) => needles.some(n => code.includes(n))

  if (status === 'stuck') {
    if (has('pause')) return 'token_settle_paused_retry'
    return 'token_settle_unreachable_retry'
  }
  if (status === 'refused') {
    if (role === 'sent') return 'token_err_refused'
    // Received side: a chain-linkage reason means an ancestor in the transfer
    // was the one refused, not this frame's own content; anything else that
    // is a content-shape reason reads as an unreadable frame rather than a
    // generic reversal. Both are narrower, truer sentences than the plain
    // "could not be confirmed" fallback.
    if (has('linkage')) return 'token_chain_reversed'
    if (has('shape', 'conservation', 'satoshi')) return 'token_frame_unreadable'
    return 'token_recv_reversed'
  }
  if (status === 'reversed') return 'token_settle_evicted'
  return null
}
