import React from 'react'
import { StyleSheet } from 'react-native'
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

const sizeOf = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as never).fontSize as number

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

  it('grows back to full size when a shorter value arrives', () => {
    const { text, report } = setup(300, [600])
    expect(sizeOf(text)).toBeLessThan(44)
    report([100]) // natural width at the reduced size is now small
    expect(sizeOf(text)).toBe(44)
  })
})
