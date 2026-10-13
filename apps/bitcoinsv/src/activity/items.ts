// Payments as rows: the shared core's wallet actions, their offline overlay
// and their stablecoin half, turned into what the Activity list draws. Pure,
// so it can be tested without a wallet.
import { counterpartyOf, type Counterparty } from '@bsv/expo-wallet-toolbox/core/pay/counterparty'
import { txStatusView, type TxStatusView } from '@bsv/expo-wallet-toolbox/ui/txStatus'
import { formatTokenAmount } from '@bsv/expo-wallet-toolbox/ui/tokenFormat'
import { tokenRowStatusView } from '@bsv/expo-wallet-toolbox/ui/tokenStatus'
import { tokenRowTitle } from '@bsv/expo-wallet-toolbox/ui/screens/tokenRowTitle'
import type { ActivityAction } from '@bsv/expo-wallet-toolbox/ui/components/wallet/ActivityRow'
import type { TokenActivityRow } from '@bsv/expo-wallet-toolbox/core/mandala/runtime'

export interface ActivityItem {
  /** txid, or the action's reference before it has one */
  id: string
  txid?: string
  reference?: string
  incoming: boolean
  /** signed satoshis (BSV rows) */
  sats?: number
  /** a stablecoin transfer: its signed figure and ticker */
  token?: { figure: string; unit: string; assetId: string }
  title: string
  /** the payment's own note or description, when it says more than the title */
  note?: string
  counterparty: Counterparty | null
  /** the contact on the other side, when there is one */
  contactKey?: string
  status: TxStatusView
  statusText: string
  /** in flight: queued, posting, parked, settling */
  pending: boolean
  createdAt?: string
  offlineStatus?: string
  /** the action's own status (completed, unproven, sending, …) */
  rawStatus: string
  labels: string[]
}

/** The action's creation time as ISO, whatever shape the storage handed back. */
function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

const GENERIC = /^(payment|bsv payment|peerpay payment|sent|received)$/i

export function toActivityItems(
  actions: ActivityAction[],
  ctx: {
    offline: Map<string, { status: string }>
    tokenByTxid: Map<string, TokenActivityRow>
    contactsByKey: Map<string, { identityKey: string; name: string; cachedHandle?: string }>
    t: (key: string) => string
  }
): ActivityItem[] {
  const { offline, tokenByTxid, t } = ctx
  return actions.map(a => {
    const id = a.txid || a.reference || `${a.description}-${a.created_at}`
    const offlineStatus = a.txid ? offline.get(a.txid)?.status : undefined
    const labels = (a.labels ?? []) as string[]
    const tok = a.txid ? tokenByTxid.get(a.txid.toLowerCase()) : undefined
    const counterparty = tok?.counterpartyKey
      ? ({ kind: 'identityKey', value: tok.counterpartyKey } as Counterparty)
      : counterpartyOf(a)
    const contact =
      counterparty?.kind === 'identityKey' ? ctx.contactsByKey.get(counterparty.value.toLowerCase()) : undefined
    const incoming = tok ? tok.role === 'received' : !a.isOutgoing
    const status = tok
      ? tokenRowStatusView(tok.status, incoming)
      : txStatusView(a.status, offlineStatus, incoming, labels)
    const description = (a.description ?? '').trim()
    const tokenTitle = tok
      ? tokenRowTitle({
          role: tok.role,
          ticker: tok.asset.ticker,
          labels,
          description,
          assetId: tok.asset.assetId,
          baseUnits: tok.baseUnits,
          t: t as never
        })
      : undefined
    const title =
      contact?.name ?? contact?.cachedHandle ?? tokenTitle ?? (incoming ? 'Payment received' : 'Payment sent')
    // the core describes a payment by the other side's shortened key when it has nothing better: not a note
    const keyOnly = /^[0-9a-f]{4,}(…|\.\.\.)[0-9a-f]{4,}$/i.test(description)
    const note = description && !GENERIC.test(description) && !keyOnly && description !== title ? description : undefined
    return {
      id,
      txid: a.txid || undefined,
      reference: a.reference,
      incoming,
      sats: tok ? undefined : a.satoshis,
      token: tok
        ? {
            figure:
              formatTokenAmount(tok.role === 'sent' ? -tok.baseUnits : tok.baseUnits, tok.asset.decimals, {
                showPlus: incoming
              }) ?? '',
            unit: tok.asset.ticker,
            assetId: tok.asset.assetId
          }
        : undefined,
      title,
      note,
      counterparty,
      contactKey: contact?.identityKey,
      status,
      statusText: t(status.key),
      pending: status.tone === 'inflight' || status.tone === 'attention',
      createdAt: tok?.at ?? toIso(a.created_at),
      offlineStatus,
      rawStatus: String(a.status ?? ''),
      labels
    }
  })
}
