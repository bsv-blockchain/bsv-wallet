/**
 * The universal send form recomposes by what the recipient field resolved to.
 * These tests drive the field and check which questions the form then asks —
 * not the send itself, which the rail tests cover.
 */
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
const mockRouterPush = jest.fn()
jest.mock('expo-router', () => ({
  router: { push: mockRouterPush, back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {}
}))
jest.mock('../../ui/components/QRScanner', () => 'QRScanner')
jest.mock('../../ui/screens/WalletCheckScreen', () => ({ promptCheckWallet: jest.fn() }))
jest.mock('../../ui/components/pay/AvailableBalance', () => {
  const { Text } = require('react-native')
  return { __esModule: true, default: () => <Text testID="available-balance">balance</Text> }
})
jest.mock('../../ui/components/wallet/AmountInput', () => {
  const { TextInput } = require('react-native')
  return {
    __esModule: true,
    SEND_MAX_VALUE: '2099999999999999',
    AmountInput: ({ value, onChangeText }: { value: string; onChangeText: (v: string) => void }) => (
      <TextInput testID="amount-input" value={value} onChangeText={onChangeText} />
    )
  }
})
// managers null: no IdentityClient, no PeerPay client. The form's composition
// does not depend on either. `storage` starts undefined so the outbox stays
// unread; only the send-gating test that needs a stuck entry sets it, and only
// the two cases that carry a payment all the way to the success screen set
// `mockManagers` (which is what makes `sendHandle`'s `!wallet || !storage`
// guard pass). `walletUserId` stays null by default so neither the contacts
// tier nor the registry tier fires for the composition tests.
type MockStorage = { getKeyValue: (k: string) => Promise<string | undefined>; setKeyValue: () => Promise<void> }
let mockStorage: MockStorage | undefined
let mockManagers: { permissionsManager: unknown } | null = null
let mockWalletUserId: number | null = null
let mockNetwork: 'main' | 'test' | 'teratest' = 'main'
const mockRegistrySearch = jest.fn()
jest.mock('../../core/identity/handleRegistry/client', () => ({
  createHandleRegistryClient: () => ({ domain: 'deggen.com', search: mockRegistrySearch })
}))
/** The contacts store is the SQLite one, built from `storage.sqliteDb`; these
 * mocks carry no database, so the store is null unless a case supplies one. */
let mockContactsStore: unknown = null
jest.mock('../../ui/hooks/useContactsStore', () => ({ useContactsStore: () => mockContactsStore }))
// The overlay tier: `useRecipientInput` builds a real IdentityClient the moment
// a wallet exists, and its search would go to the network. Stubbed to "no hits"
// so the two send cases below can type a query without leaving the machine —
// the overlay tier itself is __tests__/pay/useRecipientInput.test.ts's job.
jest.mock('../../ui/resolveIdentity', () => ({
  ...jest.requireActual('../../ui/resolveIdentity'),
  searchIdentities: jest.fn(async () => [])
}))
const mockSendViaHandle = jest.fn()
// XR-061: a bare jest.fn() spy on the address rail's send call, so the
// double-activation regression test can count how many times a value-moving
// call actually went out, independent of what the real rail would do.
const mockSendToAddress = jest.fn()
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    managers: mockManagers,
    adminOriginator: 'admin.com',
    storage: mockStorage,
    walletUserId: mockWalletUserId,
    selectedNetwork: mockNetwork
  }),
  useWalletManagers: () => ({ managers: mockManagers, adminOriginator: 'admin.com', storage: mockStorage }),
  // The two rail calls a truthy wallet would otherwise make over the wire.
  // `makePeerPayClient` stays real: the "no message-box server" case below
  // depends on its sentinel returning null.
  sendViaHandle: (...args: unknown[]) => mockSendViaHandle(...args),
  sendToAddress: (...args: unknown[]) => mockSendToAddress(...args),
  listPendingResendRequests: jest.fn(async () => ({ pending: [] }))
}))

