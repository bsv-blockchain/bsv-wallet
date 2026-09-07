/**
 * Urbit sigil: a deterministic glyph for an @p name such as `~sampel-palnet`.
 * The wallet uses it as the avatar for a counterparty it has no name or
 * picture for, so two payments to the same key are recognisably the same
 * person at a glance without showing them a hex string.
 */
import React, { useMemo } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { SvgXml } from 'react-native-svg'
// Only ever the `core` entry. The package root pulls in a DOM React renderer
// that touches `document` at import time, which does not exist on a device.
import sigil from '@urbit/sigil-js/core'

interface SigilProps {
  /** A canonical @p, `~`-prefixed. */
  point: string
  /** Rendered edge in dp; the sigil is always square. */
  size: number
  /** Symbol colour. */
  foreground: string
  /**
   * Tile colour. Must be a solid: sigil-js draws the cut-lines inside each
   * glyph in this colour, so alpha would leave gaps in the shapes.
   */
  background: string
  /**
   * sigil-js's own detail switch. `none` (the default) is the icon form: the
   * inner lines that `default` adds are illegible at avatar size and just
   * make every glyph look equally busy.
   */
  detail?: 'none' | 'default'
  style?: StyleProp<ViewStyle>
}

// sigil-js emits this on the root <svg> for the browser, where an inline svg
// is otherwise `inline` and picks up line-height slop. Fabric has no such
// value and logs an error for it on every render, so it is cut before parsing.
const DOM_ONLY_STYLE = ' style="display: block;"'

export default function Sigil({
  point,
  size,
  foreground,
  background,
  detail = 'none',
  style
}: SigilProps): React.JSX.Element | null {
  const xml = useMemo(() => {
    try {
      return sigil({ point, size, foreground, background, detail, space: 'default' }).replace(DOM_ONLY_STYLE, '')
    } catch {
      // A malformed @p (unknown syllable, odd length) throws inside sigil-js.
      // One bad label must not take a whole activity list down with it.
      return null
    }
  }, [point, size, foreground, background, detail])

  if (xml === null) return null
  // sigil-js writes `viewbox` in lower case, which the xml parser does not map
  // onto the `viewBox` prop, so the box is restated here or nothing scales.
  return <SvgXml xml={xml} width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={style} />
}
