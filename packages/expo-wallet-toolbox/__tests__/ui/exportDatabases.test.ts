/**
 * The iOS export is a byte copy of the .db file. The database runs in WAL
 * mode, so without a checkpoint first the copy misses every commit still in
 * the -wal sidecar — the newest payments, exactly what a backup is for.
 */
import { Platform } from 'react-native'
import { exportAllWalletDatabases } from '../../ui/exportDatabases'

const mockEvents: string[] = []

// The package barrel drags in native modules jest cannot parse; same fakes
// every other barrel-importing test uses.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

jest.mock('expo-file-system', () => {
  class File {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/')
    }
    get exists() {
      return true
    }
    copy(_to: unknown) {
      mockEvents.push('copy')
    }
    write(_bytes: unknown) {
      mockEvents.push('write')
    }
  }
  class Directory {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/')
    }
    get exists() {
      return false
    }
    create() {}
    delete() {}
  }
  return { File, Directory, Paths: { cache: { uri: '/cache' } } }
})
jest.mock('expo-sharing', () => ({ shareAsync: async () => undefined }))

const fakeStorage = () =>
  ({
    dbName: 'wallet-0f7ae53f-mainnet-1788405945.db',
    db: { databasePath: '/data/wallet.db', serializeAsync: async () => new Uint8Array(0) },
    checkpointWal: async () => {
      mockEvents.push('checkpoint')
    }
  }) as never

beforeEach(() => {
  mockEvents.length = 0
})

describe('exportAllWalletDatabases on iOS', () => {
  it('checkpoints the WAL before copying the database file', async () => {
    Platform.OS = 'ios'
    const n = await exportAllWalletDatabases(fakeStorage())
    expect(n).toBe(1)
    expect(mockEvents).toEqual(['checkpoint', 'copy'])
  })
})

describe('exportAllWalletDatabases on Android', () => {
  it('serialises the live database, which needs no checkpoint', async () => {
    Platform.OS = 'android'
    const n = await exportAllWalletDatabases(fakeStorage())
    expect(n).toBe(1)
    expect(mockEvents).toEqual(['write'])
  })
})
