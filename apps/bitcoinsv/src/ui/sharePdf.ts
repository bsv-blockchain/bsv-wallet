// A page of HTML as a PDF made on the phone (expo-print), named for what it
// is, through the phone's share sheet: accounting statements
// (src/settings/useExport.ts) and payment receipts (src/activity/receipt.ts).
// The native modules load on first use, so tests that import the callers
// don't need them.

/** Escapes text for the page; everything shown that came from outside goes through this. */
export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A page size in points (72 to the inch), for a PDF that isn't A4 or Letter. */
export interface PdfPage {
  width: number
  height: number
  margins?: { left: number; top: number; right: number; bottom: number }
}

export interface PdfOptions {
  page?: PdfPage
  /** a secret: the file is deleted once the share sheet closes, not left in the cache */
  secret?: boolean
}

export async function sharePdf(html: string, fileName: string, { page, secret = false }: PdfOptions = {}): Promise<void> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const Print = require('expo-print') as typeof import('expo-print')
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  const { shareAsync } = require('expo-sharing') as typeof import('expo-sharing')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { uri } = await Print.printToFileAsync(page ? { html, ...page } : { html })
  // the printed file has a random name: give it one that says what it is
  const named = new File(Paths.cache, fileName)
  if (named.exists) named.delete()
  new File(uri).move(named)
  try {
    await shareAsync(named.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: named.name })
  } finally {
    if (secret && named.exists) named.delete()
  }
}
