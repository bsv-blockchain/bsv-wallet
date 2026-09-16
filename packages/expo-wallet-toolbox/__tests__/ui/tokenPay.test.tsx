/**
 * Paying in a stablecoin.
 *
 * What these pin is the asset axis and the refusals around it: the asset is
 * chosen upstream (Home's coin switcher, or a link) and the forms show no
 * picker of their own, the amount is typed and emitted in the asset's own units, an address is refused inline without erasing what was typed, the
 * CTA names the exact figure, and every failure's copy comes from the classifier
 * rather than from whatever string the overlay happened to return.
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
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join('|')}` : key,
    i18n: { language: 'en' }
  }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {}
}))
jest.mock('../../ui/components/QRScanner', () => 'QRScanner')
jest.mock('../../ui/screens/WalletCheckScreen', () => ({ promptCheckWallet: jest.fn() }))
// `managers`/`storage` default to the same "nothing wired up" shape every
// existing test in this file already relies on; only the BSV handle-send
// success-note test below points them at something truthy, via
// `mockManagers`/`mockHandleStorage`, reset in `beforeEach`.
let mockManagers: { permissionsManager: unknown } | null = null
let mockHandleStorage: unknown = undefined
// `false` = the wallet is still building, so "no token runtime" is UNKNOWN
// rather than settled; the one test that needs a settled "never" flips it.
let mockWalletBuilt = false
const mockSendViaHandle = jest.fn()
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({ managers: mockManagers, adminOriginator: 'admin.com', storage: mockHandleStorage }),
  useWalletManagers: () => ({ managers: mockManagers, adminOriginator: 'admin.com', storage: mockHandleStorage }),
  useWalletStatus: () => ({
    walletBuilt: mockWalletBuilt,
    walletBuilding: !mockWalletBuilt,
    configStatus: 'ok',
    selectedNetwork: 'main'
  }),
  // The BSV handle rail's own send and client construction — not what this
  // suite is about (that is `__tests__/pay/handleRail.test.ts`'s job), so
  // stubbed the same way `nearbyFlowToken.test.tsx` stubs its rail deps: a
  // client truthy enough to pass `sendHandle`'s guard, and a send that
  // resolves without touching the network.
  makePeerPayClient: jest.fn(() => ({}) as never),
  sendViaHandle: (...args: unknown[]) => mockSendViaHandle(...args),
  // No outbox test in this file reads real entries; stubbed so a truthy
  // `mockHandleStorage` (a plain object, not a real StorageExpoSQLite) never
  // has to shape up as one. `loadOutbox` calls both on every mount.
  getOutboxEntries: jest.fn(async () => []),
  pruneExpiredSent: jest.fn(async () => {})
}))
jest.mock('../../ui/hooks/useSpendableBalance', () => ({ useSpendableBalance: () => 50_000 }))

beforeEach(() => {
  mockManagers = null
  mockHandleStorage = undefined
  mockWalletBuilt = false
  mockSendViaHandle.mockReset()
  mockSendViaHandle.mockResolvedValue({ satoshis: 2500 })
})

import React from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { ThemeProvider } from '@bsv/expo-wallet-toolbox'
import AssetPicker from '../../ui/components/pay/AssetPicker'
import AdmissionNotice from '../../ui/components/pay/AdmissionNotice'
import RecipientField from '../../ui/components/pay/RecipientField'
import RequestHub from '../../ui/components/pay/RequestHub'
import UniversalSend from '../../ui/components/pay/UniversalSend'
import { AmountInput } from '../../ui/components/wallet/AmountInput'
import { MandalaProvider } from '../../ui/hooks/useMandala'
import { tokenRefusalCopy, tokenSendCopy, tokenThrowCopy } from '../../ui/components/pay/tokenSendCopy'
import { resources as translations } from '../../core/i18n/translations'
import { balanceOf, makeFakeMandala, USDX, EURX } from '../__mocks__/fakeMandalaRuntime'

const KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ADDRESS = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

const CTX = {
  ticker: 'USDX',
  issuer: 'Acme Bank',
  issuerFallback: 'the issuer',
  reasonFallback: 'an unknown problem'
}
/** The shipped English copy, so a claim about a sentence is a claim about the real one. */
const en = (translations as Record<string, { translation: Record<string, string> }>).en.translation

