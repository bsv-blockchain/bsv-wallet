/**
 * Colour for a counterparty's sigil tile. Every sigil used to be drawn in the
 * text colour on a neutral tile, and at 38pt the shapes alone are too alike
 * to tell one row from the next. A hue per counterparty gives each face its
 * own tint, so the eye can pick out "the blue one" before it reads the glyph.
 *
 * The hue is whatever the caller derives (see counterpartyHue); this module
 * only turns it into a pair of solids that stay readable at every hue in
 * both themes. Saturation and lightness are fixed per theme rather than
 * varied with the hue, so the tiles read as one family and not as a random
 * scatter of swatches down the list.
 */

export type SigilPalette = {
  /** Symbol colour, six-digit lower-case hex. */
  foreground: string
  /**
   * Tile colour, six-digit lower-case hex. Solid on purpose: sigil-js draws
   * the cut-lines inside each glyph in this colour, so alpha would leave gaps.
   */
  background: string
}

type Tone = { s: number; l: number }

/**
 * Per-theme saturation and lightness, in percent. Light theme: a pale tint
 * under a deep symbol. Dark theme: a deep tint under a bright symbol.
 *
 * The lightness values are pinned by the WCAG floor of 4.5:1 across all 360
 * hues, which the palette test enforces. The weak spots are the hues whose
 * luminance moves furthest for a given lightness: yellow (hue 60) is the
 * brightest thing a light-theme symbol can be, so the foreground sits at 28%
 * rather than 30% to keep 4.75:1 there; blue (hue 240) is the darkest thing a
 * dark-theme symbol can be and clears 5.8:1 at 78%.
 */
const LIGHT: { background: Tone; foreground: Tone } = {
  background: { s: 45, l: 92 },
  foreground: { s: 55, l: 28 }
}
const DARK: { background: Tone; foreground: Tone } = {
  background: { s: 35, l: 24 },
  foreground: { s: 65, l: 78 }
}

/** Standard HSL to sRGB (CSS Color 3, section 4.2.4), then to `#rrggbb`. */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const sector = hue / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (sector < 1) [r, g, b] = [chroma, x, 0]
  else if (sector < 2) [r, g, b] = [x, chroma, 0]
  else if (sector < 3) [r, g, b] = [0, chroma, x]
  else if (sector < 4) [r, g, b] = [0, x, chroma]
  else if (sector < 5) [r, g, b] = [x, 0, chroma]
  else [r, g, b] = [chroma, 0, x]
  const m = l - chroma / 2
  const channel = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return '#' + channel(r) + channel(g) + channel(b)
}

/**
 * The symbol and tile colours for a hue in degrees. Any finite number is
 * accepted and wrapped onto [0, 360), so -30 and 330 are the same tint; a
 * non-finite hue (a NaN from a bad upstream parse) falls back to 0 rather than
 * producing `#NaNNaNNaN` and a transparent tile.
 */
export function sigilPalette(hue: number, isDark: boolean): SigilPalette {
  const h = Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : 0
  const tone = isDark ? DARK : LIGHT
  return {
    foreground: hslToHex(h, tone.foreground.s, tone.foreground.l),
    background: hslToHex(h, tone.background.s, tone.background.l)
  }
}
