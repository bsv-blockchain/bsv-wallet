// A payment's receipt as a PDF made on the phone (the prototype's "Download
// receipt", without its hosted receipts: decision 11): who, how much, when,
// what for, its state and its transaction, from the payment's own row.
// Shared through the phone's share sheet (src/ui/sharePdf.ts).
import { escapeHtml as esc } from '../ui/sharePdf'
import { bsvFigure } from './format'
import type { ActivityItem } from './useActivity'

const whenFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short' })

export interface ReceiptContext {
  /** the other side, as this wallet knows them (left out when it doesn't) */
  who?: string
  /** the explorer link for the transaction, when it has one */
  explorer?: string
}

export function receiptHtml(tx: ActivityItem, c: ReceiptContext = {}): string {
  const amount = tx.token ? `${tx.token.figure.replace(/^[+−-]/, '')} ${tx.token.unit}` : `${bsvFigure(Math.abs(tx.sats ?? 0))} BSV`
  const rows: [string, string][] = [
    ...(c.who ? ([[tx.incoming ? 'From' : 'To', c.who]] as [string, string][]) : []),
    ['Date', tx.createdAt ? whenFmt.format(new Date(tx.createdAt)) : '—'],
    ...(tx.note ? ([['For', tx.note]] as [string, string][]) : []),
    ['Status', tx.statusText],
    ['Paid with', tx.token ? tx.token.unit : 'BitcoinSV (BSV)'],
    ...(tx.txid ? ([['Transaction ID', tx.txid]] as [string, string][]) : [])
  ]
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1d1d1f;margin:48px auto;max-width:520px;font-size:13px}
.brand{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6e6e73}
h1{font-size:15px;font-weight:600;margin:24px 0 4px;color:#6e6e73}
.amount{font-size:40px;font-weight:800;letter-spacing:-.02em;margin:0 0 24px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;border-top:1px dashed #d2d2d7}
td{padding:10px 0;border-bottom:1px solid #f0f0f2;vertical-align:top}
td:first-child{color:#6e6e73;width:34%}td:last-child{text-align:right;word-break:break-all}
.foot{margin-top:24px;color:#6e6e73;font-size:11px}a{color:#1d1d1f}
</style></head><body>
<div class="brand">Bitcoin SV Wallet · Receipt</div>
<h1>${tx.incoming ? 'Payment received' : 'Payment sent'}</h1>
<p class="amount">${tx.incoming ? '+' : '−'}${esc(amount)}</p>
<table>${rows.map(([l, v]) => `<tr><td>${esc(l)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${c.explorer ? `<p class="foot">See it on the blockchain: <a href="${esc(c.explorer)}">${esc(c.explorer)}</a></p>` : ''}
</body></html>`
}

export const receiptFileName = (tx: ActivityItem) =>
  `bitcoinsv-receipt-${(tx.createdAt ?? new Date().toISOString()).slice(0, 10)}-${(tx.txid ?? tx.id).slice(0, 8)}.pdf`
