// The printed backups' tri-fold notes: six designs, each for a recovery phrase
// or a key slice. A note is 210 × 99 mm (a third of A4) and folds in three:
// the left third is the cover (the slice's number or what's inside, a line to
// label it, how to restore), the middle is public (the wallet ID, to pay in and
// check), the right is private (the words or the slice). The right third folds
// in over the middle and the left folds back: the private part ends up inside.
//
// Only shades of yellow, black and white, and every design must still read
// printed in black ink alone. Drawn as SVG in millimetres; pure, so the pages
// can be built and checked anywhere (__tests__/printDesigns.test.ts, and the
// picker's previews: scripts/print-previews.md).
import { DISC, GLYPH } from '../ui/bsvMarkPaths'
import { DRAGON } from './dragonPath'
import { band, clouds, fan, fret, loops, loopsV, rays, ring, rosette, waves } from './geometry'
import { escapeHtml } from '../ui/sharePdf'

export type BackupKind = 'seed' | 'slice'

export type NoteDesignId = 'classic' | 'banknote' | 'dragon' | 'imperial' | 'watermark' | 'minimal' | 'certificate' | 'satoshi'

/** A wallet on the phone, for the seed note's paths. */
export interface PathWallet {
  index: number
  name: string
}

export interface NoteData {
  kind: BackupKind
  /** the phrase (seed notes) */
  words?: string[]
  /** the phrase as a QR code, SVG */
  phraseQr?: string
  /** the slice codes (slice notes) */
  slices?: string[]
  /** each slice as a QR code, SVG */
  sliceQrs?: string[]
  /** the wallet being backed up: its identity key, and that as a QR code */
  walletId: string
  walletIdQr: string
  /** every wallet the phrase holds, for the paths (seed notes) */
  wallets?: PathWallet[]
  /** labels typed in the picker, printed where one would be written by hand: one for a phrase, one per slice */
  labels?: string[]
}

/** Longest label the picker takes: it fits the cover's two label lines. */
export const LABEL_MAX = 48

/** A label over the cover's two lines: as much as fits the first (after "LABEL"), the rest on the second. */
export function labelLines(label: string): [string, string] {
  const words = label.trim().replace(/\s+/g, ' ').split(' ')
  let first = ''
  let k = 0
  while (k < words.length && (first ? first.length + 1 : 0) + words[k].length <= 22) first = first ? `${first} ${words[k++]}` : words[k++]
  // one word too long for the first line: it starts on the second
  const rest = words.slice(k).join(' ')
  return [first, rest.length > 30 ? rest.slice(0, 29) + '…' : rest]
}

export interface NoteAssets {
  /** the original gold coin (assets/print/satoshi.png), as a data URI; only the Satoshi design uses it */
  satoshi?: string
}

const W = 210
const H = 99
const INK = '#141414'
const MUTED = '#5c5c5c'
const GOLD = '#EAB300'
/** each slice's colour: three yellows, light to deep, each a distinct grey in black ink */
export const SLICE_YELLOWS = ['#FFF1A8', '#FFD43B', '#E0A800']

const repeatText = (s: string, n: number) => Array(n).fill(s).join(' ')

/** A long code (a key, a slice) as lines of SVG text, `per` characters each. */
function codeLines(code: string, x: number, y: number, per: number, fill: string, anchor: 'start' | 'middle' = 'start') {
  const lines = code.match(new RegExp(`.{1,${per}}`, 'g')) ?? []
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="code" fill="${fill}">${lines
    .map((l, k) => `<tspan x="${x}" dy="${k ? 2.8 : 0}">${escapeHtml(l)}</tspan>`)
    .join('')}</text>`
}

const qrAt = (svg: string, x: number, y: number, size: number) => svg.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `)

const mark = (x: number, y: number, size: number, disc = GOLD, glyph = '#fff', op = 1) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 2500 2500" opacity="${op}"><path fill="${disc}" d="${DISC}"/><path fill="${glyph}" d="${GLYPH}"/></svg>`

