// "Print on label printer", in the design picker: 50 × 30 mm labels as PNG
// images (Niimbot printers and labelprint.bsvb.net take images), one to share
// at a time.
//
// The previews are the labels themselves drawn with sample data. The real
// ones are drawn out of sight, captured at 600 × 360 (react-native-view-shot)
// and listed, each with its Share button. The images hold the phrase or the
// slices, so they're deleted from the phone when the panel goes.
import React, { useEffect, useRef, useState } from 'react'
import { Linking, PixelRatio, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { captureRef } from 'react-native-view-shot'
import { Share, Tag } from 'lucide-react-native'
import QRCode from 'qrcode'
import { font, radii, usePalette } from '../theme'
import { GlassButton } from '../ui/GlassButton'
import { enter } from '../ui/motion'
import { LabelView } from './LabelView'
import { LABEL_H, LABEL_W, type PlannedLabel } from './labelPlan'
import type { BackupKind, NoteData } from './designs'

/** The captured image's width: 12 pixels to the millimetre (about 300 dpi), so 600 × 360. */
const PNG_W = 600
/** How wide the out-of-sight labels are drawn: in points, exactly the image's pixels at the screen's scale. */
const drawWidth = () => PNG_W / PixelRatio.get()

/** Sample words for previews: never anyone's phrase. */
const SAMPLE_WORDS = ['sample', 'your', 'own', 'words', 'print', 'here', 'when', 'you', 'back', 'up', 'this', 'wallet']

/** The previews' data: sample words, QR codes that say "sample", never the wallet's own. */
export function useSample(kind: BackupKind): NoteData | null {
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void QRCode.toString('Bitcoin SV Wallet: sample', { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000', light: '#0000' } }).then(
      x => alive && setQr(x)
    )
    return () => {
      alive = false
    }
  }, [])
  if (!qr) return null
  const walletId = '02' + 'b5c0'.repeat(16)
  return kind === 'seed'
    ? { kind, words: SAMPLE_WORDS, phraseQr: qr, walletId, walletIdQr: qr, wallets: [{ index: 0, name: '@satoshi' }] }
    : { kind, slices: ['sample', 'sample', 'sample'], sliceQrs: [qr, qr, qr], walletId, walletIdQr: qr }
}

/** Where we suggest printing them: it takes the images, and prints to Niimbot printers. */
const PRINT_SITE = 'labelprint.bsvb.net'

/** Deletes captured images (secrets) when they're no longer wanted. */
function forget(uris: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { File } = require('expo-file-system') as typeof import('expo-file-system')
  for (const uri of uris) {
    try {
      const f = new File(uri)
      if (f.exists) f.delete()
    } catch {
      // already gone
    }
  }
}

