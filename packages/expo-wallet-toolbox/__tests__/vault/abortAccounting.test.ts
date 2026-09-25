/**
 * (no ledger id — found during XQ-016 follow-up work)
 *
 * `abortActions` (core/services/vault/transfers.ts) marked an orphan
 * reference "aborted" — and `freeReservedInputs` reported it "freed" —
 * the instant it decided to CALL `w.abortAction` on it, before awaiting the
 * result, with any rejection swallowed into a `console.log`. A refused or
 * rejected abort therefore counted as a successful free even though the
 * input was never actually released, which the
 * `xq016VaultAbortRealVendorInteraction.test.ts` file documented against the
 * REAL vendor `abortAction`. This file locks the same defect against a
 * lightweight mocked wallet and proves the fix: a refused abort must not be
 * counted as freed.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => {
        store[k] = v
      },
      removeItem: async (k: string) => {
        delete store[k]
      },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => {
        for (const k of keys) delete store[k]
      },
      clear: async () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  ...(() => {
    const store: Record<string, string> = {}
    return {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wutdo',
      getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
      setItemAsync: jest.fn(async (k: string, v: string) => {
        store[k] = v
      }),
      deleteItemAsync: jest.fn(async (k: string) => {
        delete store[k]
      })
    }
  })()
}))
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  requestVaultSigner: jest.fn(),
  noteVaultProgress: jest.fn()
}))
jest.mock('../../core/toolboxConfig', () => ({
  getBackupUrl: jest.fn(() => 'https://backup.example'),
  isVaultEnabled: jest.fn(() => true),
  isVaultAvailable: jest.fn(() => true)
}))
jest.mock('../../core/backup/preference', () => ({
  isBackupPushEnabled: jest.fn(async () => true)
}))

import { freeReservedInputs, type VaultActionRow, type VaultWallet } from '../../core/services/vault/transfers'

const ADMIN = 'admin.example'
const OUTPOINT = `${'11'.repeat(32)}.0`

function walletWithOneOrphan(status: string, abortAction: jest.Mock): VaultWallet {
  const row: VaultActionRow = {
    reference: 'ref-1',
    status,
    inputs: [{ sourceOutpoint: OUTPOINT }]
  }
  return {
    createHmac: jest.fn(),
    createAction: jest.fn(),
    signAction: jest.fn(),
    listOutputs: jest.fn(),
    abortAction,
    listActions: jest.fn(async () => ({ actions: [row], totalActions: 1 })),
    getPublicKey: jest.fn(),
    encrypt: jest.fn(),
    decrypt: jest.fn(),
    internalizeAction: jest.fn()
  } as unknown as VaultWallet
}

// The shape createAction throws when it refuses to spend an outpoint another
// (here, the orphan's) action still reserves — the real trigger for the
// abortReservingOutpoints heal path (see transfers.ts's
// unspendableInputOutpoints).
const wedgedError = new Error(
  `The inputs[0] parameter must be spendable output. output ${OUTPOINT} appears to have been spent (spendable=false). [WERR_INVALID_PARAMETER]`
)

describe('an orphan is counted as freed only when its abort actually succeeds', () => {
  it('does NOT count a refused abort as freed', async () => {
    const abortAction = jest.fn(async () => {
      throw new Error('abortAction refused: chain status unknown')
    })
    const wallet = walletWithOneOrphan('nosend', abortAction)

    const freed = await freeReservedInputs(wallet, ADMIN, wedgedError, [OUTPOINT])

    expect(abortAction).toHaveBeenCalledTimes(1)
    expect(abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    // The load-bearing assertion: a rejected abortAction call must not be
    // reported as a freed reservation. Before the fix this was 1.
    expect(freed).toBe(0)
  })

  it('still counts a genuinely successful abort as freed', async () => {
    const abortAction = jest.fn(async () => ({}))
    const wallet = walletWithOneOrphan('nosend', abortAction)

    const freed = await freeReservedInputs(wallet, ADMIN, wedgedError, [OUTPOINT])

    expect(abortAction).toHaveBeenCalledTimes(1)
    expect(freed).toBe(1)
  })

  it('never calls abortAction twice for the same reference even when its first call is refused', async () => {
    const abortAction = jest.fn(async () => {
      throw new Error('abortAction refused: chain status unknown')
    })
    const wallet = walletWithOneOrphan('nosend', abortAction)

    await freeReservedInputs(wallet, ADMIN, wedgedError, [OUTPOINT])

    expect(abortAction).toHaveBeenCalledTimes(1)
  })
})
