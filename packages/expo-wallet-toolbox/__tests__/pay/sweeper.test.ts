import {
  SWEEP_BACKOFF_TICKS,
  SWEEP_INTERVAL_MS,
  backoffAfterSweepError,
  consumeBackoff,
  runSweep,
  shouldSweepNow,
  sweptTotal
} from '../../core/pay/sweeper'
import { WocRateLimited, wocConfigFor } from '../../core/pay/rails/address'
import { getWatchlist, watchAddress } from '../../core/pay/watchlist'

jest.mock('../../core/pay/rails/address', () => {
  const actual = jest.requireActual('../../core/pay/rails/address')
  return { ...actual, sweepAddress: jest.fn() }
})
// The mock has to be reached through require, not an import: the import above is
// hoisted above jest.mock's factory, so a `sweepAddress` binding taken there
// would be captured before the factory ever runs. wocConfigFor stays real via
// the requireActual spread.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sweepAddress } = require('../../core/pay/rails/address') as { sweepAddress: jest.Mock }

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const woc = wocConfigFor('main')
const wallet = {} as never

// The watchlist's date cap is a calendar-day comparison against *now*, so a
// literal date here would silently stop being swept a week after it was typed.
const TODAY = new Date().toISOString().slice(0, 10)

beforeEach(() => {
  sweepAddress.mockReset()
})

describe('shouldSweepNow', () => {
  const ok = { walletBuilt: true, appActive: true, online: true, inFlight: false }

  it('allows a pass when the wallet is built, the app is foreground and the device is online', () => {
    expect(shouldSweepNow(ok)).toBe(true)
  })

  it('refuses before the wallet is built', () => {
    expect(shouldSweepNow({ ...ok, walletBuilt: false })).toBe(false)
  })

  it('refuses in the background — no polling while the user is elsewhere', () => {
    expect(shouldSweepNow({ ...ok, appActive: false })).toBe(false)
  })

  it('refuses while offline', () => {
    expect(shouldSweepNow({ ...ok, online: false })).toBe(false)
  })

  it('refuses while a pass is already running', () => {
    expect(shouldSweepNow({ ...ok, inFlight: true })).toBe(false)
  })

  it('pins the interval: 5 s, foreground only, because address payments get no push', () => {
    expect(SWEEP_INTERVAL_MS).toBe(5_000)
  })
})

describe('runSweep', () => {
  it('does nothing when the watchlist is empty', async () => {
    const s = fakeStorage()
    await expect(runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })).resolves.toEqual([])
    expect(sweepAddress).not.toHaveBeenCalled()
  })

  it('sweeps each watched address with its stored derivation prefix', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'prefix-a' })
    sweepAddress.mockResolvedValue({ importedSatoshis: 0, failureCount: 0 })

    await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })

    expect(sweepAddress).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'addr-a', derivationPrefix: 'prefix-a', adminOriginator: 'admin.com' })
    )
  })

  it('reports what it imported', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'p' })
    sweepAddress.mockResolvedValue({ importedSatoshis: 1500, failureCount: 0 })

    await expect(runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })).resolves.toEqual([
      { address: 'addr-a', importedSatoshis: 1500, failureCount: 0 }
    ])
  })

  it('keeps a swept address alive, so a second payment to it is still caught', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'p' })
    const before = (await getWatchlist(s))[0].lastActivityAt
    await new Promise(r => setTimeout(r, 5))
    sweepAddress.mockResolvedValue({ importedSatoshis: 10, failureCount: 0 })

    await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })

    expect((await getWatchlist(s))[0].lastActivityAt >= before).toBe(true)
  })

  it('does not touch an address that received nothing', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'p' })
    const before = (await getWatchlist(s))[0].lastActivityAt
    sweepAddress.mockResolvedValue({ importedSatoshis: 0, failureCount: 0 })

    await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })

    expect((await getWatchlist(s))[0].lastActivityAt).toBe(before)
  })

  it('keeps an address alive when on-chain UTXOs were found even if import failed', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'p' })
    const before = (await getWatchlist(s))[0].lastActivityAt
    await new Promise(r => setTimeout(r, 5))
    sweepAddress.mockResolvedValue({ importedSatoshis: 0, failureCount: 1, foundOnChain: true })

    await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })

    expect((await getWatchlist(s))[0].lastActivityAt).not.toBe(before)
  })

  it('carries on to the next address when one throws', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'p' })
    await watchAddress(s, { address: 'addr-b', date: TODAY, derivationPrefix: 'q' })
    sweepAddress.mockRejectedValueOnce(new Error('woc down')).mockResolvedValueOnce({
      importedSatoshis: 20,
      failureCount: 0
    })

    const outcomes = await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].importedSatoshis).toBe(20)
  })
})

