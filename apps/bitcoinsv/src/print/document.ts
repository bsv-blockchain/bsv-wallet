// A printed backup as one HTML document for expo-print: the chosen design's
// pages for a recovery phrase or the key slices, every page in one job (one
// print dialog, one PDF if saved).
//
// The tri-fold designs (designs.ts) print one note per page: the note near the
// top, scaled to 190 mm so no printer's margin clips it, with cut lines along
// its edges out to the paper's, dashed marks where it folds, and under it, on
// the offcut, how to cut, fold and label it. The plain
// design is a full page per slice, or for the phrase, with the most to read.
//
// Pure, so it can be tested and previewed anywhere (__tests__/printDesigns.test.ts).
import { DISC, GLYPH } from '../ui/bsvMarkPaths'
import { escapeHtml } from '../ui/sharePdf'
import { NOTE_CSS, NOTE_DESIGNS, SLICE_YELLOWS, noteSvg, privateBadge, type NoteAssets, type NoteData, type NoteDesignId } from './designs'

export type PrintDesignId = NoteDesignId | 'plain'

/** Every design the picker offers, tri-folds first. */
export const PRINT_DESIGNS: { id: PrintDesignId; name: string; blurb: string }[] = [
  ...NOTE_DESIGNS.map(({ id, name, blurb }) => ({ id, name, blurb })),
  { id: 'plain', name: 'Full page', blurb: 'A whole page each, with the most to read' }
]

export interface DocumentInput {
  design: PrintDesignId
  data: NoteData
  /** a share-restored wallet's slices: older, they can't open a Vault */
  legacy?: boolean
  printed: Date
  /** @font-face rules for Nunito (src/ui/printFonts.ts) */
  fontFaces?: string
  assets?: NoteAssets
  /** the page's scale: iOS prints a CSS pixel as a point, so its mm come out a third too big */
  zoom?: number
}

const INK = '#141414'
const MUTED = '#5c5c5c'
const LINE = '#e6e1d3'
const NOTE_WIDTH = 190

const mark = (size: string) =>
  `<svg class="mark" style="width:${size};height:${size}" viewBox="0 0 2500 2500" aria-hidden="true"><path fill="#EAB300" d="${DISC}"/><path fill="#fff" d="${GLYPH}"/></svg>`

/** The printed date, as people write it: "10 October 2026". */
const printedOn = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
const spelled = (n: number) => ['zero', 'one', 'two', 'three'][n] ?? String(n)

// ── tri-fold: a note per page ──

/** The sheet's height: Letter's, so it fits A4 too. */
const SHEET_H = 279
const NOTE_TOP = 16

/** The fold, in three pictures: flat, the private third folded in, the cover out. */
const FOLD_DIAGRAM = `<svg class="diagram" viewBox="0 0 150 34" aria-hidden="true">
  <g style="font:800 3.6px Nunito" fill="${INK}">
    <rect x="1" y="6" width="51" height="22" rx="1.2" fill="#fff" stroke="${INK}" stroke-width="0.5"/>
    <rect x="35" y="6" width="17" height="22" fill="#FFE27A"/>
    <rect x="1" y="6" width="51" height="22" rx="1.2" fill="none" stroke="${INK}" stroke-width="0.5"/>
    <line x1="18" y1="4" x2="18" y2="30" stroke="${INK}" stroke-width="0.35" stroke-dasharray="1 0.8"/>
    <line x1="35" y1="4" x2="35" y2="30" stroke="${INK}" stroke-width="0.35" stroke-dasharray="1 0.8"/>
    <text x="9.5" y="18.5" text-anchor="middle">Cover</text><text x="26.5" y="18.5" text-anchor="middle">Public</text><text x="43.5" y="18.5" text-anchor="middle">Private</text>
    <path d="M43.5 3 C43.5 -1 30 -1 28 3" fill="none" stroke="${INK}" stroke-width="0.5"/><path d="M28 3 l-0.6 -2.2 M28 3 l2 -1" stroke="${INK}" stroke-width="0.5"/>
    <path d="M56 17 h8 m-2.5 -2.5 l2.5 2.5 l-2.5 2.5" fill="none" stroke="${INK}" stroke-width="0.6"/>
    <rect x="68" y="6" width="34" height="22" rx="1.2" fill="#fff" stroke="${INK}" stroke-width="0.5"/>
    <rect x="85" y="6" width="17" height="22" fill="#f4f4f4" stroke="${INK}" stroke-width="0.5"/>
    <line x1="85" y1="4" x2="85" y2="30" stroke="${INK}" stroke-width="0.35" stroke-dasharray="1 0.8"/>
    <text x="76.5" y="18.5" text-anchor="middle">Cover</text><text x="93.5" y="16.6" text-anchor="middle" style="font-size:2.8px">private</text><text x="93.5" y="20.4" text-anchor="middle" style="font-size:2.8px">inside</text>
    <path d="M76.5 31 C76.5 34 90 34 92 31" fill="none" stroke="${INK}" stroke-width="0.5"/><path d="M92 31 l0.6 2.2 M92 31 l-2 1" stroke="${INK}" stroke-width="0.5"/>
    <path d="M106 17 h8 m-2.5 -2.5 l2.5 2.5 l-2.5 2.5" fill="none" stroke="${INK}" stroke-width="0.6"/>
    <rect x="118" y="6" width="17" height="22" rx="1.2" fill="#fff" stroke="${INK}" stroke-width="0.5"/>
    <text x="126.5" y="18.5" text-anchor="middle">Cover</text>
    <text x="138" y="12" style="font:700 2.8px Nunito">Label it</text><text x="138" y="16" style="font:700 2.8px Nunito">and keep</text><text x="138" y="20" style="font:700 2.8px Nunito">it safe</text>
  </g>
</svg>`

