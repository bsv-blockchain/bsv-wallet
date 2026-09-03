import React, { ReactNode, useState, useEffect, useContext } from 'react'
import { formatAmount, ExchangeRateContext, useWallet } from '@bsv/expo-wallet-toolbox'

type Props = {
  abbreviate?: boolean
  showPlus?: boolean
  description?: string
  color?: string
  children: ReactNode
  showFiatAsInteger?: boolean
}

/**
 * AmountDisplay component shows an amount in the user's preferred currency format.
 *
 * In BSV mode (default): uses smart threshold formatting
 *   - < 1 BSV: displays as satoshis (e.g., "50,000 satoshis")
 *   - >= 1 BSV: displays as BSV (e.g., "1.5 BSV")
 *
 * In a fiat mode: displays the equivalent using WhatsOnChain USD and, for
 * non-USD currencies, a cached USD cross.
 *
 * All formatting is locale-aware (respects device locale for separators).
 *
 * @param {number|string} props.children - The amount in satoshis to display
 */
const AmountDisplay: React.FC<Props> = ({ abbreviate, showPlus, children, showFiatAsInteger }) => {
  const [formatted, setFormatted] = useState('...')

  const { settings } = useWallet()
  const currency = settings?.currency || 'BSV'

  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)

  useEffect(() => {
    const numValue = Number(children)
    if (!Number.isInteger(numValue)) {
      setFormatted('...')
      return
    }

    setFormatted(formatAmount(numValue, currency, satoshisPerUSD, { showPlus, abbreviate, showFiatAsInteger, usdToFiat }))
  }, [children, currency, satoshisPerUSD, usdToFiat, showPlus, abbreviate, showFiatAsInteger])

  return <>{formatted}</>
}

export default AmountDisplay
