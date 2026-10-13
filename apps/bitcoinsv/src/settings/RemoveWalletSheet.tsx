// Profile → Forget this wallet, for any wallet but the first: the shared
// core's profile removal (core/profiles/removeProfile), which takes the open
// wallet off this phone, releases its handle and opens the first wallet. It
// only goes ahead when the wallet holds nothing, here and on its other
// networks, so the sheet asks first and says what stands in the way. The
// first wallet is the recovery phrase's own: forgetting it is forgetting them
// all (ForgetWalletSheet).
import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AlertTriangle } from 'lucide-react-native'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { removalProblemKeys, type RemovalProblem } from '@bsv/expo-wallet-toolbox/core/profiles/removalProblems'
import { showToast } from '../ui/Toast'
import { font, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { BalancedText } from '../ui/BalancedText'
import { getPrefs, setPref } from '../state/prefs'

/** The core's reasons (removalProblemKeys), in this app's words: wallets, not profiles. */
const PROBLEM: Record<string, string> = {
  profile_remove_blocked_funds: 'It still holds money or stablecoins. Send them to another wallet first.',
  profile_remove_blocked_pending: 'A payment is still going through, or waiting to be sent or credited. Try again once it has settled.',
  profile_remove_blocked_network:
    'It also holds money or unfinished payments on another network. Switch it to that network, empty it there, then try again.',
  profile_remove_blocked_check: 'This wallet couldn’t be checked, so nothing was removed. Try again.',
  profile_remove_offline: 'Connect to the internet to forget a wallet.',
  profile_remove_failed_handle: 'Its handle couldn’t be released, or a change to it is still finishing. Check your connection and try again. Nothing was removed.',
  profile_remove_failed: 'This wallet couldn’t be forgotten. Try again.'
}

type State = { kind: 'checking' } | { kind: 'ok'; handle: string | null } | { kind: 'problem'; lines: string[] }

const linesOf = (problem: RemovalProblem) => removalProblemKeys(problem).map(k => PROBLEM[k] ?? PROBLEM.profile_remove_failed)

export function RemoveWalletSheet({ open, onOpenChange, name }: { open: boolean; onOpenChange: (o: boolean) => void; name: string }) {
  const palette = usePalette()
  const router = useRouter()
  const { activeProfile, checkProfileRemoval, removeProfile } = useWallet()
  const [state, setState] = useState<State>({ kind: 'checking' })
  const [busy, setBusy] = useState(false)

  // asked afresh each time it opens: money can arrive while it's closed
  useEffect(() => {
    if (!open) return
    let live = true
    setState({ kind: 'checking' })
    checkProfileRemoval()
      .then(c => live && setState(c.kind === 'ok' ? { kind: 'ok', handle: c.handle } : { kind: 'problem', lines: linesOf(c) }))
      .catch(() => live && setState({ kind: 'problem', lines: [PROBLEM.profile_remove_failed] }))
    return () => {
      live = false
    }
  }, [open, checkProfileRemoval])

  const remove = async () => {
    const index = activeProfile
    setBusy(true)
    try {
      // checks everything again: what was true when the sheet opened may not be now
      const result = await removeProfile()
      if (result.kind !== 'removed') {
        setState({ kind: 'problem', lines: linesOf(result) })
        return
      }
      // a wallet made again later at this index starts with its own look
      const { [index]: _gone, ...looks } = getPrefs().looks
      setPref('looks', looks)
      onOpenChange(false)
      showToast(`${name} forgotten on this device`, { type: 'success', description: 'Your recovery phrase can bring it back.' })
      router.dismissAll()
      router.replace('/')
    } catch {
      setState({ kind: 'problem', lines: [PROBLEM.profile_remove_failed] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={o => !busy && onOpenChange(o)} title={state.kind === 'problem' ? `${name} can’t be forgotten yet` : `Forget ${name}?`}>
      {state.kind === 'checking' ? (
        <View style={styles.checking}>
          <ActivityIndicator color={palette.mutedForeground} />
        </View>
      ) : state.kind === 'problem' ? (
        <View style={styles.body}>
          {state.lines.map(line => (
            <BalancedText key={line} style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              {line}
            </BalancedText>
          ))}
          <Pressable onPress={() => onOpenChange(false)} accessibilityRole="button" style={[styles.button, { backgroundColor: palette.secondary }]}>
            <Text style={[font(600), styles.small, { color: palette.foreground }]}>OK</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.body}>
          <View style={[styles.emblem, { backgroundColor: palette.destructive + '1f' }]}>
            <AlertTriangle size={24} color={palette.destructive} />
          </View>
          <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            {`${name} will be taken off this phone, and your other wallets stay. It holds nothing, and your recovery phrase can bring it back.`}
          </BalancedText>
          {state.handle && (
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              {`Its handle ${state.handle} will be released. No one else can claim it for 30 days; after that anyone can.`}
            </BalancedText>
          )}
          <Pressable
            onPress={() => void remove()}
            disabled={busy}
            accessibilityRole="button"
            style={[styles.button, { backgroundColor: palette.destructive }]}
          >
            {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={[font(600), styles.small, styles.white]}>Forget {name}</Text>}
          </Pressable>
          <Pressable onPress={() => onOpenChange(false)} disabled={busy} accessibilityRole="button" style={styles.cancel}>
            <Text style={[font(600), styles.small, { color: palette.mutedForeground }]}>Cancel</Text>
          </Pressable>
        </View>
      )}
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  checking: { paddingVertical: 32, alignItems: 'center' },
  body: { alignItems: 'center', gap: 12, paddingTop: 4 },
  emblem: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  small: { fontSize: 14, lineHeight: 20 },
  center: { alignSelf: 'stretch', textAlign: 'center' },
  button: { alignSelf: 'stretch', height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  white: { color: '#ffffff' },
  cancel: { paddingVertical: 8 }
})
