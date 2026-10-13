// One 50 × 30 mm label for a label printer (src/print/labelPlan.ts says
// what's on it), drawn at any width: small as a preview in the picker, large
// to be captured as the PNG that's printed. Made for a black-and-white
// thermal head: pure black on white, no greys, bold type, square QR modules.
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { font } from '../theme'
import { DRAGON } from './dragonPath'
import { DISC, GLYPH } from '../ui/bsvMarkPaths'
import { LABEL_H, LABEL_W, type LabelSpec } from './labelPlan'
import { privateBadge } from './designs'

const INK = '#000'
const PAPER = '#fff'

/** The dragon, white on a black disc: a thermal head prints solid black or nothing. */
const DRAGON_XML = `<svg viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="d"><circle cx="250" cy="250" r="246"/></clipPath></defs><circle cx="250" cy="250" r="246" fill="${INK}"/><path clip-path="url(#d)" fill="${PAPER}" fill-rule="evenodd" d="${DRAGON}"/></svg>`

/** "PRIVATE" with a lock, for the middle of the phrase's code (src/print/designs.ts) */
const BADGE_XML = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${privateBadge(50, 50, 100).replace(/style="font:900 ([\d.]+)px Nunito;letter-spacing:([\d.]+)px"/, 'font-family="Nunito" font-weight="900" font-size="$1" letter-spacing="$2"')}</svg>`

/** The fees line's box reaches 0.58 mm below its letters (Nunito's descent at this size): pulled down by that, the letters' foot meets the code's. */
const FEES_DROP = -0.58

/** Nunito's cap height (OS/2 sCapHeight 705 of 1000): a capital's top above its baseline, in em. */
const CAP = 0.705

/**
 * The sticker's black band, drawn in millimetres: the mark, BitcoinSV and
 * ACCEPTED HERE, each set on a baseline that centres its capitals in the band.
 * (Text views centre their line box, which sits Nunito's capitals high.)
 */
function acceptedBand(wMm: number, hMm: number): string {
  // in tenths of a millimetre: text sized in whole units draws on every platform
  const u = 10
  const w = wMm * u
  const h = hMm * u
  const logo = 4.4 * u
  // a pill: the logo as far from the end as from the top and bottom, so its
  // disc sits concentric with the rounded end; the tag clear of the other curve
  const logoPad = (h - logo) / 2
  const tagPad = 2.4 * u
  const name = 3 * u
  const tag = 2.45 * u
  const track = 0.14 * u
  // italic: Nunito's slant (about 11°), drawn as a skew so every platform sets it the same
  const slant = -11
  const base = (size: number) => h / 2 + (CAP * size) / 2
  const k = logo / 2500
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" rx="${h / 2}" fill="${INK}"/>
    <g transform="translate(${logoPad} ${(h - logo) / 2}) scale(${k})"><path fill="${PAPER}" d="${DISC}"/><path fill="${INK}" d="${GLYPH}"/></g>
    <text x="${logoPad + logo + 0.9 * u}" y="${base(name)}" font-family="Nunito" font-weight="900" font-size="${name}" letter-spacing="-0.6" fill="${PAPER}">BitcoinSV</text>
    <g transform="translate(${w - tagPad + track} ${base(tag)}) skewX(${slant})"><text x="0" y="0" text-anchor="end" font-family="Nunito" font-weight="900" font-size="${tag}" letter-spacing="${track}" fill="${PAPER}">ACCEPTED HERE</text></g>
  </svg>`
}

