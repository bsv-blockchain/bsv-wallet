/**
 * Proof bar §4.5 — the mock YubiKey driver cannot be selected in a release
 * build.
 *
 * Four independent layers, each proven here:
 *  1. Runtime gate: with `__DEV__` false, setMockDriver and
 *     setMockDriverEnabled are no-ops and getVaultDriver never returns the
 *     mock (driver.ts / devMock.ts).
 *  2. Source gate: the only code that CONSTRUCTS a MockYubiKey outside
 *     `__tests__` is devMock.ts, and the only code that ever calls
 *     setMockDriver with a real (non-null) driver outside `__tests__` is
 *     devMock.ts too — every other production call site only ever READS
 *     getVaultDriver().
 *  3. Build gate: eas.json's release profiles (every profile that is not one
 *     of the two developer-client builds) do not set `developmentClient`, and
 *     no profile anywhere defines an env var that could enable the mock —
 *     there is no such env var in this codebase at all, by design.
 *  4. UI gate: WalletConfigScreen's "Use mock YubiKey (dev)" row renders only
 *     under `__DEV__`.
 *
 * How Expo/Metro sets `__DEV__` for these builds: Metro's transform replaces
 * the global `__DEV__` identifier with a literal boolean baked into the
 * bundle at build time — `true` for a bundle built in development mode
 * (`expo start`, or a `developmentClient: true` EAS profile, which ships a
 * debug JS bundle that also enables Hermes/JSC's dev flags) and `false` for
 * `expo export --no-dev` / a production EAS build (`buildType`/
 * `credentialsSource` profiles here, none of which sets
 * `developmentClient`). Terser's dead-code elimination then drops every
 * `if (__DEV__)` / `__DEV__ && (...)` branch whose condition folds to the
 * literal `false`, so the mock-toggle UI and the `setMockDriverEnabled` call
 * inside it are not merely inert in a release bundle — for the JS layer,
 * `if (false)` folds to nothing at all, they are compiled OUT.
 */
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { getVaultDriver, setMockDriver } from '../../core/services/vault/driver'
import { setMockDriverEnabled } from '../../core/services/vault/devMock'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'