let clipIds = 0
/** the dragon on its own, in any colour */
const dragon = (x: number, y: number, size: number, fill = INK, op = 1, flip = false) => {
  const id = `dragon${clipIds++}`
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 500 500" opacity="${op}" overflow="visible"><defs><clipPath id="${id}"><circle cx="250" cy="250" r="246"/></clipPath></defs><g ${flip ? 'transform="translate(500 0) scale(-1 1)"' : ''}><path clip-path="url(#${id})" fill="${fill}" fill-rule="evenodd" d="${DRAGON}"/></g></svg>`
}

/**
 * BitcoinSV in the app's type ("SV" in gold). On a gold ground the gold
 * becomes white with an ink edge, so it still reads in black ink.
 */
const wordmark = (x: number, y: number, size: number, anchor: 'start' | 'middle' = 'start', onGold = false) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" style="font:900 ${size}px Nunito;letter-spacing:-0.03em" fill="${INK}">Bitcoin<tspan ${
    onGold ? `fill="#fff" stroke="${INK}" stroke-width="${size * 0.035}" paint-order="stroke"` : `fill="${GOLD}"`
  }>SV</tspan></text>`

interface Look {
  ink: string
  muted: string
  accent: string
  rule: string
  /** the seed middle panel's rows and code */
  seed: { eyebrow: number; box: number; row0: number; gap: number; qrY: number; qr: number }
  /** moves the wallet ID panel down, clear of a top band */
  leftTop?: number
}

const LOOK: Look = { ink: INK, muted: MUTED, accent: INK, rule: '#ecd27a', seed: { eyebrow: 15, box: 18.5, row0: 25.5, gap: 7.1, qrY: 68, qr: 24 } }

// ── the panels every design shares ──

/** The left panel: the wallet ID, safe to show. On a seed note, every wallet's paths too. */
function left(d: NoteData, look: Look, logoSlot = false) {
  const o = look.leftTop ?? 0
  if (d.kind === 'slice') {
    return `<g transform="translate(0 ${o})">
      <text x="35" y="12" text-anchor="middle" class="eyebrow" fill="${look.accent}">WALLET ID</text>
      <rect x="16.5" y="15" width="37" height="37" rx="2.5" fill="#fff" fill-opacity="0.9" stroke="${look.rule}" stroke-width="0.25"/>
      ${qrAt(d.walletIdQr, 19, 17.5, 32)}
      <text x="35" y="58.5" text-anchor="middle" class="h2" fill="${look.ink}">Pay in &amp; check</text>
      <text x="35" y="63" text-anchor="middle" class="tiny" fill="${look.muted}">Safe to show. Scanning it pays this</text>
      <text x="35" y="66.3" text-anchor="middle" class="tiny" fill="${look.muted}">wallet; it can’t spend from it.</text>
      ${logoSlot ? codeLines(d.walletId, 25, 78.5, 33, look.muted) : codeLines(d.walletId, 35, 71.5, 33, look.muted, 'middle')}</g>`
  }
  // seed: a smaller code, then where each wallet's keys are (BIP39, BIP32 hardened)
  const wallets = d.wallets?.length ? d.wallets : [{ index: 0, name: 'Wallet 1' }]
  const shown = wallets.length > 5 ? wallets.slice(0, 4) : wallets
  const rest = wallets.length - shown.length
  const x0 = logoSlot ? 24 : 9
  // the columns, closer when the corner mark takes the left
  const [c1, c2] = logoSlot ? [17, 28] : [22, 34]
  const rows = shown
    .map(
      (w, k) => `<text x="${x0}" y="${70.4 + k * 3.3}" class="tiny b" fill="${look.ink}">${escapeHtml(w.name.length > (logoSlot ? 10 : 14) ? w.name.slice(0, logoSlot ? 9 : 13) + '…' : w.name)}</text>
      <text x="${x0 + c1}" y="${70.4 + k * 3.3}" class="tiny mono" fill="${look.ink}">m/0'/${w.index}'</text>
      <text x="${x0 + c2}" y="${70.4 + k * 3.3}" class="tiny mono" fill="${look.muted}">m/1'/${w.index}'</text>`
    )
    .join('')
  return `<g transform="translate(0 ${o})">
      <text x="35" y="12" text-anchor="middle" class="eyebrow" fill="${look.accent}">WALLET ID</text>
      <rect x="21" y="14.5" width="28" height="28" rx="2" fill="#fff" fill-opacity="0.9" stroke="${look.rule}" stroke-width="0.25"/>
      ${qrAt(d.walletIdQr, 23, 16.5, 24)}
      <text x="35" y="48" text-anchor="middle" class="h2" fill="${look.ink}">Pay in &amp; check</text>
      <text x="35" y="52" text-anchor="middle" class="tiny" fill="${look.muted}">Safe to show. It can’t spend.</text>
      <text x="${x0}" y="60" class="eyebrow-sm" fill="${look.accent}">DERIVATION · BIP39, NO PASSPHRASE</text>
      <text x="${x0}" y="66" class="tiny" fill="${look.muted}">Wallet</text><text x="${x0 + c1}" y="66" class="tiny" fill="${look.muted}">Keys</text><text x="${x0 + c2}" y="66" class="tiny" fill="${look.muted}">Privileged</text>
      ${rows}
      ${rest > 0 ? `<text x="${x0}" y="${70.4 + shown.length * 3.3}" class="tiny" fill="${look.muted}">+${rest} more: m/0'/n' and m/1'/n', n = 0–${wallets[wallets.length - 1].index}</text>` : ''}</g>`
}

/** The middle panel: the private part, folded inside. */
function middle(d: NoteData, look: Look, i: number, sliceYellows = SLICE_YELLOWS) {
  const ink = look.ink
  if (d.kind === 'seed') {
    const L = look.seed
    const words = d.words ?? []
    const cols = words.length > 12 ? 3 : 2
    const perCol = Math.ceil(words.length / cols)
    const boxBottom = L.row0 + 5 * L.gap + 3.6
    const gap = cols === 2 ? L.gap : ((boxBottom - 3.6 - L.row0) / (perCol - 1))
    const colW = cols === 2 ? 33 : 22
    const wordClass = cols === 2 ? 'word' : 'word-sm'
    const list = words
      .map((w, k) => {
        const c = Math.floor(k / perCol), r = k % perCol
        const x = 74 + c * colW, y = L.row0 + r * gap
        return `<text x="${x}" y="${y}" class="num" fill="${look.muted}">${k + 1}</text><text x="${x + (cols === 2 ? 5 : 4)}" y="${y}" class="${wordClass}" fill="${ink}">${escapeHtml(w)}</text><line x1="${x + (cols === 2 ? 5 : 4)}" y1="${y + 1.2}" x2="${x + colW - 3}" y2="${y + 1.2}" stroke="${look.rule}" stroke-width="0.15"/>`
      })
      .join('')
    const t = L.qrY + L.qr / 2 - 5.5, xr = 105 + L.qr / 2 + 2.5
    return `
      <text x="105" y="${L.eyebrow}" text-anchor="middle" class="eyebrow" fill="${look.accent}">RECOVERY PHRASE · ${words.length} WORDS</text>
      <rect x="72" y="${L.box}" width="66" height="${boxBottom - L.box}" rx="3" fill="#fff" fill-opacity="0.85" stroke="${look.rule}" stroke-width="0.25"/>
      ${list}
      ${d.phraseQr ? qrAt(d.phraseQr, 105 - L.qr / 2, L.qrY, L.qr) + privateBadge(105, L.qrY + L.qr / 2, L.qr) : ''}
      <text x="${xr}" y="${t}" class="tiny" fill="${look.muted}">Scan to</text><text x="${xr}" y="${t + 3.5}" class="tiny" fill="${look.muted}">restore, or</text><text x="${xr}" y="${t + 7}" class="tiny" fill="${look.muted}">type the</text><text x="${xr}" y="${t + 10.5}" class="tiny" fill="${look.muted}">${words.length} words.</text>
      <text x="74" y="${t}" class="tiny b" fill="${ink}">Keep</text><text x="74" y="${t + 3.5}" class="tiny b" fill="${ink}">folded.</text><text x="74" y="${t + 7}" class="tiny" fill="${look.muted}">Never</text><text x="74" y="${t + 10.5}" class="tiny" fill="${look.muted}">photograph.</text>`
  }
  const n = i + 1
  const total = d.slices?.length ?? 3
  return `
      <text x="105" y="13" text-anchor="middle" class="eyebrow" fill="${look.accent}">KEY SLICE ${n} OF ${total}</text>
      <rect x="78.5" y="16.5" width="53" height="53" rx="3" fill="#fff" fill-opacity="0.92" stroke="${look.rule}" stroke-width="0.25"/>
      ${qrAt(d.sliceQrs?.[i] ?? '', 81, 19, 48)}
      <circle cx="78.5" cy="16.5" r="5.4" fill="#fff"/>
      <circle cx="78.5" cy="16.5" r="4.6" fill="${sliceYellows[i % 3]}" stroke="${ink}" stroke-width="0.35"/>
      <text x="78.5" y="18.6" text-anchor="middle" class="disc-sm" fill="${ink}">${n}</text>
      <text x="105" y="75" text-anchor="middle" class="tiny b" fill="${ink}">Scan this and one other slice to restore.</text>
      ${codeLines(d.slices?.[i] ?? '', 105, 79.5, 50, look.muted, 'middle')}`
}

/** The cover from `top`: what's inside, two lines to label it, how to restore. */
function cover(d: NoteData, look: Look, i: number, top: number, x = 175, anchor: 'middle' | 'start' = 'middle') {
  const slice = d.kind === 'slice'
  const total = d.slices?.length ?? 3
  const lx = 147
  const label = d.labels?.[slice ? i : 0]?.trim()
  const [l1, l2] = label ? labelLines(label) : ['', '']
  return `
      <text x="${x}" y="${top}" text-anchor="${anchor}" class="h1" fill="${look.ink}">${slice ? `Key slice ${i + 1} of ${total}` : 'Recovery phrase'}</text>
      <text x="${x}" y="${top + 5}" text-anchor="${anchor}" class="sub" fill="${look.muted}">${slice ? 'Any two of three bring your wallet back' : 'Every wallet on your phone, folded inside'}</text>
      <text x="${lx}" y="${top + 14}" class="label" fill="${look.ink}">LABEL</text>
      <line x1="157" y1="${top + 14.3}" x2="203" y2="${top + 14.3}" stroke="${look.ink}" stroke-width="0.3" stroke-dasharray="0.3 0.9" stroke-linecap="round"/>
      <line x1="${lx}" y1="${top + 20.3}" x2="203" y2="${top + 20.3}" stroke="${look.ink}" stroke-width="0.3" stroke-dasharray="0.3 0.9" stroke-linecap="round"/>
      ${l1 ? `<text x="158" y="${top + 13.4}" class="written" fill="${look.ink}">${escapeHtml(l1)}</text>` : ''}
      ${l2 ? `<text x="${lx + 0.5}" y="${top + 19.4}" class="written" fill="${look.ink}">${escapeHtml(l2)}</text>` : ''}
      <text x="${lx}" y="${top + 27}" class="tiny b" fill="${look.ink}">To restore</text>
      <text x="${lx}" y="${top + 30.3}" class="tiny" fill="${look.muted}">Open Bitcoin SV Wallet, tap Sign in, then</text>
      <text x="${lx}" y="${top + 33.6}" class="tiny" fill="${look.muted}">${slice ? 'Scan key slices, and scan any two.' : `type or scan your ${d.words?.length ?? 12} words.`}</text>`
}

/**
 * "PRIVATE", with a lock, over the middle of the phrase's QR code (`s` its
 * size): it's the phrase itself, never to be shared. The code is made with the
 * highest error correction (it can lose 30%), and the badge covers about 8%.
 */
export function privateBadge(cx: number, cy: number, s: number): string {
  const w = s * 0.5
  const h = s * 0.15
  const fs = s * 0.064
  const lx = cx - w / 2 + h * 0.32
  const ly = cy - h * 0.18
  const lw = h * 0.42
  return `<g>
    <rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h * 0.22}" fill="#ffffff" stroke="${INK}" stroke-width="${s * 0.012}"/>
    <path d="M${lx + lw * 0.2} ${ly} v${-h * 0.12} a${lw * 0.3} ${lw * 0.3} 0 0 1 ${lw * 0.6} 0 v${h * 0.12}" fill="none" stroke="${INK}" stroke-width="${s * 0.014}"/>
    <rect x="${lx}" y="${ly}" width="${lw}" height="${h * 0.36}" rx="${h * 0.05}" fill="${INK}"/>
    <text x="${lx + lw + h * 0.18}" y="${cy + fs * 0.36}" style="font:900 ${fs}px Nunito;letter-spacing:${fs * 0.06}px" fill="${INK}">PRIVATE</text>
  </g>`
}

/** A numbered disc for a slice. */
const disc = (cx: number, cy: number, r: number, fill: string, n: number, size: number, ring = true) =>
  `${ring ? `<circle cx="${cx}" cy="${cy}" r="${r + 1.1}" fill="#fff"/>` : ''}<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="0.5"/><text x="${cx}" y="${cy + size * 0.36}" text-anchor="middle" style="font:900 ${size}px Nunito" fill="${INK}">${n}</text>`


/**
 * The dragon's outline, never solid: its edges stroked (in millimetres, at
 * any size), optionally filled with a pattern (a fill's id, in `defs`).
 */
const dragonLine = (x: number, y: number, size: number, stroke = INK, width = 0.15, op = 1, fill = 'none', flip = false) => {
  const id = `dl${clipIds++}`
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 500 500" opacity="${op}" overflow="visible"><defs><clipPath id="${id}"><circle cx="250" cy="250" r="246"/></clipPath></defs><g ${flip ? 'transform="translate(500 0) scale(-1 1)"' : ''}><path clip-path="url(#${id})" fill="${fill}" stroke="${stroke}" stroke-width="${(width * 500) / size}" stroke-linejoin="round" fill-rule="evenodd" d="${DRAGON}"/></g></svg>`
}

