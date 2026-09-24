/**
 * `preHoldInboxSettlements` — the handle rail's pre-hold pass (P1-4).
 *
 * These are unit tests of the pass's own control flow: which messages it
 * touches, what it hands to an injected `cover`/`settle`, and — the whole
 * point of the fix — that a message COVER would accept is never left
 * unheld, while a message that will not even decode, or that COVER refuses,
 * is left alone for the library to reach the identical verdict itself.
 *
 * `cover` and `settle` are fakes here on purpose: COVER's own correctness has
 * its own suite in `@bsv/mandala`, and `settle`'s real implementation
 * (`settleThroughDrain`) has its own coverage in `createRuntime.test.ts`. What
 * this file pins is the ordering and exclusion contract between them.
 */
import { Beef, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import type { SettleArgs } from '@bsv/mandala'
import { preHoldInboxSettlements } from '../../core/mandala/inboxPrehold'
import type { PreHoldCoverBundle, PreHoldCoverFn } from '../../core/mandala/inboxPrehold'

const ASSET_ID = 'ab'.repeat(32) + '.0'
const PKH = new Array(20).fill(3)

function tokenTx(amount = 100): Transaction {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new MandalaToken().lock(ASSET_ID, amount, PKH) })
  return tx
}

function atomicBeefOf(tx: Transaction): number[] {
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return beef.toBinaryAtomic(tx.id('hex'))
}

function handoverBody(tx: Transaction, overrides: Record<string, unknown> = {}) {
  return {
    v: 2,
    kind: 'handover',
    assetId: ASSET_ID,
    amount: 100,
    sender: '02'.padEnd(66, 'a'),
    senderMode: 'blinded',
    keyID: 'k',
    protocolID: [2, 'mandala token'],
    transaction: atomicBeefOf(tx),
    outputIndex: 0,
    linkage: [],
    admissions: [],
    ...overrides
  }
}

function fakeMessageBox(messages: { messageId: string; body?: unknown }[]) {
  return { listMessages: jest.fn(async () => messages), acknowledgeMessage: jest.fn(async () => ({})) }
}

/** Never inspects the bundle's shape unless a test asks it to — that is `cover`'s own suite's job. */
function coverAlways(mustSubmit: string[]): PreHoldCoverFn {
  return jest.fn(() => ({ ok: true, mustSubmit })) as unknown as PreHoldCoverFn
}

function coverRefuses(): PreHoldCoverFn {
  return jest.fn(() => ({ ok: false, reason: 'uncovered_ancestor' })) as unknown as PreHoldCoverFn
}

