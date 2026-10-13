// The prototype's CoinIcon (components/coin-icon.tsx): BitcoinSV is its own
// logo, a dollar stablecoin the silver $1 coin, anything else a tinted disc
// with its ticker.
import React from 'react'
import { Image, Text, View } from 'react-native'
import { font } from '../theme'
import { BsvMark } from './BsvMark'

export type Coin = { kind: 'bsv' } | { kind: 'token'; ticker: string }

export function CoinMark({ coin, size = 40 }: { coin: Coin; size?: number }) {
  if (coin.kind === 'bsv') return <BsvMark size={size} />
  if (/usd/i.test(coin.ticker))
    return <Image source={require('../../assets/images/usd-coin.png')} style={{ width: size, height: size, borderRadius: size / 2 }} />
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#2775ca', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={[font(600), { color: '#ffffff', fontSize: size * 0.28 }]}>{coin.ticker.slice(0, 4)}</Text>
    </View>
  )
}
