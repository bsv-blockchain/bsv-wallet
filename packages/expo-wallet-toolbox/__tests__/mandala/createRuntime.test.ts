/**
 * `createMandalaRuntime`: the UI's one door to tokens (plan 07 Task 11, reads).
 *
 *  · Balances come from the color module's views: `units` is the exact
 *    `p color balance <assetTag>` sum and `offlineUnits` the part of it the
 *    inventory tags `color_offline` (W10). Offline is never shown as settled.
 *  · Activity is the `color_transfers` journal, mapped to display statuses.
 *  · A runtime missing endpoints, the module, the provider or a database is
 *    unavailable, and its journal refuses every read rather than reading "no
 *    row" (the guards above it would otherwise fail open).
 */
jest.mock('@bsv/mandala', () => {
  const actual = jest.requireActual('@bsv/mandala')
  return { ...actual, fetchRegistry: jest.fn() }
})
jest.mock('@bsv/mandala/adminState', () => ({ resolveAssetState: jest.fn() }))

import type { DatabaseSync } from 'node:sqlite'
import { Hash, LockingScript, PrivateKey, Transaction, UnlockingScript, type WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { assetTag, fetchRegistry } from '@bsv/mandala'
import { resolveAssetState } from '@bsv/mandala/adminState'
import type { ColorOverlayProvider } from '@bsv/color-permission-module'
import {
  activityStatusOf,
  bindOriginator,
  createMandalaRuntime,
  type CreateMandalaRuntimeArgs
} from '../../core/mandala/createRuntime'
import { createTransferJournal, type JournalDb, type TransferJournal } from '../../core/mandala/transferJournal'
import { STUCK_AFTER_MS, type ColorTransferRow } from '../../core/mandala/types'
import type { InventoryRecord } from '../../core/mandala/assets'
import { openTestDb, type ExpoLikeDb } from '../__helpers__/nodeSqlite'

const ADMIN = 'admin.example'
const ASSET = `${'ab'.repeat(32)}_0`
const OTHER = `${'cd'.repeat(32)}_0`
const SELF = new PrivateKey(7).toPublicKey().toString()
const EP = {
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: new PrivateKey(9).toPublicKey().toString(),
  messageBoxUrl: 'https://messagebox.example'
}
const NOW = Date.parse('2026-10-22T12:00:00.000Z')

const pkh = (): number[] => Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])

function rec(over: Partial<InventoryRecord> = {}): InventoryRecord {
  return { outpoint: `${'ee'.repeat(32)}.0`, assetId: ASSET, role: 'value', units: 1n, tags: [], ...over }
}

const refusingProvider: ColorOverlayProvider = {
  spendability: async () => {
    throw new Error('offline')
  },
  admission: async () => {
    throw new Error('offline')
  },
  submit: async () => {
    throw new Error('offline')
  }
}

const fakeColor = {
  settle: jest.fn(async () => ({ results: [] })),
  handoffEvidence: jest.fn(async () => undefined)
}

let raw: DatabaseSync
let db: ExpoLikeDb
let storage: CreateMandalaRuntimeArgs['storage']
let journal: TransferJournal

beforeEach(async () => {
  let kv
  ;({ raw, db, kv } = await openTestDb())
  storage = { getKeyValue: kv.getKeyValue, setKeyValue: kv.setKeyValue, sqliteDb: db } as never
  journal = createTransferJournal(db as JournalDb, () => new Date(NOW))
  ;(fetchRegistry as jest.Mock).mockReset()
  ;(resolveAssetState as jest.Mock).mockReset()
})

afterEach(() => raw.close())

