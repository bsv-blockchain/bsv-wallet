// Development builds only: one illustrated scene at a time, without a wallet,
// for checking the motion on a simulator that can't be tapped
// (docs/superpowers/2026-10-09-now-app-motion.md). Production redirects home.
//   bitcoinsv-wallet://dev-art?brief=0..6   a backup briefing screen
//   bitcoinsv-wallet://dev-art?done=1       the backed-up celebration
//   bitcoinsv-wallet://dev-art?activity=1   activity rows (tap one for its detail)
//   bitcoinsv-wallet://dev-art?notify=1     the payment-arrived toast, from a contact
//   bitcoinsv-wallet://dev-art?notify=2     the same, when its row can't be read yet
//   bitcoinsv-wallet://dev-art?cards=1      Home's small cards (a wallet with payments)
//   bitcoinsv-wallet://dev-art?nudge=1      "Back up your keys"
//   bitcoinsv-wallet://dev-art?tube=1       the tour video's loading tube
//   bitcoinsv-wallet://dev-art?handles=1    handles from each wallet, with their marks
import React, { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BackupDoneArt } from '../src/art/BackupDoneArt'
import { BriefingCard } from '../src/backup/BriefingCard'
import { usePalette } from '../src/theme'
import { TxRow } from '../src/activity/TxRow'
import { seedActivityForDev, type ActivityItem } from '../src/activity/useActivity'
import { notifyMoney } from '../src/notify/MoneyToast'
import { toastFor } from '../src/notify/PaymentAlerts'
import { SmallCards } from '../src/home/SmallCards'
import { BackupNudge } from '../src/home/BackupNudge'
import { CoinTube } from '../src/art/CoinTube'
import { setPref } from '../src/state/prefs'
import { Handle } from '../src/ui/Handle'
import { font } from '../src/theme'

const KEY = '02' + 'c4'.repeat(32)
const now = Date.now()
const SAMPLE: ActivityItem[] = [
  { id: 'dev-1', txid: 'ab'.repeat(32), incoming: true, sats: 150000, title: 'Ana Silva', note: 'Dinner', counterparty: { kind: 'identityKey', value: KEY }, status: { key: 'done', tone: 'settled' }, statusText: 'Completed', pending: false, createdAt: new Date(now - 3600e3).toISOString(), rawStatus: 'completed', labels: [] },
  { id: 'dev-2', txid: 'cd'.repeat(32), incoming: false, sats: -42000, title: 'Payment sent', counterparty: { kind: 'identityKey', value: '03' + '9e'.repeat(32) }, status: { key: 'p', tone: 'attention' }, statusText: 'Waiting to send', pending: true, offlineStatus: 'parked', createdAt: new Date(now - 7200e3).toISOString(), rawStatus: 'nosend', labels: [] },
  { id: 'dev-3', txid: 'ef'.repeat(32), incoming: true, token: { figure: '+12.50', unit: 'USDsv', assetId: 'usd' }, title: 'USDsv received', counterparty: null, status: { key: 'd', tone: 'settled' }, statusText: 'Settled', pending: false, createdAt: new Date(now - 90000e3).toISOString(), rawStatus: 'completed', labels: ['mandala'] },
  { id: 'dev-4', txid: '12'.repeat(32), incoming: false, sats: -1000, title: 'Payment sent', note: 'Refused by the network', counterparty: null, status: { key: 'f', tone: 'failed' }, statusText: 'Not sent', pending: false, createdAt: new Date(now - 200000e3).toISOString(), rawStatus: 'failed', labels: [] }
]

export default function DevArt() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const { brief, done, activity, notify, cards, nudge, tube, handles } = useLocalSearchParams<{ brief?: string; done?: string; activity?: string; notify?: string; cards?: string; nudge?: string; tube?: string; handles?: string }>()
  useEffect(() => {
    if (__DEV__ && nudge) setPref('backupNudge', true)
  }, [nudge])
  useEffect(() => {
    if (!__DEV__ || !notify) return
    seedActivityForDev(SAMPLE)
    const t = setTimeout(() => (notify === '2' ? notifyMoney({ title: 'You got paid', description: 'It’s in your activity now', incoming: true }) : toastFor({ ...SAMPLE[0], contactKey: KEY })), 600)
    return () => clearTimeout(t)
  }, [notify])
  if (!__DEV__) return <Redirect href="/" />
  return (
    <View style={[styles.root, { backgroundColor: palette.popover, paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}>
      {handles ? (
        <View style={styles.handles}>
          {['rosa@bitcoinsv.com', 'rosa@handcash.io', '23@treechat.app', 'rosa@twetch.com', 'farm@commonsource.nl', 'lab@mycelia.network', 'rosa@example.org'].map(h => (
            <View key={h} style={styles.handleRow}>
              <Handle handle={h} style={[font(500), { fontSize: 15, color: palette.foreground }]} />
              <Handle handle={h} qualified style={[font(400), { fontSize: 12, color: palette.mutedForeground }]} />
            </View>
          ))}
          <Handle handle="vince@bitcoinsv.com" peer={false} style={[font(600), { fontSize: 15, color: palette.foreground }]} />
        </View>
      ) : tube ? (
        <View style={[styles.center, { backgroundColor: '#000000' }]}>
          <CoinTube loop onDark width={112} />
        </View>
      ) : cards || nudge ? (
        <View style={[styles.center, { alignItems: 'stretch' }]}>
          <SmallCards showTour showSeed showSync onTour={() => {}} onTourDismiss={() => {}} onBackup={() => {}} onSync={() => {}} onSyncDismiss={() => {}} />
          {nudge ? <BackupNudge backedUp={false} onBackUp={() => {}} /> : null}
        </View>
      ) : activity || notify ? (
        <ActivitySample />
      ) : done ? (
        <View style={styles.center}>
          <BackupDoneArt wallets={[{ key: 'me', bg: 'mint', portrait: 'dragon' }]} />
        </View>
      ) : (
        <BriefingCard key={brief} kind="phrase" i={Number(brief ?? 0)} seen={false} onNext={() => {}} />
      )}
    </View>
  )
}

function ActivitySample() {
  seedActivityForDev(SAMPLE)
  return (
    <View>
      {SAMPLE.map(tx => (
        <TxRow key={tx.id} tx={tx} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  handles: { paddingHorizontal: 24, gap: 18 },
  handleRow: { gap: 4 },
  root: { flex: 1, paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' }
})
