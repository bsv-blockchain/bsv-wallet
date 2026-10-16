import React from 'react'
import { Text, View } from 'react-native'
import { Metric, styles } from './ui'
import { byCashier, shortKey, summarizeSales, type VerifiedSale } from './sales'
import { formatSats } from './checkout'
export function SalesOverview({
  sales,
  names = {},
  showCashiers = false
}: {
  sales: VerifiedSale[]
  names?: Record<string, string>
  showCashiers?: boolean
}) {
  const summary = summarizeSales(sales),
    grouped = byCashier(sales)
  return (
    <View style={{ gap: 20 }}>
      <View style={styles.row}>
        <Text style={styles.label}>Accepted payments</Text>
        <Text style={styles.caption}>All time · satoshis</Text>
      </View>
      <View style={styles.metrics}>
        <Metric
          label="Sales total"
          value={formatSats(summary.total)}
          detail={`${summary.count} paid ${summary.count === 1 ? 'sale' : 'sales'}`}
        />
        <Metric label="Tips included" value={formatSats(summary.tips)} detail="Part of the sales total" />
        <Metric
          label="Average sale"
          value={formatSats(summary.average)}
          detail={`${summary.pending} awaiting confirmation`}
        />
      </View>
      {showCashiers && (
        <View style={styles.card}>
          <Text style={styles.heading}>By cashier</Text>
          {grouped.length ? (
            grouped.map(row => (
              <View key={row.identity} style={{ gap: 7 }}>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.body}>{names[row.identity] || shortKey(row.identity)}</Text>
                    <Text style={styles.caption}>
                      {shortKey(row.identity)} · {row.count} paid · {row.pending} pending
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.heading, { fontSize: 18 }]}>{formatSats(row.total)} sats</Text>
                    <Text style={styles.caption}>{formatSats(row.tips)} in tips</Text>
                  </View>
                </View>
                <View style={styles.divider} />
              </View>
            ))
          ) : (
            <Text style={styles.body}>Accepted payments will appear here with the cashier who took them.</Text>
          )}
        </View>
      )}
    </View>
  )
}
