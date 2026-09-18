/**
 * A contact's activity: every interaction with one counterparty, every asset,
 * both directions (Deggen ruling, 2026-09-17 design review).
 *
 * Three sources, merged and sorted by time, newest first:
 *
 *  1. Outbound BSV/peer sends — EXACT, via the label the handle and nearby
 *     rails both write on a sent action (`labels: ['peerpay'|'localpay', recipientKey]`).
 *  2. Everything else a plain label filter can't reach (inbound payments,
 *     which carry the sender only on the output's `senderIdentityKey`, never
 *     as a label) — read from the most recent `RECENT_WINDOW` actions and
 *     matched client-side with `counterpartyOf()`. This is a bounded recent
 *     window, not full history: an old inbound payment outside it will not
 *     surface here. Documented limitation (see the 2026-09-18 spec) rather
 *     than a silent one.
 *  3. Token transfers — EXACT, via `token_settlements.counterpartyKey`
 *     (`idx_token_settlements_counterpartyKey`).
 *
 * The address rail is never attributable to a contact (no key in its label)
 * and is excluded here the same way it is everywhere else in the app.
 */
import { counterpartyOf } from '../pay/counterparty'

/** The recent-window size for source (2) above. */
export const RECENT_WINDOW = 200

/** The slice of a wallet action this module reads. Matches what
 * `listActionsSql` actually builds (see storage/methods/listActionsSql.ts). */
export interface ContactBsvAction {
  txid?: string
  satoshis: number
  status: string
  isOutgoing?: boolean
  description?: string
  labels?: string[]
  senderIdentityKey?: string
  created_at?: string | number
}

export interface ContactActivityWallet {
  listActions(
    args: { labels?: string[]; labelQueryMode?: 'any' | 'all'; limit?: number; includeLabels?: boolean },
    originator?: string
  ): Promise<{ actions: ContactBsvAction[] }>
}

/** The slice of `token_settlements` this module reads. */
export interface ContactSettlementRow {
  txid: string
  role: 'sent' | 'received'
  assetId: string
  state: string
  counterpartyKey?: string
  amountBaseUnits?: number
  createdAt: string
}

export interface ContactSettlementsDb {
  getAllAsync(sql: string, params: (string | number | null)[]): Promise<unknown[]>
}

export type ContactActivityItem = ({ kind: 'bsv' } & ContactBsvAction) | ({ kind: 'token' } & ContactSettlementRow)

function timeOf(item: ContactActivityItem): number {
  const raw = item.kind === 'bsv' ? item.created_at : item.createdAt
  if (raw === undefined || raw === null) return 0
  const ts = new Date(raw as string).getTime()
  return Number.isNaN(ts) ? 0 : ts
}

/** Token transfers with this counterparty. Exported separately so it can be
 * unit-tested against a real in-memory SQLite (see `mandala/settlementStore.ts`'s
 * own test pattern) without a wallet in the loop. */
export async function listTokenSettlementsByCounterparty(
  db: ContactSettlementsDb,
  counterpartyKey: string
): Promise<ContactSettlementRow[]> {
  const rows = (await db.getAllAsync(
    'SELECT txid, role, assetId, state, counterpartyKey, amountBaseUnits, createdAt FROM token_settlements WHERE counterpartyKey = ? ORDER BY createdAt DESC',
    [counterpartyKey]
  )) as {
    txid: string
    role: string
    assetId: string
    state: string
    counterpartyKey: string | null
    amountBaseUnits: number | null
    createdAt: string
  }[]
  return rows.map(r => ({
    txid: r.txid,
    role: r.role as 'sent' | 'received',
    assetId: r.assetId,
    state: r.state,
    counterpartyKey: r.counterpartyKey ?? undefined,
    amountBaseUnits: r.amountBaseUnits ?? undefined,
    createdAt: r.createdAt
  }))
}

/**
 * Every activity item with `identityKey`, merged and sorted newest first.
 *
 * `wallet` and `settlementsDb` are both optional so a caller that only has
 * one half built (e.g. a token-less wallet) still gets what it can — same
 * fail-open posture as `resolveIdentity.ts`.
 */
export async function getContactActivity(args: {
  wallet?: ContactActivityWallet
  adminOriginator?: string
  settlementsDb?: ContactSettlementsDb
  identityKey: string
}): Promise<ContactActivityItem[]> {
  const { wallet, adminOriginator, settlementsDb, identityKey } = args
  const items: ContactActivityItem[] = []

  if (wallet) {
    try {
      const outbound = await wallet.listActions(
        { labels: [identityKey], labelQueryMode: 'any', limit: 500, includeLabels: true },
        adminOriginator
      )
      const recent = await wallet.listActions({ limit: RECENT_WINDOW, includeLabels: true }, adminOriginator)
      const seen = new Set<string>()
      for (const action of [...outbound.actions, ...recent.actions]) {
        const cp = counterpartyOf({
          labels: action.labels,
          senderIdentityKey: action.senderIdentityKey,
          txid: action.txid
        })
        if (!cp || cp.kind !== 'identityKey' || cp.value !== identityKey) continue
        const key = action.txid ?? `${action.description ?? ''}:${action.created_at ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({ kind: 'bsv', ...action })
      }
    } catch {
      // Best-effort, same posture as resolveIdentity: a read failure here
      // must not blank a screen that also shows token activity below.
    }
  }

  if (settlementsDb) {
    try {
      const settlements = await listTokenSettlementsByCounterparty(settlementsDb, identityKey)
      for (const row of settlements) items.push({ kind: 'token', ...row })
    } catch {
      // Same posture as above.
    }
  }

  return items.sort((a, b) => timeOf(b) - timeOf(a))
}
