// Money figures as the prototype's components/money.tsx and
// animated-money.tsx: en-GB grouping, two decimals (BSV: two to eight, so a
// balance is exact to the satoshi), the display currency's
// symbol ("$" before dollars, "zł" after złoty), the BitcoinSV mark after BSV,
// "••••" in privacy mode, and on hero figures the cents set small and
// top-aligned. A 'usd' figure is in the display currency (Settings), already
// converted (src/state/displayCurrency.ts).
import React, { useEffect, useRef, useState } from 'react'
import { Text, View, type TextStyle } from 'react-native'
import Animated from 'react-native-reanimated'
import { BsvMark } from './BsvMark'
import { enter } from './motion'
import { DISPLAY_CURRENCIES, currentDisplayCurrency, useDisplayCurrency } from '../state/displayCurrency'
import { formatAmount, formatBsvAmount } from './moneyFormat'

/**
 * 'usd': the display currency (BSV when that's BitcoinSV); 'bsv': BitcoinSV;
 * 'dollars': US dollars whatever the display currency, for the other face of
 * a BSV total when BitcoinSV is the display currency.
 */
export type Unit = 'usd' | 'bsv' | 'dollars'

export { formatAmount, formatBsvAmount }

/** A fiat figure shown in BSV when BitcoinSV is the display currency. */
const shownAs = (unit: Unit): Unit => (unit === 'usd' && currentDisplayCurrency().code === 'BSV' ? 'bsv' : unit)

const USD = DISPLAY_CURRENCIES.find(c => c.code === 'USD')!

/** "$1,846.20" in the display currency, "12.50" or "0.00999977" (the mark follows) for BSV. */
export function formatMoney(amount: number, unit: Unit): string {
  const sign = amount < 0 ? '−' : ''
  if (shownAs(unit) === 'bsv') return `${sign}${formatBsvAmount(Math.abs(amount))}`
  const c = unit === 'dollars' ? USD : currentDisplayCurrency()
  const abs = formatAmount(Math.abs(amount), c.decimals)
  return c.after ? `${sign}${abs}${c.symbol}` : `${sign}${c.symbol}${abs}`
}

/** A figure at text size: "0.00 Ⓑ" or "$0.00". */
export function Money({
  amount,
  unit,
  privacy = false,
  style
}: {
  amount: number
  unit: Unit
  privacy?: boolean
  style?: TextStyle | TextStyle[]
}) {
  useDisplayCurrency()
  const flat = Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})
  const size = (flat.fontSize as number) ?? 14
  if (privacy) return <Text style={style}>••••</Text>
  if (shownAs(unit) !== 'bsv') return <Text style={style}>{formatMoney(amount, unit)}</Text>
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: flat.textAlign === 'right' ? 'flex-end' : undefined }}>
      <Text style={style}>{formatMoney(amount, unit)}</Text>
      {/* ml-[0.25em], size-[0.95em], set in ink */}
      <View style={{ marginLeft: size * 0.25 }}>
        <BsvMark size={size * 0.95} ink />
      </View>
    </View>
  )
}

const DURATION_MS = 700
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/** Counts towards its target when it changes (from 0 on first mount); a change of unit jumps. */
function useCountUp(target: number, unit: Unit): number {
  const [value, setValue] = useState(0)
  const from = useRef(0)
  const lastUnit = useRef(unit)
  useEffect(() => {
    if (lastUnit.current !== unit) {
      lastUnit.current = unit
      from.current = target
      setValue(target)
      return
    }
    const start = from.current
    if (start === target) return
    const t0 = Date.now()
    let raf = 0
    const tick = () => {
      const t = Math.min(1, (Date.now() - t0) / DURATION_MS)
      setValue(start + (target - start) * easeOutCubic(t))
      if (t < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, unit])
  return lastUnit.current === unit ? value : target
}

/** The hero balance: "$2,246" with ".20" raised at half size; BSV wears its gold mark. */
export function HeroMoney({
  amount,
  unit,
  privacy,
  style
}: {
  amount: number
  unit: Unit
  privacy: boolean
  style: TextStyle
}) {
  useDisplayCurrency()
  const animated = useCountUp(amount, unit)
  const size = style.fontSize ?? 48
  if (privacy) return <Text style={style}>••••</Text>
  const text = formatMoney(animated, unit)
  // a symbol after the figure ("12.50zł") stays after the raised cents
  const m = text.match(/^(.*?)(\.\d+)(.*)$/)
  const whole = m ? m[1] : text
  const cents = m ? m[2] : ''
  const after = m ? m[3] : ''
  // iOS clips the tops of big Nunito figures set at leading-none, so the text
  // gets a taller line box (1.2em) and the row gives the extra back as
  // negative margin: the figure sits exactly where the given line height
  // puts it, unclipped
  const base = style.lineHeight ?? size
  const line = Math.max(base, size * 1.2)
  const shift = (line - base) / 2
  return (
    // keyed on the unit: each flip between BSV and fiat fades in and rises
    // 8px (animate-in fade-in slide-in-from-bottom-2 duration-300)
    <Animated.View
      key={unit}
      style={[{ flexDirection: 'row', alignItems: 'flex-start', marginVertical: -shift }, enter({ translateY: 8, duration: 300 })]}
    >
      <Text style={[style, { lineHeight: line }]}>{whole}</Text>
      {/* mt-[0.14em] text-[0.5em] (its own line box 1.2× too) */}
      <Text style={[style, { fontSize: size * 0.5, lineHeight: size * 0.6, marginTop: size * 0.14 + shift - size * 0.05, letterSpacing: 0 }]}>
        {cents}
      </Text>
      {!!after && <Text style={[style, { lineHeight: line }]}>{after}</Text>}
      {shownAs(unit) === 'bsv' && (
        <View style={{ marginLeft: size * 0.18, marginTop: size * 0.2 + shift }}>
          <BsvMark size={size * 0.72} />
        </View>
      )}
    </Animated.View>
  )
}