function notePage(input: DocumentInput, i: number): string {
  const { design, data } = input
  const slice = data.kind === 'slice'
  const h = (NOTE_WIDTH * 99) / 210
  const half = NOTE_WIDTH / 2
  const bottom = NOTE_TOP + h
  const gap = 1.5
  const what = slice ? `key slice ${i + 1} of ${data.slices?.length ?? 3}` : 'recovery phrase'
  return `
  <section class="sheet">
    <i class="trim h" style="top:${NOTE_TOP}mm;left:0;right:calc(50% + ${half + gap}mm)"></i>
    <i class="trim h" style="top:${NOTE_TOP}mm;left:calc(50% + ${half + gap}mm);right:0"></i>
    <i class="trim h" style="top:${bottom}mm;left:0;right:calc(50% + ${half + gap}mm)"></i>
    <i class="trim h" style="top:${bottom}mm;left:calc(50% + ${half + gap}mm);right:0"></i>
    <i class="trim v" style="left:calc(50% - ${half}mm);top:0;height:${NOTE_TOP - gap}mm"></i>
    <i class="trim v" style="left:calc(50% + ${half}mm);top:0;height:${NOTE_TOP - gap}mm"></i>
    <i class="trim v" style="left:calc(50% - ${half}mm);top:${bottom + gap}mm;bottom:0"></i>
    <i class="trim v" style="left:calc(50% + ${half}mm);top:${bottom + gap}mm;bottom:0"></i>
    <i class="foldmark" style="left:calc(50% - ${half / 3}mm);top:${NOTE_TOP - 5}mm"></i>
    <i class="foldmark" style="left:calc(50% + ${half / 3}mm);top:${NOTE_TOP - 5}mm"></i>
    <i class="foldmark" style="left:calc(50% - ${half / 3}mm);top:${bottom + 1}mm"></i>
    <i class="foldmark" style="left:calc(50% + ${half / 3}mm);top:${bottom + 1}mm"></i>
    <div class="note-at" style="top:${NOTE_TOP}mm;width:${NOTE_WIDTH}mm">${noteSvg(design as NoteDesignId, data, i, input.assets ?? {}, `${NOTE_WIDTH}mm`)}</div>
    <div class="outside" style="top:${bottom + 10}mm">
      <h3>Cut it out, fold it, label it</h3>
      ${FOLD_DIAGRAM}
      <ol>
        <li><span>1</span><div>Cut along the solid lines, all the way to the edges of the paper.</div></li>
        <li><span>2</span><div>Fold the <b>right</b> third in, over the middle, at the dashed marks: the private part is now inside.</div></li>
        <li><span>3</span><div>Fold the <b>left</b> third back, behind the middle, so the cover faces out.</div></li>
        <li><span>4</span><div>Write a label on the cover in plain words, and keep it ${slice ? 'apart from your other slices' : 'somewhere only you can reach'}.</div></li>
      </ol>
      <p class="keep">This page holds your ${escapeHtml(what)}. Anyone with ${slice ? 'two slices' : 'it'} can take your money: keep it like cash, and never photograph or upload it. Throw the offcuts away.</p>
      <footer class="foot"><span>${mark('3.4mm')} Bitcoin SV Wallet · bitcoinsv.com</span><span>Printed ${escapeHtml(printedOn(input.printed))}</span></footer>
    </div>
  </section>`
}

