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
// Sheet renders its children and PressableScale records its handler, so the
// component tests below can press Reject (first) and Authorize (second).
jest.mock('../../ui/components/ui/Sheet', () => ({
  __esModule: true,
  default: ({ children }: { children?: unknown }) => children ?? null
}))
jest.mock('../../ui/components/ui/PressableScale', () => ({
  __esModule: true,
  default: ({ onPress }: { onPress?: () => void }) => {
    ;(globalThis as any).__presses.push(onPress)
    return null
  }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))
jest.mock('../../ui/components/wallet/AmountDisplay', () => ({ __esModule: true, default: () => null }))

import React from 'react'
import { act, render } from '@testing-library/react-native'
import PermissionSheet, { deriveActive } from '../../ui/components/ui/PermissionSheet'

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

// ---------------------------------------------------------------------------
// The sheet answers by identity: the manager that raised the request, and
// only while that request is still the one queued.
// ---------------------------------------------------------------------------
describe('PermissionSheet answers', () => {
  const { WalletContext, UserContext, ExchangeRateContext } = require('@bsv/expo-wallet-toolbox')

  const fakeManager = () => ({
    grantPermission: jest.fn().mockResolvedValue(undefined),
    denyPermission: jest.fn().mockResolvedValue(undefined),
    grantGroupedPermission: jest.fn().mockResolvedValue(undefined),
    dismissGroupedPermission: jest.fn().mockResolvedValue(undefined)
  })
  type FakeManager = ReturnType<typeof fakeManager>

  const protocolRequest = (requestID: string, manager: FakeManager) => ({
    requestID,
    protocolSecurityLevel: 2,
    protocolID: 'some app protocol',
    originator: 'app.example',
    manager
  })
  const groupRequest = (requestID: string, manager: FakeManager) => ({
    requestID,
    originator: 'app.example',
    permissions: { protocolPermissions: [{ protocolID: [1, 'alpha beta'] }] },
    manager
  })

  function setup(initial: Record<string, unknown>) {
    const advance = {
      advanceProtocolQueue: jest.fn(),
      advanceBasketQueue: jest.fn(),
      advanceCertificateQueue: jest.fn(),
      advanceSpendingQueue: jest.fn(),
      advanceGroupQueue: jest.fn(),
      advanceBtmsQueue: jest.fn(),
      advanceMandalaQueue: jest.fn()
    }
    // The current wallet's manager: what the old code answered, whatever raised the request.
    const current = fakeManager()
    const ui = {
      protocolAccessModalOpen: true,
      setProtocolAccessModalOpen: jest.fn(),
      basketAccessModalOpen: false,
      setBasketAccessModalOpen: jest.fn(),
      certificateAccessModalOpen: false,
      setCertificateAccessModalOpen: jest.fn(),
      spendingAuthorizationModalOpen: false,
      setSpendingAuthorizationModalOpen: jest.fn()
    }
    const tree = (queues: Record<string, unknown>) => (
      <WalletContext.Provider
        value={{
          protocolRequests: [],
          basketRequests: [],
          certificateRequests: [],
          spendingRequests: [],
          groupRequests: [],
          btmsRequests: [],
          mandalaRequests: [],
          ...advance,
          managers: { permissionsManager: current },
          settings: {},
          ...queues
        }}
      >
        <UserContext.Provider value={ui}>
          <ExchangeRateContext.Provider value={{}}>
            <PermissionSheet />
          </ExchangeRateContext.Provider>
        </UserContext.Provider>
      </WalletContext.Provider>
    )
    const view = render(tree(initial))
    const press = async (index: number) => {
      const handler = (globalThis as any).__presses.at(-2 + index) as () => unknown
      await act(async () => {
        await handler()
      })
    }
    return {
      view,
      advance,
      current,
      ui,
      rerender: (queues: Record<string, unknown>) => view.rerender(tree(queues)),
      deny: () => press(0),
      /** Presses Reject without holding an act scope open, so a re-render can land while it waits. */
      denyUnscoped: () => ((globalThis as any).__presses.at(-2) as () => Promise<void>)(),
      allow: () => press(1)
    }
  }

  beforeEach(() => {
    ;(globalThis as any).__presses = []
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  const elapse = async () => {
    await act(async () => {
      jest.advanceTimersByTime(450)
    })
  }

  it('grants the manager that raised the request, by request ID, never the current one', async () => {
    const raised = fakeManager()
    const { allow, current, advance, ui } = setup({ protocolRequests: [protocolRequest('p1', raised)] })
    await allow()
    await elapse()
    expect(raised.grantPermission).toHaveBeenCalledWith({ requestID: 'p1' })
    expect(current.grantPermission).not.toHaveBeenCalled()
    expect(advance.advanceProtocolQueue).toHaveBeenCalledWith('p1')
    expect(ui.setProtocolAccessModalOpen).toHaveBeenCalledWith(false)
  })

  it('denies the manager that raised the request, by request ID', async () => {
    const raised = fakeManager()
    const { deny, current, advance } = setup({ protocolRequests: [protocolRequest('p1', raised)] })
    await deny()
    expect(raised.denyPermission).toHaveBeenCalledWith('p1')
    expect(current.denyPermission).not.toHaveBeenCalled()
    expect(advance.advanceProtocolQueue).toHaveBeenCalledWith('p1')
  })

  describe('grant after withdrawal within 400 ms drops nothing else', () => {
    // R1 is allowed; a profile switch empties the queue inside the checkmark
    // animation and the new manager raises R2, which may even reuse R1's ID.
    it.each([
      ['protocol, same request ID', 'p1', 'p1'],
      ['protocol, new request ID', 'p1', 'p2']
    ])('%s', async (_name, firstID, secondID) => {
      const oldManager = fakeManager()
      const newManager = fakeManager()
      const { allow, rerender, advance, ui } = setup({ protocolRequests: [protocolRequest(firstID, oldManager)] })
      await allow()
      rerender({ protocolRequests: [protocolRequest(secondID, newManager)] })
      await elapse()
      expect(newManager.grantPermission).not.toHaveBeenCalled()
      expect(newManager.denyPermission).not.toHaveBeenCalled()
      expect(oldManager.grantPermission).not.toHaveBeenCalled()
      expect(advance.advanceProtocolQueue).not.toHaveBeenCalled()
      expect(ui.setProtocolAccessModalOpen).not.toHaveBeenCalled()
    })

    it('group, same request ID', async () => {
      const oldManager = fakeManager()
      const newManager = fakeManager()
      const { allow, rerender, advance } = setup({ groupRequests: [groupRequest('group:app.example', oldManager)] })
      await allow()
      rerender({ groupRequests: [groupRequest('group:app.example', newManager)] })
      await elapse()
      expect(newManager.grantGroupedPermission).not.toHaveBeenCalled()
      expect(oldManager.grantGroupedPermission).not.toHaveBeenCalled()
      expect(advance.advanceGroupQueue).not.toHaveBeenCalled()
    })

    it('the queue emptied outright', async () => {
      const oldManager = fakeManager()
      const { allow, rerender, advance } = setup({ protocolRequests: [protocolRequest('p1', oldManager)] })
      await allow()
      rerender({ protocolRequests: [] })
      await elapse()
      expect(oldManager.grantPermission).not.toHaveBeenCalled()
      expect(advance.advanceProtocolQueue).not.toHaveBeenCalled()
    })

    it('a deny that lands after the withdrawal leaves the new request queued', async () => {
      const oldManager = fakeManager()
      const newManager = fakeManager()
      // The old manager answers late, after the withdrawal and the new request.
      let answer!: (error: Error) => void
      oldManager.denyPermission.mockReturnValue(new Promise((_resolve, reject) => (answer = reject)))
      const { denyUnscoped, rerender, advance } = setup({ protocolRequests: [protocolRequest('p1', oldManager)] })
      const pressed = denyUnscoped()
      await act(async () => {
        rerender({ protocolRequests: [protocolRequest('p1', newManager)] })
      })
      answer(new Error('Request ID not found.'))
      await act(async () => {
        await pressed
      })
      expect(newManager.denyPermission).not.toHaveBeenCalled()
      expect(advance.advanceProtocolQueue).not.toHaveBeenCalled()
    })
  })

  it('no unhandled rejection when the manager refuses a stale grant', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const raised = fakeManager()
    raised.grantPermission.mockRejectedValue(new Error('Request ID not found.'))
    const { allow, advance } = setup({ protocolRequests: [protocolRequest('p1', raised)] })
    await allow()
    await elapse()
    await act(async () => {})
    expect(raised.grantPermission).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[permissions] grant failed', expect.any(Error))
    expect(advance.advanceProtocolQueue).toHaveBeenCalledWith('p1')
  })
})

// ---------------------------------------------------------------------------
// Browser bridge: unverified presentation and the connection sheet (spec 6.4, 6.5)
// ---------------------------------------------------------------------------

const {
  DEFAULT_UNVERIFIED_SEEK_FLAGS,
  DEFAULT_VERIFIED_SEEK_FLAGS,
  SEEK_FLAG_DISCLOSURE,
  SEEK_FLAG_KEYS,
  effectiveUnverified
} = require('../../core/bridge/permissionPolicy')
const { setConsentSheetSource } = require('../../core/bridge/consentSheetSource')

const UNVERIFIED = 'shop.example.gabcdefghij.unverified.invalid'

describe('unverified prompts', () => {
  const protocol = { requestID: 'r', originator: UNVERIFIED, protocolSecurityLevel: 2, protocolID: 'some app protocol' }
  const open = {
    protocolAccessModalOpen: true,
    basketAccessModalOpen: true,
    certificateAccessModalOpen: true,
    spendingAuthorizationModalOpen: true
  }
  const mandalaMessage = JSON.stringify({ type: 'mandala_access' })
  const btmsMessage = JSON.stringify({ type: 'btms_spend', sendAmount: 1, tokenName: 'T' })

  // One queue at a time, so each kind is the head.
  const cases: [string, Record<string, unknown>][] = [
    [
      'spending',
      { spendingRequests: [{ requestID: 's', originator: UNVERIFIED, authorizationAmount: 5, lineItems: [] }] }
    ],
    ['group', { groupRequests: [{ requestID: 'g', originator: UNVERIFIED, permissions: {} }] }],
    ['certificate', { certificateRequests: [{ requestID: 'c', originator: UNVERIFIED, fieldsArray: [] }] }],
    ['protocol', { protocolRequests: [protocol] }],
    ['basket', { basketRequests: [{ requestID: 'b', originator: UNVERIFIED, basket: 'x' }] }],
    ['btms', { btmsRequests: [{ originator: UNVERIFIED, message: btmsMessage }] }],
    ['mandala', { mandalaRequests: [{ originator: UNVERIFIED, message: mandalaMessage }] }]
  ]

  it.each(cases)('%s shows the plain hostname and is marked unverified', (kind, queues) => {
    const active = deriveActive({ ...baseCtx([]), ...open, ...queues } as any, formatSats)
    expect(active?.kind).toBe(kind)
    expect(active?.originator).toBe('shop.example')
    expect(active?.unverified).toBe(true)
  })

  it('a verified originator is untouched and not marked', () => {
    const active = deriveActive(
      { ...baseCtx([]), ...open, protocolRequests: [{ ...protocol, originator: 'shop.example' }] } as any,
      formatSats
    )
    expect(active).toMatchObject({ originator: 'shop.example', unverified: false })
  })

  it("keeps the site's own words apart from the wallet's for an unverified origin", () => {
    const unverified = deriveActive(
      {
        ...baseCtx([]),
        ...open,
        basketRequests: [{ requestID: 'b', originator: UNVERIFIED, reason: 'Totally official', basket: 'x' }]
      } as any,
      formatSats
    )
    expect(unverified?.description).toBe('wants to access a transaction basket')
    expect(unverified?.siteSays).toBe('Totally official')
    const verified = deriveActive(
      {
        ...baseCtx([]),
        ...open,
        basketRequests: [{ requestID: 'b', originator: 'shop.example', reason: 'Totally official', basket: 'x' }]
      } as any,
      formatSats
    )
    expect(verified?.description).toBe('Totally official')
    expect(verified?.siteSays).toBeUndefined()
  })
})

describe('connection prompts', () => {
  const pending = (over: Record<string, unknown> = {}) => ({
    requestId: 'c1',
    origin: 'https://shop.example',
    attestation: 'browser' as const,
    transportId: 'safari-extension',
    connectedBefore: false,
    walletRevision: 1,
    profileKey: '0',
    ...over
  })
  const flagsFor = (attestation: string) =>
    attestation === 'unattested'
      ? effectiveUnverified({ verified: DEFAULT_VERIFIED_SEEK_FLAGS, unverified: DEFAULT_UNVERIFIED_SEEK_FLAGS })
      : DEFAULT_VERIFIED_SEEK_FLAGS
  const derive = (p: ReturnType<typeof pending>) =>
    deriveActive({ ...baseCtx([]), connectionRequests: [p], connectionFlags: flagsFor } as any, formatSats)

  it('titles the raw origin and lists capabilities from the effective flags', () => {
    const active = derive(pending())!
    expect(active.kind).toBe('connection')
    expect(active.originator).toBe('https://shop.example')
    expect(active.unverified).toBe(false)
    const { allows, asksFirst } = active.connection!
    // Verified defaults: baskets are open, signing and grouped requests ask first.
    expect(allows).toContain('bridge.policy.seekBasketInsertionPermissions.off')
    expect(asksFirst).toEqual([
      'bridge.policy.seekGroupedPermission.on',
      'bridge.policy.seekProtocolPermissionsForSigning.on'
    ])
  })

  it('moves basket changes under "asks first" for an unverified site', () => {
    const active = derive(pending({ attestation: 'unattested' }))!
    expect(active.unverified).toBe(true)
    const { allows, asksFirst } = active.connection!
    expect(allows).not.toContain('bridge.policy.seekBasketInsertionPermissions.off')
    expect(asksFirst).toEqual(
      expect.arrayContaining([
        'bridge.policy.seekBasketInsertionPermissions.on',
        'bridge.policy.seekBasketListingPermissions.on',
        'bridge.policy.seekBasketRemovalPermissions.on'
      ])
    )
  })

  it('says payments go through automatically for a verified site, ask first for an unverified one', () => {
    expect(derive(pending())!.connection!.payments).toBe('bridge_payments_verified')
    expect(derive(pending({ attestation: 'unattested' }))!.connection!.payments).toBe('bridge_payments_unverified')
  })

  it('carries the "connected before" flag', () => {
    expect(derive(pending({ attestation: 'unattested', connectedBefore: true }))!.connection!.connectedBefore).toBe(
      true
    )
  })

  it('waits behind an open spending prompt', () => {
    const spending = { requestID: 'spend:1', originator: 'a.example', authorizationAmount: 5, lineItems: [] }
    const active = deriveActive(
      {
        ...baseCtx([]),
        spendingRequests: [spending],
        spendingAuthorizationModalOpen: true,
        connectionRequests: [pending()],
        connectionFlags: flagsFor
      } as any,
      formatSats
    )
    expect(active?.kind).toBe('spending')
  })
})

describe('tap protection and connection answers', () => {
  const { WalletContext, UserContext, ExchangeRateContext } = require('@bsv/expo-wallet-toolbox')

  const consentStub = (pendingList: any[]) => {
    const listeners = new Set<() => void>()
    return {
      listeners,
      store: {
        listPending: () => pendingList,
        answerConsent: jest.fn().mockResolvedValue(undefined),
        onChange: (fn: () => void) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        }
      }
    }
  }

  const mount = (queues: Record<string, unknown>) =>
    render(
      <WalletContext.Provider
        value={{
          protocolRequests: [],
          basketRequests: [],
          certificateRequests: [],
          spendingRequests: [],
          groupRequests: [],
          btmsRequests: [],
          mandalaRequests: [],
          advanceProtocolQueue: jest.fn(),
          advanceBasketQueue: jest.fn(),
          advanceCertificateQueue: jest.fn(),
          advanceSpendingQueue: jest.fn(),
          advanceGroupQueue: jest.fn(),
          advanceBtmsQueue: jest.fn(),
          advanceMandalaQueue: jest.fn(),
          settings: {},
          ...queues
        }}
      >
        <UserContext.Provider
          value={{
            protocolAccessModalOpen: true,
            setProtocolAccessModalOpen: jest.fn(),
            basketAccessModalOpen: false,
            setBasketAccessModalOpen: jest.fn(),
            certificateAccessModalOpen: false,
            setCertificateAccessModalOpen: jest.fn(),
            spendingAuthorizationModalOpen: false,
            setSpendingAuthorizationModalOpen: jest.fn()
          }}
        >
          <ExchangeRateContext.Provider value={{}}>
            <PermissionSheet />
          </ExchangeRateContext.Provider>
        </UserContext.Provider>
      </WalletContext.Provider>
    )
  const press = async (index: 0 | 1) => {
    const handler = (globalThis as any).__presses.at(-2 + index) as () => unknown
    await act(async () => {
      await handler()
    })
  }
  const advanceBy = (ms: number) =>
    act(async () => {
      jest.advanceTimersByTime(ms)
    })

  beforeEach(() => {
    ;(globalThis as any).__presses = []
    jest.useFakeTimers()
  })
  afterEach(() => {
    setConsentSheetSource(undefined)
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('an unverified prompt ignores Authorize for 700 ms, then grants', async () => {
    const manager = {
      grantPermission: jest.fn().mockResolvedValue(undefined),
      denyPermission: jest.fn().mockResolvedValue(undefined)
    }
    mount({
      protocolRequests: [
        { requestID: 'p1', protocolSecurityLevel: 2, protocolID: 'x y z', originator: UNVERIFIED, manager }
      ]
    })
    await press(1)
    await advanceBy(450)
    expect(manager.grantPermission).not.toHaveBeenCalled()
    await advanceBy(300)
    await press(1)
    await advanceBy(450)
    expect(manager.grantPermission).toHaveBeenCalledWith({ requestID: 'p1' })
  })

  it('a verified prompt is not delayed', async () => {
    const manager = {
      grantPermission: jest.fn().mockResolvedValue(undefined),
      denyPermission: jest.fn().mockResolvedValue(undefined)
    }
    mount({
      protocolRequests: [
        { requestID: 'p1', protocolSecurityLevel: 2, protocolID: 'x y z', originator: 'a.example', manager }
      ]
    })
    await press(1)
    await advanceBy(450)
    expect(manager.grantPermission).toHaveBeenCalledTimes(1)
  })

  it('a connection request is delayed 700 ms, then approved through the consent store', async () => {
    const entry = {
      requestId: 'c1',
      origin: 'https://shop.example',
      attestation: 'browser',
      transportId: 'safari-extension',
      connectedBefore: false,
      walletRevision: 1,
      profileKey: '0'
    }
    const stub = consentStub([])
    setConsentSheetSource({ store: stub.store as any, context: () => ({ walletRevision: 1, profileKey: '0' }) })
    const view = mount({})
    expect(view.toJSON()).toBeNull()
    // The store raises a request: the sheet picks it up through onChange.
    ;(stub.store as any).listPending = () => [entry]
    await act(async () => {
      stub.listeners.forEach(fn => fn())
    })
    await press(1)
    await advanceBy(450)
    expect(stub.store.answerConsent).not.toHaveBeenCalled()
    await advanceBy(300)
    await press(1)
    await advanceBy(450)
    expect(stub.store.answerConsent).toHaveBeenCalledWith('c1', true, { walletRevision: 1, profileKey: '0' })
  })

  it('Reject answers the connection request without a delay', async () => {
    const entry = {
      requestId: 'c2',
      origin: 'https://shop.example',
      attestation: 'unattested',
      transportId: 'loopback',
      connectedBefore: true,
      walletRevision: 1,
      profileKey: '0'
    }
    const stub = consentStub([entry])
    setConsentSheetSource({ store: stub.store as any, context: () => ({ walletRevision: 1, profileKey: '0' }) })
    mount({})
    await press(0)
    expect(stub.store.answerConsent).toHaveBeenCalledWith('c2', false, { walletRevision: 1, profileKey: '0' })
  })
})
