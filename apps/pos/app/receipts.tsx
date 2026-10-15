import React, { useState } from 'react'
import { Text, View } from 'react-native'
import { usePos } from '../src/context'
import { Button, Page, styles } from '../src/ui'
import { verify } from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import type { Sale } from '../service/controller'
export default function Receipts() {
  const pos = usePos(),
    [sales, setSales] = useState<(Sale & { pending?: boolean })[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  return (
    <Page title="Sales & receipts">
      <Button
        title="Refresh sales"
        disabled={busy}
        onPress={() => {
          setBusy(true)
          setError('')
          void pos
            .rpc<(Sale & { pending?: boolean })[]>('sales')
            .then(async rows => {
              for (const s of rows) {
                await verify(s.request, pos.config!.merchant)
                if (s.receipt) {
                  const receipt = await verify(s.receipt, pos.config!.merchant)
                  if (receipt.invoice !== s.request.payload.invoice || receipt.status !== 'accepted')
                    throw new Error('Invalid receipt')
                }
              }
              setSales(rows)
            })
            .catch(() => setError('Could not load verified receipts'))
            .finally(() => setBusy(false))
        }}
      />
      {!sales.length && <Text style={styles.body}>Refresh to see sales from your merchant service.</Text>}
      {sales.map(s => (
        <View style={styles.card} key={s.request.payload.invoice}>
          <Text style={styles.body}>{s.receipt ? 'Paid' : s.pending ? 'Checking payment' : 'Awaiting payment'}</Text>
          <Text selectable style={styles.body}>
            Invoice {s.request.payload.invoice}
          </Text>
          {s.receipt && (
            <>
              <Text style={styles.amount}>{s.receipt.payload.amount} sats</Text>
              <Text selectable style={styles.body}>
                {s.receipt.payload.txid}
              </Text>
            </>
          )}
        </View>
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Page>
  )
}
