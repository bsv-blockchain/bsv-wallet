// Choosing how a backup looks on paper, before printing it: a sheet from the
// bottom with every design (src/print/document.ts), each shown with sample
// data (assets/print/previews, from scripts/print-previews.sh: sample words,
// QR codes that say "sample", never the wallet's own). Tapping one picks it and
// puts its Print button under it; the pick is remembered for next time.
//
// Above them, "Advanced options" (off until turned on), with what they are
// behind its (i):
// - Add labels: a label for the phrase, or one for each slice, printed on the
//   label line where it would otherwise be written by hand.
// - Print on label printer: 50 × 30 mm black-and-white labels for a thermal
//   label printer, shared as a PDF (src/print/labels.ts). One template, so the
//   designs make way for its preview.
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Image } from 'expo-image'
import Animated from 'react-native-reanimated'
import { Check, Printer } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { GlassButton } from '../ui/GlassButton'
import { enter } from '../ui/motion'
import { Switch } from '../ui/Switch'
import { ViewInfo } from '../ui/ViewInfo'
import { LabelPrinterPanel, SiteLink, useSample } from './LabelPrinterPanel'
import { planLabels } from './labelPlan'
import { useAcceptedSticker } from './useAcceptedSticker'
import { useFocusRing } from '../ui/focusRing'
import { setPref, usePrefs } from '../state/prefs'
import { PRINT_DESIGNS, type PrintDesignId } from './document'
import { LABEL_MAX, SLICE_YELLOWS, type BackupKind, type NoteData } from './designs'

