// react-native-svg is deliberately NOT mocked here: its CJS build renders real
// host nodes (RNSVGSvgView, RNSVGPath, ...) under jest-expo, and the whole
// point of these tests is that sigil-js's xml survives SvgXml's parser.
import React from 'react'
import { render } from '@testing-library/react-native'
import Sigil from '../../ui/components/ui/Sigil'

type HostNode = {
  type: string
  props: Record<string, unknown>
  children: HostNode[] | null
}

function collectTypes(node: HostNode | null, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out
  out.push(node.type)
  for (const child of node.children ?? []) collectTypes(child as HostNode, out)
  return out
}

describe('Sigil', () => {
  it('renders a real svg tree for a valid planet name', () => {
    const { toJSON } = render(
      <Sigil point="~sampel-palnet" size={38} foreground="#000" background="#fff" />
    )
    const root = toJSON() as HostNode
    expect(root).not.toBeNull()
    const types = collectTypes(root)
    expect(types).toContain('RNSVGSvgView')
    expect(types.some((t) => t === 'RNSVGPath' || t === 'RNSVGCircle')).toBe(true)
  })

  it('renders null without throwing for an invalid point', () => {
    let tree: unknown = 'unset'
    expect(() => {
      const { toJSON } = render(
        <Sigil point="~notaname-xx" size={38} foreground="#000" background="#fff" />
      )
      tree = toJSON()
    }).not.toThrow()
    expect(tree).toBeNull()
  })

  it('strips the display:block inline style sigil-js emits on the root svg', () => {
    const { toJSON } = render(
      <Sigil point="~sampel-palnet" size={38} foreground="#000" background="#fff" />
    )
    const root = toJSON() as HostNode
    expect(root.type).toBe('RNSVGSvgView')
    // SvgXml spreads its own props (xml included) onto the root Svg, and Svg
    // forwards everything it does not consume to the host node, so the exact
    // string handed to SvgXml is readable here without spying on the module.
    const xml = root.props.xml
    expect(typeof xml).toBe('string')
    expect(xml).toContain('<svg')
    expect(xml).not.toContain('display: block')
    expect(xml).not.toContain('display:block')
    // The caller-supplied size wins over the xml's own width/height.
    expect(root.props.width).toBe(38)
    expect(root.props.height).toBe(38)
    // sigil-js writes `viewbox` in lower case, which the parser does not map
    // onto the prop, so Sigil restates it; without it nothing scales. Svg
    // consumes the prop and hands the host node the parsed box instead.
    expect(root.props).toMatchObject({ minX: 0, minY: 0, vbWidth: 38, vbHeight: 38 })
  })

  it('draws the simplified glyphs unless asked for detail', () => {
    const xmlOf = (el: React.ReactElement) => (render(el).toJSON() as HostNode).props.xml as string
    const implicit = xmlOf(<Sigil point="~sampel-palnet" size={38} foreground="#000" background="#fff" />)
    const none = xmlOf(<Sigil point="~sampel-palnet" size={38} foreground="#000" background="#fff" detail="none" />)
    const detailed = xmlOf(
      <Sigil point="~sampel-palnet" size={38} foreground="#000" background="#fff" detail="default" />
    )
    // The default is the icon form: at avatar size the inner detail lines
    // turn into noise.
    expect(implicit).toBe(none)
    expect(detailed).not.toBe(none)
    expect(detailed).toContain('<svg')
    expect(detailed.length).toBeGreaterThan(none.length)
  })

  it('redraws when only the detail level changes', () => {
    const r = render(<Sigil point="~sampel-palnet" size={38} foreground="#000" background="#fff" detail="none" />)
    const before = (r.toJSON() as HostNode).props.xml
    r.rerender(<Sigil point="~sampel-palnet" size={38} foreground="#000" background="#fff" detail="default" />)
    expect((r.toJSON() as HostNode).props.xml).not.toBe(before)
  })

  it('renders a two-syllable star name as well as a planet', () => {
    const { toJSON } = render(<Sigil point="~marzod" size={38} foreground="#000" background="#fff" />)
    const root = toJSON() as HostNode
    expect(root).not.toBeNull()
    expect(collectTypes(root)).toContain('RNSVGSvgView')
  })
})
