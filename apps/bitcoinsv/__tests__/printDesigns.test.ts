import fs from 'fs'
import path from 'path'
import QRCode from 'qrcode'
import { Mnemonic } from '@bsv/sdk'
import { generateEntropyShares } from '@bsv/expo-wallet-toolbox/core/recovery/shares'
import { hdFromMnemonic, deriveProfileKeys } from '@bsv/expo-wallet-toolbox/core/mnemonicWallet'
import { backupDocument, PRINT_DESIGNS, type PrintDesignId } from '../src/print/document'
import { acceptedLabel, planLabels, setCode } from '../src/print/labelPlan'
import { DRAGON_OPTIONS, NOTE_DESIGNS, NOTE_CSS, dragonOptionSvg, labelLines, noteSvg, type NoteData } from '../src/print/designs'
import { recoverSecretFromShares } from '@bsv/expo-wallet-toolbox/core/recovery/shares'

// a throwaway wallet, made fresh each run: never a real one
const mnemonic = Mnemonic.fromRandom(128).toString()
const words = mnemonic.split(' ')
const slices = generateEntropyShares(Mnemonic.fromString(mnemonic).toEntropy())
const walletId = deriveProfileKeys(hdFromMnemonic(mnemonic), 0).identityKey
const wallets = [
  { index: 0, name: '@satoshi' },
  { index: 1, name: 'Savings' },
  { index: 2, name: 'Wallet 3' }
]
/** the page's words, without markup: long codes are set over several lines */
const text = (html: string) => {
  // until nothing changes: one pass can leave a tag made of two halves
  for (let prev = ''; prev !== html; ) [prev, html] = [html, html.replace(/<[^>]+>/g, '')]
  return html
}
const svg = (n: number) => `<svg viewBox="0 0 1 1" data-qr="${n}"></svg>`

const seed: NoteData = { kind: 'seed', words, phraseQr: svg(-1), walletId, walletIdQr: svg(-2), wallets }
const slice: NoteData = { kind: 'slice', slices, sliceQrs: slices.map((_, i) => svg(i)), walletId, walletIdQr: svg(-2) }

describe.each(PRINT_DESIGNS.map(d => d.id))('%s', design => {
  test('a recovery phrase: every word, its code, the wallet ID and each wallet’s paths', () => {
    const html = backupDocument({ design, data: seed, printed: new Date('2026-10-11') })
    words.forEach(w => expect(html).toContain(`>${w}<`))
    expect(html).toContain('data-qr="-1"')
    expect(html).toContain('data-qr="-2"')
    wallets.forEach(w => {
      expect(html).toContain(`m/0'/${w.index}'`)
      expect(html).toContain(`m/1'/${w.index}'`)
    })
    expect(html).toContain('bitcoinsv.com')
  })

  test('key slices: one page each, each with its own code', () => {
    const html = backupDocument({ design, data: slice, printed: new Date('2026-10-11') })
    slices.forEach((s, i) => {
      expect(text(html)).toContain(s)
      expect(html).toContain(`data-qr="${i}"`)
    })
    expect(html.match(/class="(page|sheet)"/g)).toHaveLength(3)
    expect(html).toContain('bitcoinsv.com')
  })
})

describe.each(PRINT_DESIGNS.map(d => d.id))('labels: %s', design => {
  test('a typed label is printed on the label line, for the phrase and for each slice', () => {
    const seedHtml = text(backupDocument({ design, data: { ...seed, labels: ['Home safe'] }, printed: new Date('2026-10-11') }))
    expect(seedHtml).toContain('Home safe')
    const sliceHtml = text(backupDocument({ design, data: { ...slice, labels: ['Desk drawer', 'Sam', 'Bank box'] }, printed: new Date('2026-10-11') }))
    for (const l of ['Desk drawer', 'Sam', 'Bank box']) expect(sliceHtml).toContain(l)
  })

  test('a label is escaped', () => {
    const html = backupDocument({ design, data: { ...seed, labels: ['<b>Mum & Dad</b>'] }, printed: new Date('2026-10-11') })
    expect(html).not.toContain('<b>Mum')
    expect(html).toContain('&lt;b&gt;Mum &amp; Dad&lt;/b&gt;')
  })
})

