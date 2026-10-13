// Push simulator (development builds with EXPO_PUBLIC_PUSH_SIMULATE=true): plays
// the pushes BSVA's MessageBox server will send into the app's routing
// (src/notify/devPushAdapter.ts), with the payload it will carry
// (docs/backend-integration.md). A payment push looks at the payment inbox
// (and a tap opens Activity); a request push looks at the requests box (and a
// tap opens Activity on Requested).
import React, { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Redirect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../src/ui/Toast'
import { font, usePalette } from '../src/theme'
import { PageHeader } from '../src/ui/PageHeader'
import { GlassButton } from '../src/ui/GlassButton'
import { simulatePush } from '../src/notify/devPushAdapter'
import { REQUEST_BOX } from '../src/requests/requests'

const SIMULATING = __DEV__ && process.env.EXPO_PUBLIC_PUSH_SIMULATE === 'true'

export default function DevPush() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const { managers, adminOriginator } = useWallet()
  const [me, setMe] = useState('')
  useEffect(() => {
    void managers.permissionsManager
      ?.getPublicKey({ identityKey: true }, adminOriginator)
      .then(r => setMe(r.publicKey))
      .catch(() => {})
  }, [managers.permissionsManager, adminOriginator])
  if (!SIMULATING) return <Redirect href="/settings" />

  const play = (messageBox: string, how: 'foreground' | 'tap', what: string) => {
    simulatePush({ messageBox, recipient: me, originator: '02' + '00'.repeat(32), messageId: `sim-${Date.now()}` }, how)
    if (how === 'foreground') showToast(`${what}: looking now`, { type: 'info' })
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Push simulator" />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>
          Plays the pushes BSVA’s server will send, into the same handling a real one reaches. Nothing is registered with a server.
        </Text>
        <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>PAYMENTS (payment_inbox)</Text>
        <GlassButton variant="outline" label="Arrives while the app is open" onPress={() => play('payment_inbox', 'foreground', 'Payment push')} />
        <GlassButton variant="outline" label="Notification tapped" onPress={() => play('payment_inbox', 'tap', 'Payment push')} />
        <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>REQUESTS ({REQUEST_BOX})</Text>
        <GlassButton variant="outline" label="Arrives while the app is open" onPress={() => play(REQUEST_BOX, 'foreground', 'Request push')} />
        <GlassButton variant="outline" label="Notification tapped" onPress={() => play(REQUEST_BOX, 'tap', 'Request push')} />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  content: { paddingHorizontal: 16, paddingTop: 8, gap: 10 },
  small: { fontSize: 14, lineHeight: 20 },
  eyebrow: { fontSize: 11, lineHeight: 16, letterSpacing: 1.6, paddingTop: 14, paddingLeft: 4 }
})