describe('preHoldInboxSettlements', () => {
  it('a decodable, covered hand-over: settle runs with the tip txid and mustSubmit, no exclusion', async () => {
    const tx = tokenTx()
    const txid = tx.id('hex')
    const messageBoxClient = fakeMessageBox([{ messageId: 'm1', body: handoverBody(tx) }])
    const cover = coverAlways([txid])
    const settle = jest.fn(async (_args: SettleArgs) => undefined)

    const excluded = await preHoldInboxSettlements({ messageBoxClient, cover, settle })

    expect(excluded.size).toBe(0)
    expect(settle).toHaveBeenCalledTimes(1)
    const args = settle.mock.calls[0][0]
    expect(args.txid).toBe(txid)
    expect(args.mustSubmit).toEqual([txid])
    // bytesFor must answer for the tip itself — settleThroughDrain reads it
    // for every id in mustSubmit, the tip included.
    expect(args.bytesFor(txid)).toEqual({ beef: expect.any(Array), offChainValues: [] })
    expect(args.bytesFor('ab'.repeat(32))).toBeUndefined()
  })

  it('passes the bundle cover reads: assetId, the tip in beef, and empty linkage/admissions for a rootless tip', async () => {
    const tx = tokenTx()
    const messageBoxClient = fakeMessageBox([{ messageId: 'm1', body: handoverBody(tx) }])
    const cover = jest.fn((_tip: Transaction, bundle: PreHoldCoverBundle) => ({ ok: true, mustSubmit: [tx.id('hex')] }))
    const settle = jest.fn(async (_args: SettleArgs) => undefined)

    await preHoldInboxSettlements({ messageBoxClient, cover: cover as unknown as PreHoldCoverFn, settle })

    expect(cover).toHaveBeenCalledTimes(1)
    const [tipArg, bundleArg] = cover.mock.calls[0]
    expect(tipArg.id('hex')).toBe(tx.id('hex'))
    expect(bundleArg.assetId).toBe(ASSET_ID)
    expect(bundleArg.beef.get(tx.id('hex'))).toBeDefined()
    expect(bundleArg.linkage.size).toBe(0)
    expect(bundleArg.admissions.size).toBe(0)
  })

  it('a v1 (non-handover) message is untouched: cover and settle never run, nothing excluded', async () => {
    const tx = tokenTx()
    const messageBoxClient = fakeMessageBox([
      { messageId: 'm1', body: { assetId: ASSET_ID, amount: '100', sender: 'x', transaction: atomicBeefOf(tx) } }
    ])
    const cover = jest.fn()
    const settle = jest.fn()

    const excluded = await preHoldInboxSettlements({
      messageBoxClient,
      cover: cover as unknown as PreHoldCoverFn,
      settle
    })

    expect(excluded.size).toBe(0)
    expect(cover).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })

  it('a message with no body is untouched', async () => {
    const messageBoxClient = fakeMessageBox([{ messageId: 'm1' }])
    const settle = jest.fn()

    const excluded = await preHoldInboxSettlements({
      messageBoxClient,
      cover: coverAlways([]),
      settle
    })

    expect(excluded.size).toBe(0)
    expect(settle).not.toHaveBeenCalled()
  })

  it('COVER refuses the evidence: settle never runs, and the message is left to the library (not excluded)', async () => {
    const tx = tokenTx()
    const messageBoxClient = fakeMessageBox([{ messageId: 'm1', body: handoverBody(tx) }])
    const settle = jest.fn()

    const excluded = await preHoldInboxSettlements({ messageBoxClient, cover: coverRefuses(), settle })

    // Not excluded: `acceptOne`'s own `coverHandover` runs the identical pure
    // walk over the identical bytes and refuses BEFORE it ever calls
    // internalizeAction, so there is nothing here to guard against.
    expect(excluded.size).toBe(0)
    expect(settle).not.toHaveBeenCalled()
  })

  it('a transaction that will not parse as AtomicBEEF: skipped, left to the library, nothing excluded (decode failure)', async () => {
    const messageBoxClient = fakeMessageBox([
      { messageId: 'm1', body: handoverBody(tokenTx(), { transaction: [1, 2, 3] }) }
    ])
    const cover = jest.fn()
    const settle = jest.fn()

    const excluded = await preHoldInboxSettlements({
      messageBoxClient,
      cover: cover as unknown as PreHoldCoverFn,
      settle
    })

    expect(excluded.size).toBe(0)
    expect(cover).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })

  it('a message missing assetId or a transaction array: skipped, left to the library', async () => {
    const messageBoxClient = fakeMessageBox([
      { messageId: 'm1', body: handoverBody(tokenTx(), { assetId: undefined }) },
      { messageId: 'm2', body: handoverBody(tokenTx(), { transaction: 'not-an-array' }) }
    ])
    const settle = jest.fn()

    const excluded = await preHoldInboxSettlements({
      messageBoxClient,
      cover: coverAlways([]),
      settle
    })

    expect(excluded.size).toBe(0)
    expect(settle).not.toHaveBeenCalled()
  })

  it('FAIL CLOSED: a settlement write that throws excludes that message, and the pass does not throw', async () => {
    const tx = tokenTx()
    const txid = tx.id('hex')
    const messageBoxClient = fakeMessageBox([{ messageId: 'm1', body: handoverBody(tx) }])
    const settle = jest.fn(async () => {
      throw new Error('database is locked')
    })

    const excluded = await preHoldInboxSettlements({ messageBoxClient, cover: coverAlways([txid]), settle })

    expect(excluded).toEqual(new Set(['m1']))
  })

  it('is best-effort per message: one failing write does not stop the rest of the inbox from being pre-held', async () => {
    const bad = tokenTx(10)
    const good = tokenTx(20)
    const messageBoxClient = fakeMessageBox([
      { messageId: 'bad', body: handoverBody(bad) },
      { messageId: 'good', body: handoverBody(good) }
    ])
    const settle = jest.fn(async (args: { txid: string }) => {
      if (args.txid === bad.id('hex')) throw new Error('database is locked')
    })
    const cover = jest.fn((tip: Transaction) => ({
      ok: true,
      mustSubmit: [tip.id('hex')]
    })) as unknown as PreHoldCoverFn

    const excluded = await preHoldInboxSettlements({ messageBoxClient, cover, settle })

    expect(excluded).toEqual(new Set(['bad']))
    expect(settle).toHaveBeenCalledTimes(2)
  })

  it('propagates a whole-pass failure (e.g. listMessages itself failing) to the caller', async () => {
    const messageBoxClient = {
      listMessages: jest.fn(async () => {
        throw new Error('network down')
      }),
      acknowledgeMessage: jest.fn()
    }

    await expect(
      preHoldInboxSettlements({ messageBoxClient, cover: coverAlways([]), settle: jest.fn() })
    ).rejects.toThrow('network down')
  })
})
