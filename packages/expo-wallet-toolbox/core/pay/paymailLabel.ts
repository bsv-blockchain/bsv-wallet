/**
 * The wallet label for a payment's paymail address. It lives in its own file so
 * `rails/handle.ts` can use it without importing `rails/paymail.ts`, which
 * imports `handle.ts`.
 */
export const PAYMAIL_LABEL_PREFIX = 'paymail:'

const MAX_ADDRESS_LENGTH = 254
const ADDRESS = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/

/**
 * `paymail:<lower-case address>` for a valid address, else `undefined`. The
 * value comes from a sender's token, so it is untrusted: anything that is not a
 * short plain address gives no label.
 */
export function incomingPaymailLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_ADDRESS_LENGTH) return undefined
  if (CONTROL.test(value)) return undefined
  const address = value.toLowerCase()
  if (!ADDRESS.test(address)) return undefined
  return `${PAYMAIL_LABEL_PREFIX}${address}`
}
