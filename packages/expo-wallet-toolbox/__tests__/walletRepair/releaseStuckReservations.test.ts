/**
 * XR-032: releaseStuckReservations must not resurrect inputs of a
 * locally-'failed' transaction that was actually broadcast/delivered — it
 * has to agree with the same proven_tx_reqs gate reviewStatusOnDb already
 * applies before restoring an input.
 */
import { DatabaseSync } from 'node:sqlite'
import { releaseStuckReservationsOnDb } from '../../core/walletRepair/releaseStuckReservations'

const TX1 = 'aa'.repeat(32)
const TX2 = 'bb'.repeat(32)

function seeded(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE transactions (transactionId INTEGER PRIMARY KEY, txid TEXT, status TEXT);
    CREATE TABLE proven_tx_reqs (provenTxReqId INTEGER PRIMARY KEY, txid TEXT, status TEXT);
    CREATE TABLE outputs (outputId INTEGER PRIMARY KEY, transactionId INTEGER, satoshis INTEGER, spendable INTEGER, spentBy INTEGER);
  `)
  return d
}

const adapt = (d: DatabaseSync) => ({
  getAllAsync: async (sql: string, params: unknown[] = []) => d.prepare(sql).all(...(params as never[])),
  runAsync: async (sql: string, params: unknown[] = []) => d.prepare(sql).run(...(params as never[]))
})

const output = (d: DatabaseSync, outputId: number) =>
  d.prepare('SELECT spendable, spentBy FROM outputs WHERE outputId = ?').get(outputId) as {
    spendable: number
    spentBy: number | null
  }

describe('XR-032: releaseStuckReservationsOnDb', () => {
  it('does not release a reservation whose failed spender still has an in-flight (blocking) req', async () => {
    const d = seeded()
    // Transaction 1 is locally 'failed', but its req says 'sending' — it may
    // already have been delivered to the network.
    d.prepare('INSERT INTO transactions VALUES (1, ?, ?)').run(TX1, 'failed')
    d.prepare('INSERT INTO proven_tx_reqs VALUES (1, ?, ?)').run(TX1, 'sending')
    d.prepare('INSERT INTO outputs VALUES (10, 2, 1000, 0, 1)').run()

    const log = await releaseStuckReservationsOnDb(adapt(d))

    expect(log).toBe('No stuck reservations found.')
    expect(output(d, 10)).toEqual({ spendable: 0, spentBy: 1 })
  })

  it('releases a reservation whose failed spender has no req at all', async () => {
    const d = seeded()
    d.prepare('INSERT INTO transactions VALUES (2, ?, ?)').run(TX2, 'failed')
    d.prepare('INSERT INTO outputs VALUES (20, 3, 500, 0, 2)').run()

    const log = await releaseStuckReservationsOnDb(adapt(d))

    expect(log).toContain('Released 1 stuck reservation')
    expect(output(d, 20)).toEqual({ spendable: 1, spentBy: null })
  })

  it('releases a reservation whose failed spender only has terminal-safe reqs (invalid/doubleSpend)', async () => {
    const d = seeded()
    d.prepare('INSERT INTO transactions VALUES (3, ?, ?)').run(TX1, 'failed')
    d.prepare('INSERT INTO proven_tx_reqs VALUES (1, ?, ?)').run(TX1, 'invalid')
    d.prepare('INSERT INTO outputs VALUES (30, 4, 250, 0, 3)').run()

    const log = await releaseStuckReservationsOnDb(adapt(d))

    expect(log).toContain('Released 1 stuck reservation')
    expect(output(d, 30)).toEqual({ spendable: 1, spentBy: null })
  })

  it('returns the no-op message when nothing is stuck', async () => {
    const d = seeded()
    expect(await releaseStuckReservationsOnDb(adapt(d))).toBe('No stuck reservations found.')
  })
})
