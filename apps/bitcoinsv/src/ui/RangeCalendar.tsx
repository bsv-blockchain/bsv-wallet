// A date range picker in the app's own style (the prototype's components/
// range-calendar.tsx): tap the first day, then the last. The days between sit
// on a soft band; the ends are ink circles. Days after today can't be picked.
// Values are yyyy-mm-dd ("" = open).
import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'
import { isoDay, parseDay } from './days'

const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' })
export const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export function RangeCalendar({ from, to, onChange }: { from: string; to: string; onChange: (range: { from: string; to: string }) => void }) {
  const palette = usePalette()
  const today = isoDay(new Date())
  const [month, setMonth] = useState(() => {
    const d = parseDay(from || to || today)
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  // Monday-first grid: blanks before the 1st, then every day of the month
  const lead = (month.getDay() + 6) % 7
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const days = Array.from({ length: count }, (_, i) => isoDay(new Date(month.getFullYear(), month.getMonth(), i + 1)))
  const now = new Date()
  const lastMonth = month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth()
  const cells: (string | null)[] = [...Array.from({ length: lead }, () => null), ...days]

  const pick = (d: string) => {
    // a fresh range starts on the first tap; the second closes it (either way round)
    if (!from || to) onChange({ from: d, to: '' })
    else if (d < from) onChange({ from: d, to: from })
    else onChange({ from, to: d })
  }
  const shift = (n: number) => setMonth(m => new Date(m.getFullYear(), m.getMonth() + n, 1))

  return (
    <View style={[styles.card, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}>
      {/* the range so far */}
      <View style={styles.ends}>
        {(['from', 'to'] as const).map(k => {
          const v = k === 'from' ? from : to
          const next = k === 'from' ? !from || !!to : !!from && !to
          return (
            <View key={k} style={[styles.end, { boxShadow: `0 0 0 1px ${next ? palette.foreground + '66' : palette.border}` }]}>
              <Text style={[font(400), styles.tiny, { color: palette.mutedForeground }]}>{k === 'from' ? 'From' : 'To'}</Text>
              <Text style={[font(600), styles.small, { color: v ? palette.foreground : palette.mutedForeground + '99' }]}>
                {v ? dayFmt.format(parseDay(v)) : k === 'from' ? 'Pick a day' : 'Then the last'}
              </Text>
            </View>
          )
        })}
      </View>

      <View style={styles.monthRow}>
        <Pressable onPress={() => shift(-1)} accessibilityRole="button" accessibilityLabel="Previous month" style={styles.arrow}>
          <ChevronLeft size={16} color={palette.foreground} />
        </Pressable>
        <Text style={[font(600), styles.small, { color: palette.foreground }]}>{monthFmt.format(month)}</Text>
        <Pressable
          onPress={() => shift(1)}
          disabled={lastMonth}
          accessibilityRole="button"
          accessibilityLabel="Next month"
          style={[styles.arrow, lastMonth && { opacity: 0.3 }]}
        >
          <ChevronRight size={16} color={palette.foreground} />
        </Pressable>
      </View>

      <View style={styles.grid}>
        {WEEKDAYS.map((w, i) => (
          // pb-1 under 11px text: a short row, not a day's height
          <View key={`w${i}`} style={[styles.cell, styles.weekday]}>
            <Text style={[font(600), styles.tiny, { color: palette.mutedForeground }]}>{w}</Text>
          </View>
        ))}
        {cells.map((d, i) => {
          if (!d) return <View key={`b${i}`} style={styles.cell} />
          const end = d === from || d === to
          const col = i % 7
          // the band runs between the ends, rounded off at week edges
          const band = !!from && !!to && from !== to && d >= from && d <= to
          const future = d > today
          return (
            <View
              key={d}
              style={[
                styles.cell,
                band && { backgroundColor: palette.secondary },
                band && (d === from || col === 0) && styles.bandLeft,
                band && (d === to || col === 6) && styles.bandRight
              ]}
            >
              <Pressable
                onPress={() => pick(d)}
                disabled={future}
                accessibilityRole="button"
                accessibilityLabel={dayFmt.format(parseDay(d))}
                accessibilityState={{ selected: end, disabled: future }}
                style={[
                  styles.day,
                  end && { backgroundColor: palette.ink },
                  d === today && !end && { boxShadow: `0 0 0 1px ${palette.foreground + '4d'}` }
                ]}
              >
                <Text
                  style={[
                    // ends font-semibold; today (not an end) font-bold
                    font(end ? 600 : d === today ? 700 : 400),
                    styles.small,
                    { color: end ? palette.inkForeground : future ? palette.mutedForeground + '59' : palette.foreground, fontVariant: ['tabular-nums'] }
                  ]}
                >
                  {Number(d.slice(8))}
                </Text>
              </Pressable>
            </View>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { gap: 12, borderRadius: radii['2xl'], padding: 12 },
  ends: { flexDirection: 'row', gap: 8 },
  end: { flex: 1, borderRadius: radii.xl, paddingHorizontal: 12, paddingVertical: 8 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  arrow: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 },
  cell: { width: `${100 / 7}%`, height: 36, alignItems: 'center', justifyContent: 'center' },
  weekday: { height: 20, paddingBottom: 4, justifyContent: 'flex-end' },
  bandLeft: { borderTopLeftRadius: 18, borderBottomLeftRadius: 18 },
  bandRight: { borderTopRightRadius: 18, borderBottomRightRadius: 18 },
  day: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  small: { fontSize: 14, lineHeight: 20 },
  tiny: { fontSize: 11, lineHeight: 14 }
})
