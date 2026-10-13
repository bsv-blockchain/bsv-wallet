// Startup reads begun before the app renders: each is taken once, by the
// provider that would otherwise have started it, and only once.
const mockMigrate = jest.fn()
const mockLoadProfiles = jest.fn()
const mockGetItem = jest.fn()

jest.mock('../../core/services/secrets', () => ({ migrateLegacySecrets: () => mockMigrate() }))
jest.mock('../../core/profiles/profileStore', () => ({ loadProfiles: () => mockLoadProfiles() }))
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: (key: string) => mockGetItem(key) }
}))

type Prewarm = typeof import('../../core/context/startupPrewarm')

function fresh(): Prewarm {
  let mod!: Prewarm
  jest.isolateModules(() => {
    mod = require('../../core/context/startupPrewarm')
  })
  return mod
}

beforeEach(() => {
  mockMigrate.mockReset().mockResolvedValue({ outcome: 'not-needed' })
  mockLoadProfiles.mockReset().mockResolvedValue({ active: 0, profiles: [] })
  mockGetItem.mockReset().mockResolvedValue('{"method":"mnemonic"}')
})

it('has nothing to take when the app did not prewarm', () => {
  const p = fresh()
  expect(p.takeStartupSecrets()).toBeNull()
  expect(p.takeStartupConfig()).toBeNull()
  expect(mockMigrate).not.toHaveBeenCalled()
})

it('starts each read once and hands it over once', async () => {
  const p = fresh()
  p.prewarmStartup()
  p.prewarmStartup()
  expect(mockMigrate).toHaveBeenCalledTimes(1)
  expect(mockLoadProfiles).toHaveBeenCalledTimes(1)

  await expect(p.takeStartupSecrets()).resolves.toEqual({ outcome: 'not-needed' })
  expect(p.takeStartupSecrets()).toBeNull()

  const config = p.takeStartupConfig()
  expect(config).not.toBeNull()
  await expect(config!.profiles).resolves.toEqual({ active: 0, profiles: [] })
  await expect(config!.config).resolves.toBe('{"method":"mnemonic"}')
  expect(mockGetItem).toHaveBeenCalledWith('finalConfig')
  expect(p.takeStartupConfig()).toBeNull()
})

it('reads the stored config only after the profiles are in memory', async () => {
  let release!: () => void
  mockLoadProfiles.mockReturnValue(new Promise<void>(done => (release = done)))
  const p = fresh()
  p.prewarmStartup()
  await Promise.resolve()
  expect(mockGetItem).not.toHaveBeenCalled()
  release()
  await p.takeStartupConfig()!.config
  expect(mockGetItem).toHaveBeenCalledWith('finalConfig')
})

it('hands a failed migration to the provider, which handles it as before', async () => {
  mockMigrate.mockRejectedValue(new Error('keychain'))
  const p = fresh()
  p.prewarmStartup()
  await expect(p.takeStartupSecrets()).rejects.toThrow('keychain')
})
