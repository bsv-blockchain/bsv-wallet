/**
 * The two adapters over the wallet's `key_value_store`: the Mandala lib's
 * `MandalaStorage` and the color module's `ColorModuleStore` (IC §2.1).
 * Run against real SQLite so `LIKE`'s wildcard and case rules are the
 * engine's, not a mock's.
 */
import type { DatabaseSync } from 'node:sqlite'
import { createColorModuleStore, createMandalaKvStorage, type WalletKv } from '../../core/mandala/kvStore'
import { openTestDb } from '../__helpers__/nodeSqlite'

let raw: DatabaseSync
let kv: WalletKv

beforeEach(async () => {
  ;({ raw, kv } = await openTestDb())
})

afterEach(() => raw.close())

describe('createColorModuleStore', () => {
  it('round-trips module keys and lists by literal prefix', async () => {
    const s = createColorModuleStore(kv)
    await s.set('color.v1.a_b', '1')
    await s.set('color.v1.aXb', '2')
    await s.set('other', '3')
    expect(await s.get('color.v1.a_b')).toBe('1')
    expect(await s.get('missing')).toBeUndefined()
    expect((await s.keys('color.v1.a_')).sort()).toEqual(['color.v1.a_b']) // '_' is not a wildcard
    await s.delete('color.v1.a_b')
    expect(await s.get('color.v1.a_b')).toBeUndefined()
  })

  it('treats % and \\ in a prefix literally', async () => {
    const s = createColorModuleStore(kv)
    await s.set('color.v1.50%x', '1')
    await s.set('color.v1.50zx', '2')
    await s.set('color.v1.a\\b', '3')
    await s.set('color.v1.aXb', '4')
    expect(await s.keys('color.v1.50%')).toEqual(['color.v1.50%x'])
    expect(await s.keys('color.v1.a\\')).toEqual(['color.v1.a\\b'])
  })

  it('matches a prefix case-sensitively (SQLite LIKE alone does not)', async () => {
    const s = createColorModuleStore(kv)
    await s.set(`color.v1.tx.${'ab'.repeat(32)}`, '1')
    await s.set(`COLOR.V1.TX.${'AB'.repeat(32)}`, '2')
    expect(await s.keys('color.v1.tx.')).toEqual([`color.v1.tx.${'ab'.repeat(32)}`])
  })

  it('overwrites on set and treats deleting an absent key as a no-op', async () => {
    const s = createColorModuleStore(kv)
    await s.set('color.v1.k', 'old')
    await s.set('color.v1.k', 'new')
    expect(await s.get('color.v1.k')).toBe('new')
    await s.delete('color.v1.absent')
    expect(await s.keys('color.v1.')).toEqual(['color.v1.k'])
  })

  it('fails loudly when the database is closed', async () => {
    const s = createColorModuleStore({ getKeyValue: async () => undefined, setKeyValue: async () => {} })
    await expect(s.keys('color.v1.')).rejects.toThrow(/not open/)
    await expect(s.delete('k')).rejects.toThrow(/not open/)
  })
})

describe('createMandalaKvStorage', () => {
  it('keeps createMandalaKvStorage semantics (null for absent)', async () => {
    expect(await createMandalaKvStorage(kv).getItem('nope')).toBeNull()
  })

  it('round-trips, removes and lists by literal, case-sensitive prefix', async () => {
    const m = createMandalaKvStorage(kv)
    await m.setItem('mandala.j_1', 'a')
    await m.setItem('mandala.jX1', 'b')
    await m.setItem('MANDALA.J_2', 'c')
    expect(await m.getItem('mandala.j_1')).toBe('a')
    expect(await m.keys('mandala.j_')).toEqual(['mandala.j_1'])
    await m.removeItem('mandala.j_1')
    expect(await m.getItem('mandala.j_1')).toBeNull()
  })

  it('fails loudly when the database is closed', async () => {
    const m = createMandalaKvStorage({ getKeyValue: async () => undefined, setKeyValue: async () => {} })
    await expect(m.keys('x')).rejects.toThrow(/not open/)
    await expect(m.removeItem('x')).rejects.toThrow(/not open/)
  })
})
