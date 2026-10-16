import React, { useCallback, useState } from 'react'
import { Text, View, useWindowDimensions } from 'react-native'
import { useFocusEffect } from 'expo-router'
import QRCode from 'react-native-qrcode-svg'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { encodePos, key, type Signed, type Invite } from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import { usePos } from '../src/context'
import { Button, Navigation, Page, styles } from '../src/ui'
import { DEFAULT_MERCHANT_SERVICE } from '../src/config'
import type { Cashier } from '../service/controller'
export default function Merchant() {
  const { width } = useWindowDimensions()
  const pos = usePos(),
    { managers, adminOriginator, selectedNetwork } = useWallet()
  const url = pos.config?.service ?? DEFAULT_MERCHANT_SERVICE
  const [invite, setInvite] = useState<Signed<Invite> | null>(null),
    [cashiers, setCashiers] = useState<Cashier[]>([]),
    [cashiersLoaded, setCashiersLoaded] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merchant service unavailable')
    } finally {
      setBusy(false)
    }
  }
  const refresh = async () => {
    setCashiers(await pos.rpc<Cashier[]>('cashiers'))
    setCashiersLoaded(true)
  }
  useFocusEffect(
    useCallback(() => {
      if (!pos.config?.merchant) return
      let current = true
      setBusy(true)
      void pos
        .rpc<Cashier[]>('cashiers')
        .then(rows => {
          if (current) {
            setCashiers(rows)
            setCashiersLoaded(true)
          }
        })
        .catch(() => {
          if (current) setError('Could not load your team')
        })
        .finally(() => {
          if (current) setBusy(false)
        })
      return () => {
        current = false
      }
    }, [pos.config?.merchant, pos.rpc])
  )
  return (
    <Page
      title={pos.config ? 'Team' : 'Merchant setup'}
      footer={pos.config ? <Navigation role="merchant" /> : undefined}
    >
      <Text style={styles.body}>
        Connect the online merchant wallet, then approve the people allowed to operate your tills.
      </Text>
      {!pos.config ? (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>Prototype merchant service</Text>
            <Text selectable style={styles.body}>
              {url}
            </Text>
            <Text style={styles.caption}>Preconfigured for the US testnet pilot.</Text>
          </View>
          <Button
            title="Connect merchant"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const info = await pos.rpc<{ merchant: string; name: string; chain: string }>('info', {}, url)
                const own = await managers.permissionsManager!.getPublicKey({ identityKey: true }, adminOriginator)
                if (key(own.publicKey) !== key(info.merchant))
                  throw new Error('This wallet is not the merchant administrator')
                if (info.chain !== selectedNetwork) throw new Error('Merchant service and wallet networks differ')
                await pos.configure({ role: 'merchant', ...info, service: url })
              })
            }
          />
        </>
      ) : (
        <>
          <Text style={styles.heading}>{pos.config.name}</Text>
          <View style={styles.metrics}>
            <View style={styles.metric}>
              <Text style={styles.label}>Active cashiers</Text>
              <Text style={styles.metricValue}>
                {cashiersLoaded ? cashiers.filter(c => c.state === 'active').length : '—'}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.label}>Awaiting approval</Text>
              <Text style={styles.metricValue}>
                {cashiersLoaded ? cashiers.filter(c => c.state === 'pending').length : '—'}
              </Text>
            </View>
          </View>
          <Button
            title="Create cashier enrollment code"
            disabled={busy}
            onPress={() => void run(async () => setInvite(await pos.rpc<Signed<Invite>>('invite')))}
          />
          {invite && (
            <View style={styles.card}>
              <View style={{ backgroundColor: 'white', padding: 16, alignSelf: 'center', borderRadius: 16 }}>
                <QRCode value={encodePos(invite)} size={Math.min(240, width - 128)} />
              </View>
              <Text style={styles.body}>
                Cashier scans this code. It expires after 10 minutes. You must approve their request below.
              </Text>
            </View>
          )}
          <Button secondary title="Refresh cashier requests" disabled={busy} onPress={() => void run(refresh)} />
          {cashiers.map(c => (
            <View key={c.identity} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.heading}>{c.name}</Text>
                <Text style={styles.tag}>{c.state.toUpperCase()}</Text>
              </View>
              <Text selectable style={styles.caption}>
                {c.identity}
              </Text>
              {c.state === 'pending' && (
                <Button
                  title="Approve cashier"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await pos.rpc('approve', { cashier: c.identity })
                      await refresh()
                    })
                  }
                />
              )}
              {c.state === 'active' && (
                <Button
                  title="Revoke access"
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await pos.rpc('revoke', { cashier: c.identity })
                      await refresh()
                    })
                  }
                />
              )}
            </View>
          ))}
        </>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </Page>
  )
}
