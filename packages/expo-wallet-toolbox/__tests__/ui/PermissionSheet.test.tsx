/**
 * The permission sheet's pure display builder (`deriveActive`). The token
 * prompts are the BRC-207 color module's consent messages, rendered through
 * `describeColorRequest`: every asset leg of a request is shown, amounts stay
 * exact, and a request the sheet cannot read in full is deny-only (XR-040
 * carried forward). Targets `deriveActive` directly rather than the rendered
 * component, so this stays a fast unit test of the display logic.
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

const ASSET_A = 'a'.repeat(64) + '_0'
const ASSET_B = 'b'.repeat(64) + '_0'
const t = (key: string) => key
const assetInfo = (assetId: string) =>
  assetId === ASSET_A
    ? { ticker: 'USDX', decimals: 2 }
    : assetId === ASSET_B
      ? { ticker: 'GOLD', decimals: 0 }
      : undefined
const color = { t, assetInfo }

function leg(assetId: string, fields: Record<string, string>) {
  return {
    assetId,
    operations: ['transfer'],
    inputAmount: '0',
    foreignAmount: '0',
    authorityInputs: 0,
    foreignAuthorityInputs: 0,
    keptAmount: '0',
    keptAuthorities: 0,
    outgoingAmount: '0',
    outgoingAuthorities: 0,
    transferred: '0',
    burned: '0',
    minted: '0',
    ...fields
  }
}

function colorSend(assets: unknown[]) {
  return JSON.stringify({
    type: 'color_send',
    handoff: false,
    seekPermission: true,
    assets,
    destinations: [],
    satoshis: { inputs: 1002, outputs: 2, fee: 1000 },
    signatures: [],
    lockTime: 0
  })
}

describe('deriveActive — color module prompts', () => {
  it('renders BOTH assets of a two-asset color_send, with exact amounts', () => {
    const message = colorSend([
      leg(ASSET_A, { inputAmount: '18446744073709551615', outgoingAmount: '18446744073709551615' }),
      leg(ASSET_B, { inputAmount: '9000', outgoingAmount: '9000' })
    ])
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats, color)

    expect(active).not.toBeNull()
    expect(active!.kind).toBe('mandala')
    expect(active!.title).toBe('color_prompt_send_title')
    expect(active!.approvalBlocked).toBeFalsy()
    const values = active!.details.map(d => d.value)
    expect(values).toEqual(expect.arrayContaining([ASSET_A, '184467440737095516.15 USDX']))
    expect(values).toEqual(expect.arrayContaining([ASSET_B, '9000 GOLD']))
  })

  it('shows the full asset id, never a truncated one', () => {
    const message = JSON.stringify({
      type: 'color_relinquish',
      assetId: ASSET_A,
      role: 'value',
      outpoint: 'c'.repeat(64) + '.0',
      seekPermission: true
    })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats, color)
    expect(active!.details).toContainEqual({ label: 'Asset ID', value: ASSET_A })
    expect(active!.details).toContainEqual({ label: 'Outpoint', value: 'c'.repeat(64) + '.0' })
    expect(active!.title).toBe('color_prompt_relinquish_title')
    expect(active!.approvalBlocked).toBeFalsy()
  })

  it('blocks approval of the removed color_receive_offline type (B7): unknown, deny-only', () => {
    const message = JSON.stringify({
      type: 'color_receive_offline',
      assetId: ASSET_A,
      outputs: [{ outputIndex: 0, amount: '1500' }],
      unsettledTransactions: 2,
      signers: ['02' + 'd'.repeat(64)],
      seekPermission: true
    })
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats, color)
    expect(active!.approvalBlocked).toBe(true)
  })

  it.each([
    ['malformed JSON', '{'],
    ['an unknown type', JSON.stringify({ type: 'color_mint' })],
    ['a non-canonical amount', colorSend([leg(ASSET_A, { outgoingAmount: '01' })])],
    // There is no back-compat with the deleted 'p mandala' P-module's prompts.
    [
      'an old mandala_spend prompt',
      JSON.stringify({ type: 'mandala_spend', sendAmount: 2500, assetId: ASSET_A, tokenName: 'USDX', lines: [] })
    ]
  ])('blocks approval for %s and says so in the description', (_label, message) => {
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats, color)
    expect(active!.kind).toBe('mandala')
    expect(active!.approvalBlocked).toBe(true)
    expect(active!.details).toEqual([])
    expect(active!.description).toMatch(/could not be read/i)
  })

  it('without asset metadata, still shows exact base units and stays approvable', () => {
    const message = colorSend([leg(ASSET_A, { inputAmount: '7', outgoingAmount: '7' })])
    const active = deriveActive(baseCtx([{ originator: 'app.example.com', message }]), formatSats)
    expect(active!.details.map(d => d.value)).toEqual(expect.arrayContaining([ASSET_A, '7 units']))
    expect(active!.approvalBlocked).toBeFalsy()
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
    expect(active.details.map(d => d.label)).toEqual([
      'Protocol',
      'Security level',
      'Shared with',
      'Key ID',
      'Approval'
    ])
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