/** A wallet whose `listOutputs` serves the inventory from records and the balance view per asset. */
function fakeWallet(o: { available?: Record<string, string>; inventory?: InventoryRecord[]; inventoryError?: Error }) {
  const listOutputs = jest.fn(async (args: { basket: string; offset?: number }, _originator?: string) => {
    if (args.basket === 'p color assets') {
      if (o.inventoryError) throw o.inventoryError
      const outputs = (o.inventory ?? []).map(r => ({
        outpoint: r.outpoint,
        satoshis: 1,
        spendable: r.tags.includes('color_state_available'),
        lockingScript: new OneColor().lock(r.assetId, r.units, pkh()).toHex(),
        tags: r.tags
      }))
      return { totalOutputs: outputs.length, outputs: outputs.slice(args.offset ?? 0) }
    }
    for (const [id, total] of Object.entries(o.available ?? {})) {
      if (args.basket === `p color balance ${assetTag(id)}`) return { totalOutputs: total, outputs: [] }
    }
    throw new Error(`no basket ${args.basket}`)
  })
  const getPublicKey = jest.fn(async () => ({ publicKey: SELF }))
  return { listOutputs, getPublicKey } as unknown as WalletInterface & {
    listOutputs: typeof listOutputs
    getPublicKey: typeof getPublicKey
  }
}

function runtimeWith(
  o: {
    available?: Record<string, string>
    inventory?: InventoryRecord[]
    inventoryError?: Error
    endpoints?: CreateMandalaRuntimeArgs['endpoints'] | null
    color?: CreateMandalaRuntimeArgs['color'] | null
    provider?: CreateMandalaRuntimeArgs['provider'] | null
    storage?: CreateMandalaRuntimeArgs['storage']
    wallet?: WalletInterface
  } = {}
) {
  const pick = <T>(v: T | null | undefined, d: T): T | undefined => (v === null ? undefined : v === undefined ? d : v)
  return createMandalaRuntime({
    wallet: o.wallet ?? fakeWallet(o),
    adminOriginator: ADMIN,
    storage: o.storage ?? storage,
    chain: 'main',
    endpoints: pick(o.endpoints, EP),
    color: pick(o.color, fakeColor as never),
    provider: pick(o.provider, refusingProvider),
    now: () => new Date(NOW)
  })
}

function row(over: Partial<Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>> = {}) {
  return {
    txid: 'a1'.repeat(32),
    role: 'sent' as const,
    assetId: ASSET,
    units: 1500n,
    outputIndex: 0,
    rail: 'handle' as const,
    state: 'handed_over' as const,
    delivered: true,
    ...over
  }
}

describe('availability', () => {
  it('is available with endpoints, module, provider and a database', () => {
    expect(runtimeWith().available).toBe(true)
  })

  it('is unavailable without endpoints, module or provider', () => {
    expect(runtimeWith({ color: null }).available).toBe(false)
    expect(runtimeWith({ provider: null }).available).toBe(false)
    expect(runtimeWith({ endpoints: null }).available).toBe(false)
    expect(runtimeWith({ storage: { sqliteDb: undefined } as never }).available).toBe(false)
  })

  it('exposes the configured endpoints, or empty strings when there are none', () => {
    expect(runtimeWith().endpoints).toEqual(EP)
    expect(runtimeWith({ endpoints: null }).endpoints).toEqual({
      overlayUrl: '',
      overlayIdentityKey: '',
      messageBoxUrl: ''
    })
  })

  it('without a database, the journal refuses every read instead of reading "no row"', async () => {
    const rt = runtimeWith({ storage: { sqliteDb: undefined } as never })
    await expect(rt.journal.get('a1'.repeat(32))).rejects.toThrow(/database/)
    await expect(rt.journal.getByReference('ref')).rejects.toThrow(/database/)
    await expect(rt.journal.statesOf(['a1'.repeat(32)])).rejects.toThrow(/database/)
    await expect(rt.journal.list()).rejects.toThrow(/database/)
  })

  it('reads and writes the color_transfers journal of its storage', async () => {
    const rt = runtimeWith()
    await journal.insert(row())
    expect((await rt.journal.get(row().txid))?.state).toBe('handed_over')
  })
})

