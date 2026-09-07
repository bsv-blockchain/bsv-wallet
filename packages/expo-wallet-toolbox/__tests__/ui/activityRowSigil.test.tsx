// Same harness as activityRowParked.test.tsx. react-native-svg is deliberately
// NOT mocked: its CJS build renders real host nodes (RNSVGSvgView, ...) under
// jest-expo, and that host type is how a drawn sigil is told apart from the
// arrow tile without reaching into Sigil's internals.
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', MaterialCommunityIcons: 'MaterialCommunityIcons' }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
// The theme flag the useTheme stub hands the row. Mutable so a test can mount
// a row in one theme and flip it under the mounted row, the way the real
// ThemeContext does when the OS appearance changes. (jest.mock factories are
// hoisted, so the binding must carry the `mock` prefix to be referenced.)
let mockDark = false
jest.mock('@bsv/expo-wallet-toolbox', () => {
  // The row resolves its counterparty through the core barrel, which this
  // mock replaces wholesale, so the real resolver is spliced back in. The
  // colours Proxy hands back token names; sigil-js interpolates them as-is.
  const counterparty = jest.requireActual('../../core/pay/counterparty')
  const palette = jest.requireActual('../../core/theme/sigilPalette')
  return {
    typography: { subhead: {}, footnote: {} },
    useTheme: () => ({ colors: new Proxy({}, { get: (_t, k) => String(k) }), isDark: mockDark }),
    useWallet: jest.fn(() => ({ settings: { currency: 'BSV' } })),
    haptics: { tap: jest.fn() },
    // useContext needs a real context object, not a stand-in.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ExchangeRateContext: require('react').createContext({ satoshisPerUSD: 5_000_000 }),
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 },
    radii: { sm: 6, md: 10, lg: 14, pill: 999 },
    formatAmount: () => '1,000 sats',
    formatAmountParts: jest.fn(() => ({ value: '-1,000', unit: 'sats' })),
    counterpartyOf: counterparty.counterpartyOf,
    counterpartyHue: counterparty.counterpartyHue,
    sigilPointOf: jest.fn(counterparty.sigilPointOf),
    sigilPalette: palette.sigilPalette
  }
})

import React from 'react'
import { StyleSheet } from 'react-native'
import { render } from '@testing-library/react-native'
import { sigilPointOf } from '@bsv/expo-wallet-toolbox'
import { SENTINEL_SENDER_KEY, counterpartyHue } from '../../core/pay/counterparty'
import { sigilPalette } from '../../core/theme/sigilPalette'
import ActivityRow, { type ActivityAction } from '../../ui/components/wallet/ActivityRow'

const TXID = 'aa'.repeat(32)
const PAYEE_KEY = '02' + 'ab'.repeat(32)
const SENDER_A = '02' + '11'.repeat(32)
const SENDER_B = '03' + '22'.repeat(32)

type HostNode = {
  type: string
  props: Record<string, unknown>
  children: HostNode[] | null
}
type Tree = HostNode | HostNode[] | null

function collectTypes(node: Tree, out: string[] = []): string[] {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out)
    return out
  }
  out.push(node.type)
  for (const child of node.children ?? []) collectTypes(child, out)
  return out
}

/** The host node of the given type, or null. */
function findNode(node: Tree, type: string): HostNode | null {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findNode(n, type)
      if (hit) return hit
    }
    return null
  }
  if (node.type === type) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, type)
    if (hit) return hit
  }
  return null
}

/** The host node whose direct children include one of the given type. */
function findParentOf(node: Tree, type: string): HostNode | null {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findParentOf(n, type)
      if (hit) return hit
    }
    return null
  }
  if ((node.children ?? []).some(c => c && typeof c === 'object' && c.type === type)) return node
  for (const child of node.children ?? []) {
    const hit = findParentOf(child, type)
    if (hit) return hit
  }
  return null
}

/** The exact xml string handed to SvgXml: Svg forwards it to the host node. */
function svgXml(tree: Tree): string {
  const svg = findNode(tree, 'RNSVGSvgView')
  expect(svg).not.toBeNull()
  const xml = svg!.props.xml
  expect(typeof xml).toBe('string')
  return xml as string
}

