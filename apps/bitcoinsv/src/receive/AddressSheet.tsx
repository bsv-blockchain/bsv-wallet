// Get paid to a plain BSV address, for wallets and services that can't use a
// pay link (exchanges, faucets). The shared core's address rail, as the
// existing app's AddressReceive uses it: today's address (a new one each day),
// watched by the core's background sweep, which brings what lands there into
// this wallet; "Check now" sweeps it at once. AddressReceive is the body, for
// Receive's own "To a BSV address" view; AddressSheet wraps it in a sheet.
import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Copy, RefreshCw } from 'lucide-react-native'
import {
  derivationPrefixFor,
  getCurrentDate,
  getPaymentAddress,
  getProcessedTransactions,
  recordIssuedDate,
  sweepAddress,
  useWallet,
  watchAddress,
  wocConfigFor
} from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import { font, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { GlassButton } from '../ui/GlassButton'
import { PayQr } from '../ui/PayQr'
import { BsvMark } from '../ui/BsvMark'
import { BalancedText } from '../ui/BalancedText'
import { bsvFigure } from '../activity/format'

export function AddressSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Your BSV address" description="For a wallet or service that can’t use your pay link.">
      <AddressReceive active={open} />
    </BottomSheet>
  )
}

/** Today's address, its QR and "Check now"; made and watched while `active`. */
export function AddressReceive({ active }: { active: boolean }) {
  const open = active
  const palette = usePalette()
  const { managers, adminOriginator, selectedNetwork, storage } = useWallet()
  const wallet = managers.permissionsManager
  const woc = wocConfigFor(selectedNetwork)
  const [address, setAddress] = useState<string | null>(null)
  // the prefix the address was made with: kept with it, so a sheet left open
  // past midnight (UTC) still checks the address it shows
  const [prefix, setPrefix] = useState(() => derivationPrefixFor(getCurrentDate(0)))
  const [received, setReceived] = useState(0)
  const [checking, setChecking] = useState(false)

  const tally = useCallback(
    async (addr: string) => {
      const rows = await getProcessedTransactions(wallet as never, adminOriginator, addr)
      setReceived(rows.reduce((t, r) => t + r.satoshis, 0))
    },
    [wallet, adminOriginator]
  )

  useEffect(() => {
    if (!open || !wallet) return
    let live = true
    void (async () => {
      try {
        const date = getCurrentDate(0)
        const next = await getPaymentAddress(wallet as never, adminOriginator, derivationPrefixFor(date), woc.network)
        if (!live) return
        setAddress(next)
        setPrefix(derivationPrefixFor(date))
        // the core's background sweep looks after it from now on
        if (storage) {
          await watchAddress(storage as never, { address: next, date, derivationPrefix: derivationPrefixFor(date) })
          await recordIssuedDate(storage as never, date)
        }
        if (live) await tally(next)
      } catch {
        if (live) showToast('Your address couldn’t be made. Try again.', { type: 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [open, wallet, adminOriginator, storage, woc.network, tally])

  const checkNow = async () => {
    if (!wallet || !address || checking) return
    setChecking(true)
    try {
      const { importedSatoshis } = await sweepAddress({ wallet: wallet as never, adminOriginator, woc, address, derivationPrefix: prefix })
      await tally(address)
      showToast(importedSatoshis > 0 ? `${bsvFigure(importedSatoshis)} BSV brought into your wallet` : 'Nothing new at this address yet', {
        type: importedSatoshis > 0 ? 'success' : 'info'
      })
    } catch {
      showToast('The address couldn’t be checked right now. Try again in a moment.', { type: 'error' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <View style={styles.body}>
      <View style={styles.qr}>
        {address ? <PayQr value={address} size={196} center={<BsvMark size={40} />} /> : <ActivityIndicator color={palette.mutedForeground} />}
      </View>
      {address && (
        <Pressable
          onPress={async () => {
            await Clipboard.setStringAsync(address)
            showToast('Address copied', { type: 'success' })
          }}
          accessibilityRole="button"
          accessibilityLabel={`Copy your address, ${address}`}
          style={[styles.pill, { backgroundColor: palette.secondary }]}
        >
          <Text style={[font(500), styles.address, { color: palette.foreground }]}>{address}</Text>
          <Copy size={14} color={palette.mutedForeground} />
        </Pressable>
      )}
      <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
        {selectedNetwork === 'test' ? 'A testnet address. ' : ''}Send only BSV here. What arrives is brought into your wallet on its own; it’s a new
        address each day, and older ones keep working.
      </BalancedText>
      {received > 0 && (
        <Text style={[font(600), styles.small, styles.center, { color: palette.positive }]}>{bsvFigure(received)} BSV received here</Text>
      )}
      <GlassButton
        size="lg"
        variant="outline"
        label={checking ? 'Checking…' : 'Check for payments now'}
        icon={checking ? <ActivityIndicator color={palette.foreground} /> : <RefreshCw size={16} color={palette.foreground} />}
        disabled={!address || checking}
        onPress={() => void checkNow()}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { gap: 16, alignSelf: 'stretch' },
  qr: { alignItems: 'center', justifyContent: 'center', minHeight: 220 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  address: { flex: 1, fontSize: 13, lineHeight: 18 },
  small: { fontSize: 13, lineHeight: 19 },
  center: { textAlign: 'center' }
})
