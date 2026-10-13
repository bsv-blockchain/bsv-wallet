// The prototype's HomeCardStack for a new wallet in Now: Take the tour, Save
// your seed, Keep your history (Sync). Get your first BSV is Top up (Later)
// and is left out. Each card leaves the stack once it's done.
import React from 'react'
import { View } from 'react-native'
import { SeedPaperArt } from '../art/SeedPaperArt'
import { SyncArt } from '../art/SyncArt'
import { TourPhoneArt } from '../art/TourPhoneArt'
import { SoftEllipse } from '../ui/Soft'
import { CardCta, CardLink, CardStack, StackCard, type StackItem } from './CardStack'

export function HomeCards({
  showTour,
  showSeed,
  showSync,
  onTour,
  onBackup,
  onSync,
  onSyncLater
}: {
  showTour: boolean
  showSeed: boolean
  showSync: boolean
  onTour: () => void
  onBackup: () => void
  onSync: () => void
  onSyncLater: () => void
}) {
  const cards: (StackItem | false)[] = [
    showTour && {
      id: 'tour',
      // oklch(0.7 0.17 295 / 0.6)
      glow: '#a785fc99',
      node: (
        <StackCard
          tint="lavender"
          art={<TourPhoneArt />}
          title="Take the tour"
          body="A quick look at what everything on this screen does. Takes twenty seconds."
          action={<CardCta label="Show me around" onPress={onTour} />}
        />
      )
    },
    showSeed && {
      id: 'seed',
      // oklch(0.74 0.15 160 / 0.6)
      glow: '#38c78999',
      node: (
        <StackCard
          tint="mint"
          art={<SeedPaperArt />}
          title="Save your seed"
          body="If you lose your phone, a backup is the only way to get your money back. It takes a minute."
          action={<CardCta label="Back up now" onPress={onBackup} />}
        />
      )
    },
    showSync && {
      id: 'sync',
      // oklch(0.68 0.13 235 / 0.6)
      glow: '#2ea4dc99',
      node: (
        <StackCard
          tint="sky"
          art={
            <View style={{ width: 132, height: 132 }}>
              {/* inset-4 bg-white/20 blur-2xl */}
              <SoftEllipse frame={{ left: 16, top: 16, width: 100, height: 100 }} color="#ffffff" opacity={0.2} blur={40} />
              <SyncArt size={132} onDark />
            </View>
          }
          title="Keep your history, anywhere"
          body="Bitcoin SV Wallet Sync keeps an encrypted copy of all your wallets and payments. Sync is off, so new payments aren’t being saved. Turn it back on to keep your history safe."
          action={
            <View>
              <CardCta label="Turn on Sync" onPress={onSync} />
              <CardLink label="Not now" onPress={onSyncLater} />
            </View>
          }
        />
      )
    }
  ]
  return <CardStack cards={cards.filter((c): c is StackItem => !!c)} />
}
