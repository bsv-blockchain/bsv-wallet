import { VaultError } from './types'

/** Issued only by `checkVaultCardFunds` (through `issueResetClearance`). */
export interface VaultResetClearance {
  readonly serial: string
  readonly storageKey: string
  readonly issuedAt: number
}

/** How long a clearance stays valid. */
export const VAULT_RESET_CLEARANCE_MS = 10 * 60 * 1000

// Membership proves the object came from issueResetClearance. A hand-made object with the same fields is not in the set.
const issued = new WeakSet<object>()

export function issueResetClearance(serial: string, storageKey: string, now: number = Date.now()): VaultResetClearance {
  const clearance: VaultResetClearance = Object.freeze({ serial, storageKey, issuedAt: now })
  issued.add(clearance)
  return clearance
}

// The one validity test. `serial` undefined means "the serial is not known yet": it is then not compared.
function clearanceMatches(
  clearance: VaultResetClearance | undefined,
  serial: string | undefined,
  storageKey: string,
  now: number
): boolean {
  if (!clearance || !issued.has(clearance)) return false
  if (clearance.storageKey !== storageKey) return false
  if (serial !== undefined && clearance.serial !== serial) return false
  const age = now - clearance.issuedAt
  return age >= 0 && age <= VAULT_RESET_CLEARANCE_MS
}

export function isValidResetClearance(
  clearance: VaultResetClearance | undefined,
  serial: string,
  storageKey: string,
  now: number = Date.now()
): boolean {
  return clearanceMatches(clearance, serial, storageKey, now)
}

/**
 * The one gate in front of every operation that destroys the key in a YubiKey's Vault slot (a PIV reset, and
 * enrollKey with replaceOccupiedVaultSlot). Passes with the owner's affirmation (`acknowledgeFundsLoss: true`)
 * or an issued, fresh clearance for this wallet. With `serial` undefined (before the card is read) the
 * clearance's own serial is not compared; the caller checks again with the tapped serial.
 */
export function requireFundsGate(
  args: { fundsClearance?: VaultResetClearance; acknowledgeFundsLoss?: true },
  scope: { storageKey: string },
  serial: string | undefined,
  now: number = Date.now()
): void {
  if (args.acknowledgeFundsLoss === true) return
  if (!clearanceMatches(args.fundsClearance, serial, scope.storageKey, now)) {
    throw new VaultError(
      'chain-check-required',
      'Check the chain for funds on this YubiKey before resetting it',
      undefined,
      serial === undefined ? undefined : { serial }
    )
  }
}
