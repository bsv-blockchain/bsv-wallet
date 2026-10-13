// Settings → Sign-ins (the prototype's app/(wallet)/settings/sign-ins/page.tsx):
// the websites this wallet has signed in to (app/sign-in.tsx), when, and
// whether one is connected now; sign out of one, or all (the shared core's
// revokeConnection: this phone stops answering it at once, then tells it),
// or sign in to another.
import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { Globe, ScanLine } from 'lucide-react-native'
import { connectionStore, parseExternalOrigin, revokeConnection, useWallet, useWalletConnection, type Connection } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../src/ui/Toast'
import { font, usePalette } from '../src/theme'
import { GlassButton } from '../src/ui/GlassButton'
import { PageHeader } from '../src/ui/PageHeader'
import { BalancedText } from '../src/ui/BalancedText'
import { whenLabel } from '../src/activity/format'

const domainOf = (origin: string) => {
  try {
    return parseExternalOrigin(origin).originator.replace(/^www\./, '')
  } catch {
    return origin
  }
}

export default observer(function SignIns() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { managers } = useWallet()
  const { sessionMeta, disconnect } = useWalletConnection()
  // newest first; signed-out ones are kept by the core until removed
  const sites = [...connectionStore.connections].sort((a, b) => b.connectedAt - a.connectedAt)

  const signOut = async (c: Connection, quiet = false) => {
    await revokeConnection(c, managers.permissionsManager, { liveTopic: sessionMeta?.topic, disconnect })
    connectionStore.remove(c.sessionId)
    if (!quiet) showToast(`Signed out of ${domainOf(c.origin)}`, { type: 'success', description: 'They can’t see your wallet any more.' })
  }
  // the prototype's "Sign out of all websites"
  const signOutAll = async () => {
    const n = sites.length
    for (const c of sites) await signOut(c, true)
    showToast(`Signed out of ${n} website${n === 1 ? '' : 's'}`, { type: 'success', description: n === 1 ? 'It can’t see your wallet any more.' : 'They can’t see your wallet any more.' })
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Sign-ins" />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {sites.length === 0 ? (
          <View style={styles.empty}>
            <Globe size={40} color={palette.mutedForeground} strokeWidth={1.4} />
            <Text style={[font(700), styles.title, { color: palette.foreground }]}>No sign-ins yet</Text>
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              Websites you sign in to with your wallet show up here, so you can sign out of them.
            </BalancedText>
          </View>
        ) : (
          <View style={[styles.card, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}>
            {sites.map((c, i) => {
              const live = sessionMeta?.topic === c.sessionId
              return (
                <View key={c.sessionId} style={[styles.row, i > 0 && { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
                  <View style={[styles.icon, { backgroundColor: palette.secondary }]}>
                    <Globe size={18} color={palette.foreground} />
                  </View>
                  <View style={styles.flex}>
                    <Text numberOfLines={1} ellipsizeMode="middle" style={[font(600), styles.small, { color: palette.foreground }]}>
                      {domainOf(c.origin)}
                    </Text>
                    <Text style={[font(400), styles.xs, { color: live ? palette.positive : palette.mutedForeground }]}>
                      {live ? 'Connected now' : `Signed in ${whenLabel(new Date(c.connectedAt).toISOString())}`}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void signOut(c)}
                    accessibilityRole="button"
                    accessibilityLabel={`Sign out of ${domainOf(c.origin)}`}
                    hitSlop={6}
                    style={({ pressed }) => [styles.signOut, { backgroundColor: palette.secondary }, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[font(600), styles.xs, { color: palette.destructive }]}>Sign out</Text>
                  </Pressable>
                </View>
              )
            })}
          </View>
        )}
        {sites.length > 1 && (
          <Pressable onPress={() => void signOutAll()} accessibilityRole="button" style={styles.all}>
            <Text style={[font(600), styles.small, { color: palette.destructive }]}>Sign out of all websites</Text>
          </Pressable>
        )}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <GlassButton size="lg" label="Sign in to a website" icon={<ScanLine size={18} color={palette.goldForeground} />} onPress={() => router.push('/sign-in')} />
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  content: { paddingHorizontal: 16, paddingTop: 8, flexGrow: 1 },
  flex: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, lineHeight: 28, letterSpacing: -0.5 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  center: { textAlign: 'center', maxWidth: 300 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 48 },
  card: { borderRadius: 20, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  signOut: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  all: { alignSelf: 'center', paddingVertical: 16, paddingHorizontal: 12 },
  footer: { paddingHorizontal: 16, paddingTop: 12 }
})
