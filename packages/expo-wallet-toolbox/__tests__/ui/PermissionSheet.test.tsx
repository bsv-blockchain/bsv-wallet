/**
 * XR-040 — a multi-asset `mandala_spend`/`mandala_credit` prompt must show
 * EVERY asset it touches, not only `lines[0]` (the back-compat primary
 * fields). Targets `deriveActive` directly — the pure function that turns a
 * queued request into what the sheet renders — rather than the rendered
 * component, so this stays a fast, focused unit test of the display-building
 * logic itself (see its own doc for why it is exported).
 */
jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    spacing: {},
    radii: {},
    typography: {},
    useTheme: () => ({ colors: {} }),
    WalletContext: React.createContext({}),
    UserContext: React.createContext({}),
    ExchangeRateContext: React.createContext({}),
    formatAmountParts: () => ({ value: '0', unit: '' }),
    haptics: { tap: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
  }
})
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
jest.mock('../../ui/components/ui/Sheet', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => ({ __esModule: true, default: () => null }))
jest.mock('../../ui/components/wallet/AmountDisplay', () => ({ __esModule: true, default: () => null }))

import { deriveActive } from '../../ui/components/ui/PermissionSheet'

const formatSats = (satoshis: number) => ({ value: String(satoshis), unit: 'sats' })

function baseCtx(mandalaRequests: { originator: string; message: string }[]) {
  return {
    protocolRequests: [],
    basketRequests: [],
    certificateRequests: [],
    spendingRequests: [],
    btmsRequests: [],
    mandalaRequests,
    protocolAccessModalOpen: false,
    basketAccessModalOpen: false,
    certificateAccessModalOpen: false,
    spendingAuthorizationModalOpen: false
  }
}

const ASSET_A = 'a'.repeat(64) + '.0'
const ASSET_B = 'b'.repeat(64) + '.0'

describe('deriveActive — mandala prompts (XR-040)', () => {
  it('renders BOTH assets of a two-line mandala_spend, not only the primary', () => {
    const message = JSON.stringify({
      type: 'mandala_spend',
      // Back-compat top-level fields mirror only the first line.
      sendAmount: 2500,
      changeAmount: 100,
      assetId: ASSET_A,
      tokenName: 'USDX',
      lines: [
        { assetId: ASSET_A, sendAmount: 2500, changeAmount: 100, tokenName: 'USDX', display: '25.00 USDX' },
        { assetId: ASSET_B, sendAmount: 900_000, changeAmount: 0, tokenName: 'GOLD', display: '9,000.00 GOLD' }
      ]
    })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats)

    expect(active).not.toBeNull()
    expect(active!.approvalBlocked).toBeFalsy()
    const values = active!.details.map(d => d.value)
    // The primary asset...
    expect(values).toEqual(expect.arrayContaining(['USDX', '25.00 USDX']))
    // ...AND the second asset, which the old code never surfaced anywhere.
    expect(values).toEqual(expect.arrayContaining(['GOLD', '9,000.00 GOLD']))
  })

  it("renders both a mandala_credit's lines the same way", () => {
    const message = JSON.stringify({
      type: 'mandala_credit',
      creditAmount: 50,
      assetId: ASSET_A,
      tokenName: 'USDX',
      lines: [
        { assetId: ASSET_A, creditAmount: 50, tokenName: 'USDX', display: '0.50 USDX' },
        { assetId: ASSET_B, creditAmount: 7, tokenName: 'GOLD', display: '7 GOLD' }
      ]
    })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats)

    const values = active!.details.map(d => d.value)
    expect(values).toEqual(expect.arrayContaining(['0.50 USDX']))
    expect(values).toEqual(expect.arrayContaining(['7 GOLD']))
    expect(active!.approvalBlocked).toBeFalsy()
  })

  it('a single-line spend keeps the unnumbered back-compat labels', () => {
    const message = JSON.stringify({
      type: 'mandala_spend',
      sendAmount: 2500,
      assetId: ASSET_A,
      tokenName: 'USDX',
      lines: [{ assetId: ASSET_A, sendAmount: 2500, tokenName: 'USDX', display: '25.00 USDX' }]
    })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats)

    expect(active!.details).toEqual(
      expect.arrayContaining([
        { label: 'Token', value: 'USDX' },
        { label: 'Send amount', value: '25.00 USDX' }
      ])
    )
    expect(active!.approvalBlocked).toBeFalsy()
  })

  it.each([
    ['absent', undefined],
    ['not an array', { assetId: ASSET_A, sendAmount: 1 }],
    ['empty', []],
    ['oversized', Array.from({ length: 26 }, (_, i) => ({ assetId: ASSET_A, sendAmount: i }))],
    ['containing a non-object entry', [{ assetId: ASSET_A, sendAmount: 1 }, 'not-an-object']]
  ])('blocks approval when lines is %s, rather than falling back to the primary-only view', (_label, lines) => {
    const message = JSON.stringify({
      type: 'mandala_spend',
      sendAmount: 2500,
      assetId: ASSET_A,
      tokenName: 'USDX',
      lines
    })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats)

    expect(active!.approvalBlocked).toBe(true)
    // The primary-only fallback view (a Token/Send-amount row with no
    // indication anything is wrong) must never be shown once blocked.
    expect(active!.details.some(d => d.label === 'Token' || d.label === 'Send amount')).toBe(false)
    expect(active!.description).toMatch(/could not be verified/i)
  })
})
