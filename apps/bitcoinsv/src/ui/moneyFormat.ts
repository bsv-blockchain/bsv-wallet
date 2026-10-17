// The number formats behind Money (src/ui/Money.tsx), kept apart from its
// components so they can be used (and tested) without React Native.

export function formatAmount(amount: number, decimals = 2, maxDecimals = decimals): string {
  return amount.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: maxDecimals })
}

/** BSV to the satoshi: at least two decimals, up to eight, no trailing zeros past two. */
export const formatBsvAmount = (amount: number) => formatAmount(amount, 2, 8)