/** pure black modules: no near-black for the head to dither */
const blackQr = (xml: string) => xml.replace(/#141414/g, INK)

export function LabelView({ spec, width }: { spec: LabelSpec; width: number }) {
  // millimetres to points at this size
  const mm = (n: number) => (n * width) / LABEL_W
  const t = (size: number, weight: 700 | 800 | 900 = 800) => [font(weight), { fontSize: mm(size), lineHeight: mm(size * 1.15), color: INK }]
  const brand = (
    <View style={[styles.row, { gap: mm(0.8) }]}>
      <SvgXml xml={DRAGON_XML} width={mm(3.4)} height={mm(3.4)} />
      <Text style={[t(2.3, 900), { letterSpacing: -mm(0.05) }]}>BitcoinSV</Text>
    </View>
  )
  const setTag = 'set' in spec ? <Text style={t(1.6, 900)}>SET {spec.set}</Text> : null
  const box = { width, height: mm(LABEL_H), backgroundColor: PAPER, paddingHorizontal: mm(2), paddingVertical: mm(1.6) }

  if (spec.type === 'words') {
    const cols = [0, 1, 2].map(c => spec.words.slice(c * 4, c * 4 + 4))
    return (
      <View style={box} collapsable={false}>
        <View style={[styles.between, { paddingBottom: mm(0.8), borderBottomWidth: mm(0.3), borderColor: INK }]}>
          {brand}
          <Text style={[t(1.9, 900), { letterSpacing: mm(0.08) }]}>
            {spec.split ? `WORDS ${spec.from + 1}–${spec.from + spec.words.length} OF ${spec.total}` : 'RECOVERY PHRASE'}
          </Text>
        </View>
        <View style={[styles.row, styles.fill, { alignItems: 'stretch', gap: mm(1.2), paddingVertical: mm(0.9) }]}>
          {cols.map((col, c) => (
            <View key={c} style={[styles.fill, styles.between, { flexDirection: 'column', alignItems: 'stretch' }]}>
              {col.map((w, r) => (
                <View key={r} style={[styles.row, { alignItems: 'baseline' }]}>
                  <Text style={[t(1.7, 900), { width: mm(3) }]}>{spec.from + c * 4 + r + 1}</Text>
                  <Text numberOfLines={1} style={[t(2.6, 800), styles.fill]}>
                    {w}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
        <View style={[styles.between, { paddingTop: mm(0.5), borderTopWidth: mm(0.3), borderColor: INK }]}>
          <Text numberOfLines={1} style={[t(1.7, 800), styles.fill]}>
            {spec.footer}
          </Text>
          <Text style={t(1.7, 900)}>
            SET {spec.set} · {spec.part}
          </Text>
        </View>
      </View>
    )
  }

  if (spec.type === 'qr') {
    return (
      <View style={[box, styles.row, { gap: mm(1.8) }]} collapsable={false}>
        <View>
          <SvgXml xml={blackQr(spec.qr)} width={mm(26.4)} height={mm(26.4)} />
          {/* the phrase's code: PRIVATE over its middle */}
          {spec.slice === null && <SvgXml xml={BADGE_XML} width={mm(26.4)} height={mm(26.4)} style={StyleSheet.absoluteFill} />}
        </View>
        <View style={[styles.fill, styles.between, { flexDirection: 'column', alignItems: 'stretch', height: '100%' }]}>
          {brand}
          {spec.slice !== null ? (
            <View style={[styles.row, { gap: mm(1.4) }]}>
              <View style={[styles.disc, { width: mm(7), height: mm(7), borderRadius: mm(3.5), borderWidth: mm(0.5) }]}>
                <Text style={t(3.9, 900)}>{spec.slice}</Text>
              </View>
              <Text style={t(2.5, 900)}>{spec.title}</Text>
            </View>
          ) : (
            <Text style={t(2.5, 900)}>{spec.title}</Text>
          )}
          <Text style={t(1.75, 800)}>{spec.sub}</Text>
          {spec.tag ? (
            <View style={{ borderWidth: mm(0.3), borderColor: INK, borderRadius: mm(0.8), paddingHorizontal: mm(0.8), paddingVertical: mm(0.3) }}>
              <Text numberOfLines={2} style={t(2.1, 900)}>
                {spec.tag}
              </Text>
            </View>
          ) : null}
          <View style={styles.between}>
            <Text style={t(1.7, 800)}>{spec.foot}</Text>
            {setTag}
          </View>
        </View>
      </View>
    )
  }

  if (spec.type === 'accepted') {
    // Made for a counter: read from a step back, scanned from arm's length.
    // A black band across the top says what it is, as a card decal does; under
    // it the QR code, and beside it the one thing to do, largest: scan to pay.
    // Type is heavy throughout (a thermal head loses thin strokes), and no
    // line is longer than its column, so nothing wraps by accident.
    const band = 6.6
    const gap = 1.3
    const qr = LABEL_H - 2 * 1.4 - band - gap
    const flat = { includeFontPadding: false, textAlignVertical: 'center' as const }
    return (
      <View style={[box, { paddingHorizontal: mm(1.4), paddingVertical: mm(1.4), gap: mm(gap) }]} collapsable={false}>
        <SvgXml xml={acceptedBand(LABEL_W - 2 * 1.4, band)} width={mm(LABEL_W - 2 * 1.4)} height={mm(band)} />
        <View style={[styles.row, styles.fill, { gap: mm(1.6), alignItems: 'stretch' }]}>
          <SvgXml xml={blackQr(spec.qr)} width={mm(qr)} height={mm(qr)} />
          {/* the column's foot (the fees) sits flush with the code's foot */}
          <View style={styles.fill}>
            {/* the call to action, centred in the room above the fees */}
            <View style={{ flex: 1, justifyContent: 'center', gap: mm(0.7) }}>
              {spec.shop ? (
                <Text numberOfLines={2} style={[font(900), flat, { fontSize: mm(2.5), lineHeight: mm(2.9), color: INK, letterSpacing: -mm(0.04) }]}>
                  {spec.shop}
                </Text>
              ) : null}
              {/* as big as the column allows: about 5.3 em wide, in 26 mm */}
              <Text style={[font(900), flat, { fontSize: mm(spec.shop ? 4.4 : 4.8), lineHeight: mm(spec.shop ? 5 : 5.4), color: INK, letterSpacing: -mm(0.1) }]}>Scan to pay</Text>
              {/* the fallback when the code won't scan: the handle, to type (only when the wallet has one) */}
              {spec.handle ? (
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                  style={[font(800), flat, { fontSize: mm(2.5), lineHeight: mm(3), color: INK }]}
                >
                  or pay <Text style={font(900)}>{spec.handle}</Text>
                </Text>
              ) : null}
            </View>
            <Text numberOfLines={1} style={[font(800), flat, { fontSize: mm(1.75), lineHeight: mm(2.2), color: INK, marginBottom: mm(FEES_DROP) }]}>
              Instant · fees under 1¢
            </Text>
          </View>
        </View>
      </View>
    )
  }

  // wallets: every wallet the phrase restores, and where each one's keys are
  const rows = spec.wallets.length > 5 ? spec.wallets.slice(0, 4) : spec.wallets
  const more = spec.wallets.length - rows.length
  return (
    <View style={box} collapsable={false}>
      <View style={[styles.between, { paddingBottom: mm(0.7), borderBottomWidth: mm(0.3), borderColor: INK }]}>
        {brand}
        <Text style={t(1.7, 900)}>SET {spec.set}</Text>
      </View>
      <Text style={[t(2.2, 900), { paddingTop: mm(0.7) }]}>Wallets on this phrase</Text>
      <Text style={t(1.5, 800)}>The phrase ({spec.goesWith}) restores every one · Safe to share: no keys here</Text>
      <View style={[styles.fill, { justifyContent: 'center', gap: mm(0.25) }]}>
        <View style={styles.row}>
          <Text style={[t(1.45, 900), styles.fill]}>WALLET</Text>
          <Text style={[t(1.45, 900), { width: mm(9) }]}>KEYS</Text>
          <Text style={[t(1.45, 900), { width: mm(9) }]}>PRIVILEGED</Text>
        </View>
        {rows.map(w => (
          <View key={w.index} style={styles.row}>
            <Text numberOfLines={1} style={[t(1.75, 900), styles.fill]}>
              {w.name}
            </Text>
            <Text style={[t(1.75, 800), { width: mm(9) }]}>{`m/0'/${w.index}'`}</Text>
            <Text style={[t(1.75, 800), { width: mm(9) }]}>{`m/1'/${w.index}'`}</Text>
          </View>
        ))}
        {more > 0 && <Text style={t(1.5, 800)}>{`+${more} more: m/0'/n' and m/1'/n'`}</Text>}
      </View>
      <Text style={[t(1.5, 800), { paddingTop: mm(0.4), borderTopWidth: mm(0.3), borderColor: INK }]}>
        BIP39 seed, no passphrase{spec.tag ? ` · “${spec.tag}”` : ''}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fill: { flex: 1, minWidth: 0 },
  disc: { alignItems: 'center', justifyContent: 'center', borderColor: INK }
})
