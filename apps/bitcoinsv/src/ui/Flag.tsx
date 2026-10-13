// A country flag as the prototype draws it (flag-icons' `fi fis`): the square
// flag clipped round, with a hairline inset edge so white flags still read.
import React from 'react'
import { View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { FLAGS, FLAGS_4X3 } from './flags'

export function Flag({ country, size, round = true }: { country: string; size: number; round?: boolean }) {
  const xml = FLAGS[country]
  if (!xml) return null
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: round ? size / 2 : 2, overflow: 'hidden' }}
    >
      <SvgXml xml={xml} width={size} height={size} />
      <View
        pointerEvents="none"
        style={{ position: 'absolute', inset: 0, borderRadius: round ? size / 2 : 2, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)' }}
      />
    </View>
  )
}

/** CoinFlag: a coin's pegged country at text size, 4:3 with 2pt corners. */
export function CoinFlag({ country, height }: { country: string; height: number }) {
  const xml = FLAGS_4X3[country]
  if (!xml) return null
  const width = (height * 4) / 3
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width, height, borderRadius: 2, overflow: 'hidden' }}>
      <SvgXml xml={xml} width={width} height={height} />
      <View pointerEvents="none" style={{ position: 'absolute', inset: 0, borderRadius: 2, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)' }} />
    </View>
  )
}
