import { decodeSession } from '../../../packages/expo-wallet-toolbox/core/localpay/session'
import { key, verify } from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import type { Sale } from '../service/controller'
export type SaleStatus = 'paid' | 'pending' | 'unpaid' | 'expired'
export interface VerifiedSale {
  invoice: string
  cashier: string
  total: number
  subtotal: number
  tip: number
  status: SaleStatus
  expires: number
  txid?: string
}
export async function verifiedSales(
  rows: (Sale & { pending?: boolean })[],
  merchant: string,
  chain: string
): Promise<VerifiedSale[]> {
  const seen = new Set<string>()
  return Promise.all(
    rows.map(async row => {
      const request = await verify(row.request, merchant)
      const session = decodeSession(request.session)
      const total = session.amount
      if (
        request.kind !== 'payment' ||
        key(request.merchant) !== key(merchant) ||
        request.chain !== chain ||
        key(session.identityKey) !== key(merchant) ||
        !Number.isSafeInteger(total) ||
        !total ||
        total < 1 ||
        !Number.isSafeInteger(request.expires) ||
        !/^[a-f0-9]{32}$/.test(request.invoice) ||
        seen.has(request.invoice)
      )
        throw new Error('Invalid merchant sale')
      seen.add(request.invoice)
      const cashier = key(request.cashier)
      const tip = request.tip ?? 0,
        subtotal = request.subtotal ?? total
      if (
        !Number.isSafeInteger(tip) ||
        tip < 0 ||
        !Number.isSafeInteger(subtotal) ||
        subtotal < 1 ||
        tip > total ||
        subtotal !== total - tip
      )
        throw new Error('Invalid sale breakdown')
      let txid: string | undefined
      if (row.receipt) {
        const receipt = await verify(row.receipt, merchant)
        if (
          receipt.invoice !== request.invoice ||
          receipt.status !== 'accepted' ||
          receipt.amount !== total ||
          !/^[a-f0-9]{64}$/.test(receipt.txid)
        )
          throw new Error('Invalid merchant receipt')
        txid = receipt.txid
      }
      return {
        invoice: request.invoice,
        cashier,
        total,
        subtotal,
        tip,
        expires: request.expires,
        txid,
        status: row.receipt ? 'paid' : row.pending ? 'pending' : request.expires <= Date.now() ? 'expired' : 'unpaid'
      }
    })
  )
}
export function summarizeSales(rows: VerifiedSale[]) {
  const paid = rows.filter(row => row.status === 'paid')
  const total = paid.reduce((sum, row) => sum + BigInt(row.total), 0n)
  const tips = paid.reduce((sum, row) => sum + BigInt(row.tip), 0n)
  return {
    total,
    tips,
    count: paid.length,
    pending: rows.filter(row => row.status === 'pending').length,
    average: paid.length ? (total + BigInt(Math.floor(paid.length / 2))) / BigInt(paid.length) : 0n
  }
}
export function byCashier(rows: VerifiedSale[]) {
  return [...new Set(rows.map(row => row.cashier))]
    .map(identity => ({ identity, ...summarizeSales(rows.filter(row => row.cashier === identity)) }))
    .sort((a, b) => (a.total > b.total ? -1 : a.total < b.total ? 1 : 0))
}
export const shortKey = (value: string) => `${value.slice(0, 7)}…${value.slice(-5)}`