describe('label printer', () => {
  test('a 12-word phrase is two labels: the words, then the code; every label marked with the set', () => {
    const labels = planLabels({ ...seed, labels: ['Home safe'] })
    expect(labels.map(l => l.spec.type)).toEqual(['words', 'qr'])
    const first = labels[0].spec
    expect(first.type === 'words' && first.words).toEqual(words)
    expect(labels.every(l => 'set' in l.spec && l.spec.set === setCode(walletId))).toBe(true)
    expect(labels[1].spec.type === 'qr' && labels[1].spec.tag).toBe('Home safe')
    expect(labels.map(l => l.fileName)).toEqual([`Recovery phrase ${setCode(walletId)} 1 of 2.png`, `Recovery phrase ${setCode(walletId)} 2 of 2.png`])
  })

  test('the extra stickers: Accepted Here pays the wallet; Wallets lists every wallet the phrase restores', () => {
    const labels = planLabels(seed, { accepted: { qr: '<svg data-pay></svg>', handle: '@satoshi', shop: 'Joe’s Coffee' }, wallets: true })
    expect(labels.map(l => l.spec.type)).toEqual(['words', 'qr', 'accepted', 'wallets'])
    const accepted = labels[2].spec
    expect(accepted).toEqual({ type: 'accepted', qr: '<svg data-pay></svg>', handle: '@satoshi', shop: 'Joe’s Coffee' })
    expect(labels[2].fileName).toBe('BitcoinSV Accepted Here Joe’s Coffee.png')
    const w = labels[3].spec
    expect(w.type === 'wallets' && w.wallets).toEqual(wallets)
    expect(w.type === 'wallets' && w.set).toBe(setCode(walletId))
    expect(w.type === 'wallets' && w.goesWith).toBe('Recovery phrase · 1/2')
  })

  test('the Accepted Here sticker on its own, from Get paid', () => {
    const l = acceptedLabel({ qr: '<svg></svg>', handle: null, shop: '  ' })
    expect(l.spec).toEqual({ type: 'accepted', qr: '<svg></svg>', handle: undefined, shop: undefined })
    expect(l.fileName).toBe('BitcoinSV Accepted Here.png')
  })

  test('24 words take two word labels and the code', () => {
    const labels = planLabels({ ...seed, words: [...words, ...words] })
    expect(labels.map(l => l.spec.type)).toEqual(['words', 'words', 'qr'])
    expect(labels[1].title).toBe('Words 13–24')
  })

  test('a label per slice: its code, its number, its label', () => {
    const labels = planLabels({ ...slice, labels: ['Desk drawer', '', 'Sam'] })
    expect(labels).toHaveLength(3)
    labels.forEach((l, i) => {
      expect(l.spec.type).toBe('qr')
      if (l.spec.type !== 'qr') return
      expect(l.spec.slice).toBe(i + 1)
      expect(l.spec.qr).toContain(`data-qr="${i}"`)
    })
    expect(labels[0].spec.type === 'qr' && labels[0].spec.tag).toBe('Desk drawer')
    expect(labels[1].spec.type === 'qr' && labels[1].spec.tag).toBeUndefined()
  })
})

test('a long label wraps onto the second line, and is cut short only past both', () => {
  expect(labelLines('Desk drawer')).toEqual(['Desk drawer', ''])
  expect(labelLines('Top shelf of the wardrobe in the spare room')).toEqual(['Top shelf of the', 'wardrobe in the spare room'])
  expect(labelLines('x'.repeat(48))[1].endsWith('…')).toBe(true)
})

test('any two of the printed slices rebuild the phrase', () => {
  const entropy = Mnemonic.fromString(mnemonic).toEntropy()
  for (const pair of [[0, 1], [0, 2], [1, 2]]) {
    expect(recoverSecretFromShares(pair.map(i => slices[i]))).toEqual({ kind: 'entropy', entropy })
  }
})

test('every tri-fold design draws a note for each kind', () => {
  for (const { id } of NOTE_DESIGNS) {
    expect(noteSvg(id, seed, 0, {})).toContain('<svg class="note"')
    expect(noteSvg(id, slice, 2, {})).toContain('KEY SLICE 3 OF 3')
  }
})

