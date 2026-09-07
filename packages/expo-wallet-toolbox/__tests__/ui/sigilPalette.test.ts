import { sigilPalette, type SigilPalette } from '../../core/theme/sigilPalette'

const HEX6 = /^#[0-9a-f]{6}$/

/**
 * WCAG 2.x relative luminance and contrast ratio, written out here rather than
 * imported so the palette cannot pass by agreeing with its own arithmetic.
 */
function channel(hex2: string): number {
  const c = Number.parseInt(hex2, 16) / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function luminance(hex: string): number {
  expect(hex).toMatch(HEX6)
  return 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7))
}
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** WCAG AA for body text: the sigil's strokes are thinner than any text. */
const MIN_CONTRAST = 4.5

describe('sigilPalette', () => {
  it('returns solid six-digit lower-case hex for both colours', () => {
    for (const isDark of [false, true]) {
      for (const hue of [0, 37, 120, 199, 240, 300, 359]) {
        const p: SigilPalette = sigilPalette(hue, isDark)
        expect(p.foreground).toMatch(HEX6)
        expect(p.background).toMatch(HEX6)
        expect(p.foreground).not.toBe(p.background)
      }
    }
  })

  it('is deterministic', () => {
    expect(sigilPalette(210, false)).toEqual(sigilPalette(210, false))
    expect(sigilPalette(210, true)).toEqual(sigilPalette(210, true))
  })

  it('gives different hues different tiles', () => {
    const tints = [0, 60, 120, 180, 240, 300].map(h => sigilPalette(h, false).background)
    expect(new Set(tints).size).toBe(tints.length)
  })

  it('differs between the light and dark theme', () => {
    expect(sigilPalette(210, false)).not.toEqual(sigilPalette(210, true))
    // Light: pale tile, deep symbol. Dark: deep tile, bright symbol.
    const light = sigilPalette(210, false)
    expect(luminance(light.background)).toBeGreaterThan(luminance(light.foreground))
    const dark = sigilPalette(210, true)
    expect(luminance(dark.background)).toBeLessThan(luminance(dark.foreground))
  })

  it('normalises the hue onto [0, 360)', () => {
    expect(sigilPalette(-30, false)).toEqual(sigilPalette(330, false))
    expect(sigilPalette(720, true)).toEqual(sigilPalette(0, true))
    expect(sigilPalette(360, false)).toEqual(sigilPalette(0, false))
    expect(sigilPalette(-720, true)).toEqual(sigilPalette(0, true))
  })

  it('treats a non-finite hue as 0 rather than producing garbage', () => {
    expect(sigilPalette(Number.NaN, false)).toEqual(sigilPalette(0, false))
    expect(sigilPalette(Number.POSITIVE_INFINITY, true)).toEqual(sigilPalette(0, true))
    expect(sigilPalette(Number.NEGATIVE_INFINITY, false)).toEqual(sigilPalette(0, false))
  })

  it('keeps AA contrast between symbol and tile for every integer hue in both themes', () => {
    const failures: string[] = []
    for (const isDark of [false, true]) {
      for (let hue = 0; hue < 360; hue++) {
        const { foreground, background } = sigilPalette(hue, isDark)
        const ratio = contrast(foreground, background)
        if (ratio < MIN_CONTRAST) {
          failures.push(`${isDark ? 'dark' : 'light'} hue ${hue}: ${foreground} on ${background} = ${ratio.toFixed(2)}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})
