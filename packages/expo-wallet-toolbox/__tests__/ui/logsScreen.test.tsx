/**
 * Debugging screen: the monitor tasks, the UTXO check and the stuck-reservation
 * release are buttons, and their output lands in the terminal. No native
 * clipboard, router or icon font — those crash under Jest.
 */
import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react-native'

const mockRouter = { back: jest.fn() }
const mockRunMonitorTask = jest.fn()
const mockGetMonitorTaskNames = jest.fn(() => ['CheckForProofs'])
const mockCheckUtxo = jest.fn()
const mockRelease = jest.fn()

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const tokens = jest.requireActual('../../core/theme/tokens')
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.darkColors }),
    useWallet: () => ({
      runMonitorTask: mockRunMonitorTask,
      getMonitorTaskNames: mockGetMonitorTaskNames,
      checkUtxoSpendability: mockCheckUtxo,
      releaseStuckReservations: mockRelease
    })
  }
})
jest.mock('expo-router', () => ({
  router: mockRouter,
  useFocusEffect: (effect: () => void) => {
    require('react').useEffect(effect, [effect])
  }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('@react-native-clipboard/clipboard', () => ({ setString: jest.fn() }))

import { LogsScreen } from '../../ui/screens/LogsScreen'

beforeEach(() => {
  jest.clearAllMocks()
  mockGetMonitorTaskNames.mockReturnValue(['CheckForProofs'])
  mockRunMonitorTask.mockResolvedValue('proofs ok')
  mockCheckUtxo.mockResolvedValue('0 stale output(s) marked unspendable')
  mockRelease.mockResolvedValue('Released 0 stuck')
})

describe('LogsScreen', () => {
  test('lists monitor tasks and shows their output', async () => {
    const screen = render(<LogsScreen />)
    expect(screen.getByText('Debugging')).toBeTruthy()
    expect(screen.getByText('Tap a task above to run it and see output here.')).toBeTruthy()

    fireEvent.press(screen.getByText('CheckForProofs'))

    await waitFor(() => expect(screen.getByText('proofs ok')).toBeTruthy())
    expect(mockRunMonitorTask).toHaveBeenCalledWith('CheckForProofs')
  })

  test('a failing task is written as an error line and does not stay running', async () => {
    mockRunMonitorTask.mockRejectedValueOnce(new Error('boom'))
    const screen = render(<LogsScreen />)

    fireEvent.press(screen.getByText('CheckForProofs'))

    await waitFor(() => expect(screen.getByText('Error: boom')).toBeTruthy())
    expect(screen.getByText('Run All')).toBeTruthy()
  })

  test('Run All walks every monitor task', async () => {
    mockGetMonitorTaskNames.mockReturnValue(['CheckForProofs', 'SendWaiting'])
    mockRunMonitorTask.mockImplementation(async (name: string) => `done ${name}`)
    const screen = render(<LogsScreen />)

    fireEvent.press(screen.getByText('Run All'))

    await waitFor(() => expect(screen.getByText('done SendWaiting')).toBeTruthy())
    expect(mockRunMonitorTask.mock.calls.map(c => c[0])).toEqual(['CheckForProofs', 'SendWaiting'])
  })

  test('CheckUTXOs and Release stuck call the wallet helpers, not a monitor task', async () => {
    const screen = render(<LogsScreen />)

    fireEvent.press(screen.getByText('CheckUTXOs'))
    await waitFor(() => expect(screen.getByText('0 stale output(s) marked unspendable')).toBeTruthy())

    fireEvent.press(screen.getByText('Release stuck'))
    await waitFor(() => expect(screen.getByText('Released 0 stuck')).toBeTruthy())

    expect(mockCheckUtxo).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledTimes(1)
    expect(mockRunMonitorTask).not.toHaveBeenCalled()
  })

  test('back leaves the screen', () => {
    const screen = render(<LogsScreen />)
    const buttons = screen.UNSAFE_getAllByType(require('react-native').TouchableOpacity)
    fireEvent.press(buttons[0])
    expect(mockRouter.back).toHaveBeenCalled()
  })
})