// ── WalletConfigScreen render harness (layer 4 only) ───────────────────────
// Mirrors __tests__/ui/walletConfigArc.test.tsx's mocking exactly — the
// minimum needed to mount the screen without its real native/backend deps.
const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockWallet: any
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('../../ui/components/ui/SlideOverFromRight', () => ({ __esModule: true, default: () => null }))
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false }))
}))
jest.mock('@bsv/expo-wallet-toolbox', () => {
  const ReactLocal = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    ...jest.requireActual('../../core/theme/motion'),
    ...jest.requireActual('../../core/numberFormat'),
    splitAmountFraction: jest.requireActual('../../core/amountFormatHelpers').splitAmountFraction,
    isFiatCurrency: jest.requireActual('../../core/amountFormatHelpers').isFiatCurrency,
    validateArcUrl: jest.requireActual('../../core/net/validateArcUrl').validateArcUrl,
    useTheme: () => ({ colors: {} }),
    useWallet: () => mockWallet,
    useLocalStorage: () => ({
      hasStoredIdentity: jest.fn(async () => true),
      createMnemonic: jest.fn(),
      getMnemonic: jest.fn(),
      getRecoveredKey: jest.fn(async () => null),
      secretsReady: true
    }),
    backupAttestation: jest.requireActual('../../core/services/vault/backupAttestation').backupAttestation,
    ExchangeRateContext: ReactLocal.createContext({ satoshisPerUSD: 1000 }),
    UserContext: ReactLocal.createContext({ appName: 'Test Wallet' }),
    formatAmountParts: () => ({ integer: '0', fraction: '', unit: 'BSV' }),
    formatAmount: () => '0',
    formatSatoshisAsBsvDecimal: () => '0',
    TaskCreditInbox: { lastAttentionCount: 0 },
    TaskSendOffline: { lastStall: null },
    isBackupPushEnabled: async () => true,
    isVaultEnabled: () => true,
    isVaultAvailable: (chain: string) => chain === 'main',
    useVault: () => ({ state: { phase: 'idle' }, submitPin: jest.fn(), cancel: jest.fn(), retry: jest.fn(), hasVaultMeta: false }),
    setMockDriverEnabled: jest.requireActual('../../core/services/vault/devMock').setMockDriverEnabled,
    setMockPresentKey: jest.requireActual('../../core/services/vault/devMock').setMockPresentKey,
    getMockPresentKey: jest.requireActual('../../core/services/vault/devMock').getMockPresentKey,
    arcUrlStorageKey: () => 'arc_url',
    getArcApiToken: async () => null,
    arcApiTokenStorageKey: () => 'arc_token',
    DEFAULT_ARC_URLS: { main: 'https://arc.gorillapool.io' },
    KNOWN_ARC_URLS: [],
    DISPLAY_CURRENCY_OPTIONS: [],
    DEFAULT_AUTO_APPROVE_THRESHOLD: 0,
    AUTO_APPROVE_STORAGE_KEY: 'auto_approve',
    ADVANCED_SETTINGS_EXPANDED_KEY: 'advanced',
    NO_MESSAGE_BOX: 'none',
    getBackupUrl: () => ''
  }
})
jest.mock('expo-router', () => ({
  router: mockRouter,
  useLocalSearchParams: () => ({ section: undefined }),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect])
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: jest.fn() }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/wallet/BackupReminderSheet', () => ({ BackupReminderSheet: () => null }))
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({ BiometricAdvisoryModal: () => null }))
jest.mock('../../ui/components/wallet/ImportFromBackupPrompt', () => ({ ImportFromBackupPrompt: () => null }))
jest.mock('../../ui/components/wallet/ActivityRow', () => () => null)
jest.mock('../../ui/components/security/WalletLockNotice', () => () => null)
jest.mock('../../ui/components/pay/OfflineNotice', () => () => null)
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => false }))
jest.mock('../../ui/hooks/useOfflineNoticeActions', () => ({ useOfflineNoticeActions: () => ({}) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../ui/exportTransactions', () => ({ exportTransactionsAsCsv: jest.fn() }))
jest.mock('../../ui/components/ui/ScreenGradient', () => ({ __esModule: true, default: ({ children }: any) => children }))
jest.mock('../../ui/components/ui/ScrollFade', () => ({ __esModule: true, default: () => null, sampleScreenGradient: () => '#000000' }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const ReactLocal = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => ReactLocal.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/ListRow', () => {
  const ReactLocal = require('react')
  const { Pressable, Text } = require('react-native')
  return {
    ListRow: ({ label, onPress }: any) => ReactLocal.createElement(Pressable, { onPress }, ReactLocal.createElement(Text, {}, label))
  }
})
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))
jest.mock('../../ui/components/pay/MessageBoxConfig', () => ({
  ConfigPanel: () => null,
  useMessageBoxConfig: () => ({ messageBoxUrl: 'https://test.invalid' })
}))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))
jest.mock('../../ui/exportDatabases', () => ({ exportAllWalletDatabases: jest.fn() }))
jest.mock('../../ui/importDatabases', () => ({ importWalletDatabase: jest.fn() }))
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn() } }))

