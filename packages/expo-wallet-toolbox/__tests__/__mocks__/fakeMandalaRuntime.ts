/**
 * A fake MandalaRuntime for UI tests.
 *
 * The UI is allowed exactly one door to stablecoins (core/mandala/runtime.ts),
 * which makes this the only seam a screen test needs: no overlay, no lib, no
 * settlement tables, no wallet. Every method is a jest.fn so a test can assert
 * what the screen asked for as well as what it drew.
 */
import type {
  MandalaRuntime,
  TokenActivityRow,
  TokenAssetInfo,
  TokenAssetStatus,
  TokenBalance,
  TokenSendResult,
  TokenSettleState
} from '../../core/mandala/runtime'
import type { TokenSettlementRow } from '../../core/mandala/types'

export const USDX: TokenAssetInfo = {
  assetId: '615a06ab0000000000000000000000000000000000000000000000000000000000000004',
  label: 'Acme Dollar',
  ticker: 'USDX',
  decimals: 2,
  issuerName: 'Acme Bank',
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: '02'.padEnd(66, 'a')
}

export const EURX: TokenAssetInfo = {
  ...USDX,
  assetId: '77'.padEnd(72, '0'),
  label: 'Euro Coin',
  ticker: 'EURX',
  issuerName: 'Beta Bank'
}

export function balanceOf(
  asset: TokenAssetInfo = USDX,
  baseUnits = 124000,
  unsettledBaseUnits = 0
): TokenBalance {
  return { asset, baseUnits, unsettledBaseUnits }
}

export function activityRow(over: Partial<TokenActivityRow> = {}): TokenActivityRow {
  return {
    txid: 'a'.repeat(64),
    role: 'received',
    asset: USDX,
    baseUnits: 4000,
    status: 'settled',
    at: '2026-09-15T12:00:00.000Z',
    ...over
  }
}

/**
 * A "nothing is wrong" `TokenAssetStatus` — the default for every fake
 * runtime, so a test that never mentions `assetStatus` gets exactly today's
 * behaviour: no paused banner, no frozen note, self and recipient both
 * admitted, metadata resolved, and a MessageBox host that matches whatever
 * the test's own config uses (override per test when that comparison matters).
 */
export function assetStatusOf(over: Partial<TokenAssetStatus> = {}): TokenAssetStatus {
  return {
    paused: false,
    frozenBaseUnits: 0,
    selfAdmitted: true,
    recipientAdmitted: async () => true,
    metadataResolved: true,
    messageBoxUrl: 'https://messagebox.example',
    ...over
  }
}

export function settlementRow(over: Partial<TokenSettlementRow> = {}): TokenSettlementRow {
  return {
    txid: 'b'.repeat(64),
    role: 'received',
    assetId: USDX.assetId,
    state: 'held',
    overlayUrl: USDX.overlayUrl,
    overlayIdentityKey: USDX.overlayIdentityKey,
    createdAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:00.000Z',
    ...over
  }
}

export interface FakeMandala extends MandalaRuntime {
  listAssets: jest.Mock
  balances: jest.Mock
  activity: jest.Mock
  stuck: jest.Mock
  sendToHandle: jest.Mock
  receiveFromInbox: jest.Mock
  cover: jest.Mock
  drainNow: jest.Mock
  /**
   * The payer's own submit for ONE row (§4.3, 2026-09-15). Answers
   * `'handed_over'` by default — "asked, nothing changed yet" — so a screen
   * that fires it and forgets keeps its "settling" copy; override with
   * `settleNow` to drive the settled branch.
   */
  settleNow: jest.Mock
  recipientRefusal: jest.Mock
  subscribe: jest.Mock
  assetStatus: jest.Mock
  refreshAssetStatus: jest.Mock
  /**
   * PAYER, at park/hold (§4.4): journals the still-plaintext frame's
   * settlement row. `NearbyFlow`'s three hold/park call sites all thread this
   * through for a token session, so a test asserts on it directly rather than
   * on whatever mock received it — see `nearbyFlowToken.test.tsx`.
   */
  onTokenHandedOver: jest.Mock
  /** Fire every subscriber, as the real runtime does when money moves. */
  emit(): void
}

export function makeFakeMandala(
  over: Partial<{
    available: boolean
    balances: TokenBalance[]
    activity: TokenActivityRow[]
    stuck: TokenSettlementRow[]
    send: TokenSendResult
    refusal: string | null
    /** Merged over `assetStatusOf()`'s all-clear defaults, for every assetId. */
    assetStatus: Partial<TokenAssetStatus>
    /** What `settleNow` reports the row reached. Default: unchanged. */
    settleNow: TokenSettleState
  }> = {}
): FakeMandala {
  const listeners = new Set<() => void>()
  const status = assetStatusOf(over.assetStatus)
  const runtime = {
    available: over.available ?? true,
    // The configured deployment — what a call site that must state a §9.10
    // trust anchor (verifyFramePayment's `opts.asset`) reads off the runtime.
    endpoints: {
      overlayUrl: USDX.overlayUrl,
      overlayIdentityKey: USDX.overlayIdentityKey,
      messageBoxUrl: status.messageBoxUrl
    },
    store: {} as MandalaRuntime['store'],
    listAssets: jest.fn(async () => (over.balances ?? [balanceOf()]).map(b => b.asset)),
    balances: jest.fn(async () => over.balances ?? [balanceOf()]),
    activity: jest.fn(async () => over.activity ?? []),
    stuck: jest.fn(async () => over.stuck ?? []),
    sendToHandle: jest.fn(
      async () => over.send ?? { kind: 'sent', txid: 'c'.repeat(64), settled: false, notified: true }
    ),
    receiveFromInbox: jest.fn(async () => ({ credited: 0, failed: 0 })),
    lockToPayee: jest.fn() as unknown as MandalaRuntime['lockToPayee'],
    cover: jest.fn(async () => ({ ok: true, mustSubmit: [] })),
    drainNow: jest.fn(async () => {}),
    settleNow: jest.fn(async () => over.settleNow ?? 'handed_over'),
    recipientRefusal: jest.fn(() => over.refusal ?? null),
    assetStatus: jest.fn(async () => status),
    refreshAssetStatus: jest.fn(async () => status),
    // A stub that satisfies the runtime's own truthiness gate at the call
    // site (`mandala.runtime?.verifyAdmissionEntry`) — real verification is
    // the lib's job, and a test that cares about the settled-vs-settling
    // split controls it by mocking `readSettlementAck` directly instead.
    verifyAdmissionEntry: jest.fn(async () => true) as unknown as MandalaRuntime['verifyAdmissionEntry'],
    // Payer-side settlement journal hook (§4.4). A no-op by default; a test
    // that cares asserts calls on this mock directly (see `FakeMandala`).
    onTokenHandedOver: jest.fn(async () => {}),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit: () => listeners.forEach(l => l())
  }
  return runtime as unknown as FakeMandala
}
