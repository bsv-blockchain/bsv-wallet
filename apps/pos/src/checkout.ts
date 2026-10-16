export type TipChoice = 'none' | 10 | 20 | 'custom'
export interface Breakdown {
  subtotal: number
  tip: number
  total: number
}
export const formatSats = (value: number | bigint) => value.toLocaleString('en-US')

export function enterDigit(current: string, digit: string): string {
  if (digit === 'clear') return ''
  if (digit === 'delete') return current.slice(0, -1)
  if (!/^(\d|00)$/.test(digit)) return current
  const next = (current + digit).replace(/^0+(?=\d)/, '')
  return Number.isSafeInteger(Number(next)) ? next : current
}
export function wholeSats(value: string): number {
  if (!value) return 0
  const amount = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(amount) || amount < 0)
    throw new Error('Use whole satoshis within the supported range')
  return amount
}
export function checkoutTotal(amount: string, choice: TipChoice, custom = ''): Breakdown {
  const subtotal = wholeSats(amount)
  // Round percentage tips to the nearest whole satoshi, without float overflow.
  const tip =
    choice === 'none'
      ? 0
      : choice === 'custom'
        ? wholeSats(custom)
        : Number((BigInt(subtotal) * BigInt(choice) + 50n) / 100n)
  if (!Number.isSafeInteger(subtotal + tip)) throw new Error('The total is too large')
  return { subtotal, tip, total: subtotal + tip }
}
