import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Text, View, useWindowDimensions } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import { useRouter, useFocusEffect } from 'expo-router'
import { AirGapDecoder, isAirGapPart } from '@bsv/air-gap'
import { Random } from '@bsv/sdk'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { QRScanner } from '@bsv/expo-wallet-toolbox/ui'
import { mintSession, encodeSession, type Session } from '../../../packages/expo-wallet-toolbox/core/localpay/session'
import {
  localSupportsAwdl,
  localSupportsNearby,
  localSupportsBle
} from '../../../packages/expo-wallet-toolbox/core/localpay/transport/select'
import { requestNearbyPermissions } from '../../../packages/expo-wallet-toolbox/core/localpay/nearbyPermissions'
import { requestBlePermissions } from '../../../packages/expo-wallet-toolbox/core/localpay/blePermissions'
import { prepareBle } from '../../../packages/expo-wallet-toolbox/core/localpay/deviceCaps'
import { awdlTransport } from '../../../packages/expo-wallet-toolbox/core/localpay/transport/awdl'
import { nearbyTransport } from '../../../packages/expo-wallet-toolbox/core/localpay/transport/nearby'
import { bleTransport } from '../../../packages/expo-wallet-toolbox/core/localpay/transport/ble'
import { raceReceivers } from '../../../packages/expo-wallet-toolbox/core/localpay/transport/race'
import {
  unsealFrame,
  frameBytesFromQr,
  type PaymentFrame
} from '../../../packages/expo-wallet-toolbox/core/localpay/codec'
import type { ConfirmDelivery } from '../../../packages/expo-wallet-toolbox/core/localpay/types'
import {
  encodePos,
  verify,
  key,
  decodePos,
  type Signed,
  type MerchantRequest,
  type Receipt
} from '../../../packages/expo-wallet-toolbox/core/pos/protocol'
import { usePos } from '../src/context'
import { Button, Field, Page, styles } from '../src/ui'
export default function SaleScreen() {
  const { width } = useWindowDimensions()
  const pos = usePos(),
    router = useRouter(),
    { selectedNetwork } = useWallet()
  const [amount, setAmount] = useState(''),
    [request, setRequest] = useState<Signed<MerchantRequest> | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [scanning, setScanning] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState('')
  const heldConfirm = useRef<ConfirmDelivery | undefined>(undefined)
  const controller = useRef<AbortController | null>(null),
    claimed = useRef(false),
    mounted = useRef(true),
    decoder = useRef(new AirGapDecoder())
  const settle = useRef<
    (
      frame: PaymentFrame,
      session: Session,
      request: Signed<MerchantRequest>,
      confirm?: ConfirmDelivery
    ) => Promise<void>
  >(async () => {})
  useFocusEffect(
    useCallback(() => {
      mounted.current = true
      return () => {
        mounted.current = false
        controller.current?.abort()
      }
    }, [])
  )
  settle.current = async (frame, current, invoice, confirm) => {
    if (claimed.current) return
    if (
      frame.kind !== 'bsv' ||
      frame.derivationPrefix !== current.derivationPrefix ||
      frame.derivationSuffix !== current.derivationSuffix
    ) {
      await confirm?.(false, 'session_mismatch')
      setError('That payment does not match this sale')
      return
    }
    heldConfirm.current = confirm
    claimed.current = true
    setScanning(false)
    setBusy(true)
    setError('')
    const pending = {
      invoice: invoice.payload.invoice,
      amount: current.amount!,
      frame: { ...frame, transaction: Array.from(frame.transaction) }
    }
    let saved = false
    try {
      await pos.savePending(pending)
      saved = true
      const result = await pos.accept(pending)
      await confirm?.(true)
      if (mounted.current) {
        setReceipt(result)
        setRequest(null)
        setSession(null)
      }
    } catch {
      if (!saved) {
        claimed.current = false
        await confirm?.(false, 'save_failed')
        setError('Could not save this payment. It was not submitted.')
      } else
        setError(
          'Payment is awaiting merchant confirmation. Keep this sale open and check again. Do not request another payment.'
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const start = async () => {
    setBusy(true)
    setError('')
    claimed.current = false
    try {
      if (!pos.config || selectedNetwork !== pos.config.chain) throw new Error('Merchant and wallet networks differ')
      const n = Number(amount)
      if (!/^\d+$/.test(amount) || !Number.isSafeInteger(n) || n < 1)
        throw new Error('Enter a positive whole number of satoshis')
      const nearby = localSupportsNearby() && (await requestNearbyPermissions())
      const ble =
        localSupportsBle() &&
        (Platform.OS !== 'android' || (await requestBlePermissions())) &&
        (await prepareBle()) === 'poweredOn'
      const current = mintSession({
        identityKey: pos.config.merchant,
        amount: n,
        derivationPrefix: globalThis.btoa(String.fromCharCode(...Random(16))),
        derivationSuffix: globalThis.btoa(String.fromCharCode(...Random(16))),
        supportsAwdl: localSupportsAwdl(),
        supportsNearby: nearby,
        supportsBle: ble,
        supportsBleScan: ble && Platform.OS === 'ios',
        os: Platform.OS === 'ios' ? 'ios' : 'android'
      })
      const invoice = await pos.rpc<Signed<MerchantRequest>>('invoice', { session: encodeSession(current) })
      const checked = await decodePos(encodePos(invoice))
      if (!mounted.current) return
      if (
        checked.payload.kind !== 'payment' ||
        checked.payload.session !== encodeSession(current) ||
        key(checked.identityKey) !== key(pos.config.merchant)
      )
        throw new Error('Merchant request did not match this sale')
      setSession(current)
      setRequest(invoice)
      const abort = new AbortController()
      controller.current = abort
      const radios = [
        ...(localSupportsAwdl() ? [awdlTransport] : []),
        ...(nearby ? [nearbyTransport] : []),
        ...(ble ? [bleTransport] : [])
      ]
      if (radios.length)
        void raceReceivers(radios, current, abort.signal, () => {
          if (mounted.current) setError('A nearby connection is unavailable. You can scan the customer payment code.')
        })
          .then(received => settle.current(received.frame, current, invoice, received.confirm))
          .catch(() => {
            if (!abort.signal.aborted && mounted.current)
              setError('Use the customer payment code to complete this sale.')
          })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merchant service unavailable')
    } finally {
      setBusy(false)
    }
  }
  const scan = (text: string) => {
    if (!session || !request || claimed.current) return
    try {
      let bytes: Uint8Array | null
      if (isAirGapPart(text)) {
        const s = decoder.current.accept(text)
        if (!s.ok) return
        setProgress(`${s.have} of ${s.total} parts`)
        if (!s.done) return
        bytes = decoder.current.message()
      } else bytes = frameBytesFromQr(text)
      if (bytes) void settle.current(unsealFrame(bytes, session.psk), session, request)
    } catch {
      decoder.current = new AirGapDecoder()
      setError('Could not read this payment code')
    }
  }
  if (scanning)
    return (
      <QRScanner
        continuous
        hintText={progress || 'Scan the customer payment code'}
        onScan={scan}
        onClose={() => setScanning(false)}
      />
    )
  return (
    <Page title={receipt ? 'Payment received' : 'New sale'} back={!busy && !pos.pending}>
      <Text style={styles.body}>{pos.config?.name}</Text>
      {receipt ? (
        <>
          <Text style={styles.paid}>Paid</Text>
          <Text style={styles.amount}>{receipt.amount} sats</Text>
          <Text style={styles.body}>Your merchant wallet accepted this payment.</Text>
          <Text selectable style={styles.body}>
            {receipt.txid}
          </Text>
          <Button
            title="Next sale"
            onPress={() => {
              claimed.current = false
              setReceipt(null)
              setAmount('')
              controller.current?.abort()
            }}
          />
          <Button title="Done" onPress={() => router.replace('/')} />
        </>
      ) : pos.pending ? (
        <>
          <Text style={styles.amount}>{pos.pending.amount} sats</Text>
          <Text style={styles.body}>
            Awaiting merchant confirmation. The customer should keep their payment available. Check this sale before
            taking another payment.
          </Text>
          <Button
            title={busy ? 'Checking payment…' : 'Check merchant confirmation'}
            disabled={busy}
            onPress={() => {
              setBusy(true)
              setError('')
              void pos
                .accept(pos.pending!)
                .then(async result => {
                  await heldConfirm.current?.(true)
                  if (mounted.current) setReceipt(result)
                })
                .catch(() => setError('Merchant confirmation is still unavailable. This sale is not marked paid.'))
                .finally(() => setBusy(false))
            }}
          />
        </>
      ) : request && session ? (
        <>
          <Text style={styles.amount}>{session.amount} sats</Text>
          <View style={styles.card}>
            <QRCode value={encodePos(request)} size={Math.min(260, width - 96)} />
            <Text style={styles.body}>
              Customer scans with Bitcoin SV Wallet. Funds go directly to {pos.config?.name}.
            </Text>
          </View>
          <Text style={styles.body}>Waiting for payment. Merchant confirmation is required.</Text>
          <Button title="Scan customer payment code" disabled={busy} onPress={() => setScanning(true)} />
          <Button
            title="Cancel unpaid sale"
            disabled={busy || claimed.current}
            onPress={() => {
              controller.current?.abort()
              setSession(null)
              setRequest(null)
              setError('')
            }}
          />
        </>
      ) : (
        <>
          <Field label="Amount in satoshis" value={amount} onChange={setAmount} numeric />
          <Button
            title={busy ? 'Preparing sale…' : 'Request payment'}
            disabled={busy || !amount}
            onPress={() => void start()}
          />
          <Text style={styles.body}>Your merchant service must be online to accept a payment.</Text>
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