describe('runSweep on a WhatsOnChain rate limit', () => {
  it('rethrows WocRateLimited and stops the pass, so the other addresses are not fetched', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'p' })
    await watchAddress(s, { address: 'addr-b', date: TODAY, derivationPrefix: 'q' })
    sweepAddress.mockRejectedValue(new WocRateLimited())

    await expect(runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })).rejects.toBeInstanceOf(
      WocRateLimited
    )
    expect(sweepAddress).toHaveBeenCalledTimes(1)
  })

  it('still swallows every other error, including one after an address that paid out', async () => {
    const s = fakeStorage()
    await watchAddress(s, { address: 'addr-a', date: TODAY, derivationPrefix: 'p' })
    await watchAddress(s, { address: 'addr-b', date: TODAY, derivationPrefix: 'q' })
    // Keyed on the address, not call order: the watchlist does not promise to
    // be walked in the order it was written.
    sweepAddress.mockImplementation(async ({ address }: { address: string }) => {
      if (address === 'addr-b') throw new Error('HTTP 500')
      return { importedSatoshis: 5, failureCount: 0 }
    })

    const outcomes = await runSweep({ wallet, storage: s, adminOriginator: 'admin.com', woc })
    expect(outcomes).toEqual([{ address: 'addr-a', importedSatoshis: 5, failureCount: 0 }])
    expect(sweepAddress).toHaveBeenCalledTimes(2)
  })
})

describe('rate-limit backoff', () => {
  it('is six ticks: 30 s at the 5 s interval', () => {
    expect(SWEEP_BACKOFF_TICKS).toBe(6)
    expect(SWEEP_BACKOFF_TICKS * SWEEP_INTERVAL_MS).toBe(30_000)
  })

  it('runs the tick when nothing is pending', () => {
    expect(consumeBackoff(0)).toEqual({ skip: false, remaining: 0 })
  })

  it('skips exactly the pending ticks, then runs again', () => {
    let remaining = SWEEP_BACKOFF_TICKS
    let skipped = 0
    for (;;) {
      const step = consumeBackoff(remaining)
      remaining = step.remaining
      if (!step.skip) break
      skipped++
    }
    expect(skipped).toBe(6)
    expect(remaining).toBe(0)
  })

  it('starts a full backoff on a rate limit', () => {
    expect(backoffAfterSweepError(new WocRateLimited(), 0)).toBe(SWEEP_BACKOFF_TICKS)
  })

  it('leaves the backoff alone for any other error, so those stay best-effort', () => {
    expect(backoffAfterSweepError(new Error('woc down'), 0)).toBe(0)
    expect(backoffAfterSweepError('boom', 2)).toBe(2)
  })
})

describe('sweptTotal', () => {
  it('sums imported satoshis', () => {
    expect(
      sweptTotal([
        { address: 'a', importedSatoshis: 100, failureCount: 0 },
        { address: 'b', importedSatoshis: 50, failureCount: 1 }
      ])
    ).toBe(150)
  })

  it('is zero for an empty pass', () => {
    expect(sweptTotal([])).toBe(0)
  })
})