/** A fine-line fill, as engraving: wavy lines in a 500-unit square (a dragon's viewBox). */
const engraving = (id: string, colour: string, gap = 9, width = 1.6) =>
  `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${gap * 4}" height="${gap}"><path d="M0 ${gap / 2} Q${gap} 0 ${gap * 2} ${gap / 2} T${gap * 4} ${gap / 2}" fill="none" stroke="${colour}" stroke-width="${width}"/></pattern>`

// ── the designs ──

type Render = (d: NoteData, i: number, a: NoteAssets) => string

/*
 * Where each part sits. The panels were drawn cover-right; they're placed
 * cover-left, public in the middle, private on the right: the right third folds
 * in over the middle (the private part inside, face to face with the public
 * one) and the left third folds back behind, so the cover faces out.
 */
const toPublic = (svg: string) => `<g transform="translate(70 0)">${svg}</g>`
const toPrivate = (svg: string) => `<g transform="translate(70 0)">${svg}</g>`
const toCover = (svg: string) => `<g transform="translate(-140 0)">${svg}</g>`

/** Classic: after the original tri-fold paper wallet. */
const classic: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const id = `cl${clipIds++}`
  return `
    <defs>
      <linearGradient id="p${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffbea"/><stop offset="0.5" stop-color="#fff3c4"/><stop offset="1" stop-color="#ffe99a"/></linearGradient>
      <radialGradient id="g${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#fff3c4" stop-opacity="0"/></radialGradient>
      <clipPath id="c${id}"><rect width="${W}" height="${H}" rx="2"/></clipPath>
    </defs>
    <g clip-path="url(#c${id})">
      <rect width="${W}" height="${H}" fill="url(#p${id})"/>
      <path d="${waves(0, -2, W, H + 4, 1.15, 0.9, 22)}" fill="none" stroke="#f2cf55" stroke-width="0.07" opacity="0.8"/>
      <path d="${waves(0, -1.5, W, H + 4, 2.3, 1.6, 41, 1.3)}" fill="none" stroke="#e6b800" stroke-width="0.06" opacity="0.45"/>
      ${toPrivate(`<circle cx="105" cy="50" r="40" fill="url(#g${id})"/>${mark(72, 17, 66, '#ffe58a', '#fff6cf', 0.6)}`)}
      ${toPublic(`<path d="${fan(14, 84, 10, -0.6, 1.9, 40, 12)}" fill="none" stroke="${INK}" stroke-width="0.1" opacity="0.4"/><path d="${ring(14.2, 84.3, 9.4, 10.6, 22)}" fill="none" stroke="${GOLD}" stroke-width="0.14"/>`)}
      ${toCover(`<path d="${fan(194, 16, 11, 1.9, 5.0, 46, 14)}" fill="none" stroke="${INK}" stroke-width="0.1" opacity="0.55"/><path d="${ring(194, 16, 10.3, 11.6, 24, 1)}" fill="none" stroke="${GOLD}" stroke-width="0.14"/>`)}
      <rect x="68.2" y="0" width="3.6" height="${H}" fill="#ffe27a"/>
      <rect x="138.2" y="0" width="3.6" height="${H}" fill="#ffe27a"/>
      <text transform="translate(70.9 ${H}) rotate(-90)" class="strip" fill="${INK}" fill-opacity="0.55">${repeatText('bitcoinsv.com', 16)}</text>
      <text transform="translate(140.9 ${H}) rotate(-90)" class="strip" fill="${INK}" fill-opacity="0.55">${repeatText('bitcoinsv', 22)}</text>
      ${toPublic(`<text x="3" y="7" class="formula" fill="#d4a800">1 − Σ λᵏe⁻ᵏ/k! · (1 − (q/p)^(z−k))</text>`)}
      <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="1.6" fill="none" stroke="${GOLD}" stroke-width="0.35"/>
    </g>
    ${toPublic(`${mark(6.5, 76.5, 15.5)}${left(d, LOOK, true)}`)}
    ${toPrivate(middle(d, LOOK, i))}
    ${toCover(`${mark(185.5, 7.5, 17)}
    ${slice ? disc(165, 22, 9, SLICE_YELLOWS[i % 3], i + 1, 12, false) : ''}
    ${wordmark(slice ? 175 : 146, slice ? 43 : 40, 8.5, slice ? 'middle' : 'start')}
    ${cover(d, LOOK, i, slice ? 53 : 51)}
    <text x="147" y="94.5" class="tiny b" fill="${INK}">bitcoinsv.com</text><text x="203" y="94.5" text-anchor="end" class="tiny" fill="${MUTED}">${slice ? `Slice ${i + 1} of ${d.slices?.length ?? 3}` : 'Seed phrase backup'}</text>`)}`
}

