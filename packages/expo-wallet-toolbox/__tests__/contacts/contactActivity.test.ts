/**
 * `getContactActivity` — merges outbound-labelled BSV actions, a recent-window
 * client-side counterparty match, and the `color_transfers` journal's token
 * transfers (plan 07 W1), sorted newest first.
 */
import { DatabaseSync } from 'node:sqlite'
import { createTables } from '../../core/storage/schema/createTables'
import { createTransferJournal, type JournalDb } from '../../core/mandala/transferJournal'
import type { ColorTransferRow } from '../../core/mandala/types'
import {
  getContactActivity,
  listTokenTransfersByCounterparty,
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

const ASSET = `${'ee'.repeat(32)}_0`

/** One journal row, written through the real journal so the schema cannot drift from this reader. */
async function journalRow(
  over: Partial<Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>> & { txid: string },
  at = '2026-09-10T00:00:00.000Z'
): Promise<void> {
  const journal = createTransferJournal(adapt(raw) as unknown as JournalDb, () => new Date(at))
  await journal.insert({
    role: 'sent',
    assetId: ASSET,
    units: 4000n,
    outputIndex: 0,
    rail: 'handle',
    state: 'handed_over',
    delivered: true,
    ...over
  })
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  await createTables(adapt(raw) as never)
})

afterEach(() => raw.close())

describe('listTokenTransfersByCounterparty', () => {
  it('finds only this counterparty’s transfers', async () => {
    await journalRow({ txid: 'aa'.repeat(32), counterpartyKey: ALICE })
    await journalRow({ txid: 'bb'.repeat(32), counterpartyKey: BOB })
    const rows = await listTokenTransfersByCounterparty(adapt(raw), ALICE)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ txid: 'aa'.repeat(32), counterpartyKey: ALICE, assetId: ASSET, units: 4000n })
  })

  it('reads units above 2^53 exactly', async () => {
    await journalRow({ txid: 'aa'.repeat(32), counterpartyKey: ALICE, units: 18446744073709551615n })
    const [row] = await listTokenTransfersByCounterparty(adapt(raw), ALICE)
    expect(row.units).toBe(18446744073709551615n)
  })

  it('omits a cancelled send: that money never moved', async () => {
    await journalRow({ txid: 'aa'.repeat(32), counterpartyKey: ALICE, state: 'cancelled' })
    expect(await listTokenTransfersByCounterparty(adapt(raw), ALICE)).toEqual([])
  })

  it('keeps a row whose units do not read back, without a figure rather than a guessed one', async () => {
    await journalRow({ txid: 'aa'.repeat(32), counterpartyKey: ALICE })
    raw.prepare("UPDATE color_transfers SET units = '1e3'").run()
    const [row] = await listTokenTransfersByCounterparty(adapt(raw), ALICE)
    expect(row.txid).toBe('aa'.repeat(32))
    expect(row.units).toBeUndefined()
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
    await journalRow(
      { txid: 'ee'.repeat(32), role: 'received', state: 'settled', counterpartyKey: ALICE },
      '2026-09-10T00:00:00.000Z'
    )
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
