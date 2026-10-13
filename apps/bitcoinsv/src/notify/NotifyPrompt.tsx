// Payment notifications from the system: whether this phone lets the app
// notify, asking once, and the way to the system's settings after that. Only
// when this build has push (the core's push adapter, wired in app/_layout.tsx
// once BSVA's Firebase registration is in place).
//
// The core's own pay screen asks just before the system does, so the system
// prompt never comes out of nowhere (NotificationAdvisoryModal); this is the
// same moment in this app's sheets, on Get paid.
import React, { useCallback, useEffect, useState } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { BellRing } from 'lucide-react-native'
import { getPushAdapter, type PushPermission } from '@bsv/expo-wallet-toolbox'
import { pushAdvisory } from '@bsv/expo-wallet-toolbox/core/push/pushAdvisory'
import { font, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { GlassButton } from '../ui/GlassButton'
import { BalancedText } from '../ui/BalancedText'
import { setPref, usePrefs } from '../state/prefs'

export function usePushPermission() {
  const adapter = getPushAdapter()
  const [permission, setPermission] = useState<PushPermission | null>(null)
  const read = useCallback(async () => {
    if (!adapter) return
    try {
      const next = await adapter.getPermission()
      // Android reports a refusal as 'undetermined' again; a refusal sticks
      // (the core's SettingsScreen does the same)
      setPermission(prev => (prev === 'denied' && next === 'undetermined' ? prev : next))
    } catch {
      // keep the last known state
    }
  }, [adapter])
  useEffect(() => {
    void read()
    const sub = AppState.addEventListener('change', s => s === 'active' && void read())
    return () => sub.remove()
  }, [read])
  const request = useCallback(async () => {
    if (!adapter) return
    await pushAdvisory.set().catch(() => {})
    setPermission(await adapter.requestPermission().catch(() => 'denied' as const))
  }, [adapter])
  const openSettings = useCallback(() => adapter?.openSettings(), [adapter])
  return { available: !!adapter, permission, request, openSettings }
}

/** Asks once, on Get paid, before the system's prompt. */
export function NotifyPrompt() {
  const palette = usePalette()
  const prefs = usePrefs()
  const push = usePushPermission()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (prefs.loaded && !prefs.notifyAsked && push.available && push.permission === 'undetermined') setOpen(true)
  }, [prefs.loaded, prefs.notifyAsked, push.available, push.permission])

  const close = () => {
    setPref('notifyAsked', true)
    setOpen(false)
  }
  return (
    <BottomSheet open={open} onOpenChange={o => !o && close()} title="Notifications" hideHeader>
      <View style={styles.head}>
        <View style={[styles.emblem, { backgroundColor: palette.gold }]}>
          <BellRing size={28} color={palette.goldForeground} strokeWidth={2.4} />
        </View>
        <BalancedText style={[font(700), styles.h2, { color: palette.foreground }]}>Get notified when you’re paid</BalancedText>
        <BalancedText style={[font(400), styles.small, { color: palette.mutedForeground }]}>
          Next, your phone will ask to allow notifications. This lets Bitcoin SV Wallet tell you the moment a payment arrives, even
          when the app is closed.
        </BalancedText>
      </View>
      <View style={styles.footer}>
        <GlassButton
          size="lg"
          label="Continue"
          onPress={() => {
            close()
            void push.request()
          }}
        />
        <GlassButton size="lg" variant="outline" label="Not now" onPress={close} />
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 8, paddingTop: 24 },
  emblem: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  h2: { textAlign: 'center', fontSize: 22, lineHeight: 30, letterSpacing: -0.5 },
  small: { textAlign: 'center', fontSize: 14, lineHeight: 22 },
  footer: { paddingTop: 24, gap: 8 }
})