/** Banknote: woven bands, a rosette, microtext. */
const banknote: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const look: Look = { ...LOOK, seed: { eyebrow: 15.5, box: 18.5, row0: 24.5, gap: 6.4, qrY: 63.5, qr: 21 }, leftTop: 3 }
  const id = `bn${clipIds++}`
  return `
    <defs>
      <linearGradient id="p${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fffdf3"/><stop offset="0.5" stop-color="#ffffff"/><stop offset="1" stop-color="#fffbe8"/></linearGradient>
      <radialGradient id="r${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff6c8"/><stop offset="0.7" stop-color="#ffe98f" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
      <clipPath id="c${id}"><rect width="${W}" height="${H}" rx="2"/></clipPath>
    </defs>
    <g clip-path="url(#c${id})">
      <rect width="${W}" height="${H}" fill="url(#p${id})"/>
      <path d="${waves(0, 10, W, H - 20, 1.3, 1.1, 14)}" fill="none" stroke="#f0cf5a" stroke-width="0.06" opacity="0.7"/>
      <rect x="0" y="0" width="${W}" height="7" fill="#fff1b8"/>
      <rect x="0" y="${H - 7}" width="${W}" height="7" fill="#fff1b8"/>
      <path d="${band(0, 3.8, W, 4.6, 6, 6)}" fill="none" stroke="${INK}" stroke-width="0.09" opacity="0.55"/>
      <path d="${band(0, H - 3.8, W, 4.6, 6, 6)}" fill="none" stroke="${INK}" stroke-width="0.09" opacity="0.55"/>
      <path d="${loops(0, 8.1, W, 2.6)}" fill="none" stroke="${GOLD}" stroke-width="0.14"/>
      <path d="${loops(0, H - 8.1, W, 2.6)}" fill="none" stroke="${GOLD}" stroke-width="0.14"/>
      ${toCover(`<circle cx="175" cy="30" r="23" fill="url(#r${id})"/>
      <path d="${rosette(175, 30, 96, 36, 40, 0.24)}" fill="none" stroke="${INK}" stroke-width="0.07" opacity="0.75"/>
      <path d="${rosette(175, 30, 84, 30, 52, 0.2, 0.2)}" fill="none" stroke="${GOLD}" stroke-width="0.07" opacity="0.8"/>
      <path d="${ring(175, 30, 12.2, 13.6, 30)}" fill="none" stroke="${INK}" stroke-width="0.12"/>`)}
      ${toPrivate(`<path d="${rosette(105, 50, 120, 45, 58, 0.36)}" fill="none" stroke="#f2d468" stroke-width="0.06" opacity="0.6"/>`)}
      <line x1="70" y1="10" x2="70" y2="${H - 10}" stroke="${INK}" stroke-width="0.12" stroke-dasharray="0.6 0.8" opacity="0.6"/>
      <line x1="140" y1="10" x2="140" y2="${H - 10}" stroke="${INK}" stroke-width="0.12" stroke-dasharray="0.6 0.8" opacity="0.6"/>
      <text x="2" y="1.9" class="micro" fill="${INK}">${repeatText('BITCOINSV.COM · PEER-TO-PEER ELECTRONIC CASH ·', 12)}</text>
      <text x="2" y="${H - 0.6}" class="micro" fill="${INK}">${repeatText('BITCOINSV.COM · PEER-TO-PEER ELECTRONIC CASH ·', 12)}</text>
      <rect x="0.6" y="0.6" width="${W - 1.2}" height="${H - 1.2}" rx="1.6" fill="none" stroke="${INK}" stroke-width="0.35"/>
    </g>
    ${toPublic(left(d, look))}
    ${toPrivate(middle(d, look, i))}
    ${toCover(`${slice ? disc(175, 30, 10.5, SLICE_YELLOWS[i % 3], i + 1, 14) : mark(164, 19, 22)}
    ${cover(d, look, i, slice ? 50 : 47.5)}
    ${mark(152.5, 84.6, 4.6)}${wordmark(158, 88.3, 4.4)}
    <text x="203" y="88.3" text-anchor="end" class="tiny b" fill="${INK}">bitcoinsv.com</text>`)}`
}

