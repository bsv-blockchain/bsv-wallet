// Settings → Handles (the prototype's app/(wallet)/settings/handles/page.tsx):
// what each wallet on this phone goes by, a tap copying it. Every handle here
// is a free one; bought handles, and moving or letting one go, come with paid
// handles (decision 7's placeholder), so "Owned" says so.
import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { Copy } from 'lucide-react-native'
import { showToast } from '../src/ui/Toast'
import { font, radii, usePalette } from '../src/theme'
import { PageHeader } from '../src/ui/PageHeader'
import { ViewInfo } from '../src/ui/ViewInfo'
import { Avatar, type AvatarBg, type Portrait } from '../src/ui/Avatar'
import { BalancedText } from '../src/ui/BalancedText'
import { useWalletList } from '../src/home/useWalletList'

export default function Handles() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const wallets = useWalletList()

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader title="Handles" action={<ViewInfo about="Handles" text="Every wallet has a free handle: what people pay you by. Tap one to copy it." />} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View>
          <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>IN USE</Text>
          <View style={styles.list}>
            {wallets.map(w => (
              <Pressable
                key={w.index}
                disabled={!w.handle}
                onPress={async () => {
                  if (!w.handle) return
                  await Clipboard.setStringAsync(w.handle)
                  showToast(`${w.handle} copied`, { type: 'success' })
                }}
                accessibilityRole="button"
                accessibilityLabel={w.handle ? `${w.handle}${w.active ? ', this wallet' : ''}. Copy` : `Wallet ${w.index + 1}, no handle yet`}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}
              >
                <Avatar
                  bg={(w.look?.avatarBg as AvatarBg) ?? 'mint'}
                  portrait={(w.look?.avatarPortrait as Portrait) ?? 'dragon'}
                  uri={w.look?.avatarUri ?? undefined}
                  size={40}
                />
                <View style={styles.flex}>
                  <Text numberOfLines={1} style={[font(600), styles.small, { color: palette.foreground }]}>
                    {w.handle ?? 'No handle yet'}
                  </Text>
                  <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                    {[w.name, w.active ? 'this wallet' : null].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {w.handle ? (
                  <>
                    <View style={[styles.pill, { backgroundColor: palette.secondary }]}>
                      <Text style={[font(600), styles.pillText, { color: palette.mutedForeground }]}>Free</Text>
                    </View>
                    <Copy size={14} color={palette.mutedForeground} />
                  </>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>

        <View>
          <Text style={[font(600), styles.eyebrow, { color: palette.mutedForeground }]}>OWNED</Text>
          <View style={[styles.none, { backgroundColor: palette.secondary + '80' }]}>
            <Text style={[font(600), styles.small, { color: palette.foreground }]}>No bought handles</Text>
            <BalancedText style={[font(400), styles.xs, styles.center, { color: palette.mutedForeground }]}>
              Short and memorable handles to buy, and to move between your wallets, come in a later update.
            </BalancedText>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16 },
  content: { paddingHorizontal: 16, paddingTop: 8, gap: 24 },
  eyebrow: { fontSize: 11, lineHeight: 16, letterSpacing: 1.1, paddingBottom: 6, paddingLeft: 4 },
  list: { marginHorizontal: -8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 8, paddingVertical: 10 },
  flex: { flex: 1, minWidth: 0 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  center: { textAlign: 'center' },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: 11, lineHeight: 14 },
  none: { alignItems: 'center', gap: 4, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 20 }
})
