// One asset on Home (the prototype's coin rows): its coin, name and ticker;
// its balance and its value in the display currency. A tap opens the coin.
// While the wallet opens, placeholders hold the figures' place (and a whole
// row's, for a coin whose name isn't known yet).
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { font, radii, usePalette } from '../theme'
import { BsvMark } from '../ui/BsvMark'
import { CoinMark } from '../ui/CoinMark'
import { Money } from '../ui/Money'
import { SkeletonBar } from '../ui/Skeleton'
import type { Asset } from '../state/useAssets'
import { spoken } from './BalanceHero'
import { useDisplayCurrency } from '../state/displayCurrency'

export function AssetRow({ asset, privacy, loading = false, onPress }: { asset: Asset; privacy: boolean; loading?: boolean; onPress: () => void }) {
  const palette = usePalette()
  const bsv = asset.id === 'bsv'
  const own = bsv ? spoken(asset.amount, 'bsv') : `${asset.figure} ${asset.ticker}`
  // its worth below, unless the display currency is the coin itself (BSV again)
  const { currency } = useDisplayCurrency()
  const showWorth = asset.fiat != null && !(bsv && currency.code === 'BSV')
  const worth = showWorth ? spoken(asset.fiat as number, 'usd') : null
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${asset.name}, ${loading ? 'loading' : privacy ? 'balance hidden' : [own, worth].filter(Boolean).join(', ')}`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}
    >
      <CoinMark coin={bsv ? { kind: 'bsv' } : { kind: 'token', ticker: asset.ticker }} size={40} />
      <View style={styles.name}>
        <Text numberOfLines={1} style={[font(500), styles.title, { color: palette.foreground }]}>
          {asset.name}
        </Text>
        <View style={styles.sub}>
          {bsv ? <BsvMark size={12} ink /> : null}
          <Text style={[font(400), styles.ticker, { color: palette.mutedForeground }]}>{asset.ticker}</Text>
        </View>
      </View>
      {loading ? (
        <View style={[styles.amounts, styles.barGap]}>
          <SkeletonBar style={styles.skAmount} />
          <SkeletonBar style={styles.skValue} />
        </View>
      ) : (
      <View style={styles.amounts}>
        {bsv ? (
          <Money amount={asset.amount} unit="bsv" privacy={privacy} style={[font(600), styles.amount, { color: palette.foreground }]} />
        ) : (
          <Text style={[font(600), styles.amount, { color: palette.foreground }]}>{privacy ? '••••' : asset.figure}</Text>
        )}
        {showWorth && (
          <Money amount={asset.fiat as number} unit="usd" privacy={privacy} style={[font(400), styles.value, { color: palette.mutedForeground }]} />
        )}
      </View>
      )}
    </Pressable>
  )
}

/** A coin row before its coin is known: a circle and bars, pulsing. */
export function AssetRowSkeleton() {
  return (
    <View style={styles.row} accessible accessibilityRole="progressbar" accessibilityLabel="Loading">
      <SkeletonBar style={styles.skCircle} />
      <View style={[styles.name, styles.barGap]}>
        <SkeletonBar style={styles.skTitle} />
        <SkeletonBar style={styles.skTicker} />
      </View>
      <View style={[styles.amounts, styles.barGap]}>
        <SkeletonBar style={styles.skAmount} />
        <SkeletonBar style={styles.skValue} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 12, borderRadius: radii.xl },
  name: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 20 },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ticker: { fontSize: 12, lineHeight: 16 },
  amounts: { alignItems: 'flex-end' },
  amount: { fontSize: 14, lineHeight: 20, textAlign: 'right', fontVariant: ['tabular-nums'] },
  value: { fontSize: 12, lineHeight: 16, textAlign: 'right', fontVariant: ['tabular-nums'] },
  // the placeholders sit where the text's lines go (20 + 16)
  barGap: { gap: 8, paddingVertical: 4 },
  skCircle: { width: 40, height: 40, borderRadius: 20 },
  skTitle: { height: 12, width: '45%', borderRadius: 999 },
  skTicker: { height: 10, width: '20%', borderRadius: 999 },
  skAmount: { height: 12, width: 64, borderRadius: 999 },
  skValue: { height: 10, width: 40, borderRadius: 999 }
})
