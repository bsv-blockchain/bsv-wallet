import { webcrypto } from 'crypto'
import { checkHandle, cleanHandleInput, formatPrice, priceFor, suggestFor } from '../src/handles/rules'
import { generateHandle, generatedName, isGeneratedPattern } from '../src/handles/generator'

beforeAll(() => {
  if (!globalThis.crypto?.getRandomValues) (globalThis as { crypto: unknown }).crypto = webcrypto
})

describe('generated handles', () => {
  test('are <adjective><animal><2 digits>, recognised as generated, never repeating a taken one', () => {
    for (let i = 0; i < 50; i++) {
      const g = generateHandle()
      expect(g.handle).toMatch(/^[a-z]+\d{2}$/)
      expect(g.handle.startsWith(g.adjective + g.animal)).toBe(true)
      expect(isGeneratedPattern(g.handle)).toBe(true)
      expect(generateHandle([g.handle]).handle).not.toBe(g.handle)
    }
  })
  test('display name', () => {
    expect(generatedName({ handle: 'sneakyotter07', adjective: 'sneaky', animal: 'otter' })).toBe('Sneaky Otter')
  })
})

describe('handle rules (decision 7)', () => {
  const generated = 'sneakyotter07'
  test('the generated handle is free', () => {
    expect(checkHandle(generated, { generated })).toEqual({ ok: true, kind: 'generated' })
  })
  test('1–32 characters in the registry set, paid by length', () => {
    expect(checkHandle('v', { generated })).toMatchObject({ ok: true, kind: 'custom', monthly: 36.9 })
    expect(checkHandle('vi.n-c_e', { generated })).toMatchObject({ ok: true, kind: 'custom' })
    expect(checkHandle('a'.repeat(32), { generated })).toMatchObject({ ok: true })
    expect(checkHandle('a'.repeat(33), { generated })).toMatchObject({ ok: false })
  })
  test('refuses what the registry would', () => {
    // a name shaped like a free handle can't be bought
    const lookalike = generateHandle().handle
    for (const bad of ['.vince', 'vince-', '123', 'admin', lookalike]) expect(checkHandle(bad, { generated }).ok).toBe(false)
  })
  test('pricing and its display', () => {
    expect(priceFor('abcdefghij')).toEqual({ monthly: 0.218, yearly: 2.18 })
    expect(formatPrice(0.218)).toBe('$0.218')
    expect(formatPrice(36.9)).toBe('$36.90')
  })
  test('input keeps only handle characters, lower-cased', () => {
    expect(cleanHandleInput('Vince Media!')).toBe('vincemedia')
  })
  test('a taken handle suggests the<h>, then <h>hq, then real<h>, only ones this device accepts', () => {
    expect(suggestFor('vince', { generated: 'sneakyotter07' })).toBe('thevince')
    // past 32 characters: the next one that fits, or none
    expect(suggestFor('a'.repeat(30), { generated: 'sneakyotter07' })).toBe('a'.repeat(30) + 'hq')
    expect(suggestFor('a'.repeat(31), { generated: 'sneakyotter07' })).toBeUndefined()
  })
})
