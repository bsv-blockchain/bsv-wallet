// The prototype's TxRow (components/tx-row.tsx): the face on the other side
// (or the payment's direction), who, when and what for, and the signed
// amount, green coming in. A payment still on its way says so, in the
// core's own words for its state.
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { Face } from '../ui/Face'
import { SkeletonBar } from '../ui/Skeleton'
import { signedBsv, timeLabel } from './format'
import type { ActivityItem } from './useActivity'

export function txSubtitle(tx: ActivityItem): string {
  const parts = [tx.createdAt ? timeLabel(tx.createdAt) : null]
  if (tx.pending || tx.status.tone === 'failed') parts.push(tx.statusText)
  parts.push(tx.note ?? (tx.token ? tx.token.unit : 'BSV'))
  return parts.filter(Boolean).join(' · ')
}

export function txAmount(tx: ActivityItem): string {
  return tx.token ? `${tx.token.figure} ${tx.token.unit}` : signedBsv(tx.sats ?? 0)
}

export function TxRow({ tx }: { tx: ActivityItem }) {
  const palette = usePalette()
  const dark = useIsDark()
  const router = useRouter()
  const Icon = tx.incoming ? ArrowDownLeft : ArrowUpRight
  const failed = tx.status.tone === 'failed'
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/activity/[id]', params: { id: tx.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${tx.title}, ${txAmount(tx)}, ${txSubtitle(tx)}`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}
    >
      {({ pressed }) => (
        <>
          {tx.counterparty && tx.counterparty.kind !== 'txid' ? (
            <Face counterparty={tx.counterparty} size={40} />
          ) : (
            // fills white (black in dark) as the row greys, like the Settings
            // tiles (tx-row.tsx: group-active:bg-white dark:group-active:bg-black)
            <Animated.View
              style={[
                styles.glyph,
                {
                  borderColor: palette.foreground + '33',
                  backgroundColor: pressed ? (dark ? '#000000' : '#ffffff') : 'transparent',
                  transitionProperty: 'backgroundColor',
                  transitionDuration: 150
                }
              ]}
            >
              <Icon size={18} color={palette.foreground} />
            </Animated.View>
          )}
          <View style={styles.middle}>
            <Text numberOfLines={1} style={[font(500), styles.title, { color: palette.foreground }]}>
              {tx.title}
            </Text>
            <Text numberOfLines={1} style={[font(400), styles.sub, { color: failed ? palette.destructive : palette.mutedForeground }]}>
              {txSubtitle(tx)}
            </Text>
          </View>
          <Text
            style={[
              font(600),
              styles.amount,
              { color: failed ? palette.mutedForeground : tx.incoming ? palette.positive : palette.foreground },
              failed && styles.struck
            ]}
          >
            {txAmount(tx)}
          </Text>
        </>
      )}
    </Pressable>
  )
}

/**
 * Placeholder rows while payments load (lazy-tx-list.tsx): a circle and two
 * bars where the face and words go, one where the amount goes, pulsing.
 */
export function TxRowSkeleton({ count = 3 }: { count?: number }) {
  const bar = (style: object) => <SkeletonBar style={style} />
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading activity">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.skeleton}>
          {bar(styles.skCircle)}
          <View style={styles.skLines}>
            {bar(styles.skTitle)}
            {bar(styles.skSub)}
          </View>
          {bar(styles.skAmount)}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  skeleton: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 12 },
  skCircle: { width: 40, height: 40, borderRadius: 20 },
  skLines: { flex: 1, gap: 6 },
  skTitle: { height: 12, width: '40%', borderRadius: 999 },
  skSub: { height: 10, width: '25%', borderRadius: 999 },
  skAmount: { height: 12, width: 56, borderRadius: 999 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 12, paddingVertical: 12 },
  glyph: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  middle: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 20 },
  sub: { fontSize: 12, lineHeight: 16 },
  amount: { fontSize: 14, lineHeight: 20, textAlign: 'right', fontVariant: ['tabular-nums'] },
  struck: { textDecorationLine: 'line-through' }
})