/** Dragon: a bold yellow cover with the dragon in black. */
const dragonDesign: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const id = `dr${clipIds++}`
  const coverLook: Look = { ...LOOK, muted: '#2a2a2a' }
  return `
    <defs><clipPath id="c${id}"><rect width="${W}" height="${H}" rx="2"/></clipPath></defs>
    <g clip-path="url(#c${id})">
      <rect width="${W}" height="${H}" fill="#fff"/>
      ${toPrivate(dragon(52, 6, 106, '#FFE27A', 0.35, true))}
      ${toCover(`<rect x="140" y="0" width="70" height="${H}" fill="${GOLD}"/>
      <path d="${waves(140, 0, 70, H, 1.4, 0.8, 18)}" fill="none" stroke="${INK}" stroke-width="0.05" opacity="0.18"/>
      ${dragon(slice ? 161 : 154, -8, slice ? 48 : 52, INK)}`)}
      <rect x="70" y="0" width="140" height="2.2" fill="${GOLD}"/>
      <rect x="70" y="${H - 2.2}" width="140" height="2.2" fill="${GOLD}"/>
      <line x1="140" y1="5" x2="140" y2="${H - 5}" stroke="${INK}" stroke-width="0.12" stroke-dasharray="0.6 0.9" opacity="0.4"/>
    </g>
    ${toPublic(left(d, LOOK))}
    ${toPrivate(middle(d, LOOK, i))}
    ${toCover(`${slice ? disc(154, 16, 8.5, '#fff', i + 1, 11.5, false) : ''}
    ${wordmark(146, 50.5, 8, 'start', true)}
    ${cover(d, coverLook, i, 58.5, 146, 'start')}
    <text x="203" y="95" text-anchor="end" class="tiny b" fill="${INK}">bitcoinsv.com</text>`)}`
}

/** Minimal: white, gold hairlines, a small gold dragon. */
const minimal: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const total = d.slices?.length ?? 3
  return `
    <rect width="${W}" height="${H}" fill="#fff"/>
    <rect x="140" y="0" width="70" height="${H}" fill="#FFFAE6"/>
    <rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="2.5" fill="none" stroke="${GOLD}" stroke-width="0.3"/>
    ${[70, 140].map(x => `<line x1="${x}" y1="0" x2="${x}" y2="2.2" stroke="${INK}" stroke-width="0.2"/><line x1="${x}" y1="${H - 2.2}" x2="${x}" y2="${H}" stroke="${INK}" stroke-width="0.2"/>`).join('')}
    ${toPublic(left(d, LOOK))}
    ${toPrivate(middle(d, LOOK, i))}
    ${toCover(`${dragon(147, 9, 13, GOLD)}
    ${wordmark(162, 18.3, 6)}
    <text x="162" y="22.4" class="tiny" fill="${MUTED}">bitcoinsv.com</text>
    ${slice ? `<text x="147" y="48" style="font:900 26px Nunito;letter-spacing:-1px" fill="${GOLD}" stroke="${INK}" stroke-width="0.25" paint-order="stroke">${i + 1}</text><text x="163.5" y="48" class="h2" fill="${INK}">of ${total}</text>` : ''}
    ${cover(d, LOOK, i, slice ? 56 : 46, 147, 'start').replace(/Key slice \d+ of \d+/, 'Key slice')}
    <text x="201" y="94" text-anchor="end" class="tiny" fill="${MUTED}">${slice ? `Slice ${i + 1} of ${total}` : 'Seed phrase backup'}</text>`)}`
}

/** Certificate: a black double frame, corner rosettes, a dragon medallion. */
const certificate: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const look: Look = { ...LOOK, rule: '#e8cf7a', seed: { eyebrow: 16, box: 19, row0: 26, gap: 6.9, qrY: 67, qr: 22 }, leftTop: 1.5 }
  const corners = [[8, 8], [W - 8, 8], [8, H - 8], [W - 8, H - 8]]
  return `
    <rect width="${W}" height="${H}" fill="#fff"/>
    <path d="${waves(4, 4, W - 8, H - 8, 1.6, 0.7, 12)}" fill="none" stroke="${GOLD}" stroke-width="0.05" opacity="0.5"/>
    <rect x="2" y="2" width="${W - 4}" height="${H - 4}" fill="none" stroke="${INK}" stroke-width="0.6"/>
    <rect x="3.3" y="3.3" width="${W - 6.6}" height="${H - 6.6}" fill="none" stroke="${INK}" stroke-width="0.15"/>
    <text x="${W / 2}" y="5.6" text-anchor="middle" class="micro" fill="${INK}">${repeatText('BITCOINSV.COM', 14)}</text>
    <text x="${W / 2}" y="${H - 4.4}" text-anchor="middle" class="micro" fill="${INK}">${repeatText('BITCOINSV.COM', 14)}</text>
    ${corners.map(([x, y], k) => `<circle cx="${x}" cy="${y}" r="5.4" fill="#fff"/><path d="${rosette(x, y, 60, 22, 26, 0.085, k)}" fill="none" stroke="${INK}" stroke-width="0.06"/><path d="${ring(x, y, 4.6, 5.4, 18)}" fill="none" stroke="${GOLD}" stroke-width="0.12"/>`).join('')}
    ${[70, 140].map(x => `<line x1="${x}" y1="7" x2="${x}" y2="${H - 7}" stroke="${INK}" stroke-width="0.1" stroke-dasharray="0.4 1" opacity="0.5"/>`).join('')}
    ${toPublic(left(d, look))}
    ${toPrivate(middle(d, look, i))}
    ${toCover(`<circle cx="175" cy="26" r="15.5" fill="#fff"/>
    <path d="${rosette(175, 26, 96, 36, 40, 0.17)}" fill="none" stroke="${GOLD}" stroke-width="0.07"/>
    <path d="${ring(175, 26, 13.2, 14.6, 32)}" fill="none" stroke="${INK}" stroke-width="0.12"/>
    <circle cx="175" cy="26" r="12.4" fill="${slice ? SLICE_YELLOWS[i % 3] : '#FFF3C4'}" stroke="${INK}" stroke-width="0.35"/>
    ${slice ? `${dragon(166.5, 17.5, 17, INK, 0.14)}<text x="175" y="30.5" text-anchor="middle" style="font:900 12px Nunito" fill="${INK}">${i + 1}</text>` : dragon(165.5, 16.5, 19, INK)}
    ${cover(d, look, i, 46.5)}
    ${wordmark(175, 88.4, 4.6, 'middle')}
    <text x="175" y="91.6" text-anchor="middle" class="tiny" fill="${MUTED}">bitcoinsv.com</text>`)}`
}

