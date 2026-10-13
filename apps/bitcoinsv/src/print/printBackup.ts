// Printing a backup: the recovery phrase, or the wallet's three key slices, in
// the design the person picked (src/print/DesignSheet.tsx), as one print job.
//
// The slices are the shared core's (2 of 3, BRC-157: the phrase's framed
// entropy, or a share-restored wallet's raw key), so they restore in any app on
// the core; only the pages are this app's. The wallet ID is the wallet being
// backed up; a phrase's page lists every wallet it holds, with their paths.
import { Mnemonic, PrivateKey } from '@bsv/sdk'
import QRCode from 'qrcode'
// the pure modules, not the package's entry (which loads the native wallet)
import { ENTROPY_BYTES, generateEntropyShares, generateLegacyKeyShares } from '@bsv/expo-wallet-toolbox/core/recovery/shares'
import type { BackupMaterial } from '@bsv/expo-wallet-toolbox/core/recovery/backupMaterial'
import { nunitoFontFaces, assetDataUri } from '../ui/printFonts'
import { backupDocument, type PrintDesignId } from './document'
import type { BackupKind, NoteData, PathWallet } from './designs'

export type PrintResult = 'printed' | 'cancelled' | 'unsupported' | 'unavailable'

/** A QR code as SVG; the phrase's at the highest error correction, to carry its PRIVATE badge. */
const qrSvg = (data: string, level: 'M' | 'H' = 'M') => QRCode.toString(data, { type: 'svg', margin: 0, errorCorrectionLevel: level, color: { dark: '#141414', light: '#0000' } })

/** What goes on the page, from the wallet's material; null when it can't be printed. */
export async function noteData(kind: BackupKind, material: BackupMaterial, wallets: PathWallet[]): Promise<{ data: NoteData; legacy: boolean } | 'unsupported' | null> {
  const walletIdQr = await qrSvg(material.identityKey)
  if (kind === 'seed') {
    if (!material.mnemonic) return null
    const words = material.mnemonic.trim().split(/\s+/)
    return { data: { kind, words, phraseQr: await qrSvg(words.join(' '), 'H'), walletId: material.identityKey, walletIdQr, wallets }, legacy: false }
  }
  let slices: string[]
  if (material.mnemonic) {
    const entropy = Mnemonic.fromString(material.mnemonic).toEntropy()
    // 24 words fill the split secret, leaving no room for the format's tag
    if (entropy.length !== ENTROPY_BYTES) return 'unsupported'
    slices = generateEntropyShares(entropy)
  } else if (material.wif) {
    slices = generateLegacyKeyShares(Array.from(PrivateKey.fromWif(material.wif).toArray()))
  } else {
    return null
  }
  return { data: { kind, slices, sliceQrs: await Promise.all(slices.map(s => qrSvg(s))), walletId: material.identityKey, walletIdQr }, legacy: !material.mnemonic }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const SATOSHI = require('../../assets/print/satoshi.png') as number
/* eslint-enable @typescript-eslint/no-require-imports */

export async function printBackup({
  kind,
  design,
  material,
  wallets,
  labels
}: {
  kind: BackupKind
  design: PrintDesignId
  material: BackupMaterial
  /** the wallets on the phone (all on this phrase), for the phrase's paths */
  wallets: PathWallet[]
  /** labels typed in the picker: one for the phrase, one per slice */
  labels?: string[]
}): Promise<PrintResult> {
  let made: Awaited<ReturnType<typeof noteData>>
  try {
    made = await noteData(kind, material, wallets)
  } catch {
    return 'unavailable'
  }
  if (made === 'unsupported') return 'unsupported'
  if (!made) return 'unavailable'
  const [fontFaces, satoshi] = await Promise.all([nunitoFontFaces(), design === 'satoshi' ? assetDataUri(SATOSHI, 'image/png') : Promise.resolve(undefined)])
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Platform } = require('react-native') as typeof import('react-native')
  const Print = require('expo-print') as typeof import('expo-print')
  /* eslint-enable @typescript-eslint/no-require-imports */
  // iOS lays the page out at 72 points to the inch, Android at 96 CSS pixels:
  // scaled and without the print formatter's own margins, each page is one
  // sheet of A4 or Letter on both
  const ios = Platform.OS === 'ios'
  const data = labels?.some(l => l.trim()) ? { ...made.data, labels } : made.data
  const html = backupDocument({ design, data, legacy: made.legacy, printed: new Date(), fontFaces, assets: { satoshi }, zoom: ios ? 0.75 : 1 })
  try {
    await Print.printAsync(ios ? { html, margins: { left: 0, top: 0, right: 0, bottom: 0 } } : { html })
    return 'printed'
  } catch {
    // the print sheet was dismissed
    return 'cancelled'
  }
}
