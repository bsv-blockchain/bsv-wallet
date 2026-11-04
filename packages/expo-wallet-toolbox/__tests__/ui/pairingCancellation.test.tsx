import React from 'react'
import { act, create } from 'react-test-renderer'
import { PairScreen } from '../../ui/screens/PairScreen'
import { ConnectionsScreen } from '../../ui/screens/ConnectionsScreen'
import { runSessionTeardown } from '../../core/context/sessionTeardown'
import connectionStore from '../../core/stores/ConnectionStore'

const mockConnect = jest.fn(async () => {})
const mockReconnect = jest.fn(async () => {})
const mockStageTag = jest.fn()
const mockCreateHmac = jest.fn()
const mockVerifyHmac = jest.fn()
const mockAlert = jest.fn()
const mockToast = jest.fn()
const mockClipboard = jest.fn()
const mockParams = {
  topic: 'pending-approval',
  backendIdentityKey: '02' + '22'.repeat(32),
  protocolID: JSON.stringify([2, 'pairing']),
  origin: 'https://example.com',
  expiry: String(Math.floor(Date.now() / 1000) + 3600)
}

jest.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  SafeAreaView: 'SafeAreaView',
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  Modal: 'Modal',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }), { virtual: true })
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }), { virtual: true })
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }), { virtual: true })
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }), { virtual: true })
jest.mock('expo-clipboard', () => ({ getStringAsync: () => mockClipboard() }), { virtual: true })
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))
jest.mock('../../ui/components/ui/ListRow', () => ({ ListRow: ({ trailing }: any) => trailing }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }))
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...args: unknown[]) => mockAlert(...args) }))
jest.mock('../../ui/components/QRScanner', () => ({ __esModule: true, default: 'QRScanner' }))
jest.mock('../../core/services/revokeConnection', () => ({ revokeConnection: jest.fn() }))
jest.mock('expo-router', () => ({ router: { back: jest.fn() }, useLocalSearchParams: () => mockParams }), {
  virtual: true
})
jest.mock(
  '@bsv/expo-wallet-toolbox',
  () => ({
    useWallet: () => ({
      managers: { permissionsManager: { createHmac: mockCreateHmac, verifyHmac: mockVerifyHmac } }
    }),
    useTheme: () => ({ colors: {} }),
    spacing: {},
    radii: {},
    typography: {},
    useWalletConnection: () => ({
      status: 'idle',
      sessionMeta: null,
      connect: mockConnect,
      reconnect: mockReconnect,
      disconnect: jest.fn(),
      startNavTimer: jest.fn(),
      cancelNavTimer: jest.fn()
    }),
    guardVaultAccess: (wallet: unknown) => wallet,
    capWalletArgs: (wallet: unknown) => wallet,
    ADMIN_ORIGINATOR: 'admin',
    parseExternalOrigin: (origin: string) => ({ origin, originator: new URL(origin).hostname }),
    connectionStore: {
      get connections() {
        return jest.requireActual('../../core/stores/ConnectionStore').default.connections
      },
      remove: (topic: string) => jest.requireActual('../../core/stores/ConnectionStore').default.remove(topic),
      stageAuthorityTag: (...args: unknown[]) => mockStageTag(...args),
      discardStagedAuthorityTag: jest.fn()
    },
    DEFAULT_AUTO_APPROVE_THRESHOLD: 0,
    AUTO_APPROVE_STORAGE_KEY: 'auto-approve',
    AUTO_APPROVE_DAILY_CAP_SATS: 0
  }),
  { virtual: true }
)

function press(tree: ReturnType<typeof create>, label: string) {
  const button = tree.root
    .findAllByType('TouchableOpacity' as any)
    .find(node => node.findAllByType('Text' as any).some(text => text.props.children === label))
  expect(button).toBeDefined()
  button!.props.onPress()
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockCreateHmac.mockReset()
  mockVerifyHmac.mockReset()
  mockAlert.mockReset()
  mockClipboard.mockReset()
  mockConnect.mockReset().mockResolvedValue(undefined)
  mockReconnect.mockReset().mockResolvedValue(undefined)
  await Promise.resolve()
  for (const conn of [...connectionStore.connections]) connectionStore.remove(conn.sessionId)
})

