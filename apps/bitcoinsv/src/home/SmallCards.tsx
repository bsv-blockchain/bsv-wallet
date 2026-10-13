// The prototype's SmallCardStack (components/home-card-stack.tsx): for a
// wallet with payments, the same first steps as the big cards, small and
// stacked under the coins. The tour leads; backing up and Sync wait behind
// it. Not here: Buy BSV (Later), subscriptions and the history file (no Now
// meaning), and the Sync password check (Sync has no password, decision 6).
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Info, KeyRound, X } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { SyncArt } from '../art/SyncArt'
import { CardStack, type StackItem } from './CardStack'

function SmallCard({
  art,
  title,
  body,
  action,
  onPress,
  onDismiss
}: {
  art: React.ReactNode
  title: string
  body: string
  action: string
  onPress: () => void
  onDismiss?: () => void
}) {
  const palette = usePalette()
  const dark = useIsDark()
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: palette.card,
          boxShadow: `0 0 0 1px ${palette.border}, ${dark ? '0 2px 26px -2px rgba(255,255,255,0.10)' : '0 2px 22px -2px rgba(20,24,40,0.16)'}`
        }
      ]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${body}. ${action}`}
        style={({ pressed }) => [styles.main, pressed && { backgroundColor: palette.secondary + '73' }]}
      >
        {art}
        <View style={styles.flex}>
          <Text style={[font(600), styles.title, { color: palette.foreground }]}>{title}</Text>
          <Text numberOfLines={1} style={[font(400), styles.body, { color: palette.mutedForeground }]}>
            {body}
          </Text>
        </View>
        <View style={[styles.pill, { backgroundColor: palette.ink }]}>
          <Text style={[font(600), styles.pillText, { color: palette.inkForeground }]}>{action}</Text>
        </View>
      </Pressable>
      {onDismiss && (
        <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={`Hide ${title}`} hitSlop={6} style={styles.close}>
          <X size={16} color={palette.mutedForeground} />
        </Pressable>
      )}
    </View>
  )
}

/** The big card's tilted phone in miniature, with an info badge. */
function TourMark() {
  return (
    <View style={[styles.round, { backgroundColor: '#d3c4f0' }]}>
      <View style={styles.phone}>
        <View style={styles.screen}>
          <View style={[styles.line, { width: '100%', opacity: 0.3 }]} />
          <View style={[styles.line, { width: '100%', height: 4, opacity: 0.2 }]} />
          <View style={[styles.line, { width: '66%', opacity: 0.2 }]} />
        </View>
      </View>
      <View style={[styles.badge, { boxShadow: '0 0 0 2px #d3c4f0' }]}>
        <Info size={8} color="#ffffff" strokeWidth={3.2} />
      </View>
    </View>
  )
}

export function SmallCards({
  showTour,
  showSeed,
  showSync,
  onTour,
  onTourDismiss,
  onBackup,
  onSync,
  onSyncDismiss
}: {
  showTour: boolean
  showSeed: boolean
  showSync: boolean
  onTour: () => void
  onTourDismiss: () => void
  onBackup: () => void
  onSync: () => void
  onSyncDismiss: () => void
}) {
  const cards: StackItem[] = []
  if (showTour)
    cards.push({
      id: 'tour',
      node: <SmallCard art={<TourMark />} title="Take the tour" body="What everything here does" action="Start" onPress={onTour} onDismiss={onTourDismiss} />
    })
  if (showSeed)
    cards.push({
      id: 'seed',
      node: (
        <SmallCard
          art={
            <View style={[styles.round, { backgroundColor: '#f0de8c' }]}>
              <KeyRound size={20} color="#1d1d1f" />
            </View>
          }
          title="Save your seed"
          body="Your only way back in"
          action="Back up"
          onPress={onBackup}
        />
      )
    })
  if (showSync)
    cards.push({
      id: 'sync',
      node: (
        <SmallCard art={<SyncArt size={44} />} title="Turn on Sync" body="Your history on any phone" action="Turn on" onPress={onSync} onDismiss={onSyncDismiss} />
      )
    })
  return <CardStack cards={cards} peek={8} control="dots" />
}

const styles = StyleSheet.create({
  card: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 20, paddingVertical: 8, paddingLeft: 8, paddingRight: 6 },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: radii['2xl'], padding: 8 },
  flex: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 12, lineHeight: 16, paddingTop: 2 },
  pill: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  pillText: { fontSize: 13, lineHeight: 18 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  phone: { width: 16, height: 28, borderRadius: 4, backgroundColor: '#1d1d1f', padding: 2, transform: [{ rotate: '14deg' }], marginLeft: -4, marginTop: -2 },
  screen: { flex: 1, borderRadius: 2, backgroundColor: '#f4f2f0', padding: 2, gap: 2 },
  line: { height: 2, borderRadius: 1, backgroundColor: '#1d1d1f' },
  badge: { position: 'absolute', right: 4, bottom: 4, width: 14, height: 14, borderRadius: 7, backgroundColor: '#1d1d1f', alignItems: 'center', justifyContent: 'center' }
})
