// A key removal stayed on "re-lock sent" after its re-lock was mined (1.0.6). The toolbox's
// finalize step refused while ANY failed Vault spend was in the wallet's history, and a failed
// action never leaves it: six re-lock attempts that were aborted before the key signed them, and
// four old withdrawals, kept the tombstone for good.
//
// A failed Vault spend now blocks only when it could still matter to THIS removal: it was signed
// (it has a transaction ID) and it began at or after the removal did.
import { failedVaultSpendBlocksRemoval } from '../../core/services/vault/failedVaultSpend'

const removalStarted = Date.parse('2026-11-15T15:25:40.000Z')

describe('which failed Vault spends hold a key removal open', () => {
  test('an attempt that was never signed does not: only the key signs a Vault input', () => {
    // the re-lock attempts the wallet aborted before any tap, during the removal
    expect(failedVaultSpendBlocksRemoval({ created_at: '2026-11-15T15:25:42.661Z' }, removalStarted)).toBe(false)
    expect(failedVaultSpendBlocksRemoval({ txid: '', created_at: '2026-11-16T16:40:43.992Z' }, removalStarted)).toBe(
      false
    )
    expect(failedVaultSpendBlocksRemoval({ txid: undefined }, removalStarted)).toBe(false)
  })

  test('a signed spend from before the removal does not: the accepted re-lock spent what it could have', () => {
    expect(
      failedVaultSpendBlocksRemoval({ txid: '44c4'.repeat(16), created_at: '2026-10-01T01:29:07.349Z' }, removalStarted)
    ).toBe(false)
    expect(
      failedVaultSpendBlocksRemoval(
        { txid: 'cd58'.repeat(16), created_at: new Date('2026-10-23T17:23:10.420Z') },
        removalStarted
      )
    ).toBe(false)
  })

  test('a signed spend that failed during the removal does: it may have reached the network', () => {
    expect(
      failedVaultSpendBlocksRemoval({ txid: 'ab'.repeat(32), created_at: '2026-11-15T15:25:40.000Z' }, removalStarted)
    ).toBe(true)
    expect(
      failedVaultSpendBlocksRemoval({ txid: 'ab'.repeat(32), created_at: '2026-11-16T20:04:30.976Z' }, removalStarted)
    ).toBe(true)
  })

  test('a signed spend with no readable time does: when it cannot be placed, it blocks', () => {
    expect(failedVaultSpendBlocksRemoval({ txid: 'ab'.repeat(32) }, removalStarted)).toBe(true)
    expect(failedVaultSpendBlocksRemoval({ txid: 'ab'.repeat(32), created_at: 'not a date' }, removalStarted)).toBe(
      true
    )
    expect(
      failedVaultSpendBlocksRemoval({ txid: 'ab'.repeat(32), created_at: '2026-10-01T01:29:07.349Z' }, Number.NaN)
    ).toBe(true)
  })
})
