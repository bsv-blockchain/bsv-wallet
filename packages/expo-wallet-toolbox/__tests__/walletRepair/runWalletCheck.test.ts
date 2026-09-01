import { runWalletCheck, type WalletCheckPorts } from '../../core/walletRepair/runWalletCheck'

describe('runWalletCheck', () => {
  it('runs the quick checks first and the long coins scan last', async () => {
    const order: string[] = []
    const ports: WalletCheckPorts = {
      checkOnline: async () => ({ online: true }),
      checkBackup: async () => ({ enabled: true, uploaded: true }),
      checkPhraseBackup: async () => ({ backedUp: true }),
      reviewSpendable: async () => (order.push('coins'), { released: 2, recovered: 0 }),
      checkProofs: async () => (order.push('proofs'), { repaired: 1 }),
      reviewStatus: async () => (order.push('records-status'), { failedTxs: 1, restoredInputs: 1 }),
      releaseStuck: async () => (order.push('records-release'), { released: 0 }),
      creditInbox: async () => (order.push('inbox'), { accepted: 1 }),
      sweepAddresses: async () => (order.push('sweep'), { imported: 0 })
    }
    const steps: string[] = []
    const summary = await runWalletCheck(ports, id => steps.push(id))
    // Coins last: it is the only step that can take minutes, so everything
    // quick has reported before the user is left waiting on anything.
    expect(order).toEqual(['records-status', 'records-release', 'proofs', 'inbox', 'sweep', 'coins'])
    expect(steps).toEqual(['online', 'records', 'proofs', 'backup', 'phrase_backup', 'missed_payments', 'coins'])
    expect(summary.freedCoins).toBe(3) // 2 released UTXOs + 1 restored input
    expect(summary.recoveredPayments).toBe(1)
    expect(summary.repairedProofs).toBe(1)
    expect(summary.allOk).toBe(true)
    expect(summary.steps.every(s => s.status === 'ok')).toBe(true)
  })

  it('marks a throwing coins port as error without stopping the run', async () => {
    const order: string[] = []
    const ports: WalletCheckPorts = {
      checkOnline: async () => ({ online: true }),
      checkBackup: async () => ({ enabled: true, uploaded: true }),
      checkPhraseBackup: async () => ({ backedUp: true }),
      reviewSpendable: async () => {
        order.push('coins')
        throw new Error('offline')
      },
      checkProofs: async () => (order.push('proofs'), { repaired: 0 }),
      reviewStatus: async () => (order.push('records-status'), { failedTxs: 0, restoredInputs: 0 }),
      releaseStuck: async () => (order.push('records-release'), { released: 0 }),
      creditInbox: async () => (order.push('inbox'), { accepted: 0 }),
      sweepAddresses: async () => (order.push('sweep'), { imported: 0 })
    }
    const summary = await runWalletCheck(ports, () => {})
    // Coins last: it is the only step that can take minutes, so everything
    // quick has reported before the user is left waiting on anything.
    expect(order).toEqual(['records-status', 'records-release', 'proofs', 'inbox', 'sweep', 'coins'])
    expect(summary.allOk).toBe(false)
    expect(summary.steps.find(s => s.id === 'coins')?.status).toBe('error')
    expect(summary.steps.find(s => s.id === 'proofs')?.status).toBe('ok')
  })
})

// Offline, no backup and no written-down phrase are answers, not failures.
// Offering Retry for them would point at a button that cannot change them.
describe('checks that report a state rather than a failure', () => {
  const healthy: WalletCheckPorts = {
    checkOnline: async () => ({ online: true }),
    checkBackup: async () => ({ enabled: true, uploaded: true }),
    checkPhraseBackup: async () => ({ backedUp: true }),
    reviewSpendable: async () => ({ released: 0, recovered: 0 }),
    checkProofs: async () => ({ repaired: 0 }),
    reviewStatus: async () => ({ failedTxs: 0, restoredInputs: 0 }),
    releaseStuck: async () => ({ released: 0 }),
    creditInbox: async () => ({ accepted: 0 }),
    sweepAddresses: async () => ({ imported: 0 })
  }
  const statusOf = (r: { steps: { id: string; status: string }[] }, id: string) =>
    r.steps.find(s => s.id === id)?.status

  it('marks offline as attention, not error, and still runs everything after it', async () => {
    const r = await runWalletCheck({ ...healthy, checkOnline: async () => ({ online: false }) }, () => {})
    expect(statusOf(r, 'online')).toBe('attention')
    expect(r.steps).toHaveLength(7)
    expect(r.allOk).toBe(true)
    expect(r.allClear).toBe(false)
  })

  it('marks a backup that was never uploaded, and an opted-out one, as attention', async () => {
    const never = await runWalletCheck(
      { ...healthy, checkBackup: async () => ({ enabled: true, uploaded: false }) },
      () => {}
    )
    expect(statusOf(never, 'backup')).toBe('attention')
    const off = await runWalletCheck(
      { ...healthy, checkBackup: async () => ({ enabled: false, uploaded: false }) },
      () => {}
    )
    expect(statusOf(off, 'backup')).toBe('attention')
  })

  it('marks an unwritten recovery phrase as attention', async () => {
    const r = await runWalletCheck({ ...healthy, checkPhraseBackup: async () => ({ backedUp: false }) }, () => {})
    expect(statusOf(r, 'phrase_backup')).toBe('attention')
    expect(r.allClear).toBe(false)
  })

  it('still calls a throwing check an error, which is what Retry is for', async () => {
    const r = await runWalletCheck(
      {
        ...healthy,
        checkOnline: async () => {
          throw new Error('netinfo unavailable')
        }
      },
      () => {}
    )
    expect(statusOf(r, 'online')).toBe('error')
    expect(r.allOk).toBe(false)
  })

  it('reports a wholly healthy wallet as clear', async () => {
    const r = await runWalletCheck(healthy, () => {})
    expect(r.allOk).toBe(true)
    expect(r.allClear).toBe(true)
  })
})

