/**
 * 34pt chrome-disc profile button, top-left of Home. Wears whatever avatar
 * icon the user picked in Profile — the same `core/userAvatar.ts` choice the
 * profile hero draws, so the two can never disagree.
 *
 * Original note: 34pt chrome-disc profile button, top-left of Home — passed through
 * `WalletHomeScreen`'s existing (previously unused) `topLeft` prop from the
 * host app's `app/index.tsx`, so this needed no package API change. Same disc
 * as the settings button on the right (surfaceRaised + hairline), so the two
 * bookend the header as a matched pair.
 *
 * With wallet profiles (a mnemonic wallet), pressing opens the profile
 * switcher; the active profile's row is the way into Profile. A recovered-key
 * wallet has no profiles, so it keeps going straight to Profile.
 */
import React, { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme, useUserAvatarIcon, useWallet } from '@bsv/expo-wallet-toolbox'
import { useTranslation } from 'react-i18next'
import PressableScale from '../ui/PressableScale'
import { AvatarGlyph } from './UserAvatar'
import ProfileSwitcherPopover from './ProfileSwitcherPopover'

type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

export default function ProfileButton() {
  const { colors } = useTheme()
  const { t } = useTranslation()
  const { router } = loadExpoRouter()
  const avatar = useUserAvatarIcon()
  const { profilesSupported, profiles, activeProfile, switchProfile, addProfile, walletBuilding } = useWallet()
  const discRef = useRef<View>(null)
  const [open, setOpen] = useState(false)
  // Until the first layout measure lands: roughly where Home's top bar puts the disc.
  const [anchor, setAnchor] = useState({ x: 16, y: 54, height: 34 })

  const openProfile = () => router.push('/profile' as never)

  // Where the card hangs from, kept current from layout so a press opens at once.
  const measure = () => {
    discRef.current?.measureInWindow?.((x, y, _w, height) => {
      if (Number.isFinite(x) && Number.isFinite(y)) setAnchor({ x, y, height: height || 34 })
    })
  }

  const onPress = () => {
    if (!profilesSupported) {
      openProfile()
      return
    }
    measure()
    setOpen(true)
  }

  const run = (action: () => Promise<void>) => {
    setOpen(false)
    action().catch(err => console.warn('[ProfileButton] profile action failed:', err))
  }

  return (
    <>
      <View ref={discRef} collapsable={false} onLayout={measure}>
        <PressableScale
          onPress={onPress}
          haptic="tap"
          hitSlop={5}
          style={[styles.disc, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
          accessibilityRole="button"
          accessibilityLabel={profilesSupported ? t('profile_switcher_a11y') : t('profile')}
        >
          <AvatarGlyph
            family={avatar?.family ?? 'ionicons'}
            name={avatar?.name ?? 'person-outline'}
            size={17}
            color={colors.textSecondary}
          />
        </PressableScale>
      </View>
      {profilesSupported && (
        <ProfileSwitcherPopover
          visible={open}
          onClose={() => setOpen(false)}
          anchor={anchor}
          profiles={profiles}
          active={activeProfile}
          avatar={avatar}
          busy={walletBuilding}
          onSelect={n => run(() => switchProfile(n))}
          onOpenProfile={() => {
            setOpen(false)
            openProfile()
          }}
          onAdd={() => run(addProfile)}
        />
      )}
    </>
  )
}

const styles = StyleSheet.create({
  disc: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
