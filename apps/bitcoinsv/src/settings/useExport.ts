// This wallet's payments out, for accounting (src/settings/ExportSheet.tsx): as
// a CSV through the shared core's export (its columns and its guard against
// spreadsheet formulas), or as a PDF statement made on the phone (expo-print),
// either through the phone's share sheet. What's taken is a period and a
// direction (src/settings/exportSelect.ts).
import { useCallback, useState } from 'react'
import type { WalletAction } from '@bsv/sdk'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { exportTransactionsAsCsv, listAllActions } from '@bsv/expo-wallet-toolbox/ui'
import { showToast } from '../ui/Toast'
import { bsvFigure } from '../activity/format'
import { escapeHtml, sharePdf } from '../ui/sharePdf'
import { exportFileName, PERIODS, TYPES, selector, type ExportChoice } from './exportSelect'

export type ExportFormat = 'csv' | 'pdf'

const esc = escapeHtml
const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

/** A plain statement: what was asked for, then a row per payment. */
function statementHtml(actions: WalletAction[], c: ExportChoice): string {
  const signed = (a: WalletAction) => (a.isOutgoing ? -Math.abs(a.satoshis) : Math.abs(a.satoshis))
  const net = actions.reduce((s, a) => s + signed(a), 0)
  const when = (a: WalletAction) => {
    const at = (a as WalletAction & { created_at?: string }).created_at
    return at ? dateFmt.format(new Date(at)) : ''
  }
  const period = c.period === 'custom' ? `${c.from || 'Start'} – ${c.to || c.from || 'today'}` : PERIODS.find(p => p.id === c.period)?.label
  const rows = actions
    .map(
      a => `<tr><td>${esc(when(a))}</td><td>${esc(a.description)}</td><td class="n ${signed(a) < 0 ? '' : 'in'}">${signed(a) < 0 ? '−' : '+'}${esc(bsvFigure(Math.abs(signed(a))))}</td><td>${esc(a.status)}</td><td class="id">${esc(a.txid)}</td></tr>`
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1d1d1f;margin:32px;font-size:11px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#6e6e73}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6e6e73;border-bottom:1px solid #d2d2d7;padding:6px 4px}
td{padding:6px 4px;border-bottom:1px solid #f0f0f2;vertical-align:top}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.in{color:#1a7f37}.id{font-family:Menlo,monospace;font-size:8px;word-break:break-all;color:#6e6e73;width:28%}
</style></head><body>
<h1>Bitcoin SV Wallet statement</h1>
<p>${esc(period)} · ${esc(TYPES.find(t => t.id === c.type)?.label)} · ${actions.length} payment${actions.length === 1 ? '' : 's'} · net ${net < 0 ? '−' : '+'}${esc(bsvFigure(Math.abs(net)))} BSV</p>
<table><thead><tr><th>Date</th><th>Description</th><th class="n">BSV</th><th>Status</th><th>Transaction</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`
}

export function useExport() {
  const { managers, storage, adminOriginator } = useWallet()
  const [actions, setActions] = useState<WalletAction[] | null>(null)
  const [exporting, setExporting] = useState(false)

  /** Every payment, read once when the sheet opens. */
  const load = useCallback(async () => {
    const wallet = managers.permissionsManager
    if (!wallet) return
    setActions(null)
    try {
      setActions(await listAllActions(wallet, adminOriginator))
    } catch {
      setActions([])
    }
  }, [managers.permissionsManager, adminOriginator])

  const count = (c: ExportChoice) => (actions ? actions.filter(selector(c)).length : null)

  const exportFile = async (c: ExportChoice, format: ExportFormat): Promise<boolean> => {
    const wallet = managers.permissionsManager
    if (!wallet || exporting) return false
    setExporting(true)
    try {
      if (format === 'csv') {
        const n = await exportTransactionsAsCsv(wallet, storage ?? null, adminOriginator, selector(c), exportFileName(c, 'csv'))
        if (n === 0) showToast('There are no payments to export', { type: 'info' })
        return n > 0
      }
      const picked = (actions ?? (await listAllActions(wallet, adminOriginator))).filter(selector(c))
      if (picked.length === 0) {
        showToast('There are no payments to export', { type: 'info' })
        return false
      }
      await sharePdf(statementHtml(picked, c), exportFileName(c, 'pdf'))
      return true
    } catch {
      showToast('The export couldn’t be made. Try again.', { type: 'error' })
      return false
    } finally {
      setExporting(false)
    }
  }

  return { load, count, loaded: actions !== null, exportFile, exporting }
}
