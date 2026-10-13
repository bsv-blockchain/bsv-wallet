// What this wallet holds, coin by coin, for Home's rows and the coin page
// (the prototype's balances): BitcoinSV always, and each stablecoin from the
// shared core's Mandala runtime once it holds some. A dollar stablecoin is
// worth its peg in the display currency; any other token has no display value
// here, rather than a made-up one.
import { useContext } from 'react'
import { ExchangeRateContext } from '@bsv/expo-wallet-toolbox'
import { useMandala } from '@bsv/expo-wallet-toolbox/ui/hooks/useMandala'
import type { TokenAssetInfo } from '@bsv/expo-wallet-toolbox/core/mandala/runtime'
import { formatTokenAmount } from '@bsv/expo-wallet-toolbox/ui/tokenFormat'
import { useDisplayCurrency } from './displayCurrency'
import { useHomeData } from './useHomeData'

export interface Asset {
  /** 'bsv', or the token's asset id */
  id: string
  name: string
  ticker: string
  /** in the coin's own units (BSV, or the token's) */
  amount: number
  /** the token's own figure ("12.50"); BSV is drawn by Money */
  figure?: string
  /** its worth in the display currency; null when there's no honest figure */
  fiat: number | null
  /** "1 USDsv = $1.00", or how BSV's price behaves */
  peg: string
  token?: TokenAssetInfo
}

export const isDollar = (ticker: string) => /usd/i.test(ticker)

export function useAssets(): { assets: Asset[]; totalFiat: number | null; totalBsv: number; loading: boolean } {
  const home = useHomeData()
  const mandala = useMandala()
  const { usdToFiat, satoshisPerUSD } = useContext(ExchangeRateContext)
  const { currency } = useDisplayCurrency()
  // a dollar's worth in the display currency (in BSV, at the live rate)
  const perDollar =
    currency.code === 'USD'
      ? 1
      : currency.code === 'BSV'
        ? satoshisPerUSD
          ? satoshisPerUSD / 100_000_000
          : null
        : (usdToFiat[currency.code] ?? null)

  const bsv: Asset = {
    id: 'bsv',
    name: 'BitcoinSV',
    ticker: 'BSV',
    amount: home.bsv ?? 0,
    fiat: home.usd,
    peg: 'Price moves with the market'
  }
  const tokens: Asset[] = (mandala.balances ?? [])
    .filter(b => b.baseUnits + b.unsettledBaseUnits > 0)
    .map(b => {
      const units = b.baseUnits + b.unsettledBaseUnits
      const amount = units / 10 ** b.asset.decimals
      const dollar = isDollar(b.asset.ticker)
      return {
        id: b.asset.assetId,
        name: b.asset.label,
        ticker: b.asset.ticker,
        amount,
        figure: formatTokenAmount(units, b.asset.decimals) ?? String(amount),
        fiat: dollar && perDollar != null ? amount * perDollar : null,
        peg: dollar ? `1 ${b.asset.ticker} = $1.00` : `Issued by ${b.asset.issuerName ?? 'its issuer'}`,
        token: b.asset
      }
    })
  const assets = [bsv, ...tokens]
  const totalFiat = assets.every(a => a.fiat == null) ? null : assets.reduce((t, a) => t + (a.fiat ?? 0), 0)
  // the same total in BSV: dollar stablecoins at the live rate
  const dollarsInBsv = satoshisPerUSD ? satoshisPerUSD / 100_000_000 : 0
  const totalBsv = bsv.amount + tokens.reduce((t, a) => t + (isDollar(a.ticker) ? a.amount * dollarsInBsv : 0), 0)
  return { assets, totalFiat, totalBsv, loading: mandala.loading }
}