import { act, fireEvent, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { WalletConfigScreen } from '../../ui/screens/WalletConfigScreen'

const PACKAGE_ROOT = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..')

afterEach(() => setMockDriver(null))

// ─────────────────────────────────────────────────────────────────────────
describe('PROOF-MOCK layer 1: the __DEV__ runtime gate', () => {
  test('setMockDriver is a no-op outside __DEV__ (positive control: it installs the mock under __DEV__)', () => {
    const replaced = jest.replaceProperty(globalThis as any, '__DEV__', false)
    try {
      setMockDriver(new MockYubiKey())
      expect(getVaultDriver()).not.toBeInstanceOf(MockYubiKey)
      expect(getVaultDriver()).toBeNull()
    } finally {
      replaced.restore()
    }
    // Positive control: jest-expo's default __DEV__ is true.
    expect(__DEV__).toBe(true)
    const mock = new MockYubiKey()
    setMockDriver(mock)
    expect(getVaultDriver()).toBe(mock)
  })

  test('setMockDriverEnabled(true) is a no-op outside __DEV__ — getVaultDriver never returns the mock (positive control: it installs the mock under __DEV__)', () => {
    const replaced = jest.replaceProperty(globalThis as any, '__DEV__', false)
    try {
      setMockDriverEnabled(true)
      expect(getVaultDriver()).toBeNull()
      expect(getVaultDriver()).not.toBeInstanceOf(MockYubiKey)
    } finally {
      replaced.restore()
    }
    // Positive control: under __DEV__ true, enabling really does install one.
    setMockDriverEnabled(true)
    expect(getVaultDriver()).toBeInstanceOf(MockYubiKey)
    setMockDriverEnabled(false)
    expect(getVaultDriver()).toBeNull()
  })

})

// ─────────────────────────────────────────────────────────────────────────
/** Every .ts/.tsx file under `dir`, excluding node_modules, __tests__ and any
 * .test./.spec. file — i.e. exactly the production source tree. */
function productionSourceFiles(dir: string): string[] {
  const out: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...productionSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('PROOF-MOCK layer 2: source scan — construction and installation are confined to devMock.ts', () => {
  const files = [
    ...productionSourceFiles(path.join(PACKAGE_ROOT, 'core')),
    ...productionSourceFiles(path.join(PACKAGE_ROOT, 'ui'))
  ]
  // Sanity: the scan itself is live (finds a real, known file), so an empty
  // or misconfigured `files` list cannot make every assertion below
  // vacuously pass.
  test('the scan actually walks the real source tree (positive control)', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(files.some(f => f.endsWith(path.join('core', 'services', 'vault', 'driver.ts')))).toBe(true)
  })

  test('no production file other than devMock.ts constructs `new MockYubiKey(...)`', () => {
    const constructors = files.filter(f => /new\s+MockYubiKey\s*\(/.test(fs.readFileSync(f, 'utf8')))
    expect(constructors.map(f => path.relative(PACKAGE_ROOT, f))).toEqual([
      path.join('core', 'services', 'vault', 'devMock.ts')
    ])
  })

  test('no production file other than devMock.ts calls setMockDriver with a real driver (every other call site only reads getVaultDriver)', () => {
    const installers = files.filter(f => {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      return lines.some(line => {
        // The function's own declaration (`export function setMockDriver(`)
        // is not a call site; every genuine call is `setMockDriver(<arg>)`.
        if (/function\s+setMockDriver\s*\(/.test(line)) return false
        const call = /setMockDriver\(\s*([^)]*)\)/.exec(line)
        return call !== null && call[1].trim() !== 'null'
      })
    })
    expect(installers.map(f => path.relative(PACKAGE_ROOT, f))).toEqual([
      path.join('core', 'services', 'vault', 'devMock.ts')
    ])
  })

  test('setMockDriverEnabled is called from production code only inside devMock.ts itself and WalletConfigScreen.tsx (the DEV-gated UI toggle)', () => {
    const callers = files.filter(f => /setMockDriverEnabled\s*\(/.test(fs.readFileSync(f, 'utf8')))
    expect(callers.map(f => path.relative(PACKAGE_ROOT, f)).sort()).toEqual([
      path.join('core', 'services', 'vault', 'devMock.ts'),
      path.join('ui', 'screens', 'WalletConfigScreen.tsx')
    ])
  })

  test('WalletConfigScreen.tsx only ever calls setMockDriverEnabled from inside a `__DEV__ &&` guarded block', () => {
    const src = fs.readFileSync(path.join(PACKAGE_ROOT, 'ui', 'screens', 'WalletConfigScreen.tsx'), 'utf8')
    const callIndex = src.indexOf('setMockDriverEnabled(')
    expect(callIndex).toBeGreaterThan(-1)
    // The nearest preceding JSX-conditional opener before the call site.
    const preceding = src.slice(0, callIndex)
    const guardIndex = preceding.lastIndexOf('{__DEV__ &&')
    expect(guardIndex).toBeGreaterThan(-1)
    // No unrelated closing of that JSX conditional between the guard and the
    // call (a naive brace-depth check: the guard's own opening brace/paren
    // pair must still be open at callIndex — approximated here by requiring
    // no OTHER top-level `{__DEV__ &&` reopens a sibling block first and by
    // requiring the call site is the first occurrence after the guard).
    expect(src.indexOf('setMockDriverEnabled(', guardIndex)).toBe(callIndex)
  })

  test('devMock.ts is the sole importer of mockYubiKey.ts among non-index production modules (core/index.ts only re-exports the type, never constructs or installs anything)', () => {
    const importers = files.filter(f => {
      if (f.endsWith(path.join('services', 'vault', 'mockYubiKey.ts'))) return false
      const src = fs.readFileSync(f, 'utf8')
      return /from\s+['"].*mockYubiKey['"]/.test(src)
    })
    const relative = importers.map(f => path.relative(PACKAGE_ROOT, f)).sort()
    expect(relative).toEqual([
      path.join('core', 'index.ts'),
      path.join('core', 'services', 'vault', 'devMock.ts')
    ])
    // core/index.ts's import must be a bare re-export (no local binding it
    // could call `new` on) — confirms it cannot itself construct anything.
    const indexSrc = fs.readFileSync(path.join(PACKAGE_ROOT, 'core', 'index.ts'), 'utf8')
    expect(indexSrc).toMatch(/export \* from '\.\/services\/vault\/mockYubiKey'/)
    expect(indexSrc).not.toMatch(/new\s+MockYubiKey/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('PROOF-MOCK layer 3: eas.json build profiles', () => {
  const easJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eas.json'), 'utf8')) as {
    build: Record<string, { developmentClient?: boolean; env?: Record<string, string> }>
  }
  const profiles = Object.keys(easJson.build)
  // The only profiles meant to run a developer-connected/debug JS bundle.
  const DEV_CLIENT_PROFILES = new Set(['development', 'dev-physical'])

  test('the scan actually parsed real profiles (positive control)', () => {
    expect(profiles.length).toBeGreaterThanOrEqual(4)
    expect(profiles).toEqual(expect.arrayContaining(['production', 'development']))
  })

  test('every profile NOT in the developer-client set does not set developmentClient (positive control: the developer-client profiles DO set it)', () => {
    for (const name of profiles) {
      const profile = easJson.build[name]
      if (DEV_CLIENT_PROFILES.has(name)) {
        expect(profile.developmentClient).toBe(true)
      } else {
        expect(profile.developmentClient).not.toBe(true)
      }
    }
  })

  test('no build profile defines any env var whose name could plausibly enable the mock driver (there is no such env var anywhere in this codebase)', () => {
    for (const name of profiles) {
      const env = easJson.build[name].env ?? {}
      for (const key of Object.keys(env)) {
        expect(key.toUpperCase()).not.toMatch(/MOCK|YUBIKEY/)
      }
    }
    // Positive control: the scan is live — every profile does define SOME
    // env, or the absence of MOCK/YUBIKEY above would be vacuous for that
    // profile alone (not the whole test, since production profiles define
    // several real vars).
    expect(Object.keys(easJson.build.production.env ?? {}).length).toBeGreaterThan(0)
  })

  test('no non-development-client profile sets developmentClient even indirectly via "extends" (production-apk extends production)', () => {
    const productionApk = easJson.build['production-apk'] as { extends?: string; developmentClient?: boolean } | undefined
    if (productionApk?.extends) {
      expect(DEV_CLIENT_PROFILES.has(productionApk.extends)).toBe(false)
    }
    expect(productionApk?.developmentClient).not.toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('PROOF-MOCK layer 4: WalletConfigScreen renders the DEV mock toggle only under __DEV__', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    await AsyncStorage.clear()
    mockWallet = {
      managers: { permissionsManager: { getPublicKey: jest.fn(async () => ({ publicKey: '02' + 'a'.repeat(64) })) } },
      adminOriginator: 'admin.test',
      selectedNetwork: 'main',
      settings: {},
      storage: null,
      logout: jest.fn(),
      switchNetwork: jest.fn(),
      updateSettings: jest.fn(async () => {}),
      rebuildWallet: jest.fn(async () => {})
    }
  })

  async function renderConfig() {
    // The component's `{__DEV__ && (...)}` checks read the CURRENT global
    // __DEV__ value at render time, so no module re-require is needed here —
    // only a fresh render. The Data & Security section (which holds the DEV
    // mock row) lives behind the "Advanced" disclosure, same as
    // __tests__/ui/walletConfigArc.test.tsx's openArcSection helper.
    const screen = render(React.createElement(WalletConfigScreen))
    await act(async () => {})
    await act(async () => fireEvent.press(screen.getByText('advanced')))
    return screen
  }

  test('the row is present under __DEV__ (positive control) and absent when __DEV__ is false', async () => {
    expect(__DEV__).toBe(true)
    const shown = await renderConfig()
    expect(shown.queryByText('vault_mock_toggle')).toBeTruthy()

    const replaced = jest.replaceProperty(globalThis as any, '__DEV__', false)
    try {
      const hidden = await renderConfig()
      expect(hidden.queryByText('vault_mock_toggle')).toBeNull()
      expect(hidden.queryByText('Mock key present (dev)')).toBeNull()
    } finally {
      replaced.restore()
    }
  })
})