const action = (over: Partial<ActivityAction> = {}): ActivityAction =>
  ({
    txid: TXID,
    satoshis: -1000,
    status: 'completed',
    isOutgoing: true,
    description: 'Payment',
    labels: ['peerpay'],
    reference: 'ref-1',
    created_at: '2026-09-01T10:00:00.000Z',
    ...over
  }) as ActivityAction

function draw(over: Partial<ActivityAction> = {}) {
  const noop = () => {}
  return render(
    <ActivityRow action={action(over)} currency="BSV" rowKey="k" expanded={false} busy={false}
      onToggle={noop} onExplorer={noop} onRefreshTx={noop} onAbort={noop} />
  )
}

// react-native-svg warns once per fill it cannot parse, and the colours Proxy
// hands it token names on purpose so the tile tint can be asserted by name.
// That is the harness, not the row, so only that exact message is dropped.
const realWarn = console.warn
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].endsWith('is not a valid color or brush')) return
    realWarn(...args)
  })
})
afterAll(() => {
  jest.restoreAllMocks()
})

beforeEach(() => {
  jest.mocked(sigilPointOf).mockClear()
  mockDark = false
})

it('draws the payee sigil on an outbound peer payment instead of the arrow', () => {
  const tree = draw({ labels: ['peerpay', PAYEE_KEY] }).toJSON() as Tree
  const types = collectTypes(tree)
  expect(types).toContain('RNSVGSvgView')
  expect(types).not.toContain('MaterialCommunityIcons')
  expect(sigilPointOf).toHaveBeenCalledWith({ kind: 'identityKey', value: PAYEE_KEY })
})

it('gives inbound peer payments from different senders different faces', () => {
  const inbound = (senderIdentityKey: string) =>
    draw({ satoshis: 1000, isOutgoing: false, labels: ['peerpay'], senderIdentityKey }).toJSON() as Tree
  const xmlA = svgXml(inbound(SENDER_A))
  const xmlB = svgXml(inbound(SENDER_B))
  expect(xmlA).toContain('<svg')
  expect(xmlB).toContain('<svg')
  expect(xmlA).not.toBe(xmlB)
  expect(sigilPointOf).toHaveBeenCalledWith({ kind: 'identityKey', value: SENDER_A })
  expect(sigilPointOf).toHaveBeenCalledWith({ kind: 'identityKey', value: SENDER_B })
})

it('does not re-derive the point when a poll hands the row an equal but fresh action', () => {
  // listActions builds a new action object and a new labels array per row on
  // every poll, so the memo must key on the label contents, not the array.
  const noop = () => {}
  const props = { currency: 'BSV' as const, rowKey: 'k', expanded: false, busy: false,
    onToggle: noop, onExplorer: noop, onRefreshTx: noop, onAbort: noop }
  const r = render(<ActivityRow {...props} action={action({ labels: ['peerpay', PAYEE_KEY] })} />)
  expect(sigilPointOf).toHaveBeenCalledTimes(1)
  r.rerender(<ActivityRow {...props} action={action({ labels: ['peerpay', PAYEE_KEY] })} />)
  expect(sigilPointOf).toHaveBeenCalledTimes(1)
  // A genuinely different counterparty still gets a new face.
  r.rerender(<ActivityRow {...props} action={action({ labels: ['peerpay', SENDER_A] })} />)
  expect(sigilPointOf).toHaveBeenCalledTimes(2)
})

it('falls back to the direction arrow when nothing identifies the other side', () => {
  const tree = draw({ txid: '', labels: [], senderIdentityKey: undefined }).toJSON() as Tree
  const types = collectTypes(tree)
  expect(types).toContain('MaterialCommunityIcons')
  expect(types).not.toContain('RNSVGSvgView')
  expect(sigilPointOf).not.toHaveBeenCalled()
})

it('ignores the address-sweep sentinel sender and keys the face off the txid', () => {
  // The sweep has no real sender, so it writes PrivateKey(1)'s pubkey. Every
  // swept payment would otherwise wear the same face.
  const tree = draw({
    satoshis: 1000,
    isOutgoing: false,
    labels: [],
    senderIdentityKey: SENTINEL_SENDER_KEY
  }).toJSON() as Tree
  expect(collectTypes(tree)).toContain('RNSVGSvgView')
  expect(sigilPointOf).toHaveBeenCalledWith({ kind: 'txid', value: TXID })
})

