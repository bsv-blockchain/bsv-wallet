// Bitcoin SV Wallet Sync (the prototype's components/sync-setup.tsx, intro and
// status), on the shared core's encrypted backup log: every change to this
// wallet's database, encrypted on the phone with a key derived from the
// wallet's own secret, pushed to BSVA's backup service. Free and on by default
// (decision 6), so there is no recovery key, password or plan to set up: the
// recovery phrase or slices open it on a new phone. The prototype's paid
// plan comes later, when BSVA's Sync spec does.
//
// Sync is not a backup of the key itself, so it never marks the wallet
// backed up: without the phrase or slices the synced copy can't be opened.
import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { CircleCheck, Lock, Trash2, type LucideIcon } from 'lucide-react-native'
import {
  BACKUP_CHAINS,
  TaskBackupPush,
  eraseRemoteBackup,
  getBackupUploadState,
  getBackupUrl,
  isBackupPushEnabled,
  recoverMnemonicWallet,
  setBackupPushEnabled,
  useWallet,
  type BackupChain
} from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import { PrivateKey } from '@bsv/sdk'
import { SyncArt } from '../art/SyncArt'
import { useBackup } from '../state/useBackup'
import { font, radii, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { Switch } from '../ui/Switch'
import { GlassButton } from '../ui/GlassButton'
import { BalancedText } from '../ui/BalancedText'

export type SyncStatus =
  | { kind: 'unavailable' }
  | { kind: 'off' }
  | { kind: 'syncing' }
  | { kind: 'offline' }
  | { kind: 'failed' }
  | { kind: 'synced'; at: number | null }
  | { kind: 'waiting' }

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export function syncLine(s: SyncStatus): string {
  switch (s.kind) {
    case 'unavailable':
      return 'Not available in this build'
    case 'off':
      return 'Off. New payments aren’t being saved.'
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return 'Waiting for a connection'
    case 'failed':
      return 'Couldn’t sync. Trying again soon.'
    case 'synced':
      return s.at ? `Up to date, ${ago(s.at)}` : 'Up to date'
    case 'waiting':
      return 'Starting…'
  }
}

/* ---- Sync turned on or off: Home's card listens ---- */
const listeners = new Set<() => void>()
const notifySync = () => listeners.forEach(fn => fn())

/** Just whether Sync is on for this wallet (null while reading), kept current without polling. */
export function useSyncEnabled(): boolean | null {
  const { activeProfile } = useWallet()
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    const read = () => void isBackupPushEnabled(activeProfile).then(v => alive && setOn(v))
    read()
    listeners.add(read)
    return () => {
      alive = false
      listeners.delete(read)
    }
  }, [activeProfile])
  return on
}