// PRINT_PREVIEW=<dir>: the real documents (Nunito, the coin, real QR codes, mock data), to look at
if (process.env.PRINT_PREVIEW) {
  test('preview', async () => {
    const out = process.env.PRINT_PREVIEW!
    const qr = (s: string) => QRCode.toString(s, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#0000' } })
    const fontFaces = (['400Regular', '600SemiBold', '700Bold', '800ExtraBold', '900Black'] as const)
      .map(w => `@font-face{font-family:'Nunito';font-weight:${parseInt(w)};src:url(data:font/ttf;base64,${fs.readFileSync(require.resolve(`@expo-google-fonts/nunito/${w}/Nunito_${w}.ttf`)).toString('base64')}) format('truetype')}`)
      .join('\n')
    const satoshi = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../assets/print/satoshi.png')).toString('base64')
    const walletIdQr = await qr(walletId)
    const realSeed: NoteData = { ...seed, phraseQr: await QRCode.toString(mnemonic, { type: 'svg', margin: 0, errorCorrectionLevel: 'H', color: { dark: '#141414', light: '#0000' } }), walletIdQr }
    const labelled = process.env.PRINT_LABELS === '1'
    const realSlice: NoteData = { ...slice, sliceQrs: await Promise.all(slices.map(qr)), walletIdQr, labels: labelled ? ['Desk drawer', 'Sam', 'Top shelf of the wardrobe in the spare room'] : undefined }
    if (labelled) realSeed.labels = ['Home safe, top shelf']
    PRINT_DESIGNS.forEach((d, k) => {
      for (const [kind, data] of [['seed', realSeed], ['slice', realSlice]] as const) {
        const html = backupDocument({ design: d.id as PrintDesignId, data, printed: new Date(), fontFaces, assets: { satoshi } })
        fs.writeFileSync(path.join(out, `${k + 1}-${d.id}-${kind}.html`), html)
      }
    })
  })
}

// PRINT_PICKER=<dir>: the design picker's previews (assets/print/previews), drawn
// from sample data only: sample words, QR codes that say "sample", no real key
if (process.env.PRINT_PICKER) {
  test('picker previews', async () => {
    const out = process.env.PRINT_PICKER!
    const qr = (s: string) => QRCode.toString(s, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#0000' } })
    const fontFaces = (['400Regular', '600SemiBold', '700Bold', '800ExtraBold', '900Black'] as const)
      .map(w => `@font-face{font-family:'Nunito';font-weight:${parseInt(w)};src:url(data:font/ttf;base64,${fs.readFileSync(require.resolve(`@expo-google-fonts/nunito/${w}/Nunito_${w}.ttf`)).toString('base64')}) format('truetype')}`)
      .join('\n')
    const satoshi = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../assets/print/satoshi.png')).toString('base64')
    const sample = await qr('Bitcoin SV Wallet: sample')
    const sampleWords = ['sample', 'your', 'own', 'words', 'print', 'here', 'when', 'you', 'back', 'up', 'this', 'wallet']
    const sampleId = '02' + 'b5c0'.repeat(16)
    const sampleSlice = (n: number) => `Sample${n}SliceCodeAppearsHereWhenYouPrintYourOwnKeySlices.Sample${n}ItIsNotARealKeyAtAll.2.sample${n}`
    const data: Record<'seed' | 'slice', NoteData> = {
      seed: { kind: 'seed', words: sampleWords, phraseQr: sample, walletId: sampleId, walletIdQr: sample, wallets: [{ index: 0, name: '@satoshi' }, { index: 1, name: 'Savings' }] },
      slice: { kind: 'slice', slices: [1, 2, 3].map(sampleSlice), sliceQrs: [sample, sample, sample], walletId: sampleId, walletIdQr: sample }
    }
    const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces}*{margin:0}body{background:#fff}${NOTE_CSS}</style></head><body>${body}</body></html>`
    for (const kind of ['seed', 'slice'] as const) {
      for (const { id } of NOTE_DESIGNS) {
        fs.writeFileSync(path.join(out, `${id}-${kind}.html`), page(noteSvg(id, data[kind], 0, { satoshi }, '1260px')))
      }
      fs.writeFileSync(path.join(out, `plain-${kind}.html`), backupDocument({ design: 'plain', data: data[kind], printed: new Date('2026-10-11'), fontFaces }))
    }
  })
}

// PRINT_DRAGONS=<dir>: the dragon design options, each for a phrase and a slice, to choose from
if (process.env.PRINT_DRAGONS) {
  test('dragon options', async () => {
    const out = process.env.PRINT_DRAGONS!
    const qr = (s: string) => QRCode.toString(s, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#141414', light: '#0000' } })
    const fontFaces = (['400Regular', '600SemiBold', '700Bold', '800ExtraBold', '900Black'] as const)
      .map(w => `@font-face{font-family:'Nunito';font-weight:${parseInt(w)};src:url(data:font/ttf;base64,${fs.readFileSync(require.resolve(`@expo-google-fonts/nunito/${w}/Nunito_${w}.ttf`)).toString('base64')}) format('truetype')}`)
      .join('\n')
    const walletIdQr = await qr(walletId)
    const s: NoteData = { ...seed, phraseQr: await QRCode.toString(mnemonic, { type: 'svg', margin: 0, errorCorrectionLevel: 'H', color: { dark: '#141414', light: '#0000' } }), walletIdQr, labels: ['Home safe'] }
    const k: NoteData = { ...slice, sliceQrs: await Promise.all(slices.map(qr)), walletIdQr, labels: ['Desk drawer', 'Sam', ''] }
    const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces}*{margin:0}body{background:#d6d6d6;padding:16px;display:flex;flex-direction:column;gap:16px}.note{background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25)}${NOTE_CSS}</style></head><body>${body}</body></html>`
    for (const o of DRAGON_OPTIONS) {
      fs.writeFileSync(path.join(out, `${o.id}.html`), page(dragonOptionSvg(o.id, s, 0, '1200px') + dragonOptionSvg(o.id, k, 1, '1200px')))
    }
  })
}
