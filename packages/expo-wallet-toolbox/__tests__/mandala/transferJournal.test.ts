/**
 * `color_transfers`: the wallet's one durable record of a 1Color transfer, and
 * the only key the broadcast hold and the abort refusal read (plan 07, W1).
 * Run against real SQLite so the CAS, the INSERT OR IGNORE and the TEXT
 * amounts are the engine's behaviour, not a mock's.
 */
import type { DatabaseSync } from 'node:sqlite'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import {
  STUCK_AFTER_MS,
  TERMINAL_TRANSFER_STATES,
  type ColorTransferRow
} from '../../core/mandala/types'
import { openTestDb } from '../__helpers__/nodeSqlite'

const TXID = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const ASSET = `${'ef'.repeat(32)}_0`
const MAX_U64 = 18446744073709551615n

let raw: DatabaseSync
let j: TransferJournal
let clock: number

function row(over: Partial<Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>> = {}) {
  return {
    txid: TXID,
    role: 'sent' as const,
    assetId: ASSET,
    units: 1500n,
    outputIndex: 0,
    rail: 'handle' as const,
    state: 'built' as const,
    delivered: false,
    reference: 'ref1',
    ...over
  }
}

beforeEach(async () => {
  let db
  ;({ raw, db } = await openTestDb())
  clock = Date.parse('2026-10-22T00:00:00.000Z')
  j = createTransferJournal(db as JournalDb, () => new Date((clock += 1000)))
})

afterEach(() => raw.close())

describe('constants', () => {
  it('names the terminal states and the stuck threshold', () => {
    expect([...TERMINAL_TRANSFER_STATES].sort()).toEqual(['cancelled', 'refused', 'settled'])
    expect(STUCK_AFTER_MS).toBe(3 * 24 * 60 * 60 * 1000)
  })
})

