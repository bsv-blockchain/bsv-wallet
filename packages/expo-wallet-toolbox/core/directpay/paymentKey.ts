/**
 * The idempotency key of one payment output: `txid:outputIndex:derivationPrefix:derivationSuffix`.
 * The parts cannot contain `:` (hex, digits, base64), so distinct payments never share a key.
 *
 * One payment is one key on every path it can arrive by (the live link, the live message box,
 * the inbox list), so it is credited, and announced, once. It is the same key BSV Desktop uses
 * and `@bsv/webrtpay` computes; keep the format, since a peer's `seen` store may hold it.
 */
export function paymentKey(
  txid: string,
  outputIndex: number,
  derivationPrefix: string,
  derivationSuffix: string
): string {
  return `${txid}:${outputIndex}:${derivationPrefix}:${derivationSuffix}`
}
