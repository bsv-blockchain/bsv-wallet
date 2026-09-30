/**
 * Settings "Payment notifications" row: present only when the host wired a
 * push adapter; shows On/Off from the adapter's permission, re-read on focus
 * and on returning to the foreground; a press either asks the OS (when the
 * permission is still undetermined, recording the advisory as seen) or opens
 * the OS settings.
 *
 * Real ListRow/GroupedSection and real English strings; only the wallet
 * surface around them is mocked.
 */
import React from 'react'
import { AppState } from 'react-native'
import { act, fireEvent, render } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { SettingsScreen } from '../../ui/screens/SettingsScreen'
import { pushAdvisory } from '../../core/push/pushAdvisory'
import type { PushAdapter, PushPermission } from '../../core/push/types'
import { configureToolbox, resetToolboxConfig } from '../../core/toolboxConfig'

const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockFocusCallbacks: (() => void)[] = []

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  useWallet: () => ({
    managers: { permissionsManager: null },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    txStatusVersion: 0
  }),
  isVaultAvailable: () => false,
  useVault: () => ({ hasVaultMeta: false }),
  i18n: jest.requireActual('../../core/i18n/translations').default
}))
jest.mock('expo-router', () => ({
  router: mockRouter,
  // Run the effect on mount like a focused screen, and keep the callback so a
  // test can fire another focus.
  useFocusEffect: (effect: () => void) => {
    mockFocusCallbacks.push(effect)
    require('react').useEffect(effect, [effect])
  }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('@bsv/wallet-toolbox-mobile', () => ({ sdk: { specOpWalletBalance: 'specOpWalletBalance' } }))
jest.mock('../../ui/components/wallet/AmountDisplay', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return {
    __esModule: true,
    default: ({ children, onPress, ...rest }: any) => (
      <Pressable onPress={onPress} {...rest}>
        {children}
      </Pressable>
    )
  }
})

const flush = () => act(async () => {})

const pushAdapter = (permission: PushPermission, requestResult: PushPermission = 'granted') => {
  const adapter = {
    platform: 'ios',
    getPermission: jest.fn(async () => permission),
    requestPermission: jest.fn(async () => requestResult),
    openSettings: jest.fn(async () => {})
  }
  configureToolbox({ backupUrl: null, push: adapter as unknown as PushAdapter })
  return adapter
}

let appStateHandlers: ((state: string) => void)[] = []

beforeEach(async () => {
  jest.clearAllMocks()
  mockFocusCallbacks = []
  appStateHandlers = []
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (state: string) => void) => {
    appStateHandlers.push(handler)
    return { remove: jest.fn() }
  }) as any)
  await AsyncStorage.clear()
})

afterEach(() => {
  resetToolboxConfig()
  jest.restoreAllMocks()
})