describe('tokenSendCopy', () => {
  it('narrows a refusal to the reason, keeping the guarantee attached', () => {
    expect(tokenRefusalCopy('asset_paused', CTX).key).toBe('token_err_refused_paused')
    expect(tokenRefusalCopy('input_frozen', CTX).key).toBe('token_err_refused_frozen')
    expect(tokenRefusalCopy('recipient_not_admitted', CTX).key).toBe('token_err_refused_recipient')
    expect(tokenRefusalCopy('registry_screening', CTX).key).toBe('token_err_refused_recipient')
  })

  it('falls back to the plain refusal for a code nothing narrows', () => {
    const copy = tokenRefusalCopy('conservation_violation', CTX)
    expect(copy.key).toBe('token_err_refused')
    expect(copy.values).toEqual({ ticker: 'USDX', issuer: 'Acme Bank' })
    expect(copy.action).toBeUndefined()
  })

  it('a local fault says plainly that nothing left the wallet, names the reason, and offers no check', () => {
    // Hand-over-first (§4.5 / wire §9.13): nothing is contacted at send time,
    // so "unavailable" can only ever be a LOCAL fault — which is provable,
    // reversible and nothing to do with the issuer.
    const copy = tokenSendCopy({ kind: 'unavailable', message: 'MessageBox unreachable' }, CTX)
    expect(copy?.key).toBe('token_err_send_failed')
    expect(copy?.values.reason).toBe('MessageBox unreachable')
    expect(copy?.action).toBeUndefined()
  })

  it('the local-fault sentence never names the issuer', () => {
    const copy = tokenSendCopy({ kind: 'unavailable', message: 'wallet could not sign' }, CTX)
    const rendered = en.token_err_send_failed.replace('{{reason}}', String(copy?.values.reason))
    expect(rendered).toContain('wallet could not sign')
    expect(rendered).not.toContain('{{issuer}}')
    expect(en.token_err_send_failed).not.toContain('{{issuer}}')
    expect(en.token_err_send_failed).toMatch(/nothing left your wallet/i)
  })

  it('falls back to a translated phrase rather than an empty reason', () => {
    expect(tokenSendCopy({ kind: 'unavailable', message: '' }, CTX)?.values.reason).toBe(CTX.reasonFallback)
  })

  it('treats the lib\'s explicit overlay rejection as a refusal, and anything local as a send failure', () => {
    expect(tokenThrowCopy(new Error('overlay rejected the transaction'), CTX).key).toBe('token_err_refused')
    expect(tokenThrowCopy(new Error('fetch failed'), CTX).key).toBe('token_err_send_failed')
    expect(tokenThrowCopy(new Error('insufficient token balance: have 1, need 2'), CTX).key).toBe(
      'token_err_balance_changed'
    )
  })

  it('names "the issuer" when the issuer cannot be named', () => {
    expect(tokenRefusalCopy('x', { ticker: 'USDX', issuerFallback: 'the issuer' }).values.issuer).toBe('the issuer')
  })

  it('has no copy for a successful send', () => {
    expect(tokenSendCopy({ kind: 'sent', txid: 'a'.repeat(64), settled: true }, CTX)).toBeNull()
  })
})

describe('AmountInput in asset mode', () => {
  const draw = (onChangeText = jest.fn(), value = '') => ({
    onChangeText,
    screen: wrap(
      <AmountInput value={value} onChangeText={onChangeText} asset={{ ticker: 'USDX', decimals: 2 }} maxValue="112000" />
    )
  })

  it('takes a decimal figure and emits whole base units', () => {
    const { onChangeText, screen } = draw()
    fireEvent.changeText(screen.getByPlaceholderText('0.00'), '25.5')
    expect(onChangeText).toHaveBeenCalledWith('2550')
  })

  it('refuses more decimal places than the asset has, rather than rounding', () => {
    const { onChangeText, screen } = draw()
    fireEvent.changeText(screen.getByPlaceholderText('0.00'), '25.005')
    expect(onChangeText).not.toHaveBeenCalled()
  })

  it('labels the unit with the ticker and prints no converted line', () => {
    const { screen } = draw(jest.fn(), '2500')
    expect(screen.getByText('USDX')).toBeTruthy()
    expect(screen.queryByText('satoshis')).toBeNull()
    // The fiat/BSV cross has no meaning for a token and must not be rendered.
    expect(screen.queryByText(/BSV/)).toBeNull()
  })

  it('writes the real spendable figure for Max, never the satoshi sentinel', () => {
    const { onChangeText, screen } = draw()
    fireEvent.press(screen.getByText('send_max'))
    expect(onChangeText).toHaveBeenCalledWith('112000')
  })
})