import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  configureToolbox,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX,
  resetToolboxConfig,
  ThemeProvider
} from '@bsv/expo-wallet-toolbox'
import UniversalSend, { type UniversalSendHandle } from '../../ui/components/pay/UniversalSend'

const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
const BROKEN_ADDRESS = ADDRESS.slice(0, -1) + '3'

/** One unsent outbox entry, the shape core/peerpay/outbox.ts persists. */
const stuckOutbox = () => {
  const entries = [
    {
      id: '1700000000000_0279be66',
      createdAt: new Date().toISOString(),
      recipient: KEY,
      token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1], amount: 42 },
      messageBoxUrl: 'https://mb.example',
      status: 'unsent',
      txid: 'aa'
    }
  ]
  return {
    getKeyValue: async (k: string) => (k === 'peerpay_outbox' ? JSON.stringify(entries) : undefined),
    setKeyValue: async () => {}
  }
}

/** The host's back chevron reaches the form through this ref (no in-form back control). */
let sendRef: React.RefObject<UniversalSendHandle | null>
const draw = (props: Partial<React.ComponentProps<typeof UniversalSend>> = {}) => {
  sendRef = React.createRef<UniversalSendHandle>()
  return render(
    <ThemeProvider>
      <UniversalSend ref={sendRef} onNearbySession={jest.fn()} {...props} />
    </ThemeProvider>
  )
}
const pressBack = () => {
  act(() => {
    sendRef.current?.back()
  })
}

