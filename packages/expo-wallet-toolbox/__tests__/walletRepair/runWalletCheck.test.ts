import { runWalletCheck, type WalletCheckPorts } from '../../core/walletRepair/runWalletCheck'

describe('runWalletCheck', () => {
  it('runs records, coins, proofs, missed_payments in that order', async () => {
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
    expect(order).toEqual(['records-status', 'records-release', 'coins', 'proofs', 'inbox', 'sweep'])
    expect(steps).toEqual(['online', 'records', 'coins', 'proofs', 'missed_payments', 'backup', 'phrase_backup'])
    expect(summary.freedCoins).toBe(3) // 2 released UTXOs + 1 restored input
    expect(summary.recoveredPayments).toBe(1)
    expect(summary.repairedProofs).toBe(1)
    expect(summary.allOk).toBe(true)
    expect(summary.steps.every(s => s.status === 'ok')).toBe(true)
  })

  it('marks a throwing coins port as error and still runs later steps', async () => {
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
    expect(order).toEqual(['records-status', 'records-release', 'coins', 'proofs', 'inbox', 'sweep'])
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