function pairingUri() {
  return `bsv-wallet://pair?${new URLSearchParams({ ...mockParams, sig: 'signature' })}`
}

function addStoredPairing() {
  connectionStore.add({
    sessionId: mockParams.topic,
    origin: mockParams.origin,
    relay: 'wss://relay.example',
    backendIdentityKey: mockParams.backendIdentityKey,
    mobileIdentityKey: mockParams.backendIdentityKey,
    protocolID: mockParams.protocolID,
    connectedAt: 1,
    status: 'disconnected',
    authorityTag: 'A'.repeat(43)
  })
}

it.each(['scan', 'verify', 'confirm', 'clipboard'] as const)(
  'cancels a pending %s step before it can stage, prompt or reconnect',
  async step => {
    let finish!: (value: any) => void
    const pending = new Promise(resolve => {
      finish = resolve
    })
    addStoredPairing()
    mockCreateHmac.mockReturnValueOnce(pending)
    mockVerifyHmac.mockReturnValueOnce(step === 'verify' ? pending : Promise.resolve({ valid: true }))
    mockAlert.mockReturnValueOnce(pending)
    mockClipboard.mockReturnValueOnce(pending)
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(<ConnectionsScreen />)
    })
    try {
      await act(async () => {
        if (step === 'scan') tree.root.findByType('QRScanner' as any).props.onScan(pairingUri())
        else press(tree, step === 'clipboard' ? 'paste_uri' : 'reconnect')
      })
      if (step === 'confirm') expect(mockAlert).toHaveBeenCalledTimes(1)
      await act(async () => {
        if (step === 'clipboard') runSessionTeardown('logout')
        else {
          const trash = tree.root
            .findAllByType('TouchableOpacity' as any)
            .find(node => node.findAllByType('Ionicons' as any).some(icon => icon.props.name === 'trash-outline'))
          trash!.props.onPress()
        }
      })
      await act(async () => {
        finish(
          step === 'scan'
            ? { hmac: [1, 2, 3, 4] }
            : step === 'verify'
              ? { valid: true }
              : step === 'confirm'
                ? 'reconnect'
                : pairingUri()
        )
      })
      expect(mockStageTag).not.toHaveBeenCalled()
      expect(mockConnect).not.toHaveBeenCalled()
      expect(mockReconnect).not.toHaveBeenCalled()
      expect(mockToast).not.toHaveBeenCalled()
      if (step !== 'confirm') expect(mockAlert).not.toHaveBeenCalled()
    } finally {
      await act(async () => tree.unmount())
    }
  }
)

it('keeps only the newest screen approval when an older HMAC fails late', async () => {
  let fail!: (error: Error) => void
  mockCreateHmac.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  )
  mockCreateHmac.mockResolvedValueOnce({ hmac: [1, 2, 3, 4] })
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<ConnectionsScreen />)
  })
  try {
    await act(async () => {
      void tree.root.findByType('QRScanner' as any).props.onScan(pairingUri())
    })
    await act(async () => {
      void tree.root.findByType('QRScanner' as any).props.onScan(pairingUri())
    })
    await act(async () => fail(new Error('late wallet error')))
    expect(mockStageTag).toHaveBeenCalledTimes(1)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(mockToast).not.toHaveBeenCalled()
  } finally {
    await act(async () => tree.unmount())
  }
})