describe('UniversalSend', () => {
  beforeEach(async () => {
    mockStorage = undefined
    mockManagers = null
    mockContactsStore = null
    mockWalletUserId = null
    mockNetwork = 'main'
    mockRegistrySearch.mockReset()
    mockRouterPush.mockReset()
    mockSendViaHandle.mockReset()
    mockSendViaHandle.mockResolvedValue({ satoshis: 2500 })
    mockSendToAddress.mockReset()
    mockSendToAddress.mockResolvedValue({ paidSatoshis: 500 })
    resetToolboxConfig()
    await AsyncStorage.clear()
  })
  afterEach(() => resetToolboxConfig())

  it('opens on step "who" with the universal placeholder and nothing else yet', () => {
    // 2026-09-18 redesign: recipient, amount and review are separate steps —
    // a fresh form shows only the recipient field until one is chosen.
    const s = draw()
    expect(s.getByPlaceholderText('recipient_placeholder')).toBeTruthy()
    expect(s.queryByText('amount')).toBeNull()
    expect(s.queryByText('note')).toBeNull()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
    expect(s.queryByText('pay_conseq_handle')).toBeNull()
  })

  it('an address: valid-address row on "who", address consequence and a note on review', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    expect(s.getByText('pay_conseq_address')).toBeTruthy()
    expect(s.getByText('pay_review_note')).toBeTruthy()
  })

  it('a key: valid-key row on "who", note on review, no consequence callout', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    expect(s.getByText('pay_review_note')).toBeTruthy()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
    expect(s.queryByText('pay_conseq_handle')).toBeNull()
  })

  // misc-p2-03: a pasted address is accepted regardless of its network version
  // byte, with no warning that it belongs to a different network than the one
  // selected — same key either way, but zero visibility for the sender.
  it('an address on a different network from the one selected: shows the mismatch warning', async () => {
    mockNetwork = 'main'
    const TESTNET_ADDRESS = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), TESTNET_ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    expect(s.getByText('pay_address_network_mismatch')).toBeTruthy()
  })

  it('an address on the selected network: no mismatch warning', async () => {
    mockNetwork = 'main'
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    expect(s.queryByText('pay_address_network_mismatch')).toBeNull()
  })

  it('a checksum-broken address: inline error, nothing else', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), BROKEN_ADDRESS)
    await waitFor(() => expect(s.getByText('invalid_bsv_address')).toBeTruthy())
    expect(s.queryByText('valid_bsv_address')).toBeNull()
    expect(s.queryByText('pay_conseq_address')).toBeNull()
  })

  it('prefills from an initial handle target and amount, skipping straight to "amount"', () => {
    // A recipient known before the form opened jumps past "who" entirely —
    // there is nothing left to decide there — landing pre-filled on "amount".
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 1500 })
    expect(s.queryByPlaceholderText('recipient_placeholder')).toBeNull()
    expect(s.getByTestId('amount-input').props.value).toBe('1500')
  })

  it('shows an initial notice as a banner', () => {
    const s = draw({ initialNotice: 'PeerPay link contains an invalid identity key' })
    expect(s.getByText('PeerPay link contains an invalid identity key')).toBeTruthy()
  })

  it('a second deep link replaces the amount on screen', () => {
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 5000 })
    fireEvent.changeText(s.getByTestId('amount-input'), '1234')
    expect(s.getByTestId('amount-input').props.value).toBe('1234')
    s.rerender(
      <ThemeProvider>
        <UniversalSend
          onNearbySession={jest.fn()}
          initialTarget={{ kind: 'handle', identityKey: KEY }}
          initialSats={200}
        />
      </ThemeProvider>
    )
    expect(s.getByTestId('amount-input').props.value).toBe('200')
  })

  it('a second, malformed deep link raises its notice as a banner', () => {
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 5000 })
    s.rerender(
      <ThemeProvider>
        <UniversalSend onNearbySession={jest.fn()} initialNotice="bad" />
      </ThemeProvider>
    )
    expect(s.getByText('bad')).toBeTruthy()
  })

  // XR-053: a peerpay: link's `url` extension silently overrides normal
  // recipient-host resolution — surfacing it on the last screen before Send
  // is the local hardening that makes a substituted/unexpected host visible.
  it('XR-053: review shows the delivery host a link named via its url extension', () => {
    const s = draw({
      initialTarget: { kind: 'handle', identityKey: KEY, messageBoxUrl: 'https://evil.example' },
      initialSats: 500
    })
    fireEvent.press(s.getByText('pay_step_continue'))
    expect(s.getByText(/evil\.example/)).toBeTruthy()
  })

  it('XR-053: review shows no delivery-host row for a handle with no linked host', () => {
    const s = draw({ initialTarget: { kind: 'handle', identityKey: KEY }, initialSats: 500 })
    fireEvent.press(s.getByText('pay_step_continue'))
    expect(s.queryByText('pay_review_delivery_host')).toBeNull()
  })

  it('never shows the message-box server bar', () => {
    const s = draw()
    expect(s.queryByLabelText('message_box_server')).toBeNull()
  })

  // The two send-gating rules the spec names. Both are the kind a refactor of
  // canSend would break silently: the handle rail needs a configured server, and
  // the address rail must never be held hostage by a stuck handle payment.
  it('a handle cannot be paid with no message-box server, and says why', async () => {
    await AsyncStorage.setItem(MESSAGE_BOX_URL_KEY, NO_MESSAGE_BOX)
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    await waitFor(() => expect(s.getByText('message_box_off_hint')).toBeTruthy())
    expect(s.getByLabelText('send').props.accessibilityState.disabled).toBe(true)
  })

  it('an address can still be paid while a handle payment is stuck in the outbox', async () => {
    // The two facts no longer share a screen (the outbox lives on "who", Send
    // on "review"), so each is checked on its own step.
    mockStorage = stuckOutbox()
    const s = draw()
    await waitFor(() => expect(s.getByText('outgoing_payments')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    await waitFor(() => expect(s.getByLabelText('send')).toBeTruthy())
    expect(s.getByLabelText('send').props.accessibilityState.disabled).toBe(false)
  })

  it('leaves the form intact and shows a banner when the wallet is not ready', async () => {
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.press(s.getByLabelText('send'))
    await waitFor(() => expect(s.getByText('wallet_not_ready')).toBeTruthy())
    // A failure must never clear what was typed — confirmed by stepping back
    // through "amount" and "who" and finding both fields exactly as left.
    pressBack()
    expect(s.getByTestId('amount-input').props.value).toBe('500')
    pressBack()
    expect(s.getByPlaceholderText('recipient_placeholder').props.value).toBe(ADDRESS)
  })

  it('XR-061: two overlapping activations of the CTA send only once', async () => {
    // isSending is React state — it does not commit synchronously. Two
    // activations landing in the same JS turn (a real double-tap, or two
    // gesture callbacks firing before the disabled prop reaches the native
    // view) must still reach the value-moving rail call only once.
    mockManagers = { permissionsManager: {} }
    mockStorage = { getKeyValue: async () => undefined, setKeyValue: async () => {} }
    const s = draw()
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
    fireEvent.press(s.getByText('pay_step_continue'))
    fireEvent.changeText(s.getByTestId('amount-input'), '500')
    fireEvent.press(s.getByText('pay_step_continue'))
    const sendBtn = s.getByLabelText('send')
    // Both activations fire inside one synchronous act() so neither sees the
    // other's isSending commit in between — the exact race the reviewer
    // described (two press callbacks landing in the same JS turn).
    act(() => {
      fireEvent.press(sendBtn)
      fireEvent.press(sendBtn)
    })
    await waitFor(() => expect(mockSendToAddress).toHaveBeenCalled())
    expect(mockSendToAddress).toHaveBeenCalledTimes(1)
  })

  /**
   * The registry tier. Contacts are local and instant, the registry is one
   * debounced request, the overlay is another — and all three land in one list
   * without any of them hiding the others.
   */
  describe('registry tier', () => {
    const REGISTRY_KEY = '03' + 'cd'.repeat(32)
    const withRegistry = () => {
      mockWalletUserId = 1
      mockNetwork = 'test'
      configureToolbox({
        backupUrl: null,
        handleRegistry: { test: { domain: 'deggen.com', url: 'https://registry.example' } }
      })
    }
    const profile = (over: Record<string, unknown> = {}) => ({
      identityKey: REGISTRY_KEY,
      paymail: 'dee@deggen.com',
      handle: 'dee',
      domain: 'deggen.com',
      displayName: 'Dee K',
      issuedAt: new Date(),
      certificate: {},
      ...over
    })
    /**
     * Comfortably past the registry's own 400 ms timer, so a request the gates
     * were supposed to refuse has had its chance to be made. Every "never
     * fires" case below needs this: `waitFor` whose callback succeeds on its
     * first invocation resolves in about a millisecond, which is long before
     * the debounce, so `expect(search).not.toHaveBeenCalled()` after one would
     * hold with no gates in the component at all.
     */
    const waitPastDebounce = async () => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 450))
      })
    }

    it('offers a registry hit with its name, its full paymail and the registered badge', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([profile()])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
      expect(s.getByText('dee@deggen.com')).toBeTruthy()
      expect(s.getByText('pay_trust_handle_attested')).toBeTruthy()
      expect(mockRegistrySearch).toHaveBeenCalledWith('dee')
      // And the footer goes when the tier that raised it answers. Nothing else
      // in either suite reaches the far side of `registrySearching`, so a
      // regression there would leave a permanent spinner under every result
      // list in the app and no test would notice.
      expect(s.queryByText('searching')).toBeNull()
    })

    // misc-p2-14: the pinned registry's own certificate is real vetting; a
    // foreign domain answering `search` is only "that domain's DNS + TLS says
    // so" (paymail-equivalent) — the badge must not claim the same thing for
    // both.
    it('gives a foreign-domain registry match the domain-attested badge instead of the pinned "Registered" one', async () => {
      withRegistry() // pinned registry domain is 'deggen.com'
      mockRegistrySearch.mockResolvedValue([
        profile({ domain: 'other-registry.example', paymail: 'dee@other-registry.example' })
      ])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
      expect(s.getByText('pay_trust_handle_domain_attested')).toBeTruthy()
      expect(s.queryByText('pay_trust_handle_attested')).toBeNull()
    })

    /**
     * `displayName` is the owner's own unvalidated plaintext — no content rule
     * in the certificate builder, the verifier or the Go server — and this row
     * draws it ABOVE the handle it belongs to. Left alone, a squatter who
     * registers `dee1` with the display name `dee@deggen.com` gets a row
     * reading exactly like the victim's, carrying the same attested badge, and
     * the field and the review card then carry that NAME rather than the
     * handle.
     */
    it('will not let a display name shaped like an address stand in for the handle', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([
        profile({
          identityKey: '02' + 'ef'.repeat(32),
          displayName: 'dee@deggen.com',
          handle: 'dee1',
          paymail: 'dee1@deggen.com'
        })
      ])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('dee1@deggen.com')).toBeTruthy())
      // Its own handle on both lines, rather than somebody else's address on
      // the one the eye reads first.
      expect(s.getByText('dee1')).toBeTruthy()
      expect(s.queryByText('dee@deggen.com')).toBeNull()
    })

    /**
     * The review card is the last screen before money moves, and until now the
     * only one that never showed the `handle@domain` being paid: the row's own
     * second line was computed and then thrown away at `selectIdentity`.
     */
    it('names the handle being paid on the review card, not just the abbreviated key', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([profile()])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
      fireEvent.press(s.getByText('Dee K'))
      fireEvent.press(await waitFor(() => s.getByText('pay_step_continue')))
      fireEvent.changeText(s.getByTestId('amount-input'), '2500')
      fireEvent.press(s.getByText('pay_step_continue'))
      await waitFor(() => expect(s.getByLabelText('send')).toBeTruthy())
      expect(s.getByText('dee@deggen.com')).toBeTruthy()
    })

    it('falls back to the handle when the profile carries no public name', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([profile({ displayName: undefined })])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('dee')).toBeTruthy())
    })

    /**
     * Also the guard against the effect re-running on every render: if the
     * client were memoised on the config OBJECT it would have a new identity
     * each render, the effect's cleanup would clear the timer before it could
     * fire, and this case would time out rather than see one call.
     */
    it('debounces: one request for a word typed one letter at a time', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([])
      const s = draw()
      const input = s.getByPlaceholderText('recipient_placeholder')
      fireEvent.changeText(input, 'd')
      fireEvent.changeText(input, 'de')
      fireEvent.changeText(input, 'dee')
      await waitFor(() => expect(mockRegistrySearch).toHaveBeenCalledTimes(1))
      expect(mockRegistrySearch).toHaveBeenCalledWith('dee')
    })

    it('leaves the rows it already has on screen while the next query is in flight', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([profile()])
      const s = draw()
      const input = s.getByPlaceholderText('recipient_placeholder')
      fireEvent.changeText(input, 'dee')
      await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
      // The next keystroke must not blank the list: the footer spinner says a
      // tier is still loading, and the rows already found stay pickable.
      mockRegistrySearch.mockReturnValue(new Promise(() => {}))
      fireEvent.changeText(input, 'deeg')
      expect(s.getByText('Dee K')).toBeTruthy()
      // And the spinner is the REGISTRY's. Past the overlay's own 400 ms timer
      // `recipient.isSearching` has gone false (its callback finds no
      // IdentityClient and gives up), so a footer still on screen here can
      // only come from `registrySearching` — the half of
      // `isSearching={recipient.isSearching || registrySearching}` that
      // nothing else in either suite reaches.
      await waitPastDebounce()
      expect(s.getByText('searching')).toBeTruthy()
      expect(s.getByText('Dee K')).toBeTruthy()
    })

    it('never fires for a pasted identity key, an address, or a mistyped address', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([])
      const s = draw()
      const input = s.getByPlaceholderText('recipient_placeholder')
      fireEvent.changeText(input, KEY)
      await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
      fireEvent.changeText(input, ADDRESS)
      await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
      // The third is the one only `classifyRecipientInput` can rule out: a
      // checksum-broken address resolves no target, so the `!target` gate does
      // not cover it, and a half-typed address is nobody's handle.
      fireEvent.changeText(input, BROKEN_ADDRESS)
      await waitFor(() => expect(s.getByText('invalid_bsv_address')).toBeTruthy())
      await waitPastDebounce()
      expect(mockRegistrySearch).not.toHaveBeenCalled()
      // The positive control: the same field, one routable word, does reach the
      // registry — so the three refusals above are refusals, not a dead harness.
      fireEvent.changeText(input, 'dee')
      await waitFor(() => expect(mockRegistrySearch).toHaveBeenCalledTimes(1))
      expect(mockRegistrySearch).toHaveBeenCalledWith('dee')
    })

    it('never fires for a single character, and fires for the second', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([])
      const s = draw()
      const input = s.getByPlaceholderText('recipient_placeholder')
      fireEvent.changeText(input, 'd')
      await waitPastDebounce()
      expect(mockRegistrySearch).not.toHaveBeenCalled()
      // Two characters is the registry's own minimum, so it is also where the
      // boundary has to be proven from both sides.
      fireEvent.changeText(input, 'de')
      await waitFor(() => expect(mockRegistrySearch).toHaveBeenCalledTimes(1))
      expect(mockRegistrySearch).toHaveBeenCalledWith('de')
    })

    it('never fires with no registry configured for this chain', async () => {
      // Everything else in place: a wallet user, a routable word, and no
      // `configureToolbox` call. Elapsed time is the only available proof here
      // — nothing can ever arrive to wait for.
      mockWalletUserId = 1
      mockNetwork = 'test'
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitPastDebounce()
      expect(mockRegistrySearch).not.toHaveBeenCalled()
      // Nor is "no registry on this chain" an outage: no notice, no spinner
      // left running under a list that is never going to grow.
      expect(s.queryByText('identity_search_unavailable')).toBeNull()
      expect(s.queryByText('searching')).toBeNull()
    })

    it('never fires before the wallet user is known', async () => {
      withRegistry()
      mockWalletUserId = null
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitPastDebounce()
      expect(mockRegistrySearch).not.toHaveBeenCalled()
      expect(s.queryByText('identity_search_unavailable')).toBeNull()
    })

    it('raises the existing search notice when the registry cannot be reached, and drops it on the next step', async () => {
      withRegistry()
      // Restored at the end: the root jest config sets neither `restoreMocks`
      // nor `resetMocks`, so an unrestored spy would silence every later case
      // in this file, React's own warnings included.
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      mockRegistrySearch.mockRejectedValue(new Error('offline'))
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('identity_search_unavailable')).toBeTruthy())
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
      await waitFor(() => expect(s.getByText('valid_bsv_address')).toBeTruthy())
      fireEvent.press(s.getByText('pay_step_continue'))
      await waitFor(() => expect(s.queryByText('identity_search_unavailable')).toBeNull())
      errorSpy.mockRestore()
    })

    /**
     * And the notice goes when the registry comes back, without having to leave
     * the step: otherwise one search made on a train leaves an outage banner
     * over every successful search afterwards.
     */
    it('drops the notice as soon as a later search succeeds, on the same step', async () => {
      withRegistry()
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      mockRegistrySearch.mockRejectedValue(new Error('offline'))
      const s = draw()
      const input = s.getByPlaceholderText('recipient_placeholder')
      fireEvent.changeText(input, 'dee')
      await waitFor(() => expect(s.getByText('identity_search_unavailable')).toBeTruthy())
      mockRegistrySearch.mockResolvedValue([profile()])
      fireEvent.changeText(input, 'deek')
      await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
      expect(s.queryByText('identity_search_unavailable')).toBeNull()
      // Without having left "who", which is the only other thing that clears it.
      expect(s.getByPlaceholderText('recipient_placeholder')).toBeTruthy()
      errorSpy.mockRestore()
    })

    /**
     * Offline both remote tiers fail on the same keystroke and both reach for
     * the same sentence. Two banners carrying it read as the error coming back
     * when the first is dismissed.
     */
    it('raises one notice, not two, when the overlay tier fails alongside the registry', async () => {
      withRegistry()
      mockManagers = { permissionsManager: {} }
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const overlay = jest.requireMock('../../ui/resolveIdentity').searchIdentities as jest.Mock
      overlay.mockRejectedValueOnce(new Error('offline'))
      mockRegistrySearch.mockRejectedValue(new Error('offline'))
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(mockRegistrySearch).toHaveBeenCalled())
      await waitFor(() => expect(s.getAllByText('identity_search_unavailable')).toHaveLength(1))
      overlay.mockResolvedValue([])
      errorSpy.mockRestore()
    })

    it('selecting a registry row goes down the existing handle path', async () => {
      withRegistry()
      mockRegistrySearch.mockResolvedValue([profile()])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
      fireEvent.press(s.getByText('Dee K'))
      await waitFor(() => expect(s.getByText('pay_step_continue')).toBeTruthy())
    })

    it('shows one row per person, even when a host answers with two certificates for one key', async () => {
      withRegistry()
      // The pinned registry holds one active handle per key, but `search` may be
      // answered by any domain that resolves, and a host that is not ours can
      // sign two verifiable certificates for the same subject. De-duplication is
      // by identity key across the WHOLE merged list, this tier included.
      mockRegistrySearch.mockResolvedValue([profile(), profile({ handle: 'deek', paymail: 'deek@deggen.com' })])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('dee@deggen.com')).toBeTruthy())
      expect(s.queryByText('deek@deggen.com')).toBeNull()
      expect(s.getAllByText('Dee K')).toHaveLength(1)
    })

    /** From "who", with a recipient already resolved, to the success overlay. */
    const payCurrentRecipient = async (s: ReturnType<typeof draw>) => {
      const sendsBefore = mockSendViaHandle.mock.calls.length
      await waitFor(() => expect(s.getByText('pay_step_continue')).toBeTruthy())
      fireEvent.press(s.getByText('pay_step_continue'))
      fireEvent.changeText(s.getByTestId('amount-input'), '2500')
      fireEvent.press(s.getByText('pay_step_continue'))
      await waitFor(() => expect(s.getByLabelText('send')).toBeTruthy())
      fireEvent.press(s.getByLabelText('send'))
      await waitFor(() => expect(mockSendViaHandle.mock.calls).toHaveLength(sendsBefore + 1))
    }

    /**
     * `handleSend` clears the field through the hook's own `clearRecipient`
     * rather than the wrapper that forgets the picked handle — deliberately, so
     * the success overlay can still read it. That is exactly why the handle is
     * held against the key it belongs to: a bare string would outlive its owner
     * and be offered as the NEXT person's registered handle.
     */
    it('carries the picked handle into "save as contact", and only for the person it belongs to', async () => {
      withRegistry()
      mockManagers = { permissionsManager: {} }
      mockStorage = { getKeyValue: async () => undefined, setKeyValue: async () => {} }
      mockContactsStore = { searchContacts: async () => [], getContact: async () => undefined }
      mockRegistrySearch.mockResolvedValue([profile()])
      const s = draw()
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), 'dee')
      await waitFor(() => expect(s.getByText('Dee K')).toBeTruthy())
      fireEvent.press(s.getByText('Dee K'))
      await payCurrentRecipient(s)
      await waitFor(() => expect(s.getByText('pay_save_as_contact')).toBeTruthy())
      fireEvent.press(s.getByText('pay_save_as_contact'))
      expect(mockRouterPush).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ identityKey: REGISTRY_KEY, handle: 'dee@deggen.com' })
        })
      )

      // Same mounted form, a different person, pasted as a bare key: nothing
      // published a handle for them, so the offer must carry none.
      fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
      await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
      await payCurrentRecipient(s)
      await waitFor(() => expect(s.getByText('pay_save_as_contact')).toBeTruthy())
      fireEvent.press(s.getByText('pay_save_as_contact'))
      expect(mockRouterPush).toHaveBeenLastCalledWith(
        expect.objectContaining({ params: expect.objectContaining({ identityKey: KEY, handle: '' }) })
      )
    })
  })
})
