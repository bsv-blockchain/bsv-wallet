import React, { useState } from 'react'
import { Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useWallet, useRecoveryDeps } from '@bsv/expo-wallet-toolbox'
import { createNewWallet } from '@bsv/expo-wallet-toolbox/core/recovery/createWallet'
import { restoreWallet } from '@bsv/expo-wallet-toolbox/core/recovery/restoreWallet'
import { classifyImportInput } from '@bsv/expo-wallet-toolbox/core/recovery/secret'
import { usePos } from '../src/context'
import { Page, Button, Field, Navigation, styles } from '../src/ui'
import { SalesOverview } from '../src/SalesOverview'
import { useSales } from '../src/useSales'
import { shortKey } from '../src/sales'

function ConnectedHome() {
  const pos = usePos(),
    router = useRouter(),
    report = useSales()
  const config = pos.config!
  const names = Object.fromEntries(report.cashiers.map(c => [c.identity.toLowerCase(), c.name]))
  return (
    <Page title={config.name} back={false} footer={<Navigation role={config.role} />}>
      <View style={styles.row}>
        <Text style={styles.label}>{config.role === 'merchant' ? 'Merchant overview' : 'Your counter'}</Text>
        <Text style={styles.tag}>{config.chain === 'test' ? 'TESTNET' : config.chain.toUpperCase()}</Text>
      </View>
      {pos.pending ? (
        <Button title="Resolve pending payment" onPress={() => router.push('/sale')} />
      ) : config.enrollment ? (
        <Button title="Check cashier approval" onPress={() => router.push('/cashier')} />
      ) : config.role === 'cashier' ? (
        <Button title="Take a payment" onPress={() => router.push('/sale')} />
      ) : null}
      {!config.enrollment && report.loaded && (
        <SalesOverview sales={report.sales} names={names} showCashiers={config.role === 'merchant'} />
      )}
      {report.busy && <Text style={styles.caption}>Refreshing verified sales…</Text>}
      {report.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {report.error}
        </Text>
      ) : null}
      <Button secondary title="All sales & receipts" onPress={() => router.push('/receipts')} />
      {config.role === 'merchant' && (
        <Button secondary title="Manage team & enrollment" onPress={() => router.push('/merchant')} />
      )}
      <View style={styles.card}>
        <Text style={styles.label}>Connected merchant service</Text>
        <Text selectable style={styles.caption}>
          {config.service}
        </Text>
        <Text style={styles.caption}>Merchant identity {shortKey(config.merchant)}</Text>
      </View>
    </Page>
  )
}
export default function Home() {
  const router = useRouter(),
    deps = useRecoveryDeps(),
    { walletBuilt, selectedNetwork, switchNetwork } = useWallet(),
    pos = usePos()
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [secret, setSecret] = useState(''),
    [words, setWords] = useState('')
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wallet setup failed')
    } finally {
      setBusy(false)
    }
  }
  if (!pos.loaded)
    return (
      <Page title="Point of sale" back={false}>
        <Text style={styles.body}>Loading your setup…</Text>
      </Page>
    )
  if (walletBuilt && !words && pos.config) return <ConnectedHome />
  return (
    <Page title="Welcome to your counter" back={false}>
      <Text style={styles.body}>Take nearby payments directly into your merchant wallet.</Text>
      {!walletBuilt ? (
        <View style={styles.card}>
          <Text style={styles.body}>
            Cashiers use their own identity. Merchant administrators use the identity registered with their merchant
            service.
          </Text>
          <Button
            title={busy ? 'Preparing wallet…' : 'Create cashier wallet'}
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const outcome = await createNewWallet(deps)
                if (outcome.kind === 'created') setWords(outcome.mnemonic)
                else if (outcome.kind !== 'exists') throw new Error('Could not create your wallet')
              })
            }
          />
          <Field label="Existing wallet recovery phrase or private key" value={secret} onChange={setSecret} secret />
          <Button
            title="Use existing wallet"
            disabled={busy || !secret.trim()}
            onPress={() =>
              void run(async () => {
                if (await deps.hasStoredIdentity()) throw new Error('This device already has an identity')
                const parsed = classifyImportInput(secret)
                if (!parsed) throw new Error('Invalid recovery phrase or key')
                setSecret('')
                const result = await restoreWallet(deps, parsed, { restore: false, medium: 'phrase' })
                if (result.kind !== 'ok') throw new Error('Could not restore this wallet')
              })
            }
          />
        </View>
      ) : words ? (
        <View style={styles.card}>
          <Text style={styles.body}>Write down your cashier recovery phrase and keep it private.</Text>
          <Text selectable style={styles.body}>
            {words}
          </Text>
          <Button title="I saved my recovery phrase" onPress={() => setWords('')} />
        </View>
      ) : (
        <>
          <Text style={styles.body}>Network: {selectedNetwork === 'main' ? 'Mainnet' : selectedNetwork}</Text>
          {!pos.config && (
            <Button
              title={selectedNetwork === 'main' ? 'Use testnet for setup' : 'Use mainnet'}
              disabled={busy}
              onPress={() => void run(() => switchNetwork(selectedNetwork === 'main' ? 'test' : 'main'))}
            />
          )}
          {pos.config ? (
            <>
              <Text style={styles.body}>
                {pos.config.name} · {pos.config.role === 'merchant' ? 'Merchant administrator' : 'Cashier'}
              </Text>
              <Button
                title={
                  pos.pending
                    ? 'Resolve pending sale'
                    : pos.config.role === 'merchant'
                      ? 'Manage cashiers'
                      : pos.config.enrollment
                        ? 'Check enrollment'
                        : 'New sale'
                }
                onPress={() =>
                  router.push(
                    pos.config?.role === 'merchant' ? '/merchant' : pos.config?.enrollment ? '/cashier' : '/sale'
                  )
                }
              />
              <Button title="Sales & receipts" onPress={() => router.push('/receipts')} />
            </>
          ) : (
            <>
              <Button title="Set up as merchant" onPress={() => router.push('/merchant')} />
              <Button title="Join as cashier" onPress={() => router.push('/cashier')} />
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
