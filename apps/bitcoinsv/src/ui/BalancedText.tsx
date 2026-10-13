// Centred body copy, balanced (CSS's text-wrap: balance, as the prototype's
// centred copy has): its lines about the same length, never a long line over
// a lonely last word.
//
// Android: its own balanced line breaking (textBreakStrategy). Shrink-wrapping
// centred text in a custom font there clips the last word, so the text keeps
// its full width.
//
// iOS has no such strategy, so an unseen copy of the text finds the narrowest
// width that keeps it as many lines as at full width (a binary search on its
// height), and the text takes that width, centred in the room it had: the
// words spread evenly over the same lines. (onTextLayout, which would give
// the lines directly, doesn't fire on the new architecture here.)
import React, { useLayoutEffect, useState } from 'react'
import { Platform, Text, View, type TextProps } from 'react-native'

/** Close enough: the search stops when the width is known to within this. */
const PRECISION = 3

function plain(children: React.ReactNode): string {
  if (children == null || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(plain).join('')
  if (React.isValidElement<{ children?: React.ReactNode }>(children)) return plain(children.props.children)
  return ''
}

export function BalancedText({ style, children, onTextLayout, ...rest }: TextProps) {
  if (Platform.OS !== 'ios') {
    return (
      <Text textBreakStrategy="balanced" style={style} onTextLayout={onTextLayout} {...rest}>
        {children}
      </Text>
    )
  }
  return (
    <IosBalanced style={style} onTextLayout={onTextLayout} {...rest}>
      {children}
    </IosBalanced>
  )
}

function IosBalanced({ style, children, ...rest }: TextProps) {
  const text = plain(children)
  const [room, setRoom] = useState(0)
  // the search: the full-width height, and the range the answer lies in
  const [search, setSearch] = useState<{ height: number; lo: number; hi: number; probe: number } | null>(null)
  const [width, setWidth] = useState<number | null>(null)

  // new words or new room: search again
  useLayoutEffect(() => {
    setSearch(null)
    setWidth(null)
  }, [text, room])

  // the unseen copy laid out at the probe width: its height says whether it's still as few lines
  const probed = (height: number) => {
    if (!room) return
    if (!search) {
      // the full width first, then halfway down
      setSearch({ height, lo: Math.floor(room / 2), hi: room, probe: Math.floor(room * 0.75) })
      return
    }
    const fits = height <= search.height + 0.5
    const lo = fits ? search.lo : search.probe
    const hi = fits ? search.probe : search.hi
    if (hi - lo <= PRECISION) {
      setWidth(hi < room - 1 ? hi : null)
      setSearch({ ...search, lo, hi, probe: -1 })
      return
    }
    setSearch({ ...search, lo, hi, probe: Math.floor((lo + hi) / 2) })
  }
  const probe = !room ? 0 : !search ? room : search.probe

  return (
    <View style={{ alignSelf: 'stretch', alignItems: 'center' }} onLayout={e => setRoom(Math.floor(e.nativeEvent.layout.width))}>
      <Text {...rest} style={[style, width ? { width, maxWidth: width, alignSelf: 'center' } : null]}>
        {children}
      </Text>
      {/* holds the room open at the text's own full width: in a parent that
          shrink-wraps its content (alignItems: 'center'), the room would
          otherwise follow the balanced width, and every narrowing would start
          the search again, the text forever re-wrapping */}
      <Text
        {...rest}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[style, { height: 0, opacity: 0, overflow: 'hidden', marginVertical: 0, paddingVertical: 0 }]}
      >
        {children}
      </Text>
      {room > 0 && probe > 0 && (
        <Text
          {...rest}
          key={probe}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={[style, { position: 'absolute', left: 0, top: 0, opacity: 0, width: probe, maxWidth: probe, margin: 0, alignSelf: 'auto' }]}
          onLayout={e => probed(e.nativeEvent.layout.height)}
        >
          {children}
        </Text>
      )}
    </View>
  )
}
