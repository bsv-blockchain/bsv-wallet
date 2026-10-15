import React, { useState } from 'react'
import { Text, View, useWindowDimensions } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { encodePos, key, type Signed, type Invite } from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import { usePos } from '../src/context'
import { Button, Field, Page, styles } from '../src/ui'
import type { Cashier } from '../service/controller'
export default function Merchant() {
  const { width } = useWindowDimensions()
  const pos = usePos(),
    { managers, adminOriginator, selectedNetwork } = useWallet()
  const [url, setUrl] = useState(pos.config?.service ?? ''),
    [invite, setInvite] = useState<Signed<Invite> | null>(null),
    [cashiers, setCashiers] = useState<Cashier[]>([]),
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
  const refresh = async () => setCashiers(await pos.rpc<Cashier[]>('cashiers'))
  return (
    <Page title="Merchant setup">
      <Text style={styles.body}>
        Connect the online merchant wallet, then approve the people allowed to operate your tills.
      </Text>
      {!pos.config ? (
        <>
          <Field label="Merchant service HTTPS address" value={url} onChange={setUrl} />
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
          <Text style={styles.body}>{pos.config.name}</Text>
          <Button
            title="Create cashier enrollment code"
            disabled={busy}
            onPress={() => void run(async () => setInvite(await pos.rpc<Signed<Invite>>('invite')))}
          />
          {invite && (
            <View style={styles.card}>
              <QRCode value={encodePos(invite)} size={Math.min(240, width - 96)} />
              <Text style={styles.body}>
                Cashier scans this code. It expires after 10 minutes. You must approve their request below.
              </Text>
            </View>
          )}
          <Button title="Refresh cashier requests" disabled={busy} onPress={() => void run(refresh)} />
          {cashiers.map(c => (
            <View key={c.identity} style={styles.card}>
              <Text style={styles.body}>
                {c.name} · {c.state}
              </Text>
              <Text selectable style={styles.body}>
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
