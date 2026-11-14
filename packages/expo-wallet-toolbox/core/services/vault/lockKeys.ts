/**
 * The key set a NEW Vault lock may commit (hardening: planted-key).
 *
 * Every output-creating path (deposit, partial-withdrawal remainder, re-lock)
 * calls planLockKeys before any tap and before createAction. A key enters a
 * new lock only when it is proven: by a live tap (a durable adoption pair or a
 * session proof, both bound to serial AND pubkey) or by being the key tapped
 * inside this very operation. A chain record alone never proves a key.
 *
 * - deposit: new funds. Every key of the list must be proven, else
 *   `keys-unproven`. The staged key is never part of a deposit.
 * - re-lock / remainder: unproven keys are refused unless the caller accepts
 *   dropping them (after a clear warning). The new lock then holds only the
 *   proven keys. Fewer than two gives `not-enough-proven-keys`. A full
 *   withdrawal creates no lock and never reaches this function, so a lost or
 *   planted key cannot close the exit (R1).
 */
import { VaultError } from './types'
import { vaultStore, type VaultKeyRecord, type VaultMeta, type VaultScopeToken } from './vaultStore'

const MIN_LOCK_KEYS = 2

export interface LockKeyPlan {
  /** Keys committed by the new output, in meta order, staged key last. */
  lockKeys: VaultKeyRecord[]
  /** Keys of meta.keys left out because they are unproven. */
  dropped: VaultKeyRecord[]
  /** The staged key being activated, if any. */
  activated?: VaultKeyRecord
  /** Revision to write into the new record. */
  revision: number
  /** True when meta must be updated after success. */
  changesKeySet: boolean
}

const pairKey = (k: Pick<VaultKeyRecord, 'serial' | 'pubkey'>): string => `${k.serial}:${k.pubkey}`

export function planLockKeys(args: {
  meta: VaultMeta
  scopeToken: VaultScopeToken
  chosenSerial: string
  purpose: 'deposit' | 'relock' | 'remainder'
  /** Serial; must equal meta.staged?.serial. */
  activateStagedKey?: string
  acceptDroppingUnproven?: boolean
}): LockKeyPlan {
  const { meta, scopeToken, chosenSerial, purpose } = args
  const chosen = meta.keys.find(k => k.serial === chosenSerial)
  if (!chosen) throw new VaultError('not-enrolled', `Key ${chosenSerial} is not one of this vault's keys`)
  if (args.activateStagedKey !== undefined && args.activateStagedKey !== meta.staged?.serial) {
    throw new VaultError('not-enrolled', 'The staged key does not match the key to activate')
  }
  // A deposit never takes the staged key: it is committed only by a re-lock
  // signed by an existing key.
  const activated = purpose !== 'deposit' && args.activateStagedKey !== undefined ? meta.staged : undefined

  const proven = new Set(vaultStore.provenKeyRecords(meta, scopeToken).map(pairKey))
  // The chosen key is tapped (a fresh signature is verified) before any funds
  // move; a staged key passed its own live challenge as a ready draft.
  proven.add(pairKey(chosen))
  if (activated) proven.add(pairKey(activated))

  const candidates = [...meta.keys, ...(activated ? [activated] : [])]
  const unproven = candidates.filter(k => !proven.has(pairKey(k)))

  if (purpose === 'deposit') {
    if (unproven.length > 0) throw keysUnproven(unproven)
    return { lockKeys: [...meta.keys], dropped: [], revision: meta.revision, changesKeySet: false }
  }

  if (unproven.length > 0 && args.acceptDroppingUnproven !== true) throw keysUnproven(unproven)
  const lockKeys = candidates.filter(k => proven.has(pairKey(k)))
  if (lockKeys.length < MIN_LOCK_KEYS) {
    throw new VaultError(
      'not-enough-proven-keys',
      `A new vault lock needs at least ${MIN_LOCK_KEYS} keys checked by a tap; ${lockKeys.length} available`,
      undefined,
      { proven: lockKeys.length }
    )
  }
  const sameAsList =
    activated === undefined &&
    lockKeys.length === meta.keys.length &&
    lockKeys.every((k, i) => pairKey(k) === pairKey(meta.keys[i]))
  return {
    lockKeys,
    dropped: meta.keys.filter(k => !proven.has(pairKey(k))),
    ...(activated ? { activated } : {}),
    revision: sameAsList ? meta.revision : meta.revision + 1,
    changesKeySet: !sameAsList
  }
}

function keysUnproven(unproven: VaultKeyRecord[]): VaultError {
  return new VaultError(
    'keys-unproven',
    'A new vault lock cannot include keys that have not been checked by a tap on this phone',
    undefined,
    { serials: unproven.map(k => k.serial).join(',') }
  )
}
