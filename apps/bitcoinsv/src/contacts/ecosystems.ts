// The wallets a handle can belong to (the prototype's lib/data/ecosystems.ts).
// A handle is unique only within its wallet, so "@rosa@handcash" and
// "@rosa@twetch" are two people. `alias` is the short form a handle is shown
// with; `domain` is the one that answers for it. Their logos are in
// src/ui/Handle.tsx. A domain not listed here is written as itself.
export interface Ecosystem {
  id: string
  name: string
  alias: string
  domain: string
  /** the logo is a bare white glyph and needs this plate behind it */
  plate?: string
  /** the logo is a bare dark glyph: on the dark theme it needs this plate */
  darkPlate?: string
}

export const ECOSYSTEMS: Ecosystem[] = [
  { id: 'handcash', name: 'HandCash', alias: 'handcash', domain: 'handcash.io' },
  { id: 'treechat', name: 'Treechat', alias: 'treechat', domain: 'treechat.app' },
  { id: 'twetch', name: 'Twetch', alias: 'twetch', domain: 'twetch.com', plate: '#0f1021' },
  { id: 'commonsource', name: 'Common Source', alias: 'commonsource', domain: 'commonsource.nl', darkPlate: '#f4f3f0' },
  { id: 'mycelia', name: 'Mycelia', alias: 'mycelia', domain: 'mycelia.network' }
]

const BY_DOMAIN = new Map(ECOSYSTEMS.map(e => [e.domain, e]))

/** The wallet a domain belongs to, if it's one we know. */
export const ecosystemOf = (domain: string | null | undefined): Ecosystem | undefined => (domain ? BY_DOMAIN.get(domain.toLowerCase()) : undefined)