describe('balances', () => {
  it('balances = available view with offline portion, one row per held asset', async () => {
    const rt = runtimeWith({
      available: { [ASSET]: '1500' },
      inventory: [
        rec({ outpoint: `${'01'.repeat(32)}.0`, units: 1000n, tags: ['color_state_available'] }),
        rec({ outpoint: `${'02'.repeat(32)}.0`, units: 500n, tags: ['color_state_available', 'color_offline'] })
      ]
    })
    expect(await rt.balances()).toEqual([
      { asset: expect.objectContaining({ assetId: ASSET }), units: 1500n, offlineUnits: 500n }
    ])
  })

  it('keeps sums above 2^64 exact', async () => {
    const big = 18446744073709551615n
    const rt = runtimeWith({
      available: { [ASSET]: (2n * big).toString() },
      inventory: [
        rec({ outpoint: `${'01'.repeat(32)}.0`, units: big, tags: ['color_state_available', 'color_offline'] }),
        rec({ outpoint: `${'02'.repeat(32)}.0`, units: big, tags: ['color_state_available'] })
      ]
    })
    const [b] = await rt.balances()
    expect(b.units).toBe(2n * big)
    expect(b.offlineUnits).toBe(big)
  })

  it('one row per asset, sorted, and a pending-only asset shows zero available', async () => {
    const wallet = fakeWallet({
      available: { [ASSET]: '7' },
      inventory: [
        rec({ outpoint: `${'01'.repeat(32)}.0`, assetId: OTHER, units: 9n, tags: ['color_state_pending'] }),
        rec({ outpoint: `${'02'.repeat(32)}.0`, units: 7n, tags: ['color_state_available'] }),
        rec({ outpoint: `${'03'.repeat(32)}.0`, units: 3n, tags: ['color_state_reserved'] })
      ]
    })
    const rt = runtimeWith({ wallet })
    const got = await rt.balances()
    expect(got.map(b => [b.asset.assetId, b.units, b.offlineUnits])).toEqual([
      [ASSET, 7n, 0n],
      [OTHER, 0n, 0n]
    ])
    // The balance view is asked only for an asset with an available record.
    const baskets = wallet.listOutputs.mock.calls.map(c => c[0].basket)
    expect(baskets).not.toContain(`p color balance ${assetTag(OTHER)}`)
  })

  it('clamps the offline portion to the available figure when the snapshots disagree', async () => {
    const rt = runtimeWith({
      available: { [ASSET]: '100' },
      inventory: [rec({ units: 500n, tags: ['color_state_available', 'color_offline'] })]
    })
    const [b] = await rt.balances()
    expect(b.units).toBe(100n)
    expect(b.offlineUnits).toBe(100n)
  })

  it('throws when the inventory cannot be read, so the UI shows unknown, never zero', async () => {
    const rt = runtimeWith({ inventoryError: new Error('storage fault') })
    await expect(rt.balances()).rejects.toThrow(/storage fault/)
  })

  it('throws when an available asset has no readable balance', async () => {
    const rt = runtimeWith({ available: {}, inventory: [rec({ tags: ['color_state_available'] })] })
    await expect(rt.balances()).rejects.toThrow(/no basket/)
  })

  it('reads through the admin originator', async () => {
    const wallet = fakeWallet({ available: { [ASSET]: '1' }, inventory: [rec({ tags: ['color_state_available'] })] })
    await runtimeWith({ wallet }).balances()
    expect(wallet.listOutputs).toHaveBeenCalled()
    for (const call of wallet.listOutputs.mock.calls) expect(call[1]).toBe(ADMIN)
  })
})

describe('listAssets', () => {
  it('lists every inventory asset plus every journaled one, once each', async () => {
    await journal.insert(row({ assetId: OTHER, role: 'received', state: 'settled' }))
    const rt = runtimeWith({
      inventory: [rec({ tags: ['color_state_available'] }), rec({ outpoint: `${'0f'.repeat(32)}.1` })]
    })
    expect((await rt.listAssets()).map(a => a.assetId)).toEqual([ASSET, OTHER])
  })
})

