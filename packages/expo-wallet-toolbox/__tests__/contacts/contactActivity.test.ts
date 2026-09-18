/**
 * `getContactActivity` — merges outbound-labelled BSV actions, a recent-window
 * client-side counterparty match, and token settlements, sorted newest first.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { createSettlementStore, type SettlementDb } from '../../core/mandala/settlementStore'
import {
  getContactActivity,
  listTokenSettlementsByCounterparty,
  type ContactActivityWallet,
  type ContactBsvAction
} from '../../core/contacts/contactActivity'

function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

const ALICE = '02' + 'aa'.repeat(32)
const BOB = '03' + 'bb'.repeat(32)

function walletOf(byLabels: ContactBsvAction[], all: ContactBsvAction[]): ContactActivityWallet {
  return {
    async listActions(args) {
      if (args.labels && args.labels.length > 0) {
        return { actions: byLabels.filter(a => a.labels?.some(l => args.labels!.includes(l))) }
      }
      return { actions: all }
    }
  }
}

let raw: DatabaseSync

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
})

afterEach(() => raw.close())

describe('listTokenSettlementsByCounterparty', () => {
  it('finds only this counterparty’s settlements', async () => {
    const store = createSettlementStore(adapt(raw) as unknown as SettlementDb)
    await store.upsertSettlement({
      txid: 'aa'.repeat(32),
      role: 'sent',
      assetId: `${'ee'.repeat(32)}.0`,
      state: 'held',
      counterpartyKey: ALICE,
      overlayUrl: 'https://overlay.example',
      overlayIdentityKey: ALICE
    })
    await store.upsertSettlement({
      txid: 'bb'.repeat(32),
      role: 'sent',
      assetId: `${'ee'.repeat(32)}.0`,
      state: 'held',
      counterpartyKey: BOB,
      overlayUrl: 'https://overlay.example',
      overlayIdentityKey: BOB
    })
    const rows = await listTokenSettlementsByCounterparty(adapt(raw), ALICE)
    expect(rows).toHaveLength(1)
    expect(rows[0].counterpartyKey).toBe(ALICE)
  })
})

describe('getContactActivity', () => {
  it('includes an outbound peer send labelled with the recipient key', async () => {
    const outbound: ContactBsvAction = {
      txid: 'aa'.repeat(32),
      satoshis: -1000,
      status: 'completed',
      isOutgoing: true,
      labels: ['peerpay', ALICE],
      created_at: '2026-09-01T00:00:00.000Z'
    }
    const wallet = walletOf([outbound], [outbound])
    const items = await getContactActivity({ wallet, identityKey: ALICE })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'bsv', txid: outbound.txid })
  })

  it('finds an inbound payment via senderIdentityKey in the recent window', async () => {
    const inbound: ContactBsvAction = {
      txid: 'bb'.repeat(32),
      satoshis: 2000,
      status: 'completed',
      isOutgoing: false,
      senderIdentityKey: ALICE,
      created_at: '2026-09-02T00:00:00.000Z'
    }
    const wallet = walletOf([], [inbound])
    const items = await getContactActivity({ wallet, identityKey: ALICE })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'bsv', txid: inbound.txid })
  })

  it('excludes activity with a different counterparty', async () => {
    const other: ContactBsvAction = {
      txid: 'cc'.repeat(32),
      satoshis: 500,
      status: 'completed',
      senderIdentityKey: BOB,
      created_at: '2026-09-03T00:00:00.000Z'
    }
    const wallet = walletOf([], [other])
    const items = await getContactActivity({ wallet, identityKey: ALICE })
    expect(items).toHaveLength(0)
  })

  it('de-duplicates a row present in both the label query and the recent window', async () => {
    const both: ContactBsvAction = {
      txid: 'dd'.repeat(32),
      satoshis: -500,
      status: 'completed',
      isOutgoing: true,
      labels: ['peerpay', ALICE],
      created_at: '2026-09-04T00:00:00.000Z'
    }
    const wallet = walletOf([both], [both])
    const items = await getContactActivity({ wallet, identityKey: ALICE })
    expect(items).toHaveLength(1)
  })

  it('merges BSV and token activity, sorted newest first', async () => {
    const settlementStore = createSettlementStore(adapt(raw) as unknown as SettlementDb)
    await settlementStore.upsertSettlement({
      txid: 'ee'.repeat(32),
      role: 'received',
      assetId: `${'ff'.repeat(32)}.0`,
      state: 'admitted',
      counterpartyKey: ALICE,
      overlayUrl: 'https://overlay.example',
      overlayIdentityKey: ALICE,
      createdAt: '2026-09-10T00:00:00.000Z'
    })
    const bsv: ContactBsvAction = {
      txid: 'aa'.repeat(32),
      satoshis: -1000,
      status: 'completed',
      isOutgoing: true,
      labels: ['peerpay', ALICE],
      created_at: '2026-09-05T00:00:00.000Z'
    }
    const wallet = walletOf([bsv], [bsv])
    const items = await getContactActivity({ wallet, settlementsDb: adapt(raw), identityKey: ALICE })
    expect(items.map(i => i.kind)).toEqual(['token', 'bsv'])
  })

  it('degrades gracefully with no wallet or settlements db', async () => {
    const items = await getContactActivity({ identityKey: ALICE })
    expect(items).toEqual([])
  })
})
