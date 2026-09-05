import { DatabaseSync } from 'node:sqlite'
import type { TrxToken } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { createTables } from '../../core/storage/schema/createTables'

const ENTITY_TIME = '2026-09-01T00:00:00.000Z'
const MAP_TIME = '2026-09-02T00:00:00.000Z'

function adapt(raw: DatabaseSync) {
  return {
    execAsync: async (sql: string) => raw.exec(sql),
    getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...(params as never[])))
  }
}

let raw: DatabaseSync
let db: ReturnType<typeof adapt>
let storage: StorageExpoSQLite

beforeEach(async () => {
  raw = new DatabaseSync(':memory:')
  db = adapt(raw)
  await createTables(db as never)
  storage = new StorageExpoSQLite({ chain: 'test' } as never)
  storage.db = db as never
  for (const id of [1, 2]) {
    raw
      .prepare('INSERT INTO users (userId, created_at, updated_at, identityKey) VALUES (?, ?, ?, ?)')
      .run(id, ENTITY_TIME, ENTITY_TIME, `user-${id}`)
    raw
      .prepare(
        `INSERT INTO transactions
      (transactionId, created_at, updated_at, userId, status, reference) VALUES (?, ?, ?, ?, 'completed', ?)`
      )
      .run(id, ENTITY_TIME, ENTITY_TIME, id, `ref-${id}`)
    raw
      .prepare(
        `INSERT INTO outputs
      (outputId, created_at, updated_at, userId, transactionId, vout, satoshis, providedBy)
      VALUES (?, ?, ?, ?, ?, 0, 1, 'you')`
      )
      .run(id, ENTITY_TIME, ENTITY_TIME, id, id)
  }
  db.getAllAsync.mockClear()
})

afterEach(() => raw.close())

describe.each([
  {
    table: 'tx_labels',
    idColumn: 'txLabelId',
    valueColumn: 'label',
    ownerColumn: 'transactionId',
    method: 'getLabelsForTransactionId'
  },
  {
    table: 'output_tags',
    idColumn: 'outputTagId',
    valueColumn: 'tag',
    ownerColumn: 'outputId',
    method: 'getTagsForOutputId'
  }
] as const)('$method', ({ table, idColumn, valueColumn, ownerColumn, method }) => {
  function seed(): void {
    for (const [id, value, deleted, userId] of [
      [5, 'last', 0, 1],
      [2, 'deleted-map', 0, 1],
      [1, 'first', 0, 1],
      [4, 'deleted-entity', 1, 1],
      [3, 'other-owner', 0, 2]
    ] as const) {
      raw
        .prepare(
          `INSERT INTO ${table}
        (${idColumn}, created_at, updated_at, userId, ${valueColumn}, isDeleted) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, ENTITY_TIME, ENTITY_TIME, userId, value, deleted)
      raw
        .prepare(
          `INSERT INTO ${table}_map
        (${idColumn}, ${ownerColumn}, created_at, updated_at, isDeleted) VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, userId, MAP_TIME, MAP_TIME, id === 2 ? 1 : 0)
    }
  }

  it('returns active associations in ID order with entity dates and booleans in one read', async () => {
    seed()

    const result = await storage[method](1)

    expect(result).toEqual(
      [1, 5].map(id => ({
        [idColumn]: id,
        [valueColumn]: id === 1 ? 'first' : 'last',
        userId: 1,
        created_at: new Date(ENTITY_TIME),
        updated_at: new Date(ENTITY_TIME),
        isDeleted: false
      }))
    )
    expect(db.getAllAsync).toHaveBeenCalledTimes(1)
  })

  it('does not return associations belonging to another transaction or output', async () => {
    seed()
    expect(await storage[method](2)).toEqual([expect.objectContaining({ [valueColumn]: 'other-owner' })])
    expect(await storage[method](999)).toEqual([])
  })

  it('uses the supplied transaction connection for the lookup', async () => {
    seed()
    const transactionDb = adapt(raw)
    const token = { _inTrx: true, db: transactionDb } as unknown as TrxToken

    expect(await storage[method](1, token)).toEqual([
      expect.objectContaining({ [valueColumn]: 'first' }),
      expect.objectContaining({ [valueColumn]: 'last' })
    ])
    expect(transactionDb.getAllAsync).toHaveBeenCalledTimes(1)
    expect(db.getAllAsync).not.toHaveBeenCalled()
  })
})

it('returns no labels without touching storage when there is no transaction ID', async () => {
  expect(await storage.getLabelsForTransactionId()).toEqual([])
  expect(await storage.getLabelsForTransactionId(0)).toEqual([])
  expect(db.getAllAsync).not.toHaveBeenCalled()
})
