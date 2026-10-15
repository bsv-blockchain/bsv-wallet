import React, { useState } from 'react'
import { Text } from 'react-native'
import { useRouter } from 'expo-router'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { QRScanner } from '@bsv/expo-wallet-toolbox/ui'
import { decodePos, type Invite } from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import { usePos } from '../src/context'
import { Button, Field, Page, styles } from '../src/ui'
export default function Cashier() {
  const pos = usePos(),
    router = useRouter(),
    { selectedNetwork } = useWallet()
  const [scanning, setScanning] = useState(false),
    [name, setName] = useState(''),
    [invite, setInvite] = useState<Invite | null>(pos.config?.enrollment ?? null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [requested, setRequested] = useState(!!pos.config?.enrollment)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enrollment failed')
    } finally {
      setBusy(false)
    }
  }
  if (scanning)
    return (
      <QRScanner
        hintText="Scan the merchant enrollment code"
        onClose={() => setScanning(false)}
        onScan={data => {
          setScanning(false)
          void run(async () => {
            const { payload } = await decodePos(data)
            if (payload.kind !== 'invite') throw new Error('Scan an enrollment code')
            if (payload.chain !== selectedNetwork) throw new Error('Switch your wallet to the merchant network first')
            setInvite(payload)
          })
        }}
      />
    )
  return (
    <Page title="Join as cashier">
      <Text style={styles.body}>Your keys stay on your phone. Payments go directly to the merchant.</Text>
      <Field label="Your name for the merchant" value={name} onChange={setName} />
      {!invite ? (
        <Button title="Scan merchant code" onPress={() => setScanning(true)} />
      ) : (
        <>
          <Text style={styles.body}>{invite.name}</Text>
          <Text style={styles.body}>{invite.service}</Text>
          {!requested ? (
            <Button
              title="Request merchant approval"
              disabled={busy || !name.trim()}
              onPress={() =>
                void run(async () => {
                  await pos.rpc('enroll', { invite: invite.id, name }, invite.service)
                  await pos.configure({
                    role: 'cashier',
                    name: invite.name,
                    merchant: invite.merchant,
                    service: invite.service,
                    chain: invite.chain,
                    enrollment: invite
                  })
                  setRequested(true)
                })
              }
            />
          ) : (
            <>
              <Text style={styles.body}>Ask the merchant to approve your identity on their screen.</Text>
              <Button
                title="Check approval"
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    const info = await pos.rpc<{ merchant: string; cashier: { state: string } | null }>(
                      'info',
                      {},
                      invite.service
                    )
                    if (
                      info.merchant.toLowerCase() !== invite.merchant.toLowerCase() ||
                      info.cashier?.state !== 'active'
                    )
                      throw new Error('Merchant approval is still pending')
                    await pos.configure({
                      role: 'cashier',
                      name: invite.name,
                      merchant: invite.merchant,
                      service: invite.service,
                      chain: invite.chain
                    })
                    router.replace('/')
                  })
                }
              />
            </>
          )}
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