describe('AssetPicker', () => {
  it('does not exist for a wallet that holds no token', () => {
    expect(wrap(<AssetPicker balances={[]} selected={null} onSelect={jest.fn()} />).toJSON()).toBeNull()
  })

  it('shows BSV selected by default and expands to the held assets', () => {
    const onSelect = jest.fn()
    const s = wrap(
      <AssetPicker balances={[balanceOf(), balanceOf(EURX, 5000)]} selected={null} onSelect={onSelect} bsvBalanceText="50,000" />
    )
    expect(s.getByText('BSV')).toBeTruthy()
    // Pressed through the row's own content: the composed accessibility label
    // sits on a wrapper, and the touchable is the ListRow inside it.
    fireEvent.press(s.getByText('BSV'))
    expect(s.getByLabelText('Acme Dollar, 1,240.00 USDX')).toBeTruthy()
    fireEvent.press(s.getByLabelText('Euro Coin, 50.00 EURX'))
    expect(onSelect).toHaveBeenCalledWith(EURX.assetId)
  })

  it('announces the selection as state, not only as a checkmark', () => {
    const s = wrap(<AssetPicker balances={[balanceOf()]} selected={USDX.assetId} onSelect={jest.fn()} />)
    fireEvent.press(s.getAllByText('Acme Dollar')[0])
    // Two elements carry that label once expanded — the collapsed trigger
    // (which announces `expanded`) and the option (which announces `selected`).
    const option = s.getAllByLabelText('Acme Dollar, 1,240.00 USDX').find(e => 'selected' in (e.props.accessibilityState ?? {}))
    expect(option?.props.accessibilityState.selected).toBe(true)
    expect(s.getByLabelText('BSV').props.accessibilityState.selected).toBe(false)
  })
})