it.each(['reject', 'logout', 'profile', 'unmount'] as const)(
  'does not resume approval after %s while the authority HMAC is pending',
  async reason => {
    let finish!: (value: { hmac: number[] }) => void
    mockCreateHmac.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(<PairScreen />)
    })
    try {
      await act(async () => press(tree, 'Approve'))
      expect(finish).toBeDefined()
      await act(async () => {
        if (reason === 'reject') press(tree, 'Reject')
        else if (reason === 'unmount') tree.unmount()
        else runSessionTeardown(reason)
      })
      await act(async () => {
        finish({ hmac: [1, 2, 3, 4] })
      })
      expect(mockStageTag).not.toHaveBeenCalled()
      expect(mockConnect).not.toHaveBeenCalled()
    } finally {
      if (reason !== 'unmount') await act(async () => tree.unmount())
    }
  }
)

it('keeps an uninterrupted approval available after its authority HMAC resolves', async () => {
  mockCreateHmac.mockResolvedValueOnce({ hmac: [1, 2, 3, 4] })
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<PairScreen />)
  })
  try {
    await act(async () => press(tree, 'Approve'))
    expect(mockStageTag).toHaveBeenCalledWith(mockParams.topic, 'AQIDBA')
    expect(mockConnect).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => tree.unmount())
  }
})

for (const stale of [false, true]) {
  it.each(['pair-hmac', 'pair-connect', 'scan-hmac', 'scan-connect', 'reconnect'] as const)(
    `handles a deferred %s error with cancellation=${stale}`,
    async step => {
      let fail!: (error: Error) => void
      const pending = new Promise((_resolve, reject) => {
        fail = reject
      })
      const isPair = step.startsWith('pair')
      const hmacFails = step.endsWith('hmac')
      mockCreateHmac.mockReturnValueOnce(hmacFails ? pending : Promise.resolve({ hmac: [1, 2, 3, 4] }))
      mockVerifyHmac.mockResolvedValueOnce({ valid: true })
      mockAlert.mockResolvedValueOnce('reconnect')
      if (step === 'reconnect') {
        addStoredPairing()
        mockReconnect.mockReturnValueOnce(pending as Promise<void>)
      } else if (!hmacFails) mockConnect.mockReturnValueOnce(pending as Promise<void>)
      let tree!: ReturnType<typeof create>
      await act(async () => {
        tree = create(isPair ? <PairScreen /> : <ConnectionsScreen />)
      })
      try {
        await act(async () => {
          if (isPair) press(tree, 'Approve')
          else if (step === 'reconnect') press(tree, 'reconnect')
          else void tree.root.findByType('QRScanner' as any).props.onScan(pairingUri())
        })
        await act(async () => {
          if (stale) runSessionTeardown('logout')
          fail(new Error('late wallet error'))
        })
        if (hmacFails) {
          expect(mockStageTag).not.toHaveBeenCalled()
          expect(mockConnect).toHaveBeenCalledTimes(stale ? 0 : 1)
        }
        const reportsError = !stale && !hmacFails
        if (isPair) {
          const error = tree.root
            .findAllByType('Text' as any)
            .filter(node => node.props.children === 'late wallet error')
          expect(error).toHaveLength(reportsError ? 1 : 0)
        } else expect(mockToast).toHaveBeenCalledTimes(reportsError ? 1 : 0)
      } finally {
        await act(async () => tree.unmount())
      }
    }
  )
}

it.each(['clipboard', 'reconnect'] as const)('keeps an uninterrupted %s approval available', async step => {
  mockCreateHmac.mockResolvedValueOnce({ hmac: [1, 2, 3, 4] })
  mockVerifyHmac.mockResolvedValueOnce({ valid: true })
  mockClipboard.mockResolvedValueOnce(pairingUri())
  mockAlert.mockResolvedValueOnce('reconnect')
  addStoredPairing()
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<ConnectionsScreen />)
  })
  try {
    await act(async () => press(tree, step === 'clipboard' ? 'paste_uri' : 'reconnect'))
    expect(step === 'clipboard' ? mockConnect : mockReconnect).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => tree.unmount())
  }
})