export function LabelPrinterPanel({
  previews,
  intro,
  makeLabels,
  secret = true,
  heading = 'Your labels',
  action = 'Make labels',
  showPreviews = true
}: {
  /** what's shown before they're made: sample data for secrets, the real thing otherwise */
  previews: PlannedLabel[]
  /** a line under the previews (what they are, where to print them) */
  intro: React.ReactNode
  /** the real labels; null if they can't be made */
  makeLabels: () => Promise<PlannedLabel[] | null>
  /** they hold the phrase or the slices: say they're deleted, and why */
  secret?: boolean
  heading?: string
  /** the button that makes them */
  action?: string
  /** the small previews (off when the screen shows its own) */
  showPreviews?: boolean
}) {
  const palette = usePalette()
  const [making, setMaking] = useState(false)
  // the real labels, drawn out of sight until each is captured
  const [drawing, setDrawing] = useState<PlannedLabel[] | null>(null)
  const [made, setMade] = useState<{ label: PlannedLabel; uri: string }[] | null>(null)
  const refs = useRef<(View | null)[]>([])
  const files = useRef<string[]>([])

  // the images go with the panel (which starts afresh when its options change)
  useEffect(() => () => forget(files.current), [])

  const make = async () => {
    setMaking(true)
    const labels = await makeLabels().catch(() => null)
    if (!labels?.length) return setMaking(false)
    setDrawing(labels)
  }

  // once the real labels are drawn: each one to a PNG, named for what it is
  useEffect(() => {
    if (!drawing) return
    let alive = true
    const t = setTimeout(async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
      const out: { label: PlannedLabel; uri: string }[] = []
      for (let k = 0; k < drawing.length; k++) {
        const view = refs.current[k]
        if (!view) continue
        // drawn at the image's own size, and from the view's own layers (iOS),
        // so the clipped window it sits in doesn't matter
        const tmp = await captureRef(view, { format: 'png', result: 'tmpfile', useRenderInContext: true })
        const named = new File(Paths.cache, drawing[k].fileName)
        if (named.exists) named.delete()
        new File(tmp).move(named)
        files.current.push(named.uri)
        out.push({ label: drawing[k], uri: named.uri })
      }
      if (!alive) return forget(out.map(o => o.uri))
      setMade(out)
      setDrawing(null)
      setMaking(false)
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [drawing])

  const share = async (item: { label: PlannedLabel; uri: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shareAsync } = require('expo-sharing') as typeof import('expo-sharing')
    await shareAsync(item.uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: item.label.fileName }).catch(() => {})
  }

  return (
    <Animated.View style={[styles.card, { backgroundColor: palette.card, boxShadow: `0 0 0 2px ${palette.ink}` }, enter({ opacity: 0, translateY: 6, duration: 200 })]}>
      {made ? (
        <>
          <Text style={[font(700), styles.heading, { color: palette.foreground }]}>{heading}</Text>
          {made.map((item, k) => (
            <View key={item.uri} style={[styles.made, { backgroundColor: palette.secondary + '80' }]}>
              <View style={[styles.num, { backgroundColor: palette.ink }]}>
                <Text style={[font(800), styles.numText, { color: palette.inkForeground }]}>{k + 1}</Text>
              </View>
              <View style={styles.flex}>
                <Text style={[font(600), styles.title, { color: palette.foreground }]}>{item.label.title}</Text>
                <Text numberOfLines={1} style={[font(400), styles.small, { color: palette.mutedForeground }]}>
                  {item.label.fileName}
                </Text>
              </View>
              <GlassButton size="sm" label="Share" icon={<Share size={16} color={palette.goldForeground} />} onPress={() => void share(item)} />
            </View>
          ))}
          <Text style={[font(400), styles.small, styles.pad, { color: palette.mutedForeground }]}>
            Print {made.length > 1 ? 'them' : 'it'} at <SiteLink /> or from your label printer’s app.
            {secret ? ' Every label shows the same set code, so you can tell they belong together. The images are deleted from this phone when you close this.' : ''}
          </Text>
        </>
      ) : (
        <>
          {showPreviews && (
            <View style={[styles.previews, { backgroundColor: palette.secondary }]}>
              {previews.map((p, k) => (
                <View key={k} style={styles.preview}>
                  <LabelView spec={p.spec} width={148} />
                </View>
              ))}
            </View>
          )}
          <Text style={[font(400), styles.small, styles.pad, { color: palette.mutedForeground }]}>
            {intro}
          </Text>
          <GlassButton label={action} icon={<Tag size={18} color={palette.goldForeground} />} loading={making} onPress={() => void make()} />
        </>
      )}
      {/* the real labels, out of sight, only while they're captured */}
      {drawing && (
        <View pointerEvents="none" style={styles.offstage} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {drawing.map((p, k) => (
            <View key={k} ref={v => void (refs.current[k] = v)} collapsable={false} style={{ width: drawWidth(), height: (drawWidth() * LABEL_H) / LABEL_W }}>
              <LabelView spec={p.spec} width={drawWidth()} />
            </View>
          ))}
        </View>
      )}
    </Animated.View>
  )
}

/** labelprint.bsvb.net, opened in the browser. */
export function SiteLink() {
  const palette = usePalette()
  return (
    <Text
      onPress={() => void Linking.openURL(`https://${PRINT_SITE}`)}
      accessibilityRole="link"
      style={[font(700), { color: palette.foreground, textDecorationLine: 'underline' }]}
    >
      {PRINT_SITE}
    </Text>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radii['2xl'], padding: 10, gap: 10 },
  heading: { fontSize: 16, lineHeight: 22, paddingHorizontal: 4 },
  previews: { borderRadius: radii.xl, padding: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  preview: { boxShadow: '0 1px 3px rgba(0,0,0,0.18)' },
  made: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radii.xl, padding: 10 },
  num: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 13, lineHeight: 16 },
  flex: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  pad: { paddingHorizontal: 4 },
  // drawn but not seen: a 1-point window, out of the way (the capture draws the whole view)
  offstage: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'hidden', opacity: 1 }
})