describe('createTransferJournal', () => {
  it('stores and reads units 18446744073709551615 exactly', async () => {
    await j.insert(row({ units: MAX_U64 }))
    expect((await j.get(TXID))!.units).toBe(MAX_U64)
    // On disk it is a canonical decimal string, never a REAL.
    expect(raw.prepare('SELECT units, typeof(units) AS t FROM color_transfers').get()).toEqual({
      units: '18446744073709551615',
      t: 'text'
    })
  })

  it('round-trips every field and maps absent optionals to undefined', async () => {
    await j.insert(
      row({
        counterpartyKey: '02' + '11'.repeat(32),
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: 'c3VmZml4',
        senderIdentityKey: '03' + '22'.repeat(32),
        delivered: true,
        note: 'hello'
      })
    )
    const got = (await j.get(TXID))!
    expect(got).toEqual({
      ...row(),
      counterpartyKey: '02' + '11'.repeat(32),
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      senderIdentityKey: '03' + '22'.repeat(32),
      delivered: true,
      note: 'hello',
      createdAt: '2026-10-22T00:00:01.000Z',
      updatedAt: '2026-10-22T00:00:01.000Z'
    })
    await j.insert(row({ txid: OTHER, reference: undefined, role: 'received', rail: 'external', state: 'held' }))
    const bare = (await j.get(OTHER))!
    expect(bare.reference).toBeUndefined()
    expect(bare.counterpartyKey).toBeUndefined()
    expect(bare.code).toBeUndefined()
    expect(bare.delivered).toBe(false)
    expect(await j.get('99'.repeat(32))).toBeUndefined()
  })

  it('insert is idempotent and advance is a CAS', async () => {
    expect(await j.insert(row({ state: 'built' }))).toBe(true)
    expect(await j.insert(row({ state: 'settled' }))).toBe(false)
    expect((await j.get(TXID))!.state).toBe('built')
    expect(await j.advance(TXID, ['parked'], 'handed_over')).toBe(false)
    expect(await j.advance(TXID, ['built'], 'handed_over')).toBe(true)
    expect((await j.get(TXID))!.state).toBe('handed_over')
    // A second caller racing the same transition loses.
    expect(await j.advance(TXID, ['built'], 'handed_over')).toBe(false)
    expect(await j.advance(TXID, [], 'settled')).toBe(false)
    expect(await j.advance(OTHER, ['built'], 'settled')).toBe(false)
  })

  it('advance applies its patch in the same statement and bumps updatedAt', async () => {
    await j.insert(row())
    const before = (await j.get(TXID))!
    expect(await j.advance(TXID, ['built'], 'handed_over', { delivered: false })).toBe(true)
    expect(await j.advance(TXID, ['handed_over'], 'refused', { code: 'ERR_INPUT_SPENT', delivered: true })).toBe(true)
    const after = (await j.get(TXID))!
    expect(after.state).toBe('refused')
    expect(after.code).toBe('ERR_INPUT_SPENT')
    expect(after.delivered).toBe(true)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.updatedAt > before.updatedAt).toBe(true)
    // A refused CAS leaves the row untouched, patch included.
    expect(await j.advance(TXID, ['built'], 'settled', { code: 'X' })).toBe(false)
    expect((await j.get(TXID))!.code).toBe('ERR_INPUT_SPENT')
  })

  it('setDelivered flips only the delivered flag', async () => {
    await j.insert(row({ state: 'handed_over' }))
    await j.setDelivered(TXID, true)
    expect((await j.get(TXID))!).toMatchObject({ delivered: true, state: 'handed_over' })
    await j.setDelivered(TXID, false)
    expect((await j.get(TXID))!.delivered).toBe(false)
  })

  it('finds by reference and reports states for a batch', async () => {
    await j.insert(row())
    expect((await j.getByReference('ref1'))!.txid).toBe(TXID)
    expect(await j.getByReference('nope')).toBeUndefined()
    const states = await j.statesOf([TXID, 'ff'.repeat(32)])
    expect(states).toEqual(new Map([[TXID, 'built']]))
    expect(await j.statesOf([])).toEqual(new Map())
  })

  it('statesOf answers a batch larger than one statement can bind', async () => {
    const txids = Array.from({ length: 1200 }, (_, i) => i.toString(16).padStart(64, '0'))
    await j.insert(row({ txid: txids[1100], reference: undefined }))
    const states = await j.statesOf(txids)
    expect(states).toEqual(new Map([[txids[1100], 'built']]))
  })

  it('lists newest first with state, role and limit filters', async () => {
    await j.insert(row({ txid: TXID, state: 'built' }))
    await j.insert(row({ txid: OTHER, role: 'received', rail: 'nearby', state: 'held', reference: undefined }))
    const third = '12'.repeat(32)
    await j.insert(row({ txid: third, state: 'settled', reference: 'ref3' }))
    expect((await j.list()).map(r => r.txid)).toEqual([third, OTHER, TXID])
    expect((await j.list({ states: ['built', 'held'] })).map(r => r.txid)).toEqual([OTHER, TXID])
    expect((await j.list({ role: 'sent' })).map(r => r.txid)).toEqual([third, TXID])
    expect((await j.list({ limit: 1 })).map(r => r.txid)).toEqual([third])
    expect(await j.list({ states: [] })).toEqual([])
  })

  it('refuses a row it could not read back faithfully', async () => {
    await expect(j.insert(row({ units: -1n }))).rejects.toThrow(/units/)
    await expect(j.insert(row({ units: 1500 as unknown as bigint }))).rejects.toThrow(/units/)
    await expect(j.insert(row({ txid: 'AB'.repeat(32) }))).rejects.toThrow(/txid/)
    await expect(j.insert(row({ assetId: `${'ef'.repeat(32)}.0` }))).rejects.toThrow(/assetId/)
    await expect(j.insert(row({ outputIndex: -1 }))).rejects.toThrow(/outputIndex/)
    await expect(j.insert(row({ state: 'admitted' as never }))).rejects.toThrow(/state/)
    await expect(j.insert(row({ rail: 'address' as never }))).rejects.toThrow(/rail/)
    await expect(j.insert(row({ role: 'sender' as never }))).rejects.toThrow(/role/)
    await j.insert(row())
    await expect(j.advance(TXID, ['built'], 'admitted' as never)).rejects.toThrow(/state/)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM color_transfers').get()).toEqual({ n: 1 })
  })

  it('rejects a non-canonical units string read back from disk', async () => {
    await j.insert(row())
    raw.prepare("UPDATE color_transfers SET units='01'").run()
    await expect(j.get(TXID)).rejects.toThrow(/units/)
  })

  it('rejects an unknown state read back from disk', async () => {
    await j.insert(row())
    raw.prepare("UPDATE color_transfers SET state='admitted'").run()
    await expect(j.get(TXID)).rejects.toThrow(/state/)
    await expect(j.statesOf([TXID])).rejects.toThrow(/state/)
  })

  it('propagates a read fault from statesOf', async () => {
    const broken = createTransferJournal({
      runAsync: async () => ({ changes: 0 }),
      getAllAsync: async () => {
        throw new Error('SQLITE_BUSY: database is locked')
      }
    })
    await expect(broken.statesOf([TXID])).rejects.toThrow('locked')
  })
})
