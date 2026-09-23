import React from 'react'
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import { fireEvent, render } from '@testing-library/react-native'

import { FitAmount } from '../ui/components/wallet/FitAmount'

const style = { fontSize: 44, lineHeight: 46, letterSpacing: -1.2 }

/** Lay the wrapper out at `width`, then report the text as `lines` widths. */
function setup(width: number, lines: number[]) {
  const utils = render(<FitAmount value="2,546,156.51684664" unit="BSV" style={style} unitStyle={{ fontSize: 19 }} />)
  const text = utils.getByText(/2,546,156/)
  fireEvent(text.parent!.parent!, 'layout', { nativeEvent: { layout: { width, height: 50, x: 0, y: 0 } } })
  const report = (widths: number[]) =>
    fireEvent(text, 'textLayout', { nativeEvent: { lines: widths.map(w => ({ width: w })) } })
  report(lines)
  return { ...utils, text, report }
}

const flat = (node: { props: { style?: unknown } }): TextStyle =>
  StyleSheet.flatten(node.props.style as StyleProp<TextStyle>) ?? {}

const sizeOf = (node: { props: { style?: unknown } }) => flat(node).fontSize as number

describe('FitAmount', () => {
  it('keeps full size when the figure already fits', () => {
    const { text } = setup(300, [200])
    expect(sizeOf(text)).toBe(44)
  })

  it('shrinks an overflowing figure (wrapped onto two lines) to fit one', () => {
    const { text } = setup(300, [300, 300]) // 600 wide at 44pt on a 300 wide slot
    expect(sizeOf(text)).toBeCloseTo(44 * (300 / 600) * 0.98, 1)
  })

  it('scales the unit and the letter spacing with it', () => {
    const { text, getByText } = setup(300, [600])
    const flat = StyleSheet.flatten(text.props.style)
    const scale = (flat.fontSize as number) / 44
    expect(flat.letterSpacing).toBeCloseTo(-1.2 * scale, 5)
    expect(sizeOf(getByText(/BSV/))).toBeCloseTo(19 * scale, 5)
  })

  it('never goes below the legibility floor', () => {
    const { text } = setup(300, [300000])
    expect(sizeOf(text)).toBe(12)
  })

  it('still fits when the text is measured before the slot width is known', () => {
    const { getByText } = render(<FitAmount value="2,546,156.51684664" unit="BSV" style={style} />)
    const text = getByText(/2,546,156/)
    // The order seen on device: onTextLayout first, the wrapper's onLayout after.
    fireEvent(text, 'textLayout', { nativeEvent: { lines: [{ width: 361 }, { width: 125 }] } })
    expect(sizeOf(text)).toBe(44)
    fireEvent(text.parent!.parent!, 'layout', { nativeEvent: { layout: { width: 354, height: 50, x: 0, y: 0 } } })
    expect(sizeOf(text)).toBeCloseTo(44 * (354 / 486) * 0.98, 1)
  })

  it('grows back to full size when a shorter value arrives', () => {
    const { text, report } = setup(300, [600])
    expect(sizeOf(text)).toBeLessThan(44)
    report([100]) // natural width at the reduced size is now small
    expect(sizeOf(text)).toBe(44)
  })

  describe('with raised minor units', () => {
    const fractionStyle = { fontSize: 24, lineHeight: 28, marginTop: 10 }
    const renderRaised = (value: string) =>
      render(<FitAmount value={value} unit="" style={style} fractionStyle={fractionStyle} />)
    /** The visible runs, not the hidden measuring copy (which has opacity 0). */
    const visible = (utils: ReturnType<typeof render>, text: string) =>
      utils.getAllByText(text).find(n => flat(n).opacity !== 0)!

    it('draws the cents as their own smaller run', () => {
      const utils = renderRaised('$1,234.56')
      expect(sizeOf(visible(utils, '$1,234.'))).toBe(44)
      expect(sizeOf(visible(utils, '56'))).toBe(24)
    })

    it('shrinks the cents with the figure but keeps their top margin', () => {
      const utils = renderRaised('$1,234.56')
      const measure = utils.UNSAFE_getAllByProps({ importantForAccessibility: 'no-hide-descendants' })[0]
      const slot = measure.parent!
      fireEvent(slot, 'layout', { nativeEvent: { layout: { width: 300, height: 50, x: 0, y: 0 } } })
      fireEvent(measure, 'textLayout', { nativeEvent: { lines: [{ width: 600 }] } })
      const scale = (300 / 600) * 0.98
      const cents = flat(visible(utils, '56'))
      expect(sizeOf(visible(utils, '$1,234.'))).toBeCloseTo(44 * scale, 1)
      expect(cents.fontSize).toBeCloseTo(24 * scale, 1)
      expect(cents.marginTop).toBe(10)
    })

    it('keeps a figure with nothing to raise as one run', () => {
      const utils = renderRaised('1.2M')
      expect(utils.getAllByText('1.2M')).toHaveLength(1)
    })
  })
})