describe('activity', () => {
  it('activity maps journal rows to statuses and hides cancelled sends', async () => {
    const rows = [
      row({ txid: '01'.repeat(32), state: 'built' }),
      row({ txid: '02'.repeat(32), state: 'handed_over' }),
      row({ txid: '03'.repeat(32), role: 'received', state: 'held', counterpartyKey: SELF }),
      row({ txid: '04'.repeat(32), state: 'settled' }),
      row({ txid: '05'.repeat(32), state: 'handed_over' }),
      row({ txid: '06'.repeat(32), state: 'cancelled' }),
      row({ txid: '07'.repeat(32), state: 'parked', units: 18446744073709551615n })
    ]
    for (const r of rows) await journal.insert(r)
    await journal.advance('05'.repeat(32), ['handed_over'], 'refused', { code: 'ERR_FROZEN' })
    // One row is old enough to be stuck.
    const oldJournal = createTransferJournal(db as JournalDb, () => new Date(NOW - STUCK_AFTER_MS - 1))
    await oldJournal.insert(row({ txid: '08'.repeat(32), state: 'handed_over', rail: 'nearby' }))

    const got = await runtimeWith().activity()
    const byTxid = new Map(got.map(r => [r.txid, r]))
    expect(byTxid.has('06'.repeat(32))).toBe(false)
    expect(got).toHaveLength(7)
    expect(byTxid.get('01'.repeat(32))!.status).toBe('settling')
    expect(byTxid.get('02'.repeat(32))!.status).toBe('settling')
    expect(byTxid.get('03'.repeat(32))).toMatchObject({ status: 'settling', role: 'received', counterpartyKey: SELF })
    expect(byTxid.get('04'.repeat(32))!.status).toBe('settled')
    expect(byTxid.get('05'.repeat(32))).toMatchObject({ status: 'refused', refusedCode: 'ERR_FROZEN' })
    expect(byTxid.get('07'.repeat(32))).toMatchObject({ status: 'settling', units: 18446744073709551615n })
    expect(byTxid.get('08'.repeat(32))).toMatchObject({ status: 'stuck', rail: 'nearby' })
    expect(byTxid.get('02'.repeat(32))).toMatchObject({
      role: 'sent',
      units: 1500n,
      rail: 'handle',
      asset: expect.objectContaining({ assetId: ASSET })
    })
  })

  it('applies the limit after hiding cancelled rows', async () => {
    for (let i = 1; i <= 4; i++) {
      await journal.insert(
        row({ txid: i.toString(16).padStart(64, '0'), state: i % 2 === 0 ? 'cancelled' : 'settled' })
      )
    }
    const got = await runtimeWith().activity(2)
    expect(got).toHaveLength(2)
    expect(got.every(r => r.status === 'settled')).toBe(true)
  })

  it('activityStatusOf: terminal states map directly; cancelled has no status', () => {
    const at = new Date(NOW).toISOString()
    const base: ColorTransferRow = { ...row(), createdAt: at, updatedAt: at }
    expect(activityStatusOf({ ...base, state: 'settled' }, NOW)).toBe('settled')
    expect(activityStatusOf({ ...base, state: 'refused' }, NOW)).toBe('refused')
    expect(activityStatusOf({ ...base, state: 'cancelled' }, NOW)).toBeUndefined()
    expect(activityStatusOf({ ...base, state: 'held' }, NOW + STUCK_AFTER_MS)).toBe('stuck')
    expect(activityStatusOf({ ...base, state: 'held' }, NOW + STUCK_AFTER_MS - 1)).toBe('settling')
  })
})

describe('stuck', () => {
  it('lists non-terminal rows older than STUCK_AFTER_MS', async () => {
    const oldJournal = createTransferJournal(db as JournalDb, () => new Date(NOW - STUCK_AFTER_MS - 1))
    await oldJournal.insert(row({ txid: '01'.repeat(32), state: 'handed_over' }))
    await oldJournal.insert(row({ txid: '02'.repeat(32), state: 'settled' }))
    await journal.insert(row({ txid: '03'.repeat(32), state: 'held', role: 'received' }))
    expect((await runtimeWith().stuck()).map(r => r.txid)).toEqual(['01'.repeat(32)])
  })
})

