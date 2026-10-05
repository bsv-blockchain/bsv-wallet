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

describe('deriveActive — mandala relinquishOutput (XR-041)', () => {
  it('names the target — token, amount and outpoint — instead of the bare action name', () => {
    const OUTPOINT = 'c'.repeat(64) + '.0'
    const message = JSON.stringify({
      type: 'mandala_access',
      action: 'relinquishOutput',
      assetId: ASSET_A,
      tokenName: 'USDX',
      amount: 500,
      display: '5.00 USDX',
      outpoint: OUTPOINT
    })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats)

    expect(active!.description).toBe('wants to remove 5.00 USDX from your wallet')
    expect(active!.details).toEqual(
      expect.arrayContaining([
        { label: 'Token', value: 'USDX' },
        { label: 'Amount', value: '5.00 USDX' }
      ])
    )
    expect(active!.details.some(d => d.label === 'Outpoint')).toBe(true)
  })

  it('falls back to the old generic copy — never a crash — when the message carries no resolved target', () => {
    const message = JSON.stringify({ type: 'mandala_access', action: 'relinquishOutput' })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats)

    expect(active!.description).toBe('wants to remove a Mandala token holding from your wallet')
  })
})

describe('grouped permission requests', () => {
  const permissions = {
    spendingAuthorization: { amount: 100, description: 'Monthly test allowance' },
    protocolPermissions: [{ protocolID: [1, 'fast grouped alpha'] as [number, string], description: 'Alpha' }]
  }
  const group = { requestID: 'group:fast.brc.dev', originator: 'fast.brc.dev', permissions }

  it('shows the whole set a site asks for', () => {
    const active = deriveActive({ ...baseCtx([]), groupRequests: [group] }, formatSats)
    expect(active).toMatchObject({
      kind: 'group',
      requestID: 'group:fast.brc.dev',
      originator: 'fast.brc.dev',
      groupPermissions: permissions
    })
  })

  it('waits behind an open spending prompt, which is more time-sensitive', () => {
    const spending = { requestID: 'spend:1', originator: 'a.example', authorizationAmount: 5, lineItems: [] }
    const active = deriveActive(
      { ...baseCtx([]), spendingRequests: [spending], spendingAuthorizationModalOpen: true, groupRequests: [group] },
      formatSats
    )
    expect(active?.kind).toBe('spending')
  })
})

describe('protocol prompts', () => {
  function protocolCtx(request: Record<string, unknown>) {
    return {
      ...baseCtx([]),
      protocolRequests: [{ requestID: 'r', originator: 'app.example', ...request }],
      protocolAccessModalOpen: true
    }
  }
  const ONE_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

  test.each([
    ['anyone', 'Anyone', /Coins paid to this key could be spent/],
    [ONE_G, 'Anyone', /Coins paid to this key could be spent/],
    ['self', 'Only you', /change could be spent/],
    ['02' + 'ab'.repeat(32), '02ababab\u2026abab', /another party\. Coins paid to this key/]
  ])('names BRC-29 in plain words (counterparty %s)', (counterparty, shared, warning) => {
    const active = deriveActive(
      protocolCtx({ protocolID: '3241645161d8', protocolSecurityLevel: 2, counterparty }),
      formatSats
    )!
    expect(active.title).toBe('Payment Key Signature')
    expect(active.description).toMatch(warning)
    expect(active.details).toEqual([
      { label: 'Protocol', value: 'Payments (BRC-29)' },
      { label: 'Security level', value: '2' },
      { label: 'Shared with', value: shared },
      { label: 'Approval', value: 'This signature only' }
    ])
    expect(JSON.stringify(active)).not.toMatch(/"value":"3241645161d8"/)
    expect(active.description).not.toMatch(/BSV address/)
  })

  test.each([
    ['eGFuYS1lYXJuaW5ncw== MQ==', 'xana-earnings 1'],
    ['not base64! MQ==', 'not base64! 1'],
    ['AAEC MQ==', 'AAEC 1']
  ])('shows key ID %p as %p', (keyID, shown) => {
    const active = deriveActive(
      protocolCtx({ protocolID: '3241645161d8', protocolSecurityLevel: 2, counterparty: 'anyone', keyID }),
      formatSats
    )!
    expect(active.details).toContainEqual({ label: 'Key ID', value: shown })
    expect(active.details.map(d => d.label)).toEqual(['Protocol', 'Security level', 'Shared with', 'Key ID', 'Approval'])
  })

  test('leaves other protocols as the app named them', () => {
    const active = deriveActive(
      protocolCtx({ protocolID: 'todo list', protocolSecurityLevel: 1, description: 'wants to sign todos' }),
      formatSats
    )!
    expect(active.title).toBe('Protocol Access')
    expect(active.description).toBe('wants to sign todos')
    expect(active.details).toEqual([
      { label: 'Protocol', value: 'todo list' },
      { label: 'Security level', value: '1' }
    ])
  })
})
