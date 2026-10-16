import { checkoutTotal, enterDigit } from '../src/checkout'
import { byCashier, summarizeSales, type VerifiedSale } from '../src/sales'
test('the keypad preserves whole satoshis and rejects unsafe digits', () => {
  expect(enterDigit('0', '00')).toBe('0')
  expect(enterDigit('12', '00')).toBe('1200')
  expect(enterDigit('123', 'delete')).toBe('12')
  expect(enterDigit('123', 'clear')).toBe('')
  expect(enterDigit('900719925474099', '2')).toBe('900719925474099')
})
test('tips round once to a whole satoshi and guard the total against overflow', () => {
  expect(checkoutTotal('123', 10)).toEqual({ subtotal: 123, tip: 12, total: 135 })
  expect(checkoutTotal('5', 10)).toEqual({ subtotal: 5, tip: 1, total: 6 })
  expect(checkoutTotal('100', 20)).toEqual({ subtotal: 100, tip: 20, total: 120 })
  expect(checkoutTotal('100', 'custom', '7')).toEqual({ subtotal: 100, tip: 7, total: 107 })
  expect(() => checkoutTotal('1.2', 'none')).toThrow()
  expect(() => checkoutTotal('100', 'custom', '-5')).toThrow()
  expect(() => checkoutTotal('9007199254740991', 10)).toThrow()
})
const row = (cashier: string, status: VerifiedSale['status'], total: number, tip: number): VerifiedSale => ({
  cashier,
  status,
  total,
  tip,
  subtotal: total - tip,
  invoice: 'invoice',
  expires: 0
})
test('merchant totals count accepted receipts and group duplicate display names by identity', () => {
  const sales = [
    row('cashier-a', 'paid', 100, 10),
    row('cashier-a', 'pending', 500, 20),
    row('cashier-b', 'paid', 200, 25),
    row('cashier-b', 'expired', 999, 0)
  ]
  expect(summarizeSales(sales)).toEqual({ total: 300n, tips: 35n, count: 2, pending: 1, average: 150n })
  expect(byCashier(sales)).toEqual([
    { identity: 'cashier-b', total: 200n, tips: 25n, count: 1, pending: 0, average: 200n },
    { identity: 'cashier-a', total: 100n, tips: 10n, count: 1, pending: 1, average: 100n }
  ])
  expect(summarizeSales([row('a', 'paid', Number.MAX_SAFE_INTEGER, 0), row('b', 'paid', 1, 0)]).total).toBe(
    9007199254740992n
  )
})
