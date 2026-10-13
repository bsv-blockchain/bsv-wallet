// Settings → Forget wallet (the prototype's components/forget-wallets-sheet.tsx,
// its "Are you sure?" step): what forgetting costs, a warning when the wallet
// isn't backed up, a last check, then the shared core's logout, which erases
// every wallet on this phone (they share one recovery phrase) and returns to
// Welcome. So there's no choosing which, and with several it says all.
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { AlertTriangle, Check, KeyRound, type LucideIcon } from 'lucide-react-native'
import { liveProfiles, useProfiles, useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import { font, radii, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { BalancedText } from '../ui/BalancedText'
import { setPref } from '../state/prefs'

const POINTS: { Icon: LucideIcon; title: string; body: string }[] = [
  { Icon: Check, title: 'Your money stays safe.', body: 'It’s on the blockchain, not this phone.' },
  { Icon: KeyRound, title: 'The recovery phrase is the only way back.', body: 'Its 12 words (or two of its key slices) restore it on any phone, with every wallet made from it.' },
  { Icon: AlertTriangle, title: 'You’ll start over.', body: 'The app returns to the welcome screen.' }
]

export function ForgetWalletSheet({
  open,
  onOpenChange,
  backedUp,
  onBackUp
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  backedUp: boolean
  onBackUp: () => void
}) {
  const palette = usePalette()
  const { logout } = useWallet()
  const count = liveProfiles(useProfiles()).length
  const all = count > 1
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setConfirmed(false)
  }, [open])

  const forget = async () => {
    setBusy(true)
    // to Welcome from the start, as on a new phone, once the core lets go of the wallet
    setPref('onboarded', false)
    for (const k of ['tourDone', 'setupHidden', 'syncCardDismissed', 'notifyAsked', 'phraseBackedUp', 'backupNudge', 'backupNudged'] as const) setPref(k, false)
    setPref('looks', {})
    setPref('stagedLook', null)
    setPref('pendingHandleProfile', 0)
    for (const k of ['pendingHandle', 'pendingDisplayName', 'avatarPortrait', 'avatarUri', 'avatarBg'] as const) setPref(k, null)
    const erased = await logout().catch(() => false)
    setBusy(false)
    if (erased) {
      onOpenChange(false)
      showToast(all ? 'All wallets forgotten on this device' : 'Wallet forgotten on this device', {
        type: 'success',
        description: all ? 'Bring them back any time with the recovery phrase.' : 'Bring it back any time with the recovery phrase.'
      })
    } else {
      setPref('onboarded', true)
      showToast('The wallet couldn’t be fully removed from this phone. Try again.', { type: 'error' })
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={o => !busy && onOpenChange(o)} title="Are you sure?" fullScreen>
      <View style={styles.head}>
        <View style={[styles.emblem, { backgroundColor: palette.destructive + '1f' }]}>
          <AlertTriangle size={28} color={palette.destructive} />
        </View>
        <BalancedText style={[font(700), styles.h2, { color: palette.foreground }]}>{all ? `Forget all ${count} wallets on this device?` : 'Forget this wallet on this device?'}</BalancedText>
      </View>

      <View style={styles.points}>
        {POINTS.map(({ Icon, title, body }) => (
          <View key={title} style={styles.point}>
            <View style={[styles.ring, { borderColor: palette.foreground + '33' }]}>
              <Icon size={14} color={palette.foreground} />
            </View>
            <View style={styles.flex}>
              <Text style={[font(600), styles.small, { color: palette.foreground }]}>{title}</Text>
              <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>{body}</Text>
            </View>
          </View>
        ))}
      </View>

      {!backedUp && (
        <View style={[styles.warn, { backgroundColor: palette.warning + '1a', boxShadow: `0 0 0 1px ${palette.warning}40` }]}>
          <AlertTriangle size={20} color={palette.warning} />
          <Text style={[font(400), styles.small, { color: palette.foreground }]}>
            <Text style={font(600)}>This wallet isn’t backed up.{'\n'}</Text>
            Without its recovery phrase, the money is gone.
          </Text>
          <Pressable
            onPress={onBackUp}
            accessibilityRole="button"
            style={[styles.backUp, { backgroundColor: palette.card, boxShadow: `0 1px 2px rgba(0,0,0,0.05), 0 0 0 1px ${palette.border}` }]}
          >
            <Text style={[font(600), styles.small, { color: palette.foreground }]}>Back up now</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.footer}>
        <Pressable
          onPress={() => setConfirmed(c => !c)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: confirmed }}
          style={[styles.check, { boxShadow: `0 0 0 1px ${palette.border}` }, confirmed && { backgroundColor: palette.secondary + '99' }]}
        >
          <View style={[styles.box, { borderColor: confirmed ? palette.ink : palette.foreground + '4d' }, confirmed && { backgroundColor: palette.ink }]}>
            {confirmed && <Check size={14} color={palette.inkForeground} strokeWidth={3} />}
          </View>
          <Text style={[font(400), styles.small, styles.flex, { color: palette.foreground }]}>
            {all ? 'I have backed up the recovery phrase these wallets share' : 'I have backed up this wallet’s recovery phrase'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void forget()}
          disabled={!confirmed || busy}
          accessibilityRole="button"
          style={[styles.destructive, { backgroundColor: palette.destructive, opacity: confirmed ? 1 : 0.5 }]}
        >
          {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={[font(600), styles.btnText]}>{all ? 'Forget all wallets' : 'Forget wallet'}</Text>}
        </Pressable>
        <Pressable onPress={() => onOpenChange(false)} accessibilityRole="button" style={styles.cancel}>
          <Text style={[font(600), styles.small, { color: palette.mutedForeground }]}>Cancel</Text>
        </Pressable>
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 12, paddingTop: 8 },
  emblem: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  h2: { fontSize: 20, lineHeight: 28, textAlign: 'center', letterSpacing: -0.5 },
  points: { gap: 12 },
  point: { flexDirection: 'row', gap: 12 },
  ring: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  flex: { flex: 1 },
  small: { fontSize: 14, lineHeight: 20 },
  warn: { gap: 8, borderRadius: radii['2xl'], padding: 16 },
  backUp: { alignSelf: 'flex-start', height: 36, borderRadius: 999, paddingHorizontal: 16, justifyContent: 'center' },
  footer: { marginTop: 'auto', gap: 8, paddingTop: 8 },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderRadius: radii['2xl'], padding: 12 },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  destructive: { height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  cancel: { height: 44, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#ffffff', fontSize: 16, lineHeight: 22 }
})
