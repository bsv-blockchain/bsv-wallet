/**
 * The one modal this design spends (ux §6.3).
 *
 * When an issuer withdraws coins, the balance simply drops. On a phone, money
 * disappearing without a sentence is the worst failure in the system — worse
 * than a refusal, which at least names itself — so this is the single place the
 * design chooses interruption over quiet: one alert, once per transaction,
 * naming the actor and the figure.
 *
 * `showAlert` rather than a toast: a toast is the FYI channel and can be missed
 * entirely, while an alert must be acknowledged. No Activity row is fabricated
 * to go with it — there is no transaction of the user's to show.
 */
import type { TokenActivityRow } from '../../../core/mandala/runtime'
import { showAlert } from '../ui/AlertCard'
import { formatTokenAmount } from '../../tokenFormat'

/** The `t` every component in this package already holds. */
type Translate = ReturnType<typeof import('react-i18next').useTranslation>['t']

export interface EvictionNotice {
  txid: string
  ticker: string
  issuer?: string
  /** Base units the holder lost. */
  baseUnits: number
  decimals: number
}

/**
 * Money that was credited to this wallet and is no longer there.
 *
 * A `reversed` row is exactly that and nothing else: a `refused` SENT payment
 * never left, so the holder's balance is unchanged and there is nothing to
 * announce; a `refused` RECEIVED payment is the settlement spec's row 1
 * (reversed credit) and belongs here too.
 */
export function evictionsFrom(rows: readonly TokenActivityRow[] | null, alreadySeen: readonly string[]): EvictionNotice[] {
  if (!rows) return []
  return rows
    .filter(r => r.role === 'received' && (r.status === 'reversed' || r.status === 'refused'))
    .filter(r => !alreadySeen.includes(r.txid))
    .map(r => ({
      txid: r.txid,
      ticker: r.asset.ticker,
      issuer: r.asset.issuerName,
      baseUnits: r.baseUnits,
      decimals: r.asset.decimals
    }))
}

/** Raises the alert and resolves once it has been acknowledged. */
export async function announceEviction(t: Translate, notice: EvictionNotice): Promise<void> {
  const issuer = notice.issuer || t('token_issuer_fallback')
  const amount = formatTokenAmount(notice.baseUnits, notice.decimals)
  await showAlert({
    title: t('token_evicted_title', { ticker: notice.ticker }),
    // Without a figure the sentence would be "some money left" — true, useless,
    // and the reason the alert exists. If the figure cannot be formatted the
    // alert still fires, because the withdrawal happened either way.
    message: amount
      ? t('token_evicted_body', { issuer, amount, ticker: notice.ticker })
      : t('token_recv_reversed', { issuer })
  })
}