it('keeps the direction tint on the tile edge around the sigil', () => {
  const tile = (over: Partial<ActivityAction>) => {
    const node = findParentOf(draw(over).toJSON() as Tree, 'RNSVGSvgView')
    expect(node).not.toBeNull()
    return StyleSheet.flatten(node!.props.style as never) as Record<string, unknown>
  }
  const incoming = tile({ satoshis: 1000, isOutgoing: false, senderIdentityKey: SENDER_A })
  // The Proxy returns token names, so successStrong + '2E' reads back verbatim.
  expect(incoming.borderColor).toBe('successStrong2E')
  expect(incoming.overflow).toBe('hidden')
  const outgoing = tile({ labels: ['peerpay', PAYEE_KEY] })
  expect(outgoing.borderColor).toBe('surfaceSunkenBorder')
})

/** Every host node of the given type, in document order. */
function findAll(node: Tree, type: string, out: HostNode[] = []): HostNode[] {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  for (const child of node.children ?? []) findAll(child, type, out)
  return out
}

/** react-native-svg stores a processed colour as { type: 0, payload: 0xAARRGGBB }. */
function fillPayload(node: HostNode | undefined): number {
  expect(node).toBeDefined()
  const fill = node!.props.fill as { type: number; payload: number }
  expect(fill).toEqual({ type: 0, payload: expect.any(Number) })
  return fill.payload
}
const argb = (hex: string) => (0xff000000 + Number.parseInt(hex.slice(1), 16)) >>> 0