/** Satoshi: the original gold coin on a sunburst. */
const satoshi: Render = (d, i, a) => {
  const slice = d.kind === 'slice'
  const id = `st${clipIds++}`
  const coin = (x: number, y: number, size: number, op = 1) => (a.satoshi ? `<image href="${a.satoshi}" x="${x}" y="${y}" width="${size}" height="${size}" opacity="${op}"/>` : mark(x, y, size, GOLD, '#fff', op))
  return `
    <defs>
      <linearGradient id="p${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf2"/><stop offset="1" stop-color="#fff4cc"/></linearGradient>
      <radialGradient id="r${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFE27A" stop-opacity="0.9"/><stop offset="1" stop-color="#FFE27A" stop-opacity="0"/></radialGradient>
      <clipPath id="c${id}"><rect width="${W}" height="${H}" rx="2"/></clipPath>
      <clipPath id="k${id}"><rect x="0" y="0" width="70" height="${H}"/></clipPath>
    </defs>
    <g clip-path="url(#c${id})">
      <rect width="${W}" height="${H}" fill="url(#p${id})"/>
      <path d="${waves(0, 0, W, H, 0.9, 0.35, 9)}" fill="none" stroke="${INK}" stroke-width="0.03" opacity="0.12"/>
      <g clip-path="url(#k${id})">${toCover(`<path d="${rays(175, 24, 0, 80, 48)}" fill="#FFE27A" opacity="0.45"/><circle cx="175" cy="24" r="26" fill="url(#r${id})"/>`)}</g>
      ${toPrivate(coin(75, 20, 60, 0.1))}
      <rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="1.5" fill="none" stroke="${INK}" stroke-width="0.25"/>
      <rect x="4.2" y="4.2" width="${W - 8.4}" height="${H - 8.4}" rx="1" fill="none" stroke="${GOLD}" stroke-width="0.5"/>
      ${[70, 140].map(x => `<line x1="${x}" y1="6" x2="${x}" y2="${H - 6}" stroke="${INK}" stroke-width="0.1" stroke-dasharray="0.4 1" opacity="0.5"/>`).join('')}
    </g>
    ${toPublic(left(d, LOOK))}
    ${toPrivate(middle(d, LOOK, i))}
    ${toCover(`${coin(159, 7, 32)}
    ${slice ? disc(187, 33, 6.4, SLICE_YELLOWS[i % 3], i + 1, 8.6) : ''}
    ${cover(d, LOOK, i, 48)}
    ${wordmark(175, 89.6, 4.6, 'middle')}
    <text x="175" y="93" text-anchor="middle" class="tiny b" fill="${INK}">bitcoinsv.com</text>`)}`
}