const SHEET_CSS = `
.sheet { position: relative; height: ${SHEET_H}mm; overflow: hidden; page-break-after: always; break-after: page; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.trim { position: absolute; display: block; background: ${INK}; }
.trim.h { height: 0.25mm; margin-top: -0.125mm; }
.trim.v { width: 0.25mm; margin-left: -0.125mm; }
.foldmark { position: absolute; display: block; width: 0; height: 4mm; border-left: 0.3mm dashed ${INK}; }
.note-at { position: absolute; left: 50%; transform: translateX(-50%); }
.note-at .note { display: block; }
.outside { position: absolute; left: 50%; transform: translateX(-50%); width: ${NOTE_WIDTH - 16}mm; display: flex; flex-direction: column; gap: 4mm; }
.outside h3 { margin: 0; font-size: 12pt; }
.diagram { width: 100%; }
.keep { font-size: 8.5pt; line-height: 1.45; color: ${MUTED}; }
.outside .foot { margin-top: 2mm; }
.foot span { display: inline-flex; align-items: center; gap: 1.5mm; }`

// ── plain: a full page each ──

function plainSlicePage(input: DocumentInput, i: number): string {
  const d = input.data
  const shares = d.slices ?? []
  const total = shares.length
  const needed = Number(shares[0]?.split('.')[2]) || 2
  const n = i + 1
  const colour = SLICE_YELLOWS[i % 3]
  const comesBack = input.legacy
    ? 'Your everyday balance comes back. (These are older slices: they can’t open a Vault.)'
    : 'Your wallet comes back, with its balance and history.'
  return `
  <section class="page">
    <header class="top">
      <div class="brand">${mark('6mm')}<span>Bitcoin SV Wallet</span></div>
      <div class="kind">Key slice backup · bitcoinsv.com</div>
    </header>
    <div class="hero">
      <div class="disc" style="background:${colour}">${n}</div>
      <div>
        <h1>Key slice ${n} of ${total}</h1>
        <p class="lede">Any ${spelled(needed)} of your ${spelled(total)} slices bring your wallet back. One on its own can’t.</p>
      </div>
    </div>
    ${labelRow(d.labels?.[i])}
    <div class="card">
      <div class="corner" style="background:${colour}">${n}</div>
      <div class="slice">
        <div class="qr">${d.sliceQrs?.[i] ?? ''}</div>
        <div class="slice-text">
          <h2>Scan to restore</h2>
          <p>Scan this code, and one other slice, in Bitcoin SV Wallet.</p>
          <div class="code-name">Slice code</div>
          <div class="code">${escapeHtml(shares[i])}</div>
        </div>
      </div>
      ${walletRow(d, `The same on all ${spelled(total)} slices, so you can tell they’re one set. It can’t spend: scanning it pays this wallet.`)}
    </div>
    <div class="guide">
      <div>
        <h3>Bring your wallet back</h3>
        <ol>
          <li><span>1</span><div>Get Bitcoin SV Wallet on any phone and open it.</div></li>
          <li><span>2</span><div>Tap <b>Sign in</b>, then <b>Scan key slices</b>.</div></li>
          <li><span>3</span><div>Scan any ${spelled(needed)} of your ${spelled(total)} slices.</div></li>
          <li><span>4</span><div>${comesBack}</div></li>
        </ol>
      </div>
      <div>
        <h3>Keep it safe</h3>
        <ul>
          <li>Keep each slice in a different place.</li>
          <li>Two slices together can spend your money: keep this page as safe as cash.</li>
          <li>Never photograph, scan or upload it.</li>
          <li>Give one to someone you trust, and tell them what it’s for.</li>
          <li>Once a year, check you can still find two.</li>
        </ul>
      </div>
    </div>
    <footer class="foot"><span>Key slice ${n} of ${total}</span><span>Printed ${escapeHtml(printedOn(input.printed))}</span></footer>
  </section>`
}

