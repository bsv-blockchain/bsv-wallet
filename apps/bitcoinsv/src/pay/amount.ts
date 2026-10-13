// What the amount field keeps of what's typed or pasted (the prototype's
// send page: one decimal point, 7 whole digits, and no more decimals than the
// coin has, 8 for BSV). "1.2.3" becomes "1.23", ".5" becomes "0.5", "007" "7".
export const MAX_WHOLE_DIGITS = 7

export function cleanAmount(typed: string, decimals: number): string {
  const kept = typed.replace(/[^0-9.]/g, '')
  const dot = kept.indexOf('.')
  let whole = dot === -1 ? kept : kept.slice(0, dot)
  // the first point only: any after it are dropped, the digits kept
  const fraction = dot === -1 ? null : kept.slice(dot + 1).replace(/\./g, '')
  whole = whole.replace(/^0+(?=\d)/, '').slice(0, MAX_WHOLE_DIGITS)
  if (fraction === null) return whole
  if (decimals <= 0) return whole
  return `${whole || '0'}.${fraction.slice(0, decimals)}`
}
