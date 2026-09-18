/**
 * The profile QR / add-contact deep link: `bsv-wallet://contact/add?identityKey=<hex>`
 * (2026-09-18 design ruling — a deep link straight to this app's add-contact
 * screen, never a bare key and never `peerpay:`).
 *
 * `app/+native-intent.ts` already strips the `bsv-wallet://`/`bsv-browser://`
 * scheme and hands the remainder to Expo Router as a route, so an OS-level
 * scan resolves on its own. `parseContactAddLink` below is for the OTHER
 * path — the in-app QR scanner on the Contacts header, which hands this
 * module raw scanned text rather than navigating anywhere.
 */

const COMPRESSED_KEY = /^0[23][0-9a-fA-F]{64}$/

export function contactAddLinkFor(identityKey: string): string {
  return `bsv-wallet://contact/add?identityKey=${identityKey.toLowerCase()}`
}

/**
 * The identity key out of a scanned code, or undefined when the text names
 * neither a contact-add link nor a bare compressed key. Accepts a bare key
 * too — a QR carrying just the identifier is not wrong, only less specific.
 */
export function parseIdentityKeyFromScan(text: string): string | undefined {
  const trimmed = text.trim()
  if (COMPRESSED_KEY.test(trimmed)) return trimmed.toLowerCase()
  const query = trimmed.split('?')[1]
  if (!query) return undefined
  const key = new URLSearchParams(query).get('identityKey')
  return key && COMPRESSED_KEY.test(key) ? key.toLowerCase() : undefined
}
