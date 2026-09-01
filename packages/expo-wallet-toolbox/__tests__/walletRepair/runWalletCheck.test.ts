import { runWalletCheck, type WalletCheckPorts } from '../../core/walletRepair/runWalletCheck'

describe('runWalletCheck', () => {
  it('runs records, coins, proofs, missed_payments in that order', async () => {
    const order: string[] = []
    const ports: WalletCheckPorts = {
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
    expect(steps).toEqual(['records', 'coins', 'proofs', 'missed_payments'])
    expect(summary.freedCoins).toBe(3) // 2 released UTXOs + 1 restored input
    expect(summary.recoveredPayments).toBe(1)
    expect(summary.repairedProofs).toBe(1)
    expect(summary.allOk).toBe(true)
    expect(summary.steps.every(s => s.status === 'ok')).toBe(true)
  })

  it('marks a throwing coins port as error and still runs later steps', async () => {
    const order: string[] = []
    const ports: WalletCheckPorts = {
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