// The Skip button. A skipped step is not an error and not clear either — its
// answer is simply unknown, which the verdict has to keep saying.
describe('skipping a check', () => {
  const base: WalletCheckPorts = {
    checkOnline: async () => ({ online: true }),
    checkBackup: async () => ({ enabled: true, uploaded: true }),
    checkPhraseBackup: async () => ({ backedUp: true }),
    reviewSpendable: async () => ({ released: 0, recovered: 0 }),
    checkProofs: async () => ({ repaired: 0 }),
    reviewStatus: async () => ({ failedTxs: 0, restoredInputs: 0 }),
    releaseStuck: async () => ({ released: 0 }),
    creditInbox: async () => ({ accepted: 0 }),
    sweepAddresses: async () => ({ imported: 0 })
  }

  /** Mirrors the screen: a set plus one resolver per id, no timers. */
  function controller() {
    const skipped = new Set<string>()
    const waiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()
    const waiterFor = (id: string) => {
      const found = waiters.get(id)
      if (found) return found
      let resolve: () => void = () => {}
      const promise = new Promise<void>(r => {
        resolve = r
      })
      const entry = { promise, resolve }
      waiters.set(id, entry)
      return entry
    }
    return {
      skip: (id: string) => {
        skipped.add(id)
        waiterFor(id).resolve()
      },
      skips: {
        isSkipped: (id: string) => skipped.has(id),
        whenSkipped: (id: string) => waiterFor(id).promise
      }
    }
  }

  it('does not run a step already marked skipped', async () => {
    let ran = false
    const c = controller()
    c.skip('coins')
    const r = await runWalletCheck(
      { ...base, reviewSpendable: async () => ((ran = true), { released: 9, recovered: 0 }) },
      () => {},
      () => {},
      c.skips
    )
    expect(ran).toBe(false)
    expect(r.steps.find(s => s.id === 'coins')?.status).toBe('skipped')
    // Nothing was released, so nothing may be claimed.
    expect(r.freedCoins).toBe(0)
  })

  it('stops waiting on a step skipped while it is still running', async () => {
    const c = controller()
    let released: (v: { released: number; recovered: number }) => void = () => {}
    const r = await runWalletCheck(
      {
        ...base,
        // Never settles on its own: only the skip can end this step, which is
        // the whole point of the button.
        reviewSpendable: () =>
          new Promise(resolve => {
            released = resolve
            c.skip('coins')
          })
      },
      () => {},
      () => {},
      c.skips
    )
    expect(r.steps.find(s => s.id === 'coins')?.status).toBe('skipped')
    expect(r.freedCoins).toBe(0)
    // The abandoned work finishing later must not resurrect its result.
    released({ released: 9, recovered: 0 })
    expect(r.freedCoins).toBe(0)
  })

  // Skipping is the user's own choice; answering it with "some checks need
  // your attention" treats their decision as a fault.
  it('still reads as clear when the only non-ok steps were skipped', async () => {
    const c = controller()
    c.skip('coins')
    const r = await runWalletCheck(base, () => {}, () => {}, c.skips)
    expect(r.allOk).toBe(true)
    expect(r.allClear).toBe(true)
  })

  it('does not call a run clear when nothing was actually checked', async () => {
    const c = controller()
    for (const id of ['online', 'records', 'proofs', 'missed_payments', 'backup', 'phrase_backup', 'coins']) {
      c.skip(id)
    }
    const r = await runWalletCheck(base, () => {}, () => {}, c.skips)
    expect(r.steps.every(s => s.status === 'skipped')).toBe(true)
    expect(r.allClear).toBe(false)
  })

  it('a real finding still outweighs a skip', async () => {
    const c = controller()
    c.skip('coins')
    const r = await runWalletCheck(
      { ...base, checkPhraseBackup: async () => ({ backedUp: false }) },
      () => {},
      () => {},
      c.skips
    )
    expect(r.allClear).toBe(false)
  })

  it('runs every step when nothing is skipped', async () => {
    const r = await runWalletCheck(base, () => {}, () => {}, controller().skips)
    expect(r.steps.map(s => s.status)).toEqual(Array(7).fill('ok'))
    expect(r.allClear).toBe(true)
  })
})
