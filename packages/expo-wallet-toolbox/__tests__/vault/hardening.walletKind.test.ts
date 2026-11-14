// Own AsyncStorage/SecureStore mocks, matching __tests__/vault/transfers.test.ts:
// vaultStore.ts imports both directly, and neither transforms under jest by
// default (expo-secure-store ships ESM `import` syntax).
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
      }),
      __clear: () => {
        for (const k of Object.keys(store)) delete store[k]
      }
    }
  })()
}))

jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false }))
}))
import fs from 'node:fs'
import path from 'node:path'
import * as SecureStore from 'expo-secure-store'
import { envKey } from '../../core/services/secrets/storage'
import { setMockDriver } from '../../core/services/vault/driver'
import { canSetUpVault, requireMnemonicWallet } from '../../core/services/vault/walletKind'
import { enrollKey, finalizeEnrollment, resumeEnrollmentDraft } from '../../core/services/vault/VaultKeyService'
import { VaultError } from '../../core/services/vault/types'

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const store = SecureStore as unknown as {
  setItemAsync: jest.Mock
  getItemAsync: jest.Mock
  __clear: () => void
}

let driverTouched = 0
function spyDriver(): any {
  return new Proxy(
    {},
    {
      get() {
        driverTouched++
        return () => {
          driverTouched++
          throw new Error('driver must not be used')
        }
      }
    }
  )
}

const put = (name: string) => store.setItemAsync(envKey(name), 'x')

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    return e instanceof VaultError ? e.code : `other:${String(e)}`
  }
  return undefined
}

const enrollArgs: any = {
  pendingSerials: [],
  onPhase: () => {},
  getPin: async () => '123456',
  requestPukChange: async () => ({ oldPuk: '1', newPuk: '2' }),
  acknowledgeDedicatedPivApplication: true,
  wallet: {},
  adminOriginator: 'admin'
}

beforeEach(() => {
  store.__clear()
  driverTouched = 0
  setMockDriver(spyDriver())
})
afterEach(() => setMockDriver(null))

describe('vault setup needs a wallet made from a recovery phrase', () => {
  test('primary-key PoC: a wallet with only a recoveredKey secret: enrollKey refuses with no-mnemonic and never calls the driver', async () => {
    await put('recoveredKey')
    expect(await code(enrollKey(enrollArgs))).toBe('no-mnemonic')
    expect(driverTouched).toBe(0)
  })

  test('finalizeEnrollment and resumeEnrollmentDraft refuse the same way', async () => {
    await put('recoveredKey')
    expect(await code(finalizeEnrollment([], undefined, {} as any))).toBe('no-mnemonic')
    expect(
      await code(
        resumeEnrollmentDraft({
          entry: {} as any,
          onPhase: () => {},
          getPin: async () => '1',
          wallet: {} as any,
          adminOriginator: 'a'
        })
      )
    ).toBe('no-mnemonic')
    expect(driverTouched).toBe(0)
  })

  test('a wallet with a mnemonic secret (and a recoveredKey) is allowed', async () => {
    await put('recoveredKey')
    await put('mnemonic')
    await expect(requireMnemonicWallet()).resolves.toBeUndefined()
    expect(await code(enrollKey(enrollArgs))).not.toBe('no-mnemonic')
  })

  test('neither secret present is allowed (test and dev builds)', async () => {
    await expect(requireMnemonicWallet()).resolves.toBeUndefined()
  })

  test("canSetUpVault returns {ok:false, reason:'no-mnemonic'} for the legacy wallet and {ok:true} otherwise", async () => {
    expect(await canSetUpVault()).toEqual({ ok: true })
    await put('recoveredKey')
    expect(await canSetUpVault()).toEqual({ ok: false, reason: 'no-mnemonic' })
    await put('mnemonic')
    expect(await canSetUpVault()).toEqual({ ok: true })
  })

  test('a keychain read error fails closed with template-invalid', async () => {
    store.getItemAsync.mockImplementationOnce(async () => {
      throw new Error('keychain locked')
    })
    const err = await requireMnemonicWallet().catch(e => e)
    expect(err).toBeInstanceOf(VaultError)
    expect(err.code).toBe('template-invalid')
    expect(err.message).toContain('Could not read the wallet secret state')
  })

  test('shares.ts header and backupShares.ts no longer claim old slices cannot open a vault', () => {
    const shares = fs.readFileSync(path.join(PACKAGE_ROOT, 'core/recovery/shares.ts'), 'utf8')
    const ui = fs.readFileSync(path.join(PACKAGE_ROOT, 'ui/backupShares.ts'), 'utf8')
    expect(shares).not.toContain('and the vault key needs the phrase.')
    expect(shares).toContain('requireMnemonicWallet')
    expect(ui).not.toContain('cannot open a vault')
    expect(ui).toContain('A vault can only be set up on a wallet made from a recovery phrase.')
  })
})
