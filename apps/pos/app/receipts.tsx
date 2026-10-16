import React, { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { usePos } from '../src/context'
import { Button, Chip, Field, Navigation, Page, styles } from '../src/ui'
import { useSales } from '../src/useSales'
import { SalesOverview } from '../src/SalesOverview'
import { shortKey, type SaleStatus } from '../src/sales'
import { formatSats } from '../src/checkout'
export default function Receipts() {
  const pos = usePos(),
    report = useSales()
  const [filter, setFilter] = useState<'all' | SaleStatus>('all'),
    [cashier, setCashier] = useState('all'),
    [search, setSearch] = useState(''),
    [expanded, setExpanded] = useState<string | null>(null)
  const names = useMemo(
    () => Object.fromEntries(report.cashiers.map(c => [c.identity.toLowerCase(), c.name])),
    [report.cashiers]
  )
  const identities = [...new Set(report.sales.map(s => s.cashier))]
  const rows = report.sales.filter(
    s =>
      (filter === 'all' || s.status === filter) &&
      (cashier === 'all' || cashier === s.cashier) &&
      `${s.invoice} ${s.txid ?? ''} ${s.cashier} ${names[s.cashier] ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
  )
  return (
    <Page title="Sales" footer={pos.config ? <Navigation role={pos.config.role} /> : undefined}>
      <View style={styles.row}>
        <Text style={styles.body}>
          {pos.config?.role === 'merchant'
            ? 'Every cashier. One merchant wallet.'
            : 'Payments taken by your cashier identity.'}
        </Text>
      </View>
      {report.loaded && <SalesOverview sales={report.sales} names={names} />}
      {report.loaded && (
        <Text style={styles.caption}>Totals cover all verified sales. Filters below apply to the sale list.</Text>
      )}
      <Button
        secondary
        title={report.busy ? 'Refreshing…' : 'Refresh sales'}
        disabled={report.busy}
        onPress={() => void report.refresh()}
      />
      <Field label="Search sales" value={search} onChange={setSearch} />
      <View style={styles.chips}>
        {(['all', 'paid', 'pending', 'unpaid', 'expired'] as const).map(value => (
          <Chip
            key={value}
            title={{ all: 'All', paid: 'Paid', pending: 'Confirming', unpaid: 'Unpaid', expired: 'Expired' }[value]}
            selected={filter === value}
            onPress={() => setFilter(value)}
          />
        ))}
      </View>
      {pos.config?.role === 'merchant' && identities.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={styles.label}>Taken by</Text>
          <View style={styles.chips}>
            <Chip title="All cashiers" selected={cashier === 'all'} onPress={() => setCashier('all')} />
            {identities.map(identity => (
              <Chip
                key={identity}
                title={names[identity] ? `${names[identity]} · ${identity.slice(-4)}` : shortKey(identity)}
                selected={cashier === identity}
                onPress={() => setCashier(identity)}
              />
            ))}
          </View>
        </View>
      )}
      {report.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {report.error}
        </Text>
      ) : null}
      {!rows.length && (
        <View style={styles.card}>
          <Text style={styles.heading}>
            {report.loaded ? 'No matching sales' : report.busy ? 'Loading your sales…' : 'Sales will appear here'}
          </Text>
          <Text style={styles.body}>
            Only a verified merchant receipt counts toward accepted sales. Unresolved payments stay separate.
          </Text>
        </View>
      )}
      {rows.map(s => (
        <View key={s.invoice} style={styles.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sale ${s.invoice}, ${s.status}, ${s.total} satoshis`}
            accessibilityState={{ expanded: expanded === s.invoice }}
            onPress={() => setExpanded(expanded === s.invoice ? null : s.invoice)}
            style={{ gap: 12, minHeight: 64 }}
          >
            <View style={styles.row}>
              <Text style={styles.label}>Sale {s.invoice.slice(-8)}</Text>
              <Text style={[styles.tag, s.status !== 'paid' && { color: '#b4b5be' }]}>
                {s.status === 'pending' ? 'CONFIRMING' : s.status.toUpperCase()}
              </Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.heading}>{formatSats(s.total)} sats</Text>
              <Text style={styles.caption}>
                {names[s.cashier] || shortKey(s.cashier)} {expanded === s.invoice ? '−' : '+'}
              </Text>
            </View>
            <Text style={styles.caption}>
              {formatSats(s.subtotal)} sale · {formatSats(s.tip)} tip
            </Text>
          </Pressable>
          {expanded === s.invoice && (
            <View style={{ gap: 12 }}>
              <View style={styles.divider} />
              <Text style={styles.label}>Taken by</Text>
              <Text style={styles.body}>{names[s.cashier] || 'Cashier'}</Text>
              <Text selectable style={styles.caption}>
                {s.cashier}
              </Text>
              <Text style={styles.label}>Invoice</Text>
              <Text selectable style={styles.caption}>
                {s.invoice}
              </Text>
              {s.txid ? (
                <>
                  <Text style={styles.label}>Transaction</Text>
                  <Text selectable style={styles.caption}>
                    {s.txid}
                  </Text>
                  <Text style={styles.caption}>
                    Accepted by the merchant wallet. This is not a mined-confirmation guarantee.
                  </Text>
                </>
              ) : (
                <Text style={styles.caption}>
                  {s.status === 'pending'
                    ? 'Saved payment awaiting merchant confirmation. Do not request another charge.'
                    : 'No accepted receipt for this invoice.'}
                </Text>
              )}
            </View>
          )}
        </View>
      ))}
    </Page>
  )
}
