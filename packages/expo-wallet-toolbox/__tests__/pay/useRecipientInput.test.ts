// The hook imports from the package root, which pulls LocalStorageProvider's
// secrets stack (expo-secure-store / expo-local-authentication) at module load.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { act, renderHook } from '@testing-library/react-native'
import { classifyIdentitySearchError, useRecipientInput } from '../../ui/components/pay/useRecipientInput'
import { encodeSession, mintSession } from '../../core/localpay/session'

const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + '3'

// wallet: null → no IdentityClient is built, so search resolves to nothing
// without touching the network. Everything else here is pure classification.
const draw = (extra: Partial<Parameters<typeof useRecipientInput>[0]> = {}) =>
  renderHook(() => useRecipientInput({ wallet: null, adminOriginator: 'admin.com', ...extra }))

describe('classifyIdentitySearchError', () => {
  it('treats any thrown overlay lookup failure as an outage, not “no such person”', () => {
    expect(classifyIdentitySearchError(new Error('timeout'))).toBe(true)
  })
})

describe('useRecipientInput — typing', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('starts empty', () => {
    const { result } = draw()
    expect(result.current.target).toBeNull()
    expect(result.current.inputText).toBe('')
    expect(result.current.inlineError).toBeNull()
  })

  it('makes an address target from a valid address, with no search', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(ADDRESS))
    expect(result.current.target).toEqual({ kind: 'address', address: ADDRESS })
    expect(result.current.isSearching).toBe(false)
  })

  it('flags a checksum-broken address inline and keeps the target null', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(BROKEN_ADDRESS))
    expect(result.current.target).toBeNull()
    expect(result.current.inlineError).toBe('invalid_bsv_address')
    expect(result.current.isSearching).toBe(false)
  })

  it('makes a handle target from a compressed key, lowercased', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(KEY.toUpperCase()))
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY })
  })

  it('makes a handle target from a peerpay link and reports its amount and host', () => {
    const onPeerPayAmount = jest.fn()
    const { result } = draw({ onPeerPayAmount })
    act(() => result.current.onChangeText(`peerpay:${KEY}?sats=99&url=${encodeURIComponent('https://mb.example')}`))
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' })
    expect(onPeerPayAmount).toHaveBeenCalledWith(99)
  })

  it('reports a malformed peerpay link through onPeerPayError', () => {
    const onPeerPayError = jest.fn()
    const { result } = draw({ onPeerPayError })
    act(() => result.current.onChangeText('peerpay:nope'))
    expect(result.current.target).toBeNull()
    expect(onPeerPayError).toHaveBeenCalledWith(expect.stringContaining('identity key'))
  })

  it('searches for free text after the debounce, and stops when there is no client', () => {
    const { result } = draw()
    act(() => result.current.onChangeText('alice'))
    expect(result.current.isSearching).toBe(true)
    expect(result.current.target).toBeNull()
    act(() => {
      jest.advanceTimersByTime(450)
    })
    expect(result.current.isSearching).toBe(false)
    expect(result.current.searchResults).toEqual([])
  })

  it('clears everything on an empty string', () => {
    const { result } = draw()
    act(() => result.current.onChangeText(ADDRESS))
    act(() => result.current.onChangeText(''))
    expect(result.current.target).toBeNull()
    expect(result.current.inlineError).toBeNull()
  })

  it('adopts an initial target and shows its text', () => {
    const { result } = draw({ initialTarget: { kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' } })
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://mb.example' })
    expect(result.current.inputText).toBe(KEY)
  })

  it('clearRecipient resets to empty', () => {
    const { result } = draw({ initialTarget: { kind: 'address', address: ADDRESS } })
    act(() => result.current.clearRecipient())
    expect(result.current.target).toBeNull()
    expect(result.current.inputText).toBe('')
  })
})

describe('useRecipientInput — scanning', () => {
  it('sets an address target from an address QR and closes the scanner', () => {
    const { result } = draw()
    act(() => result.current.openScanner())
    expect(result.current.scannerVisible).toBe(true)
    act(() => result.current.onScan(`bitcoin:${ADDRESS}`))
    expect(result.current.target).toEqual({ kind: 'address', address: ADDRESS })
    expect(result.current.scannerVisible).toBe(false)
  })

  it('sets a handle target from a peerpay QR and reports the amount', () => {
    const onPeerPayAmount = jest.fn()
    const { result } = draw({ onPeerPayAmount })
    act(() => result.current.openScanner())
    act(() => result.current.onScan(`peerpay:${KEY}?sats=12`))
    expect(result.current.target).toEqual({ kind: 'handle', identityKey: KEY })
    expect(onPeerPayAmount).toHaveBeenCalledWith(12)
    expect(result.current.scannerVisible).toBe(false)
  })

  it('hands a nearby session up and closes the scanner without setting a target', () => {
    const onNearbySession = jest.fn()
    const { result } = draw({ onNearbySession })
    const session = mintSession({
      identityKey: KEY,
      derivationPrefix: 'ZGV2LXByZWZpeA==',
      derivationSuffix: 'ZGV2LXN1ZmZpeA==',
      supportsAwdl: false
    })
    act(() => result.current.openScanner())
    act(() => result.current.onScan(encodeSession(session)))
    expect(onNearbySession).toHaveBeenCalledWith(expect.objectContaining({ identityKey: KEY }))
    expect(result.current.target).toBeNull()
    expect(result.current.scannerVisible).toBe(false)
  })

  it('ignores junk and leaves the scanner open', () => {
    const { result } = draw()
    act(() => result.current.openScanner())
    act(() => result.current.onScan('hello world'))
    expect(result.current.target).toBeNull()
    expect(result.current.scannerVisible).toBe(true)
  })
})
