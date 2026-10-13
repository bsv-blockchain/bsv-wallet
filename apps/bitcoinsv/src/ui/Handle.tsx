// A handle, written as the prototype writes it (components/ecosystem-mark.tsx's
// Handle): someone in this wallet's own handle space is "@rosa"; anyone else,
// and your own handle in full, carry their wallet between the second "@" and
// the domain: "@rosa@ [mark] handcash". This wallet's mark is the BSV coin;
// the wallets we know (src/contacts/ecosystems.ts) wear their own logos, from
// the prototype's public/ecosystems; any other shows its initial.
import React from 'react'
import { StyleSheet, Text, View, type ImageSourcePropType, type StyleProp, type TextStyle } from 'react-native'
import { Image } from 'expo-image'
import { getHandleRegistryConfig, useWallet } from '@bsv/expo-wallet-toolbox'
import { font, useIsDark, usePalette } from '../theme'
import { BsvMark } from './BsvMark'
import { HOME_DOMAIN, bareHandle, domainOf, isOwnSpace, ownDomains, shortDomain } from '../contacts/handles'
import { ecosystemOf } from '../contacts/ecosystems'

/** Each known wallet's logo, by its id */
const LOGOS: Record<string, ImageSourcePropType> = {
  handcash: require('../../assets/images/ecosystems/handcash.webp'),
  treechat: require('../../assets/images/ecosystems/treechat.webp'),
  twetch: require('../../assets/images/ecosystems/twetch.svg'),
  commonsource: require('../../assets/images/ecosystems/commonsource.svg'),
  mycelia: require('../../assets/images/ecosystems/mycelia.png')
}

/** A wallet's mark at a size: its logo (on its plate, if it needs one), or its initial. */
export function WalletMark({ domain, size }: { domain: string; size: number }) {
  const palette = usePalette()
  const dark = useIsDark()
  const eco = ecosystemOf(domain)
  const logo = eco && LOGOS[eco.id]
  // rounded-lg at badge size: about a quarter of it
  const radius = size * 0.25
  // a bare glyph sits on a plate that shows it: white ones always, dark ones on the dark theme
  const plate = eco?.plate ?? (dark ? eco?.darkPlate : undefined)
  if (logo) {
    return plate ? (
      <View style={[styles.initial, { width: size, height: size, borderRadius: radius, backgroundColor: plate }]}>
        <Image source={logo} style={{ width: size * 0.72, height: size * 0.72 }} contentFit="contain" accessible={false} />
      </View>
    ) : (
      <Image source={logo} style={{ width: size, height: size, borderRadius: radius }} contentFit="contain" accessible={false} />
    )
  }
  return (
    <View style={[styles.initial, { width: size, height: size, borderRadius: radius, backgroundColor: palette.secondary }]}>
      <Text style={[font(700), { fontSize: size * 0.6, lineHeight: size, color: palette.foreground }]}>{domain[0]?.toUpperCase()}</Text>
    </View>
  )
}

/** This wallet's own handle domains, for this network. */
export function useOwnDomains(): string[] {
  const { selectedNetwork } = useWallet()
  return ownDomains(getHandleRegistryConfig(selectedNetwork)?.domain)
}

export function Handle({
  handle,
  peer = true,
  qualified = false,
  style
}: {
  /** "rosa@bitcoinsv.com", "@rosa" … */
  handle: string
  /** someone else's: in this wallet's own space, "@rosa" alone; your own shows its domain */
  peer?: boolean
  /** the full domain (handcash.io) rather than its short form (handcash) */
  qualified?: boolean
  style?: StyleProp<TextStyle>
}) {
  const own = useOwnDomains()
  const bare = bareHandle(handle)
  const home = isOwnSpace(handle, own)
  if (home && peer) {
    return (
      <Text numberOfLines={1} style={style}>
        @{bare}
      </Text>
    )
  }
  const domain = domainOf(handle) ?? HOME_DOMAIN
  const shown = home || qualified ? domain : shortDomain(domain)
  const size = (StyleSheet.flatten(style)?.fontSize as number | undefined) ?? 14
  const mark = size * 0.95
  return (
    <View style={styles.row} accessible accessibilityLabel={`@${bare}@${domain}`}>
      <Text style={[style, styles.fixed]}>@{bare}@</Text>
      <View style={{ marginHorizontal: size * 0.1 }}>
        {home ? <BsvMark size={mark} /> : <WalletMark domain={domain} size={mark} />}
      </View>
      <Text numberOfLines={1} style={[style, styles.tail]}>
        {shown}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minWidth: 0, maxWidth: '100%' },
  fixed: { flexShrink: 0 },
  tail: { flexShrink: 1, minWidth: 0 },
  initial: { alignItems: 'center', justifyContent: 'center' }
})