/** The engraved dragon: filled with fine gold and ink lines, outlined in ink (never solid). */
const engravedDragon = (id: string, x: number, y: number, size: number, op = 1, outline = 0.16) =>
  `${dragonLine(x, y, size, 'none', 0, op, `url(#e${id})`)}${dragonLine(x, y, size, 'none', 0, op, `url(#f${id})`)}${outline ? dragonLine(x, y, size, INK, outline, op) : ''}`
const engravedDefs = (id: string, gold = GOLD) => `${engraving(`e${id}`, gold, 9, 2.2)}${engraving(`f${id}`, INK, 18, 1.1)}`

/** The scroll dragon: three engraved lines, gold under ink. */
const scrollDragon = (x: number, y: number, size: number) =>
  `${dragonLine(x, y, size, GOLD, size * 0.02)}${dragonLine(x, y, size, INK, size * 0.006)}${dragonLine(x + size * 0.048, y + size * 0.048, size * 0.904, INK, size * 0.003, 0.6)}`

/** Where the fret starts, so its whole keys sit centred across the note. */
const FRET_X = (W - Math.floor(W / 5) * 5) / 2

/** Dragon D, "Imperial": dragon scales, a Greek-key fret, the engraved dragon in a medallion. */
const dragonImperial: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const look: Look = { ...LOOK, seed: { eyebrow: 15.5, box: 18.5, row0: 24.5, gap: 6.4, qrY: 63.5, qr: 21 }, leftTop: 3 }
  const id = `di${clipIds++}`
  return `
    <defs>
      ${engravedDefs(id)}
      <pattern id="s${id}" patternUnits="userSpaceOnUse" width="4.8" height="2.4"><path d="M0 2.4 A2.4 2.4 0 0 1 4.8 2.4 M-2.4 0 A2.4 2.4 0 0 1 2.4 0 M2.4 0 A2.4 2.4 0 0 1 7.2 0" fill="none" stroke="#f0cf5a" stroke-width="0.12"/></pattern>
      <linearGradient id="p${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#fff7d6"/></linearGradient>
      <clipPath id="c${id}"><rect width="${W}" height="${H}" rx="1.5"/></clipPath>
    </defs>
    <g clip-path="url(#c${id})">
      <rect width="${W}" height="${H}" fill="url(#p${id})"/>
      <rect y="7" width="${W}" height="${H - 14}" fill="url(#s${id})" opacity="0.55"/>
      <rect width="${W}" height="7" fill="#ffffff"/><rect y="${H - 7}" width="${W}" height="7" fill="#ffffff"/>
      <path d="${fret(FRET_X, 1.6, W, 1.25)}" fill="none" stroke="${GOLD}" stroke-width="0.4" stroke-linejoin="miter"/>
      <path d="${fret(FRET_X, H - 5.4, W, 1.25)}" fill="none" stroke="${GOLD}" stroke-width="0.4" stroke-linejoin="miter"/>
      ${[6.6, H - 6.6].map(y => `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${INK}" stroke-width="0.25"/><line x1="0" y1="${y + (y < 50 ? 0.7 : -0.7)}" x2="${W}" y2="${y + (y < 50 ? 0.7 : -0.7)}" stroke="${INK}" stroke-width="0.08"/>`).join('')}
      ${toCover(`<circle cx="175" cy="25.5" r="15" fill="#ffffff"/>
      <circle cx="175" cy="25.5" r="15" fill="none" stroke="${GOLD}" stroke-width="0.8"/>
      <circle cx="175" cy="25.5" r="13.9" fill="none" stroke="${INK}" stroke-width="0.14"/>
      <circle cx="175" cy="25.5" r="16" fill="none" stroke="${INK}" stroke-width="0.12"/>
      ${engravedDragon(id, 162.5, 13, 25)}`)}
      ${[70, 140].map(x => `<line x1="${x}" y1="9" x2="${x}" y2="${H - 9}" stroke="${INK}" stroke-width="0.1" stroke-dasharray="0.5 0.9" opacity="0.55"/>`).join('')}
      <rect x="0.4" y="0.4" width="${W - 0.8}" height="${H - 0.8}" rx="1.3" fill="none" stroke="${INK}" stroke-width="0.4"/>
    </g>
    ${toPublic(left(d, look))}
    ${toPrivate(middle(d, look, i))}
    ${toCover(`${slice ? disc(197, 15, 5.6, SLICE_YELLOWS[i % 3], i + 1, 7.8) : ''}
    ${cover(d, look, i, 50.5)}
    ${wordmark(175, 89.6, 4.4, 'middle')}`)}`
}

/** Dragon E, "Cloud": cloud curls on a fine crosshatch, the scroll dragon free on the cover. */
const dragonCloud: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const id = `dk${clipIds++}`
  return `
    <defs>
      <pattern id="x${id}" patternUnits="userSpaceOnUse" width="1.6" height="1.6"><path d="M0 1.6 L1.6 0 M0 0 L1.6 1.6" stroke="#f2d468" stroke-width="0.05"/></pattern>
      <radialGradient id="r${id}" cx="0.5" cy="0.45" r="0.55"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
      <clipPath id="c${id}"><rect width="${W}" height="${H}" rx="2"/></clipPath>
    </defs>
    <g clip-path="url(#c${id})">
      <rect width="${W}" height="${H}" fill="#fffcf0"/>
      <rect width="${W}" height="${H}" fill="url(#x${id})" opacity="0.8"/>
      <path d="${clouds(-2, 5.2, W + 4, 2.6, true)}" fill="none" stroke="${GOLD}" stroke-width="0.3"/>
      <path d="${clouds(0.6, 6.8, W + 4, 2.6, true)}" fill="none" stroke="${INK}" stroke-width="0.1" opacity="0.7"/>
      <path d="${clouds(-2, H - 5.2, W + 4, 2.6, false)}" fill="none" stroke="${GOLD}" stroke-width="0.3"/>
      <path d="${clouds(0.6, H - 6.8, W + 4, 2.6, false)}" fill="none" stroke="${INK}" stroke-width="0.1" opacity="0.7"/>
      ${toCover(`<ellipse cx="175" cy="28" rx="27" ry="21" fill="url(#r${id})"/>
      <path d="${clouds(150, 41, 14, 2.2, false)}" fill="none" stroke="${GOLD}" stroke-width="0.25"/>
      <path d="${clouds(186, 17, 14, 2.2, true)}" fill="none" stroke="${GOLD}" stroke-width="0.25"/>
      ${scrollDragon(159, 11, 32)}`)}
      ${toPrivate(`<rect x="70" y="9" width="70" height="${H - 18}" fill="#ffffff" opacity="0.45"/>`)}
      ${[70, 140].map(x => `<line x1="${x}" y1="10" x2="${x}" y2="${H - 10}" stroke="${GOLD}" stroke-width="0.2" stroke-dasharray="0.8 0.8"/>`).join('')}
      <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="1.6" fill="none" stroke="${GOLD}" stroke-width="0.6"/>
      <rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="1.2" fill="none" stroke="${INK}" stroke-width="0.12"/>
    </g>
    ${toPublic(left(d, { ...LOOK, leftTop: 2 }))}
    ${toPrivate(middle(d, { ...LOOK, seed: { eyebrow: 16, box: 19, row0: 25.5, gap: 6.8, qrY: 66.5, qr: 21 } }, i))}
    ${toCover(`${slice ? disc(155, 17, 6.4, SLICE_YELLOWS[i % 3], i + 1, 8.8) : ''}
    ${cover(d, LOOK, i, 49.5)}
    ${wordmark(147, 89.6, 4.6)}<text x="203" y="89.6" text-anchor="end" class="tiny b" fill="${INK}">bitcoinsv.com</text>`)}`
}

/** Dragon F, "Watermark": one great engraved dragon behind all three panels, a fret-cornered frame. */
const dragonWatermark: Render = (d, i) => {
  const slice = d.kind === 'slice'
  const id = `dw${clipIds++}`
  const corner = (x: number, y: number, sx: number, sy: number) =>
    `<path d="M${x} ${y + sy * 9} V${y} H${x + sx * 9} M${x + sx * 1.4} ${y + sy * 7} V${y + sy * 1.4} H${x + sx * 7} M${x + sx * 2.8} ${y + sy * 5} V${y + sy * 2.8} H${x + sx * 5} V${y + sy * 5} H${x + sx * 4.2}" fill="none" stroke="${GOLD}" stroke-width="0.35"/>`
  return `
    <defs>
      ${engraving(`e${id}`, '#f0cf5a', 9, 2.2)}${engraving(`f${id}`, '#e8c34a', 18, 1.2)}
      <clipPath id="c${id}"><rect width="${W}" height="${H}" rx="1.5"/></clipPath>
    </defs>
    <g clip-path="url(#c${id})">
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      ${dragonLine(40, -16, 132, 'none', 0, 0.4, `url(#e${id})`)}${dragonLine(40, -16, 132, 'none', 0, 0.4, `url(#f${id})`)}${dragonLine(40, -16, 132, '#e6b800', 0.22, 0.5)}
      <rect x="2.2" y="2.2" width="${W - 4.4}" height="${H - 4.4}" fill="none" stroke="${GOLD}" stroke-width="0.35"/>
      <rect x="3.4" y="3.4" width="${W - 6.8}" height="${H - 6.8}" fill="none" stroke="${INK}" stroke-width="0.1"/>
      ${corner(4.6, 4.6, 1, 1)}${corner(W - 4.6, 4.6, -1, 1)}${corner(4.6, H - 4.6, 1, -1)}${corner(W - 4.6, H - 4.6, -1, -1)}
      ${[70, 140].map(x => `<line x1="${x}" y1="6" x2="${x}" y2="${H - 6}" stroke="${INK}" stroke-width="0.1" stroke-dasharray="0.4 1" opacity="0.5"/>`).join('')}
      ${toCover(`<rect x="142" y="5" width="66" height="${H - 10}" fill="#ffffff" opacity="0.55"/>`)}
    </g>
    ${toPublic(left(d, { ...LOOK, leftTop: 1 }))}
    ${toPrivate(middle(d, LOOK, i))}
    ${toCover(`<circle cx="160" cy="20" r="10.5" fill="#ffffff" stroke="${GOLD}" stroke-width="0.5"/><circle cx="160" cy="20" r="9.6" fill="none" stroke="${INK}" stroke-width="0.12"/>
    ${scrollDragon(151.2, 11.2, 17.6)}
    ${slice ? disc(190, 20, 7.2, SLICE_YELLOWS[i % 3], i + 1, 10, false) : `<text x="175" y="21" class="h2" fill="${INK}" style="font-size:4.6px">Bitcoin<tspan fill="${GOLD}">SV</tspan></text>`}
    ${cover(d, LOOK, i, 46, 147, 'start')}
    ${slice ? wordmark(147, 90.5, 4.6) : ''}<text x="203" y="90.5" text-anchor="end" class="tiny b" fill="${INK}">bitcoinsv.com</text>`)}`
}

/** The three dragon designs to choose from (one becomes "Dragon"). */
export const DRAGON_OPTIONS: { id: string; name: string; render: Render }[] = [
  { id: 'dragon-d-imperial', name: 'Imperial', render: dragonImperial },
  { id: 'dragon-e-cloud', name: 'Cloud', render: dragonCloud },
  { id: 'dragon-f-watermark', name: 'Watermark', render: dragonWatermark }
]

/** A note drawn with one of the dragon options (for choosing). */
export function dragonOptionSvg(option: string, d: NoteData, i: number, width = '210mm'): string {
  const render = DRAGON_OPTIONS.find(o => o.id === option)?.render ?? dragonImperial
  return `<svg class="note" viewBox="0 0 ${W} ${H}" style="width:${width};height:calc(${width} * ${H / W})" xmlns="http://www.w3.org/2000/svg">${render(d, i, {})}</svg>`
}

export const NOTE_DESIGNS: { id: NoteDesignId; name: string; blurb: string; render: Render }[] = [
  { id: 'minimal', name: 'Minimal', blurb: 'White and clean, easy on ink', render: minimal },
  { id: 'satoshi', name: 'Satoshi', blurb: 'The original gold coin on a sunburst', render: satoshi },
  { id: 'classic', name: 'Classic', blurb: 'The tri-fold paper wallet, in warm yellow', render: classic },
  { id: 'banknote', name: 'Banknote', blurb: 'Woven bands and a rosette, like a note', render: banknote },
  { id: 'dragon', name: 'Dragon', blurb: 'A bold yellow cover with the dragon', render: dragonDesign },
  { id: 'imperial', name: 'Imperial', blurb: 'The engraved dragon in a medallion, a Greek-key border', render: dragonImperial },
  { id: 'watermark', name: 'Watermark', blurb: 'A great engraved dragon behind it all', render: dragonWatermark },
  { id: 'certificate', name: 'Certificate', blurb: 'A framed certificate with a medallion', render: certificate }
]

/** One note as SVG, drawn at `width` (the page scales it; the drawing is 210 × 99 mm). */
export function noteSvg(design: NoteDesignId, d: NoteData, i: number, a: NoteAssets, width = '210mm'): string {
  const render = NOTE_DESIGNS.find(x => x.id === design)?.render ?? minimal
  const height = `calc(${width} * ${H / W})`
  return `<svg class="note" viewBox="0 0 ${W} ${H}" style="width:${width};height:${height}" xmlns="http://www.w3.org/2000/svg">${render(d, i, a)}</svg>`
}

/** The type the notes are set in (the page supplies Nunito's @font-face). */
export const NOTE_CSS = `
.note text{font-family:'Nunito',sans-serif}
.note .eyebrow{font-size:2.6px;font-weight:800;letter-spacing:0.35px}
.note .eyebrow-sm{font-size:2.05px;font-weight:800;letter-spacing:0.25px}
.note .h1{font-size:6px;font-weight:900;letter-spacing:-0.15px}
.note .h2{font-size:3.6px;font-weight:800}
.note .sub{font-size:2.8px;font-weight:600}
.note .label{font-size:2.3px;font-weight:800;letter-spacing:0.3px}
.note .written{font-size:3.3px;font-weight:800;letter-spacing:-0.02px}
.note .tiny{font-size:2.35px;font-weight:600}
.note .mono{font-variant-numeric:tabular-nums}
.note .b{font-weight:800}
.note .num{font-size:2.3px;font-weight:700}
.note .word{font-size:3.6px;font-weight:800}
.note .word-sm{font-size:2.9px;font-weight:800}
.note .disc-sm{font-size:6px;font-weight:900}
.note .strip{font-size:2.6px;font-weight:800;letter-spacing:0.2px}
.note .formula{font-size:3px;font-style:italic;font-weight:600}
.note .micro{font-size:1.25px;font-weight:700;letter-spacing:0.1px}
.note .code{font-size:2.05px;font-weight:600;font-variant-numeric:tabular-nums}
.note .center{text-align:center}`