/* eslint-disable @typescript-eslint/no-require-imports */
const PREVIEWS: Record<BackupKind, Record<PrintDesignId, number>> = {
  seed: {
    classic: require('../../assets/print/previews/classic-seed.jpg'),
    banknote: require('../../assets/print/previews/banknote-seed.jpg'),
    dragon: require('../../assets/print/previews/dragon-seed.jpg'),
    imperial: require('../../assets/print/previews/imperial-seed.jpg'),
    watermark: require('../../assets/print/previews/watermark-seed.jpg'),
    minimal: require('../../assets/print/previews/minimal-seed.jpg'),
    certificate: require('../../assets/print/previews/certificate-seed.jpg'),
    satoshi: require('../../assets/print/previews/satoshi-seed.jpg'),
    plain: require('../../assets/print/previews/plain-seed.jpg')
  },
  slice: {
    classic: require('../../assets/print/previews/classic-slice.jpg'),
    banknote: require('../../assets/print/previews/banknote-slice.jpg'),
    dragon: require('../../assets/print/previews/dragon-slice.jpg'),
    imperial: require('../../assets/print/previews/imperial-slice.jpg'),
    watermark: require('../../assets/print/previews/watermark-slice.jpg'),
    minimal: require('../../assets/print/previews/minimal-slice.jpg'),
    certificate: require('../../assets/print/previews/certificate-slice.jpg'),
    satoshi: require('../../assets/print/previews/satoshi-slice.jpg'),
    plain: require('../../assets/print/previews/plain-slice.jpg')
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

export interface PrintOptions {
  labels?: string[]
  labelPrinter?: boolean
}

const ADVANCED_INFO =
  'Add labels: type a name for each page, printed where you’d write one by hand. Print on label printer: small 50 × 30 mm black-and-white labels for thermal printers like Niimbot, as images to print at labelprint.bsvb.net or from the printer’s app.'

/** What's picked until the person picks another. */
const DEFAULT_DESIGN: PrintDesignId = 'minimal'

/** A tri-fold note's shape (210 × 99 mm), and a full page's (A4). */
const NOTE_RATIO = 210 / 99
const PAGE_RATIO = 210 / 297

export function DesignSheet({
  open,
  onOpenChange,
  kind,
  printing,
  onPrint,
  makeLabelData
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: BackupKind
  /** a print is being prepared: the button spins */
  printing: boolean
  onPrint: (design: PrintDesignId, options: PrintOptions) => void
  /** the wallet's own data for label-printer labels, with any labels typed */
  makeLabelData: (labels?: string[]) => Promise<NoteData | null>
}) {
  const palette = usePalette()
  const prefs = usePrefs()
  const remembered = prefs.printDesigns?.[kind] as PrintDesignId | undefined
  // a tap this time, else the last design printed
  const [tapped, setTapped] = useState<PrintDesignId | null>(null)
  const picked = tapped ?? remembered ?? DEFAULT_DESIGN
  // the advanced options, for this print, kept while the sheet's open
  const [advanced, setAdvanced] = useState(false)
  const [labelling, setLabelling] = useState(false)
  const [labelPrinter, setLabelPrinter] = useState(false)
  // the phrase's extra stickers, both safe to share
  const [accepted, setAccepted] = useState(false)
  const [shop, setShop] = useState('')
  const [walletsSticker, setWalletsSticker] = useState(false)
  const acceptedSticker = useAcceptedSticker()
  const sample = useSample(kind)
  const [labels, setLabels] = useState<string[]>(['', '', ''])
  const fields = kind === 'slice' ? 3 : 1
  const withLabels = advanced && labelling
  const onLabelPrinter = advanced && labelPrinter
  const openChange = (o: boolean) => {
    if (!o) {
      setTapped(null)
      setAdvanced(false)
      setLabelling(false)
      setLabelPrinter(false)
      setAccepted(false)
      setShop('')
      setWalletsSticker(false)
      setLabels(['', '', ''])
    }
    onOpenChange(o)
  }

  const print = (design: PrintDesignId) => {
    if (!onLabelPrinter) setPref('printDesigns', { ...prefs.printDesigns, [kind]: design })
    onPrint(design, { labels: withLabels ? labels.slice(0, fields) : undefined, labelPrinter: onLabelPrinter })
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={openChange}
      title={onLabelPrinter ? 'Print on label printer' : 'Choose a design'}
      description={
        onLabelPrinter
          ? kind === 'slice'
            ? 'A 50 × 30 mm label for each slice, in black and white.'
            : 'Two 50 × 30 mm labels for your phrase, in black and white, and any stickers you add.'
          : kind === 'slice'
            ? 'Each slice prints on its own page, to cut out and fold. Every design prints well in black ink alone.'
            : 'Your phrase prints on one page, to cut out and fold. Every design prints well in black ink alone.'
      }
    >
      <View style={[styles.options, { backgroundColor: palette.secondary + '80' }]}>
        <View style={styles.row}>
          {/* the whole row turns it on, as the settings rows do */}
          <Pressable onPress={() => setAdvanced(v => !v)} accessible={false} style={[styles.row, styles.flex]}>
            <Text style={[font(700), styles.name, styles.flex, { color: palette.foreground }]}>Advanced options</Text>
          </Pressable>
          <ViewInfo about="Advanced options" text={ADVANCED_INFO} />
          <Switch value={advanced} onValueChange={setAdvanced} label="Advanced options" />
        </View>
        {advanced && (
          <Animated.View style={[styles.fields, enter({ opacity: 0, translateY: -4, duration: 200 })]}>
            <OptionRow
              label={labelPrinter ? 'Add custom label' : 'Add labels'}
              blurb={
                labelPrinter
                  ? 'Your own text, like “piggy bank”'
                  : kind === 'slice'
                    ? 'Printed on each slice, where you’d write one by hand'
                    : 'Printed on the page, where you’d write one by hand'
              }
              value={labelling}
              onChange={setLabelling}
            />
            {labelling && (
              <Animated.View style={[styles.fields, enter({ opacity: 0, translateY: -4, duration: 200 })]}>
                {Array.from({ length: fields }, (_, k) => (
                  <LabelField
                    key={k}
                    n={kind === 'slice' ? k + 1 : null}
                    value={labels[k]}
                    onChange={v => setLabels(ls => ls.map((l, j) => (j === k ? v : l)))}
                  />
                ))}
                <Text style={[font(400), styles.hint, { color: palette.mutedForeground }]}>
                  Plain words, like “Desk drawer” or “Sam”: nothing that says crypto or wallet.
                </Text>
              </Animated.View>
            )}
            <OptionRow
              label="Print on label printer"
              blurb="50 × 30 mm labels in black and white, for thermal printers like Niimbot"
              value={labelPrinter}
              onChange={on => {
                setLabelPrinter(on)
                // the phrase's two stickers come with it, each still turned off on its own
                if (on) {
                  setAccepted(true)
                  setWalletsSticker(true)
                }
              }}
            />
            {labelPrinter && kind === 'seed' && (
              <>
                <OptionRow label="Accepted here sticker" blurb="A QR code anyone can scan to pay you. Safe to share." value={accepted} onChange={setAccepted} />
                {accepted && <LabelField n={null} value={shop} onChange={setShop} placeholder="Shop name (optional)" />}
                <OptionRow label="Wallets sticker" blurb="Every wallet this phrase restores, with its paths. Safe to share." value={walletsSticker} onChange={setWalletsSticker} />
              </>
            )}
          </Animated.View>
        )}
      </View>
      {onLabelPrinter ? (
        // one template, made as images to share
        <LabelPrinterPanel
          key={`${kind}-${accepted}-${walletsSticker}`}
          previews={
            sample
              ? planLabels(sample, {
                  accepted: accepted && kind === 'seed' ? { qr: sample.walletIdQr, handle: '@satoshi', shop } : undefined,
                  wallets: walletsSticker && kind === 'seed'
                })
              : []
          }
          intro={
            <>
              {kind === 'slice' ? 'A label for each slice, as an image to print at ' : 'The words, then the QR code, as images to print at '}
              <SiteLink /> or from your label printer’s app.
            </>
          }
          makeLabels={async () => {
            const data = await makeLabelData(withLabels ? labels.slice(0, fields) : undefined)
            if (!data) return null
            return planLabels(data, {
              accepted: accepted && kind === 'seed' && acceptedSticker ? acceptedSticker.sticker(shop) : undefined,
              wallets: walletsSticker && kind === 'seed'
            })
          }}
        />
      ) : (
      <View style={styles.list}>
        {PRINT_DESIGNS.map(d => {
          const on = d.id === picked
          const plain = d.id === 'plain'
          return (
            <Pressable
              key={d.id}
              onPress={() => setTapped(d.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${d.name}. ${d.blurb}`}
              style={[
                styles.card,
                { backgroundColor: palette.card, boxShadow: on ? `0 0 0 2px ${palette.ink}` : `0 0 0 1px ${palette.border}` }
              ]}
            >
              <View style={[styles.preview, { backgroundColor: palette.secondary }]}>
                <Image
                  source={PREVIEWS[kind][d.id]}
                  contentFit="contain"
                  transition={150}
                  accessible={false}
                  style={plain ? [styles.page, { aspectRatio: PAGE_RATIO }] : { width: '100%', aspectRatio: NOTE_RATIO }}
                />
              </View>
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Text style={[font(700), styles.name, { color: palette.foreground }]}>{d.name}</Text>
                  <Text style={[font(400), styles.blurb, { color: palette.mutedForeground }]}>{d.blurb}</Text>
                </View>
                <View style={[styles.radio, { borderColor: on ? palette.ink : palette.foreground + '4d' }, on && { backgroundColor: palette.ink }]}>
                  {on && <Check size={12} color={palette.inkForeground} strokeWidth={3} />}
                </View>
              </View>
              {on && (
                <Animated.View style={enter({ opacity: 0, translateY: -4, duration: 200 })}>
                  <GlassButton
                    label={kind === 'slice' ? 'Print my 3 slices' : 'Print my phrase'}
                    icon={<Printer size={18} color={palette.goldForeground} />}
                    loading={printing}
                    onPress={() => print(d.id)}
                  />
                </Animated.View>
              )}
            </Pressable>
          )
        })}
      </View>
      )}
    </BottomSheet>
  )
}

/** An advanced option: what it does, and its switch (the whole row turns it). */
function OptionRow({ label, blurb, value, onChange }: { label: string; blurb: string; value: boolean; onChange: (v: boolean) => void }) {
  const palette = usePalette()
  return (
    <Pressable onPress={() => onChange(!value)} accessible={false} style={[styles.row, styles.option, { backgroundColor: palette.card }]}>
      <View style={styles.flex}>
        <Text style={[font(600), styles.optionName, { color: palette.foreground }]}>{label}</Text>
        <Text style={[font(400), styles.blurb, { color: palette.mutedForeground }]}>{blurb}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} label={label} />
    </Pressable>
  )
}

/** One label: for the phrase, or a slice (with its numbered disc). */
export function LabelField({ n, value, onChange, placeholder }: { n: number | null; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const palette = usePalette()
  const ring = useFocusRing(palette)
  return (
    <Animated.View style={[styles.field, { backgroundColor: palette.card }, ring.style]}>
      {n !== null && (
        <View style={[styles.disc, { backgroundColor: SLICE_YELLOWS[n - 1] }]}>
          <Text style={[font(900), styles.discText]}>{n}</Text>
        </View>
      )}
      <TextInput
        {...ring.handlers}
        value={value}
        onChangeText={onChange}
        maxLength={LABEL_MAX}
        placeholder={placeholder ?? (n === null ? 'Label' : `Label for slice ${n}`)}
        placeholderTextColor={palette.mutedForeground + 'b3'}
        accessibilityLabel={placeholder ?? (n === null ? 'Label' : `Label for slice ${n}`)}
        autoCapitalize="sentences"
        autoCorrect={false}
        returnKeyType="done"
        style={[font(600), styles.input, { color: palette.foreground }]}
      />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  options: { borderRadius: radii['2xl'], padding: 14, gap: 12, marginBottom: 14 },
  option: { borderRadius: radii.xl, paddingHorizontal: 12, paddingVertical: 10 },
  optionName: { fontSize: 15, lineHeight: 20 },
  fields: { gap: 8 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 48, borderRadius: radii.xl, paddingHorizontal: 12 },
  disc: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#141414' },
  discText: { fontSize: 13, lineHeight: 16, color: '#141414' },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  hint: { fontSize: 12, lineHeight: 16, paddingHorizontal: 4 },
  list: { gap: 14 },
  card: { borderRadius: radii['2xl'], padding: 10, gap: 10 },
  preview: { borderRadius: radii.xl, overflow: 'hidden', alignItems: 'center' },
  page: { height: 240 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 },
  flex: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 22 },
  blurb: { fontSize: 13, lineHeight: 18 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }
})
