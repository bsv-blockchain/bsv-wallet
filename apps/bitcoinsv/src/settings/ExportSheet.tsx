// Export for accounting (the prototype's components/export-sheet.tsx): which
// period, which payments, and as what (a CSV for a spreadsheet, or a PDF
// statement), with how many that is, then the phone's share sheet. From
// Settings, your profile and Activity's menu.
//
// Recent exports are listed under it: a tap sets that period, those payments
// and that format again, ready to export afresh.
//
// Not here, unlike the prototype: Excel files (the CSV opens in Excel), and
// archiving past exports (the file is shared, not kept here).
import React, { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, FileSpreadsheet, FileText } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'
import { showToast } from '../ui/Toast'
import { BottomSheet } from '../ui/BottomSheet'
import { GlassButton } from '../ui/GlassButton'
import { RangeCalendar } from '../ui/RangeCalendar'
import { PERIODS, TYPES, type ExportChoice } from './exportSelect'
import { useExport, type ExportFormat } from './useExport'
import { setPref, usePrefs } from '../state/prefs'
import { useWalletList } from '../home/useWalletList'
import { whenLabel } from '../activity/format'

const FORMATS: { id: ExportFormat; label: string; hint: string; Icon: typeof FileText }[] = [
  { id: 'csv', label: 'Spreadsheet (CSV)', hint: 'Opens in Excel, Numbers or Google Sheets', Icon: FileSpreadsheet },
  { id: 'pdf', label: 'Statement (PDF)', hint: 'To read, print or send on', Icon: FileText }
]

const START: ExportChoice = { period: 'year', from: '', to: '', type: 'all' }

export function ExportSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const palette = usePalette()
  const { load, count, loaded, exportFile, exporting } = useExport()
  const [choice, setChoice] = useState<ExportChoice>(START)
  const [format, setFormat] = useState<ExportFormat>('csv')
  const set = (c: Partial<ExportChoice>) => setChoice(prev => ({ ...prev, ...c }))

  // the payments, read afresh each time it opens
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const n = count(choice)
  const prefs = usePrefs()
  const me = useWalletList().find(w => w.active)
  const recent = prefs.recentExports ?? []
  const label = exporting ? 'Preparing…' : !loaded ? 'Counting…' : n === 0 ? 'Nothing to export' : `Export ${n} payment${n === 1 ? '' : 's'}`

  const chip = (on: boolean, text: string, onPress: () => void) => (
    <Pressable
      key={text}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[styles.chip, { backgroundColor: on ? palette.ink : palette.secondary }]}
    >
      <Text style={[font(600), styles.chipText, { color: on ? palette.inkForeground : palette.secondaryForeground }]}>{text}</Text>
    </Pressable>
  )
  const head = (t: string) => <Text style={[font(600), styles.heading, { color: palette.mutedForeground }]}>{t}</Text>

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Export for accounting" description="This wallet’s payments, as a file to share.">
      <View>
        {head('PERIOD')}
        <View style={styles.chips}>{PERIODS.map(p => chip(choice.period === p.id, p.label, () => set({ period: p.id })))}</View>
        {choice.period === 'custom' && (
          <View style={styles.calendar}>
            <RangeCalendar from={choice.from} to={choice.to} onChange={set} />
          </View>
        )}
      </View>
      <View>
        {head('PAYMENTS')}
        <View style={styles.chips}>{TYPES.map(t => chip(choice.type === t.id, t.label, () => set({ type: t.id })))}</View>
      </View>
      <View>
        {head('FORMAT')}
        <View style={styles.list}>
          {FORMATS.map(f => {
            const on = format === f.id
            return (
              <Pressable
                key={f.id}
                onPress={() => setFormat(f.id)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                style={({ pressed }) => [styles.choice, pressed && { backgroundColor: palette.secondary + '99' }]}
              >
                <View style={[styles.icon, { backgroundColor: palette.secondary }]}>
                  <f.Icon size={18} color={palette.foreground} />
                </View>
                <View style={styles.flex}>
                  <Text style={[font(500), styles.small, { color: palette.foreground }]}>{f.label}</Text>
                  <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>{f.hint}</Text>
                </View>
                <View style={[styles.radio, { borderColor: on ? palette.ink : palette.foreground + '4d' }, on && { backgroundColor: palette.ink }]}>
                  {on && <Check size={12} color={palette.inkForeground} strokeWidth={3} />}
                </View>
              </Pressable>
            )
          })}
        </View>
      </View>
      <GlassButton
        label={label}
        disabled={exporting || !loaded || !n}
        onPress={async () => {
          if (!(await exportFile(choice, format))) return
          showToast('Export ready', { type: 'success', description: `${n === 1 ? '1 payment' : `${n ?? 0} payments`} saved as ${format === 'pdf' ? 'PDF' : 'CSV'}.` })
          setPref('recentExports', [
            { at: new Date().toISOString(), wallet: me?.name ?? 'This wallet', ...choice, format, count: n ?? 0 },
            ...(prefs.recentExports ?? [])
          ].slice(0, 5))
          onOpenChange(false)
        }}
      />
      {recent.length > 0 && (
        <View>
          {head('RECENT')}
          <View style={styles.list}>
            {recent.map(r => (
              <Pressable
                key={r.at}
                onPress={() => {
                  setChoice({ period: r.period as ExportChoice['period'], from: r.from, to: r.to, type: r.type as ExportChoice['type'] })
                  setFormat(r.format as ExportFormat)
                }}
                accessibilityRole="button"
                accessibilityHint="Sets these again"
                style={({ pressed }) => [styles.choice, pressed && { backgroundColor: palette.secondary + '99' }]}
              >
                <View style={styles.flex}>
                  <Text numberOfLines={1} style={[font(500), styles.small, { color: palette.foreground }]}>
                    {[r.period === 'custom' ? `${r.from || 'Start'} – ${r.to || r.from || 'today'}` : PERIODS.find(p => p.id === r.period)?.label, TYPES.find(t => t.id === r.type)?.label, r.format.toUpperCase()].join(' · ')}
                  </Text>
                  <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                    {r.wallet} · {r.count} payment{r.count === 1 ? '' : 's'} · {whenLabel(r.at)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  heading: { fontSize: 11, lineHeight: 16, letterSpacing: 1.1, paddingBottom: 8, paddingLeft: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  chipText: { fontSize: 13, lineHeight: 18 },
  calendar: { paddingTop: 12 },
  list: { marginHorizontal: -8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 8, paddingVertical: 8 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 }
})
