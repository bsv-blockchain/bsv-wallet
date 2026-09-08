import React from 'react'
import { act, render } from '@testing-library/react-native'
import LocalStorageProvider, {
  type LocalStorageContextType,
  useLocalStorage
} from '../../core/context/LocalStorageProvider'

const mockEncrypted = new Map<string, string>()
const mockLegacy = new Map<string, string>()
const mockMigrate = jest.fn()
const mockPutSecret = jest.fn()
const mockAutoUnlock = jest.fn()
const mockHasAnySecret = jest.fn()

jest.mock('../../core/i18n/translations', () => ({ t: (key: string) => key }))
jest.mock('../../core/services/secrets', () => ({
  autoUnlockKek: (...args: unknown[]) => mockAutoUnlock(...args),
  deleteAllSecrets: jest.fn(),
  deleteSecret: jest.fn(),
  getSecret: jest.fn(async () => null),
  getUnlockState: () => ({ status: 'locked' }),
  hasAnySecret: (...args: unknown[]) => mockHasAnySecret(...args),
  hasSecret: async (name: string) => mockEncrypted.has(name),
  isUnlocked: () => false,
  migrateLegacySecrets: () => mockMigrate(),
  putSecret: (...args: unknown[]) => mockPutSecret(...args),
  readLegacySecret: async (name: string) => mockLegacy.get(name) ?? null,
  subscribeUnlockState: () => () => {},
  unlockKek: jest.fn()
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function renderStorage() {
  let context!: LocalStorageContextType
  function Observe() {
    context = useLocalStorage()
    return null
  }
  const renderer = render(<LocalStorageProvider><Observe /></LocalStorageProvider>)
  await act(async () => {})
  return { get context() { return context }, renderer }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockEncrypted.clear()
  mockLegacy.clear()
  mockMigrate.mockResolvedValue({ outcome: 'not-needed' })
  mockHasAnySecret.mockImplementation(async () => mockEncrypted.size > 0)
  mockPutSecret.mockImplementation(async (name: string, value: string) => {
    mockEncrypted.set(name, value)
    return true
  })
})

it('rejects fresh creation until migration finishes, including through an earlier callback', async () => {
  const migration = deferred<{ outcome: 'not-needed' }>()
  mockMigrate.mockReturnValue(migration.promise)
  const storage = await renderStorage()
  const create = storage.context.createMnemonic

  expect(storage.context.secretsReady).toBe(false)
  expect(await create('new test mnemonic')).toBe(false)
  expect(mockPutSecret).not.toHaveBeenCalled()

  await act(async () => migration.resolve({ outcome: 'not-needed' }))
  expect(storage.context.secretsReady).toBe(true)
  expect(await create('new test mnemonic')).toBe(true)
  expect(mockEncrypted.get('mnemonic')).toBe('new test mnemonic')
})

it.each(['mnemonic', 'recoveredKey'])('preserves an encrypted %s while the wallet is locked', async name => {
  mockEncrypted.set(name, 'existing test identity')
  const { context } = await renderStorage()

  expect(context.unlockState.status).toBe('locked')
  expect(await context.createMnemonic('new test mnemonic')).toBe(false)
  expect(await context.hasStoredIdentity()).toBe(true)
  expect(mockEncrypted.get(name)).toBe('existing test identity')
  expect(mockPutSecret).not.toHaveBeenCalled()
  expect(mockAutoUnlock).not.toHaveBeenCalled()
})

it.each([
  ['mnemonic', 'failed'],
  ['recoveredKey', 'failed'],
  ['mnemonic', 'not-needed'],
  ['recoveredKey', 'not-needed']
])('preserves a legacy %s when migration reports %s', async (name, outcome) => {
  mockLegacy.set(name, 'existing legacy identity')
  mockMigrate.mockResolvedValue(outcome === 'failed'
    ? { outcome: 'failed', stage: 'provision', retryable: true }
    : { outcome: 'not-needed' })
  const { context } = await renderStorage()

  expect(await context.createMnemonic('new test mnemonic')).toBe(false)
  expect(await context.hasStoredIdentity()).toBe(true)
  expect(mockLegacy.get(name)).toBe('existing legacy identity')
  expect(mockPutSecret).not.toHaveBeenCalled()
})

it('preserves encrypted identities even when migration failed and legacy fallback is active', async () => {
  mockEncrypted.set('recoveredKey', 'existing encrypted identity')
  mockMigrate.mockResolvedValue({ outcome: 'failed', stage: 'unknown', retryable: true })
  const { context } = await renderStorage()

  expect(await context.hasStoredIdentity()).toBe(true)
  expect(await context.createMnemonic('new test mnemonic')).toBe(false)
  expect(mockPutSecret).not.toHaveBeenCalled()
})

it('refuses fresh creation after a failed migration even when no identity is readable', async () => {
  mockMigrate.mockResolvedValue({ outcome: 'failed', stage: 'unknown', retryable: true })
  const { context } = await renderStorage()

  expect(context.secretsReady).toBe(true)
  expect(await context.createMnemonic('new test mnemonic')).toBe(false)
  expect(mockPutSecret).not.toHaveBeenCalled()
})

it('does not write when checking storage fails and allows a later verified retry', async () => {
  mockHasAnySecret.mockRejectedValueOnce(new Error('storage unavailable'))
  const { context } = await renderStorage()

  await expect(context.createMnemonic('new test mnemonic')).rejects.toThrow('storage unavailable')
  expect(mockPutSecret).not.toHaveBeenCalled()
  expect(await context.createMnemonic('verified retry mnemonic')).toBe(true)
  expect(mockEncrypted.get('mnemonic')).toBe('verified retry mnemonic')
})

it('allows an empty installation to create exactly one identity', async () => {
  const { context } = await renderStorage()

  expect(await context.createMnemonic('first test mnemonic')).toBe(true)
  expect(await context.createMnemonic('second test mnemonic')).toBe(false)
  expect(mockEncrypted.get('mnemonic')).toBe('first test mnemonic')
  expect(mockPutSecret).toHaveBeenCalledTimes(1)
})

it('rejects overlapping creation callbacks while the first write is pending', async () => {
  const write = deferred<boolean>()
  mockPutSecret.mockImplementation(async (name: string, value: string) => {
    const saved = await write.promise
    if (saved) mockEncrypted.set(name, value)
    return saved
  })
  const { context } = await renderStorage()

  const first = context.createMnemonic('first test mnemonic')
  expect(await context.createMnemonic('second test mnemonic')).toBe(false)
  await act(async () => {})
  expect(mockPutSecret).toHaveBeenCalledTimes(1)
  expect(mockEncrypted.size).toBe(0)

  write.resolve(true)
  expect(await first).toBe(true)
  expect(mockEncrypted.get('mnemonic')).toBe('first test mnemonic')
})

it('shares the creation guard across overlapping providers', async () => {
  const write = deferred<boolean>()
  mockPutSecret.mockReturnValue(write.promise)
  const firstProvider = await renderStorage()
  const secondProvider = await renderStorage()

  const first = firstProvider.context.createMnemonic('first test mnemonic')
  expect(await secondProvider.context.createMnemonic('second test mnemonic')).toBe(false)
  await act(async () => {})
  expect(mockPutSecret).toHaveBeenCalledTimes(1)

  write.resolve(true)
  expect(await first).toBe(true)
})

it('allows retry when fresh creation could not write a secret', async () => {
  mockPutSecret.mockResolvedValueOnce(false)
  const { context } = await renderStorage()

  expect(await context.createMnemonic('first test mnemonic')).toBe(false)
  expect(await context.createMnemonic('retry test mnemonic')).toBe(true)
  expect(mockEncrypted.get('mnemonic')).toBe('retry test mnemonic')
})

it('refuses creation through a callback from an unmounted provider', async () => {
  const { context, renderer } = await renderStorage()
  renderer.unmount()

  expect(await context.createMnemonic('new test mnemonic')).toBe(false)
  expect(mockPutSecret).not.toHaveBeenCalled()
})

it('keeps explicit import replacement available through setMnemonic', async () => {
  mockEncrypted.set('mnemonic', 'existing test mnemonic')
  const { context } = await renderStorage()

  expect(await context.setMnemonic('imported test mnemonic')).toBe(true)
  expect(mockEncrypted.get('mnemonic')).toBe('imported test mnemonic')
})
