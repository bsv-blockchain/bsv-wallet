let mockWalletCtx: any

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => mockWalletCtx,
  readWalletBalance: jest.fn()
}))
jest.mock('@bsv/wallet-toolbox-mobile', () => ({ sdk: { specOpWalletBalance: 'balance' } }))

import { act, renderHook } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { readWalletBalance } from '@bsv/expo-wallet-toolbox'
import { useSpendableBalance } from '../../ui/hooks/useSpendableBalance'

const fetchBalance = jest.mocked(readWalletBalance)
const settle = async () => {
  await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

beforeEach(async () => {
  jest.clearAllMocks()
  await AsyncStorage.clear()
  fetchBalance.mockReset()
  mockWalletCtx = {
    managers: { permissionsManager: { listOutputs: jest.fn(async () => ({ totalOutputs: 75 })) } },
    adminOriginator: 'admin', selectedNetwork: 'main', storage: { chain: 'main' },
    walletUserId: 1, txStatusVersion: 0
  }
})

it('coalesces invalidations during a read and commits the subsequent balance', async () => {
  const first = deferred<number>()
  fetchBalance.mockReturnValueOnce(first.promise).mockResolvedValue(200)
  const screen = renderHook(() => useSpendableBalance())
  await settle()
  expect(fetchBalance).toHaveBeenCalledTimes(1)
  for (const txStatusVersion of [1, 2]) {
    mockWalletCtx = { ...mockWalletCtx, txStatusVersion }
    screen.rerender(undefined)
    await settle()
  }
  expect(fetchBalance).toHaveBeenCalledTimes(1)
  await act(async () => { first.resolve(100) })
  await settle()
  expect(fetchBalance).toHaveBeenCalledTimes(2)
  expect(screen.result.current).toBe(200)
  expect(AsyncStorage.setItem).not.toHaveBeenCalledWith('cached_wallet_balance_main', '100')
  expect(await AsyncStorage.getItem('cached_wallet_balance_main')).toBe('200')
})

it('hides the old network figure and waits for storage on the selected chain', async () => {
  fetchBalance.mockResolvedValue(500)
  const screen = renderHook(() => useSpendableBalance())
  await settle()
  expect(screen.result.current).toBe(500)
  mockWalletCtx = { ...mockWalletCtx, selectedNetwork: 'test' }
  screen.rerender(undefined)
  expect(screen.result.current).toBeNull()
  await settle()
  expect(fetchBalance).toHaveBeenCalledTimes(1)
  expect(await AsyncStorage.getItem('cached_wallet_balance_test')).toBeNull()
  fetchBalance.mockResolvedValue(80)
  mockWalletCtx = { ...mockWalletCtx, storage: { chain: 'test' } }
  screen.rerender(undefined)
  await settle()
  expect(screen.result.current).toBe(80)
  expect(await AsyncStorage.getItem('cached_wallet_balance_test')).toBe('80')
})

it('does not publish or cache a previous network read after switching networks', async () => {
  const first = deferred<number>()
  fetchBalance.mockReturnValueOnce(first.promise).mockResolvedValue(80)
  const screen = renderHook(() => useSpendableBalance())
  await settle()
  mockWalletCtx = { ...mockWalletCtx, selectedNetwork: 'test', storage: { chain: 'test' } }
  screen.rerender(undefined)
  await act(async () => { first.resolve(500) })
  await settle()
  expect(screen.result.current).toBe(80)
  expect(await AsyncStorage.getItem('cached_wallet_balance_main')).toBeNull()
  expect(await AsyncStorage.getItem('cached_wallet_balance_test')).toBe('80')
})

it('still reads the wallet when reading cache fails, including the listOutputs fallback', async () => {
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('cache unavailable'))
  fetchBalance.mockResolvedValue(null)
  const screen = renderHook(() => useSpendableBalance())
  await settle()
  expect(screen.result.current).toBe(75)
  expect(mockWalletCtx.managers.permissionsManager.listOutputs).toHaveBeenCalledWith({ basket: 'balance' }, 'admin')
})

it('does not update cache after unmount while a read is pending', async () => {
  const first = deferred<number>()
  fetchBalance.mockReturnValueOnce(first.promise)
  const screen = renderHook(() => useSpendableBalance())
  await settle()
  screen.unmount()
  await act(async () => { first.resolve(500) })
  expect(AsyncStorage.setItem).not.toHaveBeenCalled()
})