it('tints the tile per counterparty, so two senders get two colours', () => {
  const inbound = (senderIdentityKey: string) =>
    draw({ satoshis: 1000, isOutgoing: false, labels: ['peerpay'], senderIdentityKey }).toJSON() as Tree
  const tileOf = (tree: Tree) => {
    const node = findParentOf(tree, 'RNSVGSvgView')
    expect(node).not.toBeNull()
    return StyleSheet.flatten(node!.props.style as never) as Record<string, unknown>
  }
  const a = tileOf(inbound(SENDER_A))
  const b = tileOf(inbound(SENDER_B))
  expect(a.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
  expect(b.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
  expect(a.backgroundColor).not.toBe(b.backgroundColor)
  // The useTheme stub reports the light theme unless a test flips it.
  expect(a.backgroundColor).toBe(sigilPalette(counterpartyHue({ kind: 'identityKey', value: SENDER_A }), false).background)
  expect(b.backgroundColor).toBe(sigilPalette(counterpartyHue({ kind: 'identityKey', value: SENDER_B }), false).background)
})

it('paints the tile and the sigil from the dark palette on a dark theme', () => {
  // A light tile (L ~92%) on a dark row surface is the one mismatch the
  // two-tone palette exists to prevent, so the theme flag has to reach
  // sigilPalette, not be defaulted away.
  mockDark = true
  const tree = draw({ satoshis: 1000, isOutgoing: false, labels: ['peerpay'], senderIdentityKey: SENDER_A }).toJSON() as Tree
  const hue = counterpartyHue({ kind: 'identityKey', value: SENDER_A })
  const dark = sigilPalette(hue, true)
  const light = sigilPalette(hue, false)
  expect(dark.background).not.toBe(light.background)
  const tile = findParentOf(tree, 'RNSVGSvgView')
  expect(tile).not.toBeNull()
  const style = StyleSheet.flatten(tile!.props.style as never) as Record<string, unknown>
  expect(style.backgroundColor).toBe(dark.background)
  expect(fillPayload(findAll(tree, 'RNSVGRect')[0])).toBe(argb(dark.background))
  expect(fillPayload(findAll(tree, 'RNSVGPath')[0] ?? findAll(tree, 'RNSVGCircle')[0])).toBe(argb(dark.foreground))
})

it('recolours a mounted row when the theme flips without re-deriving the point', () => {
  // The palette is resolved outside the point memo on purpose: the hue is a
  // property of the counterparty, the colours are a property of the theme,
  // and the theme can change under a row that stays mounted. A poll hands
  // the row an equal but fresh action, which is what re-renders it here.
  const noop = () => {}
  const props = { currency: 'BSV' as const, rowKey: 'k', expanded: false, busy: false,
    onToggle: noop, onExplorer: noop, onRefreshTx: noop, onAbort: noop }
  const inbound = () => action({ satoshis: 1000, isOutgoing: false, labels: ['peerpay'], senderIdentityKey: SENDER_A })
  const tileColour = (tree: Tree) => {
    const tile = findParentOf(tree, 'RNSVGSvgView')
    expect(tile).not.toBeNull()
    return (StyleSheet.flatten(tile!.props.style as never) as Record<string, unknown>).backgroundColor
  }
  const hue = counterpartyHue({ kind: 'identityKey', value: SENDER_A })
  const r = render(<ActivityRow {...props} action={inbound()} />)
  expect(tileColour(r.toJSON() as Tree)).toBe(sigilPalette(hue, false).background)
  mockDark = true
  r.rerender(<ActivityRow {...props} action={inbound()} />)
  expect(tileColour(r.toJSON() as Tree)).toBe(sigilPalette(hue, true).background)
  expect(sigilPointOf).toHaveBeenCalledTimes(1)
})

it('hands the sigil the same palette as the tile', () => {
  const inbound = (senderIdentityKey: string) =>
    draw({ satoshis: 1000, isOutgoing: false, labels: ['peerpay'], senderIdentityKey }).toJSON() as Tree
  const treeA = inbound(SENDER_A)
  const treeB = inbound(SENDER_B)
  // sigil-js draws the tile rect first in the background colour, then the
  // glyph paths in the foreground colour.
  const rectA = fillPayload(findAll(treeA, 'RNSVGRect')[0])
  const rectB = fillPayload(findAll(treeB, 'RNSVGRect')[0])
  expect(rectA).not.toBe(rectB)
  // The detailed glyphs mix filled shapes with stroke-only paths (fill none),
  // so look at every fill the glyph uses rather than the first element.
  const glyphFills = (tree: Tree) =>
    new Set(
      [...findAll(tree, 'RNSVGPath'), ...findAll(tree, 'RNSVGCircle')]
        .map(n => (n.props.fill as { payload?: number } | null | undefined)?.payload)
        .filter((f): f is number => typeof f === 'number')
    )
  const paletteA = sigilPalette(counterpartyHue({ kind: 'identityKey', value: SENDER_A }), false)
  const paletteB = sigilPalette(counterpartyHue({ kind: 'identityKey', value: SENDER_B }), false)
  expect(rectA).toBe(argb(paletteA.background))
  expect(glyphFills(treeA)).toContain(argb(paletteA.foreground))
  expect(glyphFills(treeB)).toContain(argb(paletteB.foreground))
  expect(glyphFills(treeA)).not.toContain(argb(paletteB.foreground))
  // Nothing in the glyph is painted in a third colour.
  for (const f of glyphFills(treeA)) expect([argb(paletteA.foreground), argb(paletteA.background)]).toContain(f)
  // And the xml itself carries the hex, so the sigil is not painted in a
  // colour the tile does not share (sigil-js cuts its glyph lines in the
  // background colour, so a mismatch would show as a halo).
  expect(svgXml(treeA)).toContain(`fill="${paletteA.background}"`)
  expect(svgXml(treeA)).toContain(`fill='${paletteA.foreground}'`)
})

it('asks for the detailed form of the sigil', () => {
  const tree = draw({ labels: ['peerpay', PAYEE_KEY] }).toJSON() as Tree
  // The row draws the full Urbit glyph set, not the simplified icon table: on
  // a device the inner line-work is what tells two faces apart at 38pt.
  const palette = sigilPalette(counterpartyHue({ kind: 'identityKey', value: PAYEE_KEY }), false)
  const detailed = (
    jest.requireActual('@urbit/sigil-js/core').default({
      point: jest.mocked(sigilPointOf).mock.results[0].value as string,
      size: 38,
      foreground: palette.foreground,
      background: palette.background,
      detail: 'default',
      space: 'default'
    }) as string
  ).replace(' style="display: block;"', '')
  expect(svgXml(tree)).toBe(detailed)
})