describe('Settings payment notifications row', () => {
  it('is hidden on a host that wired no push adapter', async () => {
    const { queryByText } = render(<SettingsScreen />)
    await flush()
    expect(queryByText('Payment notifications')).toBeNull()
    expect(queryByText(/^notifications$/i)).toBeNull()
  })

  it('shows under a Notifications header with the value On when granted', async () => {
    pushAdapter('granted')
    const { getByText, queryByText } = render(<SettingsScreen />)
    await flush()
    expect(getByText(/^notifications$/i)).toBeTruthy()
    expect(getByText('Payment notifications')).toBeTruthy()
    expect(getByText('On')).toBeTruthy()
    expect(queryByText('Off')).toBeNull()
  })

  it.each(['denied', 'undetermined'] as const)('shows Off when the permission is %s', async permission => {
    pushAdapter(permission)
    const { getByText, queryByText } = render(<SettingsScreen />)
    await flush()
    expect(getByText('Off')).toBeTruthy()
    expect(queryByText('On')).toBeNull()
  })

  it('catches up with a changed permission when the screen is focused again', async () => {
    const adapter = pushAdapter('denied')
    const { getByText, queryByText } = render(<SettingsScreen />)
    await flush()
    expect(getByText('Off')).toBeTruthy()

    adapter.getPermission.mockResolvedValue('granted')
    await act(async () => {
      mockFocusCallbacks[mockFocusCallbacks.length - 1]()
    })
    expect(getByText('On')).toBeTruthy()
    expect(queryByText('Off')).toBeNull()
  })

  it('re-reads the permission when the app returns to the foreground', async () => {
    const adapter = pushAdapter('denied')
    const { getByText } = render(<SettingsScreen />)
    await flush()
    const reads = adapter.getPermission.mock.calls.length

    adapter.getPermission.mockResolvedValue('granted')
    await act(async () => {
      appStateHandlers.forEach(handler => handler('background'))
    })
    expect(adapter.getPermission).toHaveBeenCalledTimes(reads)

    await act(async () => {
      appStateHandlers.forEach(handler => handler('active'))
    })
    expect(getByText('On')).toBeTruthy()
  })

  it('asks the OS and records the advisory when the permission is undetermined', async () => {
    const adapter = pushAdapter('undetermined', 'granted')
    const { getByText, queryByText } = render(<SettingsScreen />)
    await flush()
    expect(await pushAdvisory.get()).toBe(false)

    await act(async () => {
      fireEvent.press(getByText('Payment notifications'))
    })
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    expect(adapter.openSettings).not.toHaveBeenCalled()
    expect(await pushAdvisory.get()).toBe(true)
    expect(getByText('On')).toBeTruthy()
    expect(queryByText('Off')).toBeNull()
  })

  it('opens the OS settings once the OS has denied, without asking again', async () => {
    // Android reads a denial back as undetermined; the answer the request just
    // gave must stand, so the second press gets out to the OS settings instead
    // of re-requesting forever.
    const adapter = pushAdapter('undetermined', 'denied')
    const { getByText } = render(<SettingsScreen />)
    await flush()

    await act(async () => {
      fireEvent.press(getByText('Payment notifications'))
    })
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    expect(getByText('Off')).toBeTruthy()

    await act(async () => {
      fireEvent.press(getByText('Payment notifications'))
    })
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    expect(adapter.openSettings).toHaveBeenCalledTimes(1)
  })

  describe('after a denial (Android reads every not-granted state as undetermined)', () => {
    const fireActive = async () => {
      await act(async () => {
        appStateHandlers.forEach(handler => handler('active'))
      })
    }
    const fireFocus = async () => {
      await act(async () => {
        mockFocusCallbacks[mockFocusCallbacks.length - 1]()
      })
    }

    // The OS dialog is its own activity: dismissing it brings the app back to
    // 'active' right after requestPermission resolves 'denied'.
    it.each([
      ['the app returning to the foreground', fireActive],
      ['the screen being focused again', fireFocus]
    ] as const)('keeps the denial through %s, so the next press opens the OS settings', async (_name, reread) => {
      const adapter = pushAdapter('undetermined', 'denied')
      const { getByText } = render(<SettingsScreen />)
      await flush()

      await act(async () => {
        fireEvent.press(getByText('Payment notifications'))
      })
      expect(adapter.requestPermission).toHaveBeenCalledTimes(1)

      const reads = adapter.getPermission.mock.calls.length
      await reread()
      // The re-read really happened and really said undetermined.
      expect(adapter.getPermission.mock.calls.length).toBe(reads + 1)
      expect(getByText('Off')).toBeTruthy()

      await act(async () => {
        fireEvent.press(getByText('Payment notifications'))
      })
      expect(adapter.openSettings).toHaveBeenCalledTimes(1)
      expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    })

    it('still shows On when the user grants it in the OS settings and comes back', async () => {
      const adapter = pushAdapter('undetermined', 'denied')
      const { getByText, queryByText } = render(<SettingsScreen />)
      await flush()

      await act(async () => {
        fireEvent.press(getByText('Payment notifications'))
      })
      await fireActive()
      expect(getByText('Off')).toBeTruthy()

      await act(async () => {
        fireEvent.press(getByText('Payment notifications'))
      })
      expect(adapter.openSettings).toHaveBeenCalledTimes(1)

      // The user flips the switch in the OS settings and returns.
      adapter.getPermission.mockResolvedValue('granted')
      await fireActive()
      expect(getByText('On')).toBeTruthy()
      expect(queryByText('Off')).toBeNull()
    })

    it('does not wedge a denial on iOS, where denied reads back as denied', async () => {
      const adapter = pushAdapter('undetermined', 'denied')
      const { getByText } = render(<SettingsScreen />)
      await flush()
      await act(async () => {
        fireEvent.press(getByText('Payment notifications'))
      })

      adapter.getPermission.mockResolvedValue('denied')
      await fireActive()
      await act(async () => {
        fireEvent.press(getByText('Payment notifications'))
      })
      expect(adapter.openSettings).toHaveBeenCalledTimes(1)
      expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['granted', 'denied'] as const)('opens the OS settings when the permission is %s', async permission => {
    const adapter = pushAdapter(permission)
    const { getByText } = render(<SettingsScreen />)
    await flush()

    await act(async () => {
      fireEvent.press(getByText('Payment notifications'))
    })
    expect(adapter.openSettings).toHaveBeenCalledTimes(1)
    expect(adapter.requestPermission).not.toHaveBeenCalled()
    // Opening settings is not the advisory.
    expect(await pushAdvisory.get()).toBe(false)
  })

  it('survives adapter calls that reject, leaving the row as it was', async () => {
    const adapter = pushAdapter('undetermined')
    adapter.getPermission.mockRejectedValueOnce(new Error('native module missing'))
    adapter.requestPermission.mockRejectedValueOnce(new Error('prompt failed'))
    adapter.openSettings.mockRejectedValueOnce(new Error('no settings'))
    const { getByText } = render(<SettingsScreen />)
    await flush()
    // The failed first read leaves the null default, which reads as Off.
    expect(getByText('Off')).toBeTruthy()

    // null is not undetermined, so this press goes to openSettings (rejects).
    await act(async () => {
      fireEvent.press(getByText('Payment notifications'))
    })
    expect(adapter.openSettings).toHaveBeenCalledTimes(1)
    expect(getByText('Off')).toBeTruthy()

    // A rejected request also leaves the state alone.
    adapter.getPermission.mockResolvedValue('undetermined')
    await act(async () => {
      mockFocusCallbacks[mockFocusCallbacks.length - 1]()
    })
    await act(async () => {
      fireEvent.press(getByText('Payment notifications'))
    })
    expect(adapter.requestPermission).toHaveBeenCalledTimes(1)
    expect(getByText('Off')).toBeTruthy()
  })
})