function plainSeedPage(input: DocumentInput): string {
  const d = input.data
  const words = d.words ?? []
  const cols = words.length > 12 ? 4 : 3
  const wallets = d.wallets?.length ? d.wallets : [{ index: 0, name: 'Wallet 1' }]
  return `
  <section class="page">
    <header class="top">
      <div class="brand">${mark('6mm')}<span>Bitcoin SV Wallet</span></div>
      <div class="kind">Recovery phrase backup · bitcoinsv.com</div>
    </header>
    <div class="hero">
      <div class="disc" style="background:#FFF3C4">${words.length}</div>
      <div>
        <h1>Recovery phrase</h1>
        <p class="lede">These ${words.length} words are every wallet on your phone. Anyone who has them can take your money.</p>
      </div>
    </div>
    ${labelRow(d.labels?.[0])}
    <div class="card">
      <div class="words" style="grid-template-columns: repeat(${cols}, 1fr)">
        ${words.map((w, k) => `<div class="w"><span>${k + 1}</span>${escapeHtml(w)}</div>`).join('')}
      </div>
      <div class="phrase-qr">
        <div class="qr-small qr-private">${d.phraseQr ?? ''}<svg class="badge" viewBox="0 0 100 100">${privateBadge(50, 50, 100)}</svg></div>
        <div>
          <div class="code-name">The same words, as a code</div>
          <p class="note">Scan it in Bitcoin SV Wallet instead of typing the words. It’s as private as the words themselves.</p>
        </div>
      </div>
      ${walletRow(d, 'Safe to show: scanning it pays this wallet. It can’t spend.')}
      <div class="paths">
        <div class="code-name">Derivation · BIP39 seed, no passphrase · BIP32 hardened paths</div>
        <table>
          <tr><th>Wallet</th><th>Keys</th><th>Privileged key</th></tr>
          ${wallets.map(w => `<tr><td>${escapeHtml(w.name)}</td><td>m/0'/${w.index}'</td><td>m/1'/${w.index}'</td></tr>`).join('')}
        </table>
      </div>
    </div>
    <div class="guide">
      <div>
        <h3>Bring your wallets back</h3>
        <ol>
          <li><span>1</span><div>Get Bitcoin SV Wallet on any phone and open it.</div></li>
          <li><span>2</span><div>Tap <b>Sign in</b>, then type the ${words.length} words or scan the code.</div></li>
          <li><span>3</span><div>Your wallets come back, with their balances and history.</div></li>
        </ol>
      </div>
      <div>
        <h3>Keep it safe</h3>
        <ul>
          <li>Keep this page somewhere only you can reach, like a safe.</li>
          <li>Never photograph, scan or upload it, or type the words into a website.</li>
          <li>No one from Bitcoin SV Wallet will ever ask for them.</li>
          <li>Once a year, check you can still find it.</li>
        </ul>
      </div>
    </div>
    <footer class="foot"><span>Recovery phrase · ${words.length} words</span><span>Printed ${escapeHtml(printedOn(input.printed))}</span></footer>
  </section>`
}

/** The label line; a label typed in the picker sits on it, as if written. */
const labelRow = (label?: string) => `<div class="label">
      <div class="label-row"><span class="label-name">Label</span><span class="dots">${label?.trim() ? `<span class="written">${escapeHtml(label.trim())}</span>` : ''}</span></div>
      ${label?.trim() ? '' : '<p class="hint">Where it lives or who has it, in plain words: “Desk drawer”, “Sam”. Nothing that says crypto or wallet.</p>'}
    </div>`

const walletRow = (d: NoteData, note: string) => `<div class="wallet">
        <div class="qr-small">${d.walletIdQr}</div>
        <div>
          <div class="code-name">Wallet ID</div>
          <div class="code id">${escapeHtml(d.walletId)}</div>
          <p class="note">${note}</p>
        </div>
      </div>`

