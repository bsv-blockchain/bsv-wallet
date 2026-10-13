// What goes on each 50 × 30 mm label for a label printer (src/print/LabelView
// .tsx draws them; DesignSheet makes each a PNG to share, as Niimbot printers
// and labelprint.bsvb.net take images). Pure, so it can be tested anywhere.
//
// A phrase: its words (12 to a label), then its QR code; and, if wanted, two
// stickers that are safe to share: "BitcoinSV Accepted Here" (a QR code that
// pays this wallet, for a shop's counter) and "Wallets on this phrase" (every
// wallet it restores, with their paths). A slice: a label each, its QR code and
// number. The secret labels and the wallets sticker carry the set's code (from
// the wallet ID), so they're plainly one set.
import type { NoteData, PathWallet } from './designs'

export const LABEL_W = 50
export const LABEL_H = 30

export type LabelSpec =
  | { type: 'words'; words: string[]; from: number; total: number; split: boolean; footer: string; part: string; set: string }
  | { type: 'qr'; qr: string; slice: number | null; title: string; sub: string; tag?: string; foot: string; set: string }
  | { type: 'accepted'; qr: string; handle?: string; shop?: string }
  | { type: 'wallets'; wallets: PathWallet[]; goesWith: string; tag?: string; set: string }

export interface PlannedLabel {
  spec: LabelSpec
  /** what it is, in the list of labels to share */
  title: string
  /** the PNG's name */
  fileName: string
}

/** A short code for the set: the same on every label of one backup. */
export const setCode = (walletId: string) => walletId.slice(2, 8).toUpperCase()

/** A label as much as fits a tag's two short lines. */
export const fitTag = (label: string) => (label.length > 26 ? label.slice(0, 25).trimEnd() + '…' : label)

/** What the Accepted Here sticker needs: its pay QR code (the website pay link), and who it pays. */
export interface AcceptedSticker {
  qr: string
  handle?: string | null
  /** the shop's name, typed in */
  shop?: string
}

/** The "BitcoinSV Accepted Here" sticker: safe to share, it only pays this wallet. */
export function acceptedLabel({ qr, handle, shop }: AcceptedSticker): PlannedLabel {
  const name = shop?.trim()
  return {
    spec: { type: 'accepted', qr, handle: handle ?? undefined, shop: name ? fitTag(name) : undefined },
    title: 'BitcoinSV Accepted Here',
    fileName: `BitcoinSV Accepted Here${name ? ` ${name.replace(/[\\/:*?"<>|]/g, '')}` : ''}.png`
  }
}

export function planLabels(
  data: NoteData,
  { accepted, wallets: withWallets = false }: { accepted?: AcceptedSticker; wallets?: boolean } = {}
): PlannedLabel[] {
  const set = setCode(data.walletId)
  if (data.kind === 'seed') {
    const words = data.words ?? []
    const tag = data.labels?.[0]?.trim() || undefined
    const chunks = Array.from({ length: Math.ceil(words.length / 12) }, (_, k) => words.slice(k * 12, k * 12 + 12))
    const parts = chunks.length + 1
    const labels: PlannedLabel[] = chunks.map((chunk, k) => ({
      spec: {
        type: 'words',
        words: chunk,
        from: k * 12,
        total: words.length,
        split: chunks.length > 1,
        footer: tag ? fitTag(tag) : 'Never photograph',
        part: `${k + 1}/${parts}`,
        set
      },
      title: chunks.length > 1 ? `Words ${k * 12 + 1}–${k * 12 + chunk.length}` : `The ${words.length} words`,
      fileName: `Recovery phrase ${set} ${k + 1} of ${parts}.png`
    }))
    labels.push({
      spec: { type: 'qr', qr: data.phraseQr ?? '', slice: null, title: 'Recovery phrase', sub: `Scan to restore all ${words.length} words`, tag: tag && fitTag(tag), foot: `${parts}/${parts}`, set },
      title: 'The phrase as a QR code',
      fileName: `Recovery phrase ${set} ${parts} of ${parts}.png`
    })
    if (accepted) labels.push(acceptedLabel(accepted))
    if (withWallets) {
      labels.push({
        spec: { type: 'wallets', wallets: data.wallets?.length ? data.wallets : [{ index: 0, name: 'Wallet 1' }], goesWith: `Recovery phrase · 1/${parts}`, tag: tag && fitTag(tag), set },
        title: 'Wallets on this phrase',
        fileName: `Recovery phrase ${set} wallets.png`
      })
    }
    return labels
  }
  const total = data.slices?.length ?? 3
  return (data.sliceQrs ?? []).map((qr, i) => {
    const tag = data.labels?.[i]?.trim() || undefined
    return {
      spec: { type: 'qr', qr, slice: i + 1, title: `Slice\n${i + 1} of ${total}`, sub: 'Any two bring your wallet back', tag: tag && fitTag(tag), foot: 'bitcoinsv.com', set },
      title: `Key slice ${i + 1} of ${total}`,
      fileName: `Key slice ${set} ${i + 1} of ${total}.png`
    }
  })
}
