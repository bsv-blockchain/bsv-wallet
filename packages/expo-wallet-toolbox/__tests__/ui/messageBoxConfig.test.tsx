/**
 * XR-065 (SEC2-074): MessageBoxConfig's handleSave persisted whatever the
 * person typed with only a trailing-slash trim -- no scheme policy at all,
 * unlike WalletConfigScreen's ARC endpoint (validateArcUrl, XR-064). A plain
 * http: MessageBox host, or one carrying embedded credentials, saved
 * successfully and every later handle-rail request went out over it.
 */
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/pay/rails/handle'),
  isAllowedServiceOrigin: jest.requireActual('../../core/toolboxConfig').isAllowedServiceOrigin,
  spacing: {},
  typography: {},
  radii: {}
}))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))

import { act, renderHook } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useMessageBoxConfig } from '../../ui/components/pay/MessageBoxConfig'
import { DEFAULT_MESSAGE_BOX_URL } from '../../core/pay/rails/handle'

const t = (key: string) => key

beforeEach(async () => {
  await AsyncStorage.clear()
})

it('XR-065: refuses to save a plain http MessageBox host', async () => {
  const { result } = renderHook(() => useMessageBoxConfig(t))
  await act(async () => {
    await result.current.handleSave('http://mb.example.com')
  })
  expect(result.current.messageBoxUrl).toBe(DEFAULT_MESSAGE_BOX_URL)
  expect(await AsyncStorage.getItem('message_box_url')).toBeNull()
})

it('XR-065: refuses to save a MessageBox host carrying embedded credentials', async () => {
  const { result } = renderHook(() => useMessageBoxConfig(t))
  await act(async () => {
    await result.current.handleSave('https://user:pass@mb.example.com')
  })
  expect(result.current.messageBoxUrl).toBe(DEFAULT_MESSAGE_BOX_URL)
  expect(await AsyncStorage.getItem('message_box_url')).toBeNull()
})

it('still saves an ordinary https MessageBox host', async () => {
  const { result } = renderHook(() => useMessageBoxConfig(t))
  await act(async () => {
    await result.current.handleSave('https://mb.example.com')
  })
  expect(result.current.messageBoxUrl).toBe('https://mb.example.com')
  expect(await AsyncStorage.getItem('message_box_url')).toBe('https://mb.example.com')
})

it('still saves a plain http MessageBox host on a local-dev host', async () => {
  const { result } = renderHook(() => useMessageBoxConfig(t))
  await act(async () => {
    await result.current.handleSave('http://localhost:9000')
  })
  expect(result.current.messageBoxUrl).toBe('http://localhost:9000')
})
