import { PEERPAY_LABEL } from '../../core/localpay/pending'

const NEARBY_FIXED: Record<'sent' | 'received', string> = {
  sent: 'Sent token',
  received: 'Received token'
}

/**
 * The message-box rail's own fixed wording (`@bsv/mandala`'s `transfer.ts`
 * `Send ${amount} of ${assetId}` / `receive.ts` `Receive ${amount} of
 * ${assetId}`), reconstructed from the row's own fields so it can be told
 * apart from a real note. Requires `assetId`/`baseUnits` — without them
 * there is nothing to reconstruct against, so the caller below treats the
 * rail as unrecognised rather than guess.
 */
function messageBoxFixed(role: 'sent' | 'received', assetId?: string, baseUnits?: number): string | undefined {
  if (assetId === undefined || baseUnits === undefined) return undefined
  return `${role === 'sent' ? 'Send' : 'Receive'} ${baseUnits} of ${assetId}`
}

/**
 * The fixed wording for whichever rail authored this action, or `undefined`
 * when the action carries neither rail's marker label — in which case the
 * description is never trusted as a note (see `tokenRowTitle`'s doc).
 */
function fixedDescriptionFor(
  role: 'sent' | 'received',
  labels: string[] | undefined,
  assetId: string | undefined,
  baseUnits: number | undefined
): string | undefined {
  const set = new Set(labels ?? [])
  if (set.has(PEERPAY_LABEL)) return NEARBY_FIXED[role]
  if (set.has('transfer') || set.has('receive')) return messageBoxFixed(role, assetId, baseUnits)
  return undefined
}

/**
 * A token activity row's title. Normally the fixed "Sent/Received <ticker>"
 * template (`token_row_sent`/`token_row_received`) — but a sender's own note
 * overrides it, same as a BSV row's description already does.
 *
 * Two rails write a real note into `description` today: the nearby rail
 * (label `'localpay'`, fixed wording "Sent/Received token") and the
 * message-box rail (label `'transfer'`/`'receive'`, `@bsv/mandala`'s own
 * fixed wording "Send/Receive N of assetId"). An action from neither rail —
 * or a message-box action missing the `assetId`/`baseUnits` needed to
 * reconstruct its fixed wording — never has its description shown: it may be
 * an opaque developer string the lib wrote for some other purpose, not
 * anything a user typed (the reason this override existed in the first
 * place).
 */
export function tokenRowTitle(args: {
  role: 'sent' | 'received'
  ticker: string
  labels?: string[]
  description?: string
  /** The row's own asset id — needed to recognise the message-box rail's fixed wording. */
  assetId?: string
  /** The row's own amount, in base units — same reason as `assetId`. */
  baseUnits?: number
  t: (key: string, values?: Record<string, unknown>) => string
}): string {
  const fixed = fixedDescriptionFor(args.role, args.labels, args.assetId, args.baseUnits)
  const hasNote = fixed !== undefined && !!args.description && args.description !== fixed
  if (hasNote) return args.description as string
  return args.t(args.role === 'sent' ? 'token_row_sent' : 'token_row_received', { ticker: args.ticker })
}
