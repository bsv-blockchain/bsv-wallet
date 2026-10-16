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
import { Button, Page, styles } from '../src/ui'
import { CounterEntry } from '../src/CounterEntry'
import { checkoutTotal, formatSats, type TipChoice } from '../src/checkout'
export default function SaleScreen() {
  const { width } = useWindowDimensions()
  const pos = usePos(),
    router = useRouter(),
    { selectedNetwork } = useWallet()
  const [amount, setAmount] = useState(''),
    [tipChoice, setTipChoice] = useState<TipChoice>('none'),
    [customTip, setCustomTip] = useState(''),
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
      if (mounted.current) {
        setReceipt(result)
        setRequest(null)
        setSession(null)
      }
      try {
        await confirm?.(true)
      } catch {
        if (mounted.current) setError('Payment accepted. The customer connection closed before acknowledgment.')
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
      const breakdown = checkoutTotal(amount, tipChoice, customTip)
      const n = breakdown.total
      if (breakdown.subtotal < 1) throw new Error('Enter a positive sale amount')
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
      const invoice = await pos.rpc<Signed<MerchantRequest>>('invoice', {
        session: encodeSession(current),
        subtotal: breakdown.subtotal,
        tip: breakdown.tip
      })
      const checked = await decodePos(encodePos(invoice))
      if (!mounted.current) return
      if (
        checked.payload.kind !== 'payment' ||
        checked.payload.session !== encodeSession(current) ||
        key(checked.identityKey) !== key(pos.config.merchant)
      )
        throw new Error('Merchant request did not match this sale')
      if ((checked.payload.tip ?? 0) !== breakdown.tip || (checked.payload.subtotal ?? n) !== breakdown.subtotal)
        throw new Error('Merchant service does not support this tip breakdown yet')
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
  let entryTotal = 0,
    validEntry = false
  try {
    const value = checkoutTotal(amount, tipChoice, customTip)
    entryTotal = value.total
    validEntry = value.subtotal > 0
  } catch {
    /* The entry component displays the validation error. */
  }
  const clearEntry = () => {
    setAmount('')
    setTipChoice('none')
    setCustomTip('')
  }
  return (
    <Page
      title={receipt ? 'Payment received' : request || pos.pending ? 'Collect payment' : 'Counter'}
      back={!busy && !pos.pending}
      footer={
        !request && !pos.pending && !receipt ? (
          <View style={{ paddingHorizontal: 22, paddingVertical: 12, gap: 12, flexDirection: 'row' }}>
            <Button secondary title="Clear" disabled={busy} onPress={clearEntry} />
            <View style={{ flex: 1 }}>
              <Button
                title={busy ? 'Preparing…' : `Charge ${formatSats(entryTotal)} sats`}
                disabled={busy || !validEntry}
                onPress={() => void start()}
              />
            </View>
          </View>
        ) : undefined
      }
    >
      <Text style={styles.body}>{pos.config?.name}</Text>
      {receipt ? (
        <>
          <Text style={styles.paid}>Paid</Text>
          <Text style={styles.amount}>{formatSats(receipt.amount)} sats</Text>
          <Text style={styles.body}>Your merchant wallet accepted this payment.</Text>
          <Text selectable style={styles.body}>
            {receipt.txid}
          </Text>
          <Button
            title="Next sale"
            onPress={() => {
              claimed.current = false
              setReceipt(null)
              setRequest(null)
              setSession(null)
              setAmount('')
              setTipChoice('none')
              setCustomTip('')
              controller.current?.abort()
            }}
          />
          <Button title="Done" onPress={() => router.replace('/')} />
        </>
      ) : pos.pending ? (
        <>
          <Text style={styles.amount}>{formatSats(pos.pending.amount)} sats</Text>
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
                  if (mounted.current) {
                    setReceipt(result)
                    setRequest(null)
                    setSession(null)
                  }
                  try {
                    await heldConfirm.current?.(true)
                  } catch {
                    if (mounted.current)
                      setError('Payment accepted. The customer connection closed before acknowledgment.')
                  }
                })
                .catch(() => setError('Merchant confirmation is still unavailable. This sale is not marked paid.'))
                .finally(() => setBusy(false))
            }}
          />
        </>
      ) : request && session ? (
        <>
          <Text style={styles.amount}>{formatSats(session.amount!)} sats</Text>
          <View style={styles.card}>
            <View style={{ backgroundColor: 'white', padding: 16, alignSelf: 'center', borderRadius: 18 }}>
              <QRCode value={encodePos(request)} size={Math.min(260, width - 128)} />
            </View>
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
          <CounterEntry
            showActions={false}
            amount={amount}
            onAmount={setAmount}
            tipChoice={tipChoice}
            onTipChoice={setTipChoice}
            customTip={customTip}
            onCustomTip={setCustomTip}
            busy={busy}
            onCharge={() => void start()}
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