describe('RecipientField with an asset selected', () => {
  const base = {
    selectedIdentity: null,
    inputText: ADDRESS,
    inlineError: null,
    isSearching: false,
    searchResults: [],
    onChangeText: jest.fn(),
    onSelectIdentity: jest.fn(),
    onClear: jest.fn(),
    onOpenScanner: jest.fn(),
    t: ((k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join('|')}` : k)) as never
  }

  it('refuses an address with a plain reason, and keeps what was typed', () => {
    const s = render(
      <ThemeProvider>
        <RecipientFieldHarness {...base} target={{ kind: 'address', address: ADDRESS }} assetTicker="USDX" />
      </ThemeProvider>
    )
    expect(s.getByText('pay_asset_address_status:USDX')).toBeTruthy()
    // Non-destructive: switch back to BSV and it is valid again immediately.
    expect(s.getByDisplayValue(ADDRESS)).toBeTruthy()
    expect(s.queryByText('valid_bsv_address')).toBeNull()
  })

  it('is the ordinary field again with no asset selected', () => {
    const s = render(
      <ThemeProvider>
        <RecipientFieldHarness {...base} target={{ kind: 'address', address: ADDRESS }} />
      </ThemeProvider>
    )
    expect(s.getByText('valid_bsv_address')).toBeTruthy()
  })

  it('renders a caller-owned status line for the issuer\'s own refusal', () => {
    const s = render(
      <ThemeProvider>
        <RecipientFieldHarness
          {...base}
          inputText={KEY}
          target={{ kind: 'handle', identityKey: KEY }}
          assetTicker="USDX"
          statusOverride={{ text: 'Acme Bank has not registered this person', tone: 'warning' }}
        />
      </ThemeProvider>
    )
    expect(s.getByText('Acme Bank has not registered this person')).toBeTruthy()
  })
})

/** Typed wrapper so each case reads as the props under test, not as a cast. */
function RecipientFieldHarness(props: React.ComponentProps<typeof RecipientField>) {
  const { colors } = require('@bsv/expo-wallet-toolbox').useTheme()
  return <RecipientField {...props} colors={colors} />
}

describe('RequestHub with an asset selected', () => {
  const drawHub = (selectedAssetId: string | null) =>
    wrap(
      <RequestHub
        requestSats=""
        onChangeRequestSats={jest.fn()}
        onPick={jest.fn()}
        online
        balances={[balanceOf()]}
        selectedAssetId={selectedAssetId}
        onSelectAsset={jest.fn()}
      />
    )

  it('offers no picker of its own: the coin was chosen on Home (design 1b)', () => {
    expect(drawHub(null).queryByText('pay_asset_label_get')).toBeNull()
    expect(drawHub(USDX.assetId).queryByText('pay_asset_label_get')).toBeNull()
  })

  it('disables the address row with a plain reason rather than removing it', () => {
    const s = drawHub(USDX.assetId)
    const row = s.getByLabelText('pay_method_address. pay_asset_address_status:USDX')
    expect(row.props.accessibilityState.disabled).toBe(true)
    expect(s.getByText('pay_method_address')).toBeTruthy()
  })

  it('offers the link row the same way in either money — the link names the asset and carries the figure', () => {
    const s = drawHub(USDX.assetId)
    expect(s.getByText('pay_cell_handle_get_sub')).toBeTruthy()
    expect(s.queryByText('pay_asset_link_no_amount')).toBeNull()
  })

  it('leaves all three rows alone when paying in BSV', () => {
    const s = drawHub(null)
    expect(s.getByLabelText('pay_method_address. pay_cell_address_get_sub').props.accessibilityState.disabled).toBe(
      false
    )
  })
})

describe('AdmissionNotice', () => {
  it('names the party who decides and offers the rail that works', () => {
    const onBsvInstead = jest.fn()
    const s = wrap(<AdmissionNotice ticker="USDX" issuerName="Acme Bank" onBsvInstead={onBsvInstead} />)
    expect(s.getByText('token_admit_title:USDX')).toBeTruthy()
    expect(s.getByText('token_admit_body:Acme Bank|USDX')).toBeTruthy()
    fireEvent.press(s.getByLabelText('token_admit_bsv_instead'))
    expect(onBsvInstead).toHaveBeenCalled()
  })

  it('prefers the runtime\'s own plain reason when it has one', () => {
    const s = wrap(
      <AdmissionNotice ticker="USDX" reason="Acme Bank has revoked your registration." onBsvInstead={jest.fn()} />
    )
    expect(s.getByText('Acme Bank has revoked your registration.')).toBeTruthy()
    expect(s.queryByText(/token_admit_body/)).toBeNull()
  })
})

describe('UniversalSend with stablecoins', () => {
  /** The form is up and the runtime's holdings have landed (nothing on screen announces that any more). */
  const held = async (s: ReturnType<typeof render>) => {
    await waitFor(() => expect(s.getByText('recipient')).toBeTruthy())
    await act(async () => {
      await new Promise(resolve => setImmediate(resolve))
    })
  }
  const drawSend = (runtime: ReturnType<typeof makeFakeMandala> | null, props = {}) =>
    render(
      <ThemeProvider>
        <MandalaProvider runtime={runtime}>
          <UniversalSend onNearbySession={jest.fn()} {...props} />
        </MandalaProvider>
      </ThemeProvider>
    )

  it('is today\'s form when no runtime exists at all', async () => {
    const s = drawSend(null)
    await waitFor(() => expect(s.getByText('recipient')).toBeTruthy())
    expect(s.queryByText('pay_asset_label')).toBeNull()
  })

  it('is today\'s form when a runtime exists but nothing is held', async () => {
    const s = drawSend(makeFakeMandala({ balances: [] }))
    await waitFor(() => expect(s.getByText('recipient')).toBeTruthy())
    expect(s.queryByText('pay_asset_label')).toBeNull()
  })

  it('offers no picker even when something is held: the coin was chosen on Home (design 1b)', async () => {
    const s = drawSend(makeFakeMandala())
    await held(s)
    expect(s.queryByText('pay_asset_label')).toBeNull()
    const labels = s.getAllByText(/^(recipient|pay_asset_label|amount)$/).map(el => el.props.children)
    expect(labels).toEqual(['recipient', 'amount'])
  })

  it('names the coin in the amount field once it is selected upstream', async () => {
    const s = drawSend(makeFakeMandala(), { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    expect(s.queryByText('pay_asset_label')).toBeNull()
  })

  // ── What a pasted or scanned peerpay link does to the money and the figure ──

  it('a token link selects its asset and seeds the figure in base units', async () => {
    // Uncontrolled selection: the form owns the asset choice here.
    const s = drawSend(makeFakeMandala())
    await held(s)
    fireEvent.changeText(
      s.getByPlaceholderText('recipient_placeholder'),
      `peerpay:${KEY}?asset=${USDX.assetId}&amount=2500`
    )
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    await waitFor(() => expect(s.getByPlaceholderText('0.00').props.value).toBe('25.00'))
    expect(s.getByText('pay_asset_cta:25.00|USDX')).toBeTruthy()
  })

  it('an open token link selects the asset and leaves the figure to the payer', async () => {
    const s = drawSend(makeFakeMandala())
    await held(s)
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), `peerpay:${KEY}?asset=${USDX.assetId}`)
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    expect(s.getByPlaceholderText('0.00').props.value).toBe('')
  })

  it('a sats link while paying in a token switches the form back to BSV', async () => {
    const onSelectAsset = jest.fn()
    const s = drawSend(makeFakeMandala(), { selectedAssetId: USDX.assetId, onSelectAsset })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), `peerpay:${KEY}?sats=1000`)
    await waitFor(() => expect(onSelectAsset).toHaveBeenCalledWith(null))
    expect(s.queryByText('pay_asset_link_not_held')).toBeNull()
    // The controlled parent has not switched yet, so a satoshi figure must not
    // surface in a field still denominated in USDX.
    expect(s.getByPlaceholderText('0.00').props.value).toBe('')
  })

  it('a token link for an asset this wallet does not hold keeps the recipient, seeds nothing, and says why', async () => {
    const s = drawSend(makeFakeMandala({ balances: [balanceOf(USDX)] }))
    await held(s)
    fireEvent.changeText(
      s.getByPlaceholderText('recipient_placeholder'),
      `peerpay:${KEY}?asset=${EURX.assetId}&amount=500`
    )
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    expect(s.getByText('pay_asset_link_not_held')).toBeTruthy()
    expect(s.queryByPlaceholderText('0.00')).toBeNull()
    expect(s.getByPlaceholderText('0').props.value).toBe('')
  })

  it('a token link pasted before the holdings are known waits for them, then takes effect', async () => {
    // `balances === null` is UNKNOWN, never "holds nothing": the link must not
    // be refused on a fact the form does not have yet.
    const runtime = makeFakeMandala()
    let release: ((b: ReturnType<typeof balanceOf>[]) => void) | undefined
    runtime.balances.mockImplementation(() => new Promise(resolve => (release = resolve)))
    const s = drawSend(runtime)
    await waitFor(() => expect(s.getByText('recipient')).toBeTruthy())
    fireEvent.changeText(
      s.getByPlaceholderText('recipient_placeholder'),
      `peerpay:${KEY}?asset=${USDX.assetId}&amount=2500`
    )
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    expect(s.queryByText('pay_asset_link_not_held')).toBeNull()
    await act(async () => {
      release?.([balanceOf()])
      await new Promise(resolve => setImmediate(resolve))
    })
    await waitFor(() => expect(s.getByPlaceholderText('0.00').props.value).toBe('25.00'))
    expect(s.queryByText('pay_asset_link_not_held')).toBeNull()
  })

  it('a link for a token this wallet does not hold blanks the figure typed for the old money', async () => {
    const onSelectAsset = jest.fn()
    const s = drawSend(makeFakeMandala({ balances: [balanceOf(USDX)] }), {
      selectedAssetId: USDX.assetId,
      onSelectAsset
    })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    expect(s.getByPlaceholderText('0.00').props.value).toBe('25')
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), `peerpay:${KEY}?asset=${EURX.assetId}`)
    await waitFor(() => expect(s.getByText('pay_asset_link_not_held')).toBeTruthy())
    expect(s.getByPlaceholderText('0.00').props.value).toBe('')
    // …and, as the banner says, the form goes back to BSV.
    expect(onSelectAsset).toHaveBeenCalledWith(null)
  })

  it('a token link on a built wallet with no token runtime is refused at once, not parked', async () => {
    // A built wallet publishes its runtime only on a chain with endpoints, so
    // "built and none" is a settled fact: the link gets its verdict now.
    mockWalletBuilt = true
    const s = drawSend(null)
    await waitFor(() => expect(s.getByText('recipient')).toBeTruthy())
    fireEvent.changeText(
      s.getByPlaceholderText('recipient_placeholder'),
      `peerpay:${KEY}?asset=${USDX.assetId}&amount=2500`
    )
    await waitFor(() => expect(s.getByText('pay_asset_link_not_held')).toBeTruthy())
    expect(s.getByText('valid_identity_key')).toBeTruthy()
    expect(s.getByPlaceholderText('0').props.value).toBe('')
  })

  it('a parked token link is dropped, not applied, if the recipient moved while the holdings were unknown', async () => {
    // secp256k1 2G — a second genuinely valid compressed key.
    const OTHER = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
    const runtime = makeFakeMandala()
    let release: ((b: ReturnType<typeof balanceOf>[]) => void) | undefined
    runtime.balances.mockImplementation(() => new Promise(resolve => (release = resolve)))
    const s = drawSend(runtime)
    await waitFor(() => expect(s.getByText('recipient')).toBeTruthy())
    fireEvent.changeText(
      s.getByPlaceholderText('recipient_placeholder'),
      `peerpay:${KEY}?asset=${USDX.assetId}&amount=2500`
    )
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    // Retarget to someone else before the holdings land.
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), OTHER)
    await act(async () => {
      release?.([balanceOf()])
      await new Promise(resolve => setImmediate(resolve))
    })
    await held(s)
    // Still BSV, still blank, no banner: nothing from the old link reached the new payee.
    expect(s.queryByPlaceholderText('0.00')).toBeNull()
    expect(s.getByPlaceholderText('0').props.value).toBe('')
    expect(s.queryByText('pay_asset_link_not_held')).toBeNull()
  })

  it('a figure typed in a token is never shown once the form is back in satoshis', async () => {
    const runtime = makeFakeMandala()
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    expect(s.getByPlaceholderText('0.00').props.value).toBe('25')
    s.rerender(
      <ThemeProvider>
        <MandalaProvider runtime={runtime}>
          <UniversalSend onNearbySession={jest.fn()} selectedAssetId={null} onSelectAsset={jest.fn()} />
        </MandalaProvider>
      </ThemeProvider>
    )
    await waitFor(() => expect(s.getByPlaceholderText('0')).toBeTruthy())
    expect(s.getByPlaceholderText('0').props.value).toBe('')
  })

  it('names the exact figure on the button and sends it in base units', async () => {
    const runtime = makeFakeMandala()
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    await waitFor(() => expect(s.getByText('pay_asset_cta:25.00|USDX')).toBeTruthy())
    fireEvent.press(s.getByText('pay_asset_cta:25.00|USDX'))
    await waitFor(() =>
      expect(runtime.sendToHandle).toHaveBeenCalledWith({
        assetId: USDX.assetId,
        recipientIdentityKey: KEY,
        baseUnits: 2500
      })
    )
  })

  it('reports the notify as pending, never as an unsettled broadcast, when notified is false', async () => {
    // `notified === false` is a delivery-channel gap, not a network one — the
    // money already moved. It must read differently from "not yet broadcast"
    // and must never be swallowed by a `settled: true` on the same result.
    const runtime = makeFakeMandala({
      send: { kind: 'sent', txid: 'e'.repeat(64), settled: true, notified: false }
    })
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    fireEvent.press(s.getByText('pay_asset_cta:25.00|USDX'))
    await waitFor(() => expect(s.getByText('pay_sent_not_notified')).toBeTruthy())
    expect(s.queryByText('token_sent_settled:Acme Bank')).toBeNull()
    expect(s.queryByText('pay_sent_not_broadcast')).toBeNull()
  })

  it('says SETTLED when the send’s own submit already got there (2026-09-15 refinement)', async () => {
    // Hand-over first, then this device's own submit — so an online payer's
    // receipt can honestly say the issuer already has it, without the screen
    // knowing anything about overlays. `settled` is the runtime's whole word
    // for that.
    const runtime = makeFakeMandala({
      send: { kind: 'sent', txid: 'e'.repeat(64), settled: true, notified: true }
    })
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    fireEvent.press(s.getByText('pay_asset_cta:25.00|USDX'))
    await waitFor(() => expect(s.getByText('token_sent_settled:Acme Bank')).toBeTruthy())
    expect(s.queryByText(/token_sent_settling/)).toBeNull()
  })

  it('says the payment is SETTLING once the recipient has been told — never "not yet broadcast"', async () => {
    const runtime = makeFakeMandala({
      send: { kind: 'sent', txid: 'e'.repeat(64), settled: false, notified: true }
    })
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    fireEvent.press(s.getByText('pay_asset_cta:25.00|USDX'))
    // Hand-over-first: the money is made and on its way to the issuer, which
    // is what the nearby rail has always said. "Not yet broadcast" would be a
    // narrower (and, on this rail, misleading) claim about the network.
    await waitFor(() => expect(s.getByText('token_sent_settling_unnamed:Acme Bank')).toBeTruthy())
    expect(s.queryByText('pay_sent_not_broadcast')).toBeNull()
    expect(s.queryByText('pay_sent_not_notified')).toBeNull()
  })

  it('refuses an address inline, in the runtime\'s own words, and never sends', async () => {
    const runtime = makeFakeMandala({ refusal: 'USDX can only be sent to a person or a nearby device.' })
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('pay_asset_address_status:USDX')).toBeTruthy())
    expect(s.getByText('USDX can only be sent to a person or a nearby device.')).toBeTruthy()
    // The typed text survives: switching back to BSV makes it valid again.
    expect(s.getByDisplayValue(ADDRESS)).toBeTruthy()
    expect(runtime.sendToHandle).not.toHaveBeenCalled()
  })

  it('falls back to the design\'s own sentence when the runtime offers no reason', async () => {
    const runtime = makeFakeMandala()
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), ADDRESS)
    await waitFor(() => expect(s.getByText('pay_asset_no_address:USDX')).toBeTruthy())
  })

  it('shows the classified refusal, with the guarantee, when the overlay says no', async () => {
    const runtime = makeFakeMandala({ send: { kind: 'refused', code: 'asset_paused', message: 'paused' } })
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    fireEvent.press(s.getByText('pay_asset_cta:25.00|USDX'))
    await waitFor(() => expect(s.getByText('token_err_refused_paused:USDX|Acme Bank')).toBeTruthy())
  })

  it('names a LOCAL fault, promises nothing left the wallet, and offers no check', async () => {
    // Nothing is contacted at send time, so there is no lost response to
    // reconcile: the banner states the local reason and drops "Check again".
    const runtime = makeFakeMandala({ send: { kind: 'unavailable', message: 'MessageBox unreachable' } })
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '25')
    fireEvent.press(s.getByText('pay_asset_cta:25.00|USDX'))
    await waitFor(() =>
      expect(s.getByText('token_err_send_failed:USDX|Acme Bank|MessageBox unreachable')).toBeTruthy()
    )
    expect(s.queryByLabelText('token_err_check_again')).toBeNull()
  })

  it('refuses an amount larger than the balance before anything is built', async () => {
    const runtime = makeFakeMandala()
    const s = drawSend(runtime, { selectedAssetId: USDX.assetId, onSelectAsset: jest.fn() })
    await waitFor(() => expect(s.getByPlaceholderText('0.00')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0.00'), '9999')
    await waitFor(() => expect(s.getByText('pay_asset_over_balance:USDX')).toBeTruthy())
    fireEvent.press(s.getByText('pay_asset_cta:9,999.00|USDX'))
    expect(runtime.sendToHandle).not.toHaveBeenCalled()
  })
})

describe("UniversalSend — the handle rail's own success note", () => {
  // Deliberately no asset selected (no `MandalaProvider` runtime, no
  // `selectedAssetId`) — this is the BSV PeerPay path, `sendHandle`, not
  // `sendToken`. `mockManagers`/`mockHandleStorage` are what make that path's
  // `!wallet || !storage` guard pass; `sendViaHandle` and `makePeerPayClient`
  // are stubbed at the barrel (see the top of this file) so nothing here
  // touches a real wallet or network.
  const draw = (props: Partial<React.ComponentProps<typeof UniversalSend>> = {}) =>
    render(
      <ThemeProvider>
        <MandalaProvider runtime={null}>
          <UniversalSend onNearbySession={jest.fn()} {...props} />
        </MandalaProvider>
      </ThemeProvider>
    )

  it('tells a handle-rail payer their payment went to a wallet, not a hand', async () => {
    mockManagers = { permissionsManager: {} }
    mockHandleStorage = {}
    const s = draw()
    await waitFor(() => expect(s.getByText('recipient')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('recipient_placeholder'), KEY)
    await waitFor(() => expect(s.getByText('valid_identity_key')).toBeTruthy())
    fireEvent.changeText(s.getByPlaceholderText('0'), '2500')
    fireEvent.press(s.getByText('pay'))
    await waitFor(() => expect(mockSendViaHandle).toHaveBeenCalled())
    await waitFor(() => expect(s.getByText('pay_sent_handed_to_wallet')).toBeTruthy())
  })
})