describe('assetStatus', () => {
  it('reads paused, exact frozen units and registry admission', async () => {
    ;(resolveAssetState as jest.Mock).mockResolvedValue({
      assetId: ASSET,
      isPaused: true,
      accessMode: 'allowlist',
      blockedIdentities: [],
      allowedIdentities: [],
      frozenOutpoints: [
        { outpoint: `${'01'.repeat(32)}.0`, amount: 18446744073709551615n, owner: SELF, reason: '' },
        { outpoint: `${'02'.repeat(32)}.0`, amount: 1n, owner: SELF, reason: '' }
      ],
      evictedOutpoints: []
    })
    const other = new PrivateKey(11).toPublicKey().toString()
    ;(fetchRegistry as jest.Mock).mockResolvedValue([
      { identityKey: SELF, status: 'admitted', txid: '0a'.repeat(32), outputIndex: 0, admitSeq: 1, createdAt: '' }
    ])
    const s = await runtimeWith().assetStatus(ASSET)
    expect(s).toMatchObject({
      paused: true,
      frozenUnits: 18446744073709551616n,
      accessMode: 'allowlist',
      metadataResolved: false,
      messageBoxUrl: EP.messageBoxUrl
    })
    expect(s.selfAdmitted).toBe(true)
    expect(await s.recipientAdmitted(other)).toBe(false)
  })

  it('reads an unreachable overlay as the least alarming answer, and caches ~10 s', async () => {
    ;(resolveAssetState as jest.Mock).mockRejectedValue(new Error('offline'))
    ;(fetchRegistry as jest.Mock).mockRejectedValue(new Error('offline'))
    const rt = runtimeWith()
    const s = await rt.assetStatus(ASSET)
    expect(s).toMatchObject({ paused: false, frozenUnits: 0n, selfAdmitted: undefined })
    await rt.assetStatus(ASSET)
    expect(resolveAssetState).toHaveBeenCalledTimes(1)
    await rt.refreshAssetStatus(ASSET)
    expect(resolveAssetState).toHaveBeenCalledTimes(2)
    expect((resolveAssetState as jest.Mock).mock.calls[1]).toEqual([ASSET, { force: true }])
  })
})

describe('recipientRefusal', () => {
  it('refuses a non-key and an off-curve key, and allows sending to self', () => {
    const rt = runtimeWith()
    expect(rt.recipientRefusal('')).toMatch(/required/)
    expect(rt.recipientRefusal('1BitcoinAddress')).toMatch(/identity key/)
    expect(rt.recipientRefusal(`02${'05'.repeat(32)}`)).toMatch(/identity key/) // no point with this x
    expect(rt.recipientRefusal(`02${'ff'.repeat(32)}`)).toMatch(/identity key/) // x is not a field element
    expect(rt.recipientRefusal(SELF)).toBeNull()
    expect(rt.recipientRefusal(` ${EP.overlayIdentityKey} `)).toBeNull()
  })
})