/** This wallet's Sync, read from the core every couple of seconds while shown. */
export function useSyncStatus(active: boolean): { status: SyncStatus; on: boolean | null; refresh: () => void } {
  const { selectedNetwork, activeProfile, getBackupPseudonym, walletBuilt } = useWallet()
  const [on, setOn] = useState<boolean | null>(null)
  const [uploaded, setUploaded] = useState(false)
  const [, setTick] = useState(0)
  const chain = selectedNetwork as BackupChain

  const refresh = useCallback(() => {
    void isBackupPushEnabled(activeProfile).then(setOn)
    const pseudonym = getBackupPseudonym(chain)
    if (pseudonym)
      void getBackupUploadState(chain, pseudonym, activeProfile)
        .then(s => setUploaded(s.uploaded))
        .catch(() => {})
    setTick(t => t + 1)
  }, [activeProfile, chain, getBackupPseudonym])

  useEffect(() => {
    if (!active) return
    refresh()
    // the push task has no events: its state is read on a short poll
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [active, refresh])

  let status: SyncStatus
  if (!getBackupUrl()) status = { kind: 'unavailable' }
  else if (on === false) status = { kind: 'off' }
  else if (TaskBackupPush.running) status = { kind: 'syncing' }
  else if (!TaskBackupPush.onlineNow) status = { kind: 'offline' }
  else if (TaskBackupPush.lastError && !TaskBackupPush.lastSuccessAt) status = { kind: 'failed' }
  else if (TaskBackupPush.lastSuccessAt || uploaded) status = { kind: 'synced', at: TaskBackupPush.lastSuccessAt ?? null }
  else status = { kind: walletBuilt ? 'waiting' : 'off' }
  return { status, on, refresh }
}

function Hero({ icon, title, body }: { icon: React.ReactNode; title: string; body?: string }) {
  const palette = usePalette()
  return (
    <View style={styles.hero}>
      {icon}
      <BalancedText style={[font(700), styles.title, { color: palette.foreground }]}>{title}</BalancedText>
      {body && <BalancedText style={[font(400), styles.body, { color: palette.mutedForeground }]}>{body}</BalancedText>}
    </View>
  )
}

function Points({ items }: { items: { icon: LucideIcon; text: string }[] }) {
  const palette = usePalette()
  return (
    <View style={styles.points}>
      {items.map(({ icon: Icon, text }) => (
        <View key={text} style={styles.point}>
          <View style={[styles.pointIcon, { backgroundColor: palette.secondary }]}>
            <Icon size={16} color={palette.foreground} />
          </View>
          <Text style={[font(400), styles.pointText, { color: palette.foreground }]}>{text}</Text>
        </View>
      ))}
    </View>
  )
}

export function SyncSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const palette = usePalette()
  const { activeProfile } = useWallet()
  const backup = useBackup()
  const { status, on, refresh } = useSyncStatus(open)
  const [erasing, setErasing] = useState(false)
  const available = status.kind !== 'unavailable'

  const turnOn = async () => {
    await setBackupPushEnabled(true, activeProfile)
    TaskBackupPush.requestNow()
    refresh()
    notifySync()
    showToast('Sync is on', { type: 'info' })
  }

  // turning off costs something that isn't obvious, so it's confirmed
  const turnOff = () =>
    Alert.alert(
      'Turn off Sync?',
      'Your recovery phrase brings your money back, but not everything: without Sync, some of this wallet’s history and the details it needs to spend change can’t be restored on a new phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: async () => {
            await setBackupPushEnabled(false, activeProfile)
            refresh()
            notifySync()
            // turning it off keeps the copy; deleting it is its own button
            showToast('Sync is off', { type: 'info', description: 'New payments aren’t saved now. Your synced copy stays until you delete it.' })
          }
        }
      ]
    )

  const erase = async () => {
    if (erasing) return
    setErasing(true)
    try {
      const r = await backup.unlock('erase')
      if (r.kind !== 'ok') {
        if (r.kind === 'unavailable') showToast('Your wallet’s keys couldn’t be read. Unlock your wallet and try again.', { type: 'error' })
        return
      }
      const m = r.material
      const primaryKey = m.mnemonic
        ? recoverMnemonicWallet(m.mnemonic, '', activeProfile).primaryKey
        : PrivateKey.fromWif(m.wif as string).toArray()
      let deleted = 0
      // every network's copy: each is its own account on the service
      for (const chain of BACKUP_CHAINS) {
        deleted += (await eraseRemoteBackup({ primaryKey, chain, baseUrl: getBackupUrl(), profileIndex: activeProfile })).deleted
      }
      showToast('Sync is off', { type: 'success', description: deleted ? 'Your synced copy was deleted.' : 'There was nothing to delete.' })
    } catch {
      // never report a deletion that didn't happen
      showToast('Your synced copy couldn’t be deleted. Check your connection and try again.', { type: 'error' })
    } finally {
      setErasing(false)
      refresh()
      notifySync()
    }
  }

  const confirmErase = () =>
    Alert.alert('Delete your synced copy?', 'This deletes everything Sync has saved for this wallet and turns Sync off. Your money stays in your wallet.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void erase() }
    ])

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Bitcoin SV Wallet Sync" fullScreen>
      <Hero
        icon={<SyncArt done={status.kind === 'synced'} />}
        title="Never lose your history"
        body="Sync keeps an encrypted copy of this wallet’s payments, notes and contacts. Get a new phone or reinstall, restore with your recovery phrase or slices, and it all comes back."
      />
      <Points
        items={[
          { icon: Lock, text: 'End-to-end encrypted with your wallet’s own key. Only your phrase or slices open it.' },
          { icon: CircleCheck, text: 'Free, and on unless you turn it off' },
          { icon: Trash2, text: 'Turn it off and delete it anytime' }
        ]}
      />

      <View style={[styles.card, { backgroundColor: palette.secondary + '80' }]}>
        <View style={styles.row}>
          <View style={styles.flex}>
            <Text style={[font(600), styles.rowTitle, { color: palette.foreground }]}>Sync this wallet</Text>
            <Text
              accessibilityLiveRegion="polite"
              style={[font(400), styles.rowLine, { color: status.kind === 'failed' || status.kind === 'off' ? palette.warning : palette.mutedForeground }]}
            >
              {syncLine(status)}
            </Text>
          </View>
          {/* the app's switch, as in Settings; nothing to switch until the core says Sync is available */}
          <View style={!available || on === null ? styles.dim : null} pointerEvents={!available || on === null ? 'none' : 'auto'}>
            <Switch value={!!on && available} onValueChange={v => (v ? void turnOn() : turnOff())} label="Sync this wallet" />
          </View>
        </View>
        {/* the prototype's "Sync now": the core's push, at once */}
        {on && available && status.kind !== 'syncing' && (
          <Pressable
            onPress={() => {
              TaskBackupPush.requestNow()
              refresh()
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.syncNow, { backgroundColor: palette.background }, pressed && { opacity: 0.7 }]}
          >
            <Text style={[font(600), styles.rowLine, { color: palette.foreground }]}>Sync now</Text>
          </Pressable>
        )}
      </View>

      {/* decision 6: free now; the paid plan is a placeholder until BSVA sets it */}
      <View style={[styles.card, styles.row, { backgroundColor: palette.secondary + '80' }]} accessible accessibilityLabel="Plan: Free. A paid plan with more comes later.">
        <View style={styles.flex}>
          <Text style={[font(600), styles.rowTitle, { color: palette.foreground }]}>Plan</Text>
          <Text style={[font(400), styles.rowLine, { color: palette.mutedForeground }]}>A paid plan with more comes later</Text>
        </View>
        <View style={[styles.freePill, { backgroundColor: palette.positive + '1f' }]}>
          <Text style={[font(700), styles.freeText, { color: palette.positive }]}>Free</Text>
        </View>
      </View>

      <View style={styles.footer}>
        <GlassButton size="lg" label="Done" onPress={() => onOpenChange(false)} />
        {available && (
          <Pressable onPress={confirmErase} disabled={erasing} accessibilityRole="button" style={styles.erase}>
            <Trash2 size={16} color={palette.destructive} />
            <Text style={[font(600), styles.eraseText, { color: palette.destructive }]}>{erasing ? 'Deleting…' : 'Delete synced copy'}</Text>
          </Pressable>
        )}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  syncNow: { alignSelf: 'flex-start', marginTop: 10, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  flex: { flex: 1 },
  hero: { alignItems: 'center', gap: 8, paddingTop: 8 },
  title: { paddingTop: 8, textAlign: 'center', fontSize: 24, lineHeight: 32, letterSpacing: -0.6 },
  body: { maxWidth: 340, textAlign: 'center', fontSize: 15, lineHeight: 24 },
  points: { gap: 12, paddingTop: 8 },
  point: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pointIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pointText: { flex: 1, fontSize: 14, lineHeight: 20 },
  card: { borderRadius: radii['2xl'], padding: 16 },
  dim: { opacity: 0.5 },
  freePill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  freeText: { fontSize: 12, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowTitle: { fontSize: 15, lineHeight: 20 },
  rowLine: { fontSize: 13, lineHeight: 18 },
  footer: { marginTop: 'auto', paddingTop: 16, gap: 8 },
  erase: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  eraseText: { fontSize: 14, lineHeight: 20 }
})
