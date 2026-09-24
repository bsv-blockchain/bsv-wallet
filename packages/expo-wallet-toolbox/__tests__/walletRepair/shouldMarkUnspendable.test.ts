import { shouldMarkUnspendable } from '../../core/walletRepair/shouldMarkUnspendable'

const wocSpent = { status: 'success' as const, isUtxo: false }
const wocUnspent = { status: 'success' as const, isUtxo: true }
const utxoStatusNotUtxo = { status: 'success' as const, isUtxo: false }
const utxoStatusIsUtxo = { status: 'success' as const, isUtxo: true }

it('marks unspendable when WoC reports spent-with-txid and the second source agrees it is not a utxo', () => {
  expect(shouldMarkUnspendable({ wocProbe: wocSpent, wocSpendingTxid: 'abc', utxoStatus: utxoStatusNotUtxo })).toBe(
    true
  )
})

it('does not mark unspendable when the second source still reports it as a utxo', () => {
  expect(shouldMarkUnspendable({ wocProbe: wocSpent, wocSpendingTxid: 'abc', utxoStatus: utxoStatusIsUtxo })).toBe(
    false
  )
})

it('does not mark unspendable on a WoC 404 (unspent)', () => {
  expect(
    shouldMarkUnspendable({ wocProbe: wocUnspent, wocSpendingTxid: undefined, utxoStatus: utxoStatusNotUtxo })
  ).toBe(false)
})

it('does not mark unspendable when WoC has no spending txid', () => {
  expect(shouldMarkUnspendable({ wocProbe: wocSpent, wocSpendingTxid: undefined, utxoStatus: utxoStatusNotUtxo })).toBe(
    false
  )
})

it('does not mark unspendable when the second source errored', () => {
  expect(shouldMarkUnspendable({ wocProbe: wocSpent, wocSpendingTxid: 'abc', utxoStatus: { status: 'error' } })).toBe(
    false
  )
})
