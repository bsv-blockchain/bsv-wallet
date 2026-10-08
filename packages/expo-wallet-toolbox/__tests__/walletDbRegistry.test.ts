/**
 * XQ-008: "Delete Wallet" (WalletContext.tsx's logout()) closed the SQLite
 * connection via storage.destroy() but never deleted the underlying .db
 * file(s) or cleared their walletDbRegistry entry — both survived
 * indefinitely, and the file silently reattached with full prior history if
 * the same mnemonic was ever built again on the same device.
 *
 * purgeRegisteredDbFiles is the fix's core: given the wallet's current
 * dbName, delete every filename this identity+chain's registry knows about
 * (via a host-supplied delete callback) and clear their registry entries.
 */
// The repo's jest mock for this package (jest/async-storage-mock.js) is a
// plain CJS `module.exports = asMock`, with no `.default`. A compiled `import
// X from '...'` gets Babel's interop for that automatically, but
// walletDbRegistry.ts's lazy `require(...).default` (needed to keep a native
// module out of the barrel's eager import graph) does not — so it sees
// `undefined` unless `.default` is added here, test-locally. Same workaround
// as __tests__/ui/importDatabases.test.ts, which exercises the same module.
jest.mock('@react-native-async-storage/async-storage', () => {
  const actual = jest.requireActual('@react-native-async-storage/async-storage')
  return { ...actual, default: actual }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  getAllRegisteredDbs,
  getRegisteredDbs,
  registerDb,
  purgeRegisteredDbFiles,
  purgeIdentityDbFiles
} from '../core/walletDbRegistry'

const KEY_SUFFIX = 'deadbeef'
const CHAIN = 'main'
const CURRENT_DB = `wallet-${KEY_SUFFIX}-${CHAIN}net-1700000100.db`

beforeEach(async () => {
  // walletDbRegistry lazy-requires the same (globally mocked, in-memory)
  // AsyncStorage module — clear it so each test starts from an empty registry.
  await AsyncStorage.clear()
})

describe('XQ-008: purgeRegisteredDbFiles deletes every registered wallet db and clears the registry', () => {
  it('deletes every registered file and clears the registry entirely', async () => {
    const olderDb = `wallet-${KEY_SUFFIX}-${CHAIN}net-1700000000.db`
    await registerDb(KEY_SUFFIX, CHAIN, olderDb)
    await registerDb(KEY_SUFFIX, CHAIN, CURRENT_DB)

    const deleted: string[] = []
    await purgeRegisteredDbFiles(CURRENT_DB, async name => {
      deleted.push(name)
    })

    expect(deleted.sort()).toEqual([CURRENT_DB, olderDb].sort())
    expect(await getRegisteredDbs(KEY_SUFFIX, CHAIN)).toEqual([])
  })

  it('also deletes the current db file when the registry never recorded it', async () => {
    // Defensive case named in the fix: the registry (for any reason) does not
    // list the file currently open — it must still be deleted, not skipped.
    const deleted: string[] = []
    await purgeRegisteredDbFiles(CURRENT_DB, async name => {
      deleted.push(name)
    })

    expect(deleted).toEqual([CURRENT_DB])
  })

  it('does not touch a different identity/chain\'s registry', async () => {
    const otherDb = `wallet-cafebabe-${CHAIN}net-1700000000.db`
    await registerDb('cafebabe', CHAIN, otherDb)

    await purgeRegisteredDbFiles(CURRENT_DB, async () => {})

    expect(await getRegisteredDbs('cafebabe', CHAIN)).toEqual([otherDb])
  })

  it('is a no-op for a dbName that is not a valid wallet db filename', async () => {
    const deleteFile = jest.fn(async () => {})
    await purgeRegisteredDbFiles('not-a-wallet-db.sqlite', deleteFile)
    expect(deleteFile).not.toHaveBeenCalled()
  })

  it('keeps purging remaining files when one delete rejects', async () => {
    const olderDb = `wallet-${KEY_SUFFIX}-${CHAIN}net-1700000000.db`
    await registerDb(KEY_SUFFIX, CHAIN, olderDb)
    await registerDb(KEY_SUFFIX, CHAIN, CURRENT_DB)

    const deleted: string[] = []
    await purgeRegisteredDbFiles(CURRENT_DB, async name => {
      if (name === olderDb) throw new Error('native fs error')
      deleted.push(name)
    })

    expect(deleted).toEqual([CURRENT_DB])
    // The registry entry is still cleared even though the file delete failed —
    // this is best-effort cleanup of already-inert bookkeeping, not a gate.
    expect(await getRegisteredDbs(KEY_SUFFIX, CHAIN)).toEqual([])
  })
})

describe('purgeIdentityDbFiles: Delete Wallet reaches every profile on every network', () => {
  it('deletes and unregisters every chain\'s files for that identity only', async () => {
    const files = {
      main: `wallet-${KEY_SUFFIX}-mainnet-1700000000.db`,
      test: `wallet-${KEY_SUFFIX}-testnet-1700000000.db`,
      teratest: `wallet-${KEY_SUFFIX}-teratestnet-1700000000.db`,
      scaletest: `wallet-${KEY_SUFFIX}-scaletestnet-1700000000.db`
    }
    for (const [chain, file] of Object.entries(files)) await registerDb(KEY_SUFFIX, chain, file)
    await registerDb('cafebabe', 'main', 'wallet-cafebabe-mainnet-1700000000.db')

    const deleted: string[] = []
    await purgeIdentityDbFiles(KEY_SUFFIX, async name => {
      deleted.push(name)
    })

    expect(deleted.sort()).toEqual(Object.values(files).sort())
    for (const chain of Object.keys(files)) expect(await getRegisteredDbs(KEY_SUFFIX, chain)).toEqual([])
    expect(await getRegisteredDbs('cafebabe', 'main')).toEqual(['wallet-cafebabe-mainnet-1700000000.db'])
  })

  it('keeps going when one delete fails', async () => {
    await registerDb(KEY_SUFFIX, 'main', 'a.db')
    await registerDb(KEY_SUFFIX, 'test', 'b.db')
    const deleted: string[] = []
    await purgeIdentityDbFiles(KEY_SUFFIX, async name => {
      if (name === 'a.db') throw new Error('locked')
      deleted.push(name)
    })
    expect(deleted).toEqual(['b.db'])
    expect(await getRegisteredDbs(KEY_SUFFIX, 'main')).toEqual([])
  })
})

describe('purgeIdentityDbFiles for a removed profile', () => {
  const notDeleted = new Error("Unable to delete the database file for 'a.db' database")

  it('keeps the registry entry of a file that could not be deleted, which is how the startup retry finds it again', async () => {
    await registerDb(KEY_SUFFIX, 'main', 'a.db')
    await registerDb(KEY_SUFFIX, 'test', 'b.db')
    const deleted: string[] = []
    const clean = await purgeIdentityDbFiles(
      KEY_SUFFIX,
      async name => {
        if (name === 'a.db') throw notDeleted
        deleted.push(name)
      },
      { keepFailed: true }
    )
    expect(clean).toBe(false)
    expect(deleted).toEqual(['b.db'])
    expect(await getRegisteredDbs(KEY_SUFFIX, 'main')).toEqual(['a.db'])
    expect(await getRegisteredDbs(KEY_SUFFIX, 'test')).toEqual([])
  })

  it('finishes the job on the retry, once the file can be deleted', async () => {
    await registerDb(KEY_SUFFIX, 'main', 'a.db')
    let locked = true
    const deleteFile = async () => {
      if (locked) throw notDeleted
    }
    expect(await purgeIdentityDbFiles(KEY_SUFFIX, deleteFile, { keepFailed: true })).toBe(false)
    locked = false
    expect(await purgeIdentityDbFiles(KEY_SUFFIX, deleteFile, { keepFailed: true })).toBe(true)
    expect(await getRegisteredDbs(KEY_SUFFIX, 'main')).toEqual([])
  })

  it.each([
    ["Android", "Database 'a.db' not found"],
    ['iOS', 'Database /var/mobile/Containers/Data/SQLite/a.db not found']
  ])('a file that is already gone (%s) counts as deleted, and its entry goes', async (_platform, message) => {
    await registerDb(KEY_SUFFIX, 'main', 'a.db')
    const clean = await purgeIdentityDbFiles(
      KEY_SUFFIX,
      async () => {
        throw new Error(message)
      },
      { keepFailed: true }
    )
    expect(clean).toBe(true)
    expect(await getRegisteredDbs(KEY_SUFFIX, 'main')).toEqual([])
  })

  it('a file that is still open cannot be deleted, so it stays registered', async () => {
    await registerDb(KEY_SUFFIX, 'main', 'a.db')
    const clean = await purgeIdentityDbFiles(
      KEY_SUFFIX,
      async () => {
        throw new Error("Unable to delete database 'a.db' that is currently open. Close it prior to deletion.")
      },
      { keepFailed: true }
    )
    expect(clean).toBe(false)
    expect(await getRegisteredDbs(KEY_SUFFIX, 'main')).toEqual(['a.db'])
  })

  it('Delete Wallet is unchanged: without the option the entry is cleared whatever the delete did, and it still says so', async () => {
    await registerDb(KEY_SUFFIX, 'main', 'a.db')
    const clean = await purgeIdentityDbFiles(KEY_SUFFIX, async () => {
      throw notDeleted
    })
    expect(clean).toBe(false)
    expect(await getRegisteredDbs(KEY_SUFFIX, 'main')).toEqual([])
  })
})

describe('getAllRegisteredDbs', () => {
  it('lists the files of every network for one identity, and no other identity’s', async () => {
    await registerDb(KEY_SUFFIX, 'main', `wallet-${KEY_SUFFIX}-mainnet-1700000000.db`)
    await registerDb(KEY_SUFFIX, 'main', `wallet-${KEY_SUFFIX}-mainnet-1700000050.db`)
    await registerDb(KEY_SUFFIX, 'test', `wallet-${KEY_SUFFIX}-testnet-1700000000.db`)
    await registerDb(KEY_SUFFIX, 'teratest', `wallet-${KEY_SUFFIX}-teratestnet-1700000000.db`)
    await registerDb(KEY_SUFFIX, 'scaletest', `wallet-${KEY_SUFFIX}-scaletestnet-1700000000.db`)
    await registerDb('cafebabe', 'main', 'wallet-cafebabe-mainnet-1700000000.db')
    expect((await getAllRegisteredDbs(KEY_SUFFIX)).sort()).toEqual(
      [
        `wallet-${KEY_SUFFIX}-mainnet-1700000000.db`,
        `wallet-${KEY_SUFFIX}-mainnet-1700000050.db`,
        `wallet-${KEY_SUFFIX}-testnet-1700000000.db`,
        `wallet-${KEY_SUFFIX}-teratestnet-1700000000.db`,
        `wallet-${KEY_SUFFIX}-scaletestnet-1700000000.db`
      ].sort()
    )
    expect(await getAllRegisteredDbs('00000000')).toEqual([])
  })
})
