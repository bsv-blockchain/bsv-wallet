// The prototype's input focus (components/ui/input.tsx): `focus-visible:
// border-ring ring-3 ring-ring/50`, over a 150ms colour transition. Spread
// onto an Animated.View around the field; pass the hook's handlers to the
// TextInput.
import { useState } from 'react'
import type { Palette } from '../theme/tokens'

export function useFocusRing(palette: Palette, rest = `0 0 0 1px ${palette.input}`) {
  const [focused, setFocused] = useState(false)
  return {
    focused,
    handlers: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
    style: {
      boxShadow: focused ? `0 0 0 1px ${palette.ring}, 0 0 0 4px ${palette.ring}80` : rest,
      transitionProperty: 'boxShadow' as const,
      transitionDuration: 150
    }
  }
}