const PLAIN_CSS = `
.page { padding: 14mm 16mm 12mm; page-break-after: always; break-after: page; display: flex; flex-direction: column; gap: 7mm; }
.page:last-child { page-break-after: auto; break-after: auto; }
.top { display: flex; justify-content: space-between; align-items: center; padding-bottom: 4mm; border-bottom: 0.3mm solid ${LINE}; }
.brand { display: flex; align-items: center; gap: 2mm; font-weight: 800; font-size: 11pt; letter-spacing: -0.01em; }
.mark { display: block; }
.kind { font-size: 8pt; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED}; }
.hero { display: flex; align-items: center; gap: 6mm; }
.disc { flex: none; width: 22mm; height: 22mm; border-radius: 50%; border: 0.6mm solid ${INK}; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 34pt; line-height: 1; color: ${INK}; font-variant-numeric: lining-nums; }
h1 { font-size: 24pt; font-weight: 800; letter-spacing: -0.025em; line-height: 1.1; }
.lede { margin-top: 1.5mm; font-size: 11pt; line-height: 1.45; color: ${MUTED}; }
.label-row { display: flex; align-items: flex-end; gap: 3mm; height: 10mm; }
.label-name { font-size: 8pt; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; padding-bottom: 0.6mm; }
.dots { flex: 1; border-bottom: 0.5mm dotted #8a8a8e; }
.written { display: block; padding: 0 0 0.8mm 1mm; font-size: 13pt; font-weight: 800; line-height: 1; }
.hint { margin-top: 1.5mm; font-size: 8pt; color: ${MUTED}; }
.card { position: relative; border: 0.3mm solid ${LINE}; border-radius: 6mm; padding: 7mm; display: flex; flex-direction: column; gap: 6mm; }
.slice { display: flex; gap: 7mm; align-items: center; }
.qr { flex: none; width: 62mm; height: 62mm; }
.qr svg, .qr-small svg { display: block; width: 100%; height: 100%; }
/* the slice's number on the card's edge, clear of the code: a QR code needs its corners */
.corner { position: absolute; top: -4.5mm; left: 7mm; width: 9mm; height: 9mm; border-radius: 50%; border: 0.5mm solid ${INK}; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13pt; line-height: 1; box-shadow: 0 0 0 1.2mm #fff; }
.slice-text { display: flex; flex-direction: column; gap: 2mm; min-width: 0; }
h2 { font-size: 15pt; font-weight: 800; letter-spacing: -0.015em; }
.slice-text p { font-size: 10pt; line-height: 1.45; color: ${MUTED}; }
.code-name { margin-top: 2mm; font-size: 7pt; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED}; }
.code { font-size: 7.5pt; font-weight: 600; line-height: 1.45; word-break: break-all; font-variant-numeric: tabular-nums; }
.wallet, .phrase-qr { display: flex; gap: 5mm; align-items: center; padding-top: 5mm; border-top: 0.3mm solid ${LINE}; }
.qr-small { flex: none; width: 22mm; height: 22mm; }
.qr-private { position: relative; }
.qr-private .badge { position: absolute; inset: 0; }
.wallet .code-name, .phrase-qr .code-name, .paths .code-name { margin-top: 0; }
.id { margin-top: 1mm; }
.note { margin-top: 1.5mm; font-size: 8pt; line-height: 1.4; color: ${MUTED}; }
.words { display: grid; gap: 2.5mm 6mm; }
.w { display: flex; align-items: baseline; gap: 2mm; font-size: 13pt; font-weight: 800; padding-bottom: 1mm; border-bottom: 0.3mm solid ${LINE}; }
.w span { width: 5mm; font-size: 8pt; font-weight: 700; color: ${MUTED}; font-variant-numeric: tabular-nums; }
.paths { padding-top: 5mm; border-top: 0.3mm solid ${LINE}; }
.paths table { margin-top: 2mm; border-collapse: collapse; font-size: 8.5pt; }
.paths th { text-align: left; font-weight: 600; color: ${MUTED}; padding: 0 8mm 1mm 0; }
.paths td { font-weight: 700; padding: 0.6mm 8mm 0.6mm 0; font-variant-numeric: tabular-nums; }
.guide { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.foot { margin-top: auto; display: flex; justify-content: space-between; padding-top: 3mm; border-top: 0.3mm solid ${LINE}; font-size: 7.5pt; color: ${MUTED}; }`

const SHARED_CSS = `
@page { margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Nunito', -apple-system, Helvetica, Arial, sans-serif; font-weight: 400; color: ${INK}; background: #fff; }
h3 { font-size: 11pt; font-weight: 800; margin-bottom: 2.5mm; }
ol, ul { list-style: none; display: flex; flex-direction: column; gap: 2mm; font-size: 9pt; line-height: 1.45; }
ol li { display: flex; gap: 2.5mm; }
ol li span { flex: none; width: 4.6mm; height: 4.6mm; border-radius: 50%; background: ${INK}; color: #fff; font-size: 7pt; font-weight: 800; display: flex; align-items: center; justify-content: center; margin-top: 0.3mm; }
ol b { font-weight: 800; }
ul li { position: relative; padding-left: 4mm; }
ul li::before { content: ''; position: absolute; left: 0.6mm; top: 1.9mm; width: 1.4mm; height: 1.4mm; border-radius: 50%; background: #EAB300; }
.foot { display: flex; justify-content: space-between; padding-top: 3mm; border-top: 0.3mm solid ${LINE}; font-size: 7.5pt; color: ${MUTED}; }`

/** The whole document. */
export function backupDocument(input: DocumentInput): string {
  const { design, data } = input
  const count = data.kind === 'slice' ? (data.slices?.length ?? 0) : 1
  const pages = Array.from({ length: count }, (_, i) =>
    design === 'plain' ? (data.kind === 'slice' ? plainSlicePage(input, i) : plainSeedPage(input)) : notePage(input, i)
  )
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${input.fontFaces ?? ''}
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; zoom: ${input.zoom ?? 1}; }
${SHARED_CSS}
${design === 'plain' ? PLAIN_CSS : SHEET_CSS + NOTE_CSS}
</style>
</head>
<body>
${pages.join('\n')}
</body>
</html>`
}