describe('subscribe', () => {
  it('notifies listeners when a deploy is remembered, and stops after unsubscribe', async () => {
    const rt = runtimeWith()
    const listener = jest.fn()
    const off = rt.subscribe(listener)
    await rt.rememberDeploy('00')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    await rt.rememberDeploy('00')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('tick (Task 17)', () => {
  const SENT = 'f1'.repeat(32)
  const QUEUED_COLOR = 'f2'.repeat(32)
  const QUEUED_PLAIN = 'f3'.repeat(32)

  /**
   * A storage stub over the real test database, with the two request reads
   * the tick's held-receipt step makes. `colorHeldTxids` names only the 1Color
   * one, as the real guard does for a plain-BSV queue row.
   */
  function tickStorage(calls: string[], o: { heldError?: Error; unreadableReq?: string } = {}) {
    const findProvenTxReqs = jest.fn(async (a: { partial: { txid: string } }) => {
      if (a.partial.txid === o.unreadableReq) throw new Error('request row unreadable')
      return [{ txid: a.partial.txid, rawTx: [1, 2, 3] }]
    })
    const colorHeldTxids = jest.fn(async (reqs: readonly { txid: string }[]) => {
      calls.push(`held:${reqs.map(r => r.txid.slice(0, 2)).join(',')}`)
      if (o.heldError) throw o.heldError
      return new Set(reqs.map(r => r.txid).filter(t => t === QUEUED_COLOR))
    })
    return {
      stub: {
        ...(storage as object),
        findProvenTxReqs,
        colorHeldTxids
      } as unknown as CreateMandalaRuntimeArgs['storage'],
      colorHeldTxids
    }
  }

  async function seedTickRows(): Promise<void> {
    await journal.insert(
      row({
        txid: SENT,
        delivered: false,
        counterpartyKey: SELF,
        derivationPrefix: 'cHJl',
        derivationSuffix: 'c3Vm',
        senderIdentityKey: SELF
      })
    )
    raw.prepare(`INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (1,'n','n','k')`).run()
    for (const [i, txid] of [QUEUED_COLOR, QUEUED_PLAIN].entries()) {
      raw
        .prepare(
          `INSERT INTO offline_actions (created_at, updated_at, userId, txid, seq, role, status)
           VALUES ('n','n',1,?,?, 'received', 'queued')`
        )
        .run(txid, i + 1)
    }
  }

  const heldCredit = () => rec({ outpoint: `${QUEUED_COLOR}.0`, tags: ['color_state_available', 'color_offline'] })

  it("tick() runs redeliver → settle → reconcileHeld and swallows each step's error", async () => {
    await seedTickRows()
    const calls: string[] = []
    const color = {
      handoffEvidence: jest.fn(async () => {
        calls.push('redeliver')
        return undefined
      }),
      settle: jest.fn(async () => {
        calls.push('settle')
        return { results: [] }
      })
    }
    const { stub } = tickStorage(calls)
    const rt = runtimeWith({ storage: stub, color: color as never, inventory: [heldCredit()] })
    const listener = jest.fn()
    rt.subscribe(listener)

    await expect(rt.tick()).resolves.toBeUndefined()
    expect(calls).toEqual(['redeliver', 'settle', 'held:f2,f3'])
    // Only the 1Color queue row is reconciled, and an offline credit stays held.
    expect(await rt.journal.get(QUEUED_COLOR)).toMatchObject({ role: 'received', rail: 'external', state: 'held' })
    expect(await rt.journal.get(QUEUED_PLAIN)).toBeUndefined()
    expect(listener).toHaveBeenCalled()

    // Every step throws: the tick still runs the next one and still resolves.
    calls.length = 0
    const failing = {
      handoffEvidence: jest.fn(async () => {
        calls.push('redeliver')
        throw new Error('evidence store down')
      }),
      settle: jest.fn(async () => {
        calls.push('settle')
        throw new Error('overlay down')
      })
    }
    const broken = tickStorage(calls, { heldError: new Error('journal unreadable') })
    const rt2 = runtimeWith({ storage: broken.stub, color: failing as never, inventoryError: new Error('view down') })
    await expect(rt2.tick()).resolves.toBeUndefined()
    expect(calls).toEqual(['redeliver', 'settle', 'held:f2,f3'])
  })

  it('a held-txid read fault reconciles nothing rather than guessing', async () => {
    await seedTickRows()
    const calls: string[] = []
    const { stub } = tickStorage(calls, { heldError: new Error('journal unreadable') })
    const rt = runtimeWith({ storage: stub, inventory: [heldCredit()] })
    await expect(rt.tick()).resolves.toBeUndefined()
    expect(await rt.journal.get(QUEUED_COLOR)).toBeUndefined()
  })

  it('one unreadable request never starves the reconcile of the other held receipts', async () => {
    await seedTickRows()
    const calls: string[] = []
    const { stub, colorHeldTxids } = tickStorage(calls, { unreadableReq: QUEUED_PLAIN })
    const rt = runtimeWith({ storage: stub, inventory: [heldCredit()] })
    await rt.tick()
    // The unreadable one reaches the guard with no bytes (which holds it).
    expect(colorHeldTxids).toHaveBeenCalledWith([
      { txid: QUEUED_COLOR, rawTx: [1, 2, 3] },
      { txid: QUEUED_PLAIN, rawTx: undefined }
    ])
    expect((await rt.journal.get(QUEUED_COLOR))?.state).toBe('held')
  })

  it('without the module or a database, a tick is a quiet no-op', async () => {
    await expect(runtimeWith({ color: null }).tick()).resolves.toBeUndefined()
    await expect(runtimeWith({ storage: { sqliteDb: undefined } as never }).tick()).resolves.toBeUndefined()
  })
})

describe('the nearby payee member (Task 16)', () => {
  const TXID = 'c3'.repeat(32)
  const received = (over: Partial<Parameters<ReturnType<typeof runtimeWith>['nearby']['onReceived']>[0]> = {}) => ({
    txid: TXID,
    assetId: ASSET,
    units: 18446744073709551615n,
    counterpartyKey: SELF,
    outputIndex: 0,
    ...over
  })
  const credit = (tags: string[]) => rec({ outpoint: `${TXID}.0`, units: 18446744073709551615n, tags })

  it('journals a credited offline receipt as held, exactly, on the nearby rail', async () => {
    const rt = runtimeWith({ inventory: [credit(['color_state_available', 'color_offline'])] })
    const listener = jest.fn()
    rt.subscribe(listener)
    await rt.nearby.onReceived(received(), { ok: true })
    expect(await rt.journal.get(TXID)).toMatchObject({
      role: 'received',
      state: 'held',
      rail: 'nearby',
      units: 18446744073709551615n,
      counterpartyKey: SELF,
      outputIndex: 0,
      delivered: false
    })
    expect(listener).toHaveBeenCalled()
  })

  it('journals a credit the inventory shows settled as settled', async () => {
    const rt = runtimeWith({ inventory: [credit(['color_state_available'])] })
    await rt.nearby.onReceived(received(), { ok: true })
    expect((await rt.journal.get(TXID))?.state).toBe('settled')
  })

  it('keeps a credit held when the inventory cannot be read or does not show it yet', async () => {
    const unreadable = runtimeWith({ inventoryError: new Error('view down') })
    await unreadable.nearby.onReceived(received(), { ok: true })
    expect((await unreadable.journal.get(TXID))?.state).toBe('held')

    const other = 'd4'.repeat(32)
    const unseen = runtimeWith({ inventory: [] })
    await unseen.nearby.onReceived(received({ txid: other }), { ok: true })
    expect((await unseen.journal.get(other))?.state).toBe('held')
  })

  it('a replayed credit never forks the row and still settles it', async () => {
    const offline = runtimeWith({ inventory: [credit(['color_state_available', 'color_offline'])] })
    await offline.nearby.onReceived(received(), { ok: true })
    const settled = runtimeWith({ inventory: [credit(['color_state_available'])] })
    await Promise.all([
      settled.nearby.onReceived(received(), { ok: true }),
      settled.nearby.onReceived(received(), { ok: true })
    ])
    expect(await settled.journal.list()).toEqual([expect.objectContaining({ txid: TXID, state: 'settled' })])
  })

  it('caches the attested deploy the receipt carried, so the asset is named offline', async () => {
    // IC §4 fixture F-REQ (as in assets.test): K is the deploy's overlay key.
    const K = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
    const REQ_HEX =
      'a2781c68747470733a2f2f6272632e6465762f3230372f6174746573746564a266706172616d73a26974727573744d6f6465686964656e746974796b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01785068747470733a2f2f6769746875622e636f6d2f6273762d626c6f636b636861696e2f6d616e64616c612f626c6f622f6d61737465722f646f63732f70726f66696c65732f6973737565722d76312e6d64a266706172616d73a16b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01'
    const PAYLOAD_HEX = `a4636465630263726571${REQ_HEX}6373796d6454555344656c6162656c6b5465737420446f6c6c6172`
    const deploy = new Transaction()
    deploy.addInput({
      sourceTXID: '11'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: UnlockingScript.fromHex('00')
    })
    deploy.addOutput({
      satoshis: 1,
      lockingScript: LockingScript.fromHex(
        `00006d4d6d01${PAYLOAD_HEX}7576a914a1d8edf2f9ebd6d2fe4728e0eb3bd369ab78d76a88ac`
      )
    })
    const assetId = `${deploy.id('hex')}_0`
    const rt = runtimeWith({ endpoints: { ...EP, overlayIdentityKey: K }, inventory: [] })
    await rt.nearby.onReceived(received({ assetId, declarationTx: deploy.toHex() }), { ok: true })
    expect(await rt.listAssets()).toEqual([expect.objectContaining({ assetId, ticker: 'TUSD', resolved: true })])
  })

  it('journals a definitive refusal as refused with its code, and a retriable one not at all', async () => {
    const rt = runtimeWith()
    await rt.nearby.onReceived(received(), { ok: false, code: 'AttestationEvidenceError', final: true })
    expect(await rt.journal.get(TXID)).toMatchObject({
      role: 'received',
      state: 'refused',
      code: 'AttestationEvidenceError',
      rail: 'nearby'
    })
    const other = 'e5'.repeat(32)
    await rt.nearby.onReceived(received({ txid: other }), { ok: false, code: 'ERR_BUSY', final: false })
    expect(await rt.journal.get(other)).toBeUndefined()
  })

  it('never overwrites a credited row with a later refusal', async () => {
    const rt = runtimeWith({ inventory: [credit(['color_state_available', 'color_offline'])] })
    await rt.nearby.onReceived(received(), { ok: true })
    await rt.nearby.onReceived(received(), { ok: false, code: 'ProfileDataError', final: true })
    expect((await rt.journal.get(TXID))?.state).toBe('held')
  })

  it('without a database, refuses rather than pretending to journal', async () => {
    const rt = runtimeWith({ storage: { sqliteDb: undefined } as never })
    await expect(rt.nearby.onReceived(received(), { ok: true })).rejects.toThrow(/not available/)
  })
})

describe('the nearby payer members (Task 15)', () => {
  it('journal the payer row through the runtime’s own journal', async () => {
    const rt = runtimeWith()
    await rt.journal.insert({
      txid: 'a1'.repeat(32),
      role: 'sent',
      state: 'built',
      assetId: ASSET,
      units: 5n,
      outputIndex: 0,
      rail: 'nearby',
      delivered: false,
      reference: 'ref-a1'
    })
    const listener = jest.fn()
    rt.subscribe(listener)
    await rt.nearby.onHandedOver('a1'.repeat(32), 'parked')
    expect((await rt.journal.get('a1'.repeat(32)))?.state).toBe('parked')
    expect(listener).toHaveBeenCalled()
    await expect(rt.nearby.onHandedOver('b2'.repeat(32), 'parked')).rejects.toThrow(/no sent row/)
  })

  it('without the module, a nearby hand-over refuses before anything is built', async () => {
    const rt = runtimeWith({ color: null })
    await expect(
      rt.nearby.handover({
        assetId: ASSET,
        units: 1n,
        recipientKey: SELF,
        derivationPrefix: 'cA==',
        derivationSuffix: 'cw=='
      })
    ).rejects.toThrow(/not available/)
  })

  it('without a database, neither member pretends to journal', async () => {
    const rt = runtimeWith({ storage: { sqliteDb: undefined } as never })
    await expect(rt.nearby.onHandedOver('a1'.repeat(32), 'handed_over')).rejects.toThrow(/not available/)
  })
})

describe('the handle rail members (Task 13)', () => {
  it('without the module, a send is unavailable and nothing is built or journaled', async () => {
    const rt = runtimeWith({ color: null })
    expect(await rt.sendToHandle({ assetId: ASSET, recipientIdentityKey: SELF, units: 1n })).toMatchObject({
      kind: 'unavailable'
    })
    expect(await rt.resendTransfer('a1'.repeat(32))).toBe('unavailable')
    expect(await rt.receiveFromInbox()).toEqual({ credited: 0, failed: 0, incomplete: true })
  })

  it('a runtime with no MessageBox reads the inbox as incomplete, never as empty', async () => {
    const rt = runtimeWith()
    expect(await rt.receiveFromInbox()).toEqual({ credited: 0, failed: 0, incomplete: true })
  })
})

describe('bindOriginator', () => {
  it('fills the originator only when the caller gave none', async () => {
    const seen: (string | undefined)[] = []
    const w = {
      getPublicKey: async (_a: unknown, o?: string) => {
        seen.push(o)
        return { publicKey: SELF }
      }
    }
    const bound = bindOriginator(w, ADMIN)
    await bound.getPublicKey({}, undefined)
    await bound.getPublicKey({}, 'other.example')
    expect(seen).toEqual([ADMIN, 'other.example'])
  })
})
