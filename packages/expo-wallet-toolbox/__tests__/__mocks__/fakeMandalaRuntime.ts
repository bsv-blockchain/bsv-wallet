/**
 * A fake MandalaRuntime for UI tests.
 *
 * The UI is allowed exactly one door to stablecoins (core/mandala/runtime.ts),
 * which makes this the only seam a screen test needs: no overlay, no color
 * module, no journal, no wallet. Every method is a jest.fn so a test can
 * assert what the screen asked for as well as what it drew.
 *
 * Amounts are exact `bigint` token units, as on the real surface.
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
import type { ColorTransferRow } from '../../core/mandala/types'

/** The configured deployment every fake runtime reports as its `endpoints`. */
export const FAKE_OVERLAY_URL = 'https://overlay.example'
export const FAKE_OVERLAY_KEY = '02'.padEnd(66, 'a')

export const USDX: TokenAssetInfo = {
  // The deploy outpoint in asset-id form, `<txid>_<vout>` (IC §0).
  assetId: 'ab'.repeat(32) + '_0',
  label: 'Acme Dollar',
  ticker: 'USDX',
  decimals: 2,
  issuerName: 'Acme Bank',
  resolved: true
}

export const EURX: TokenAssetInfo = {
  ...USDX,
  assetId: 'cd'.repeat(32) + '_0',
  label: 'Euro Coin',
  ticker: 'EURX',
  issuerName: 'Beta Bank'
}

export function balanceOf(asset: TokenAssetInfo = USDX, units = 124000n, offlineUnits = 0n): TokenBalance {
  return { asset, units, offlineUnits }
}

export function activityRow(over: Partial<TokenActivityRow> = {}): TokenActivityRow {
  return {
    txid: 'a'.repeat(64),
    role: 'received',
    asset: USDX,
    units: 4000n,
    status: 'settled',
    at: '2026-09-15T12:00:00.000Z',
    rail: 'handle',
    ...over
  }
}

/**
 * A "nothing is wrong" `TokenAssetStatus` — the default for every fake
 * runtime, so a test that never mentions `assetStatus` gets no paused banner,
 * no frozen note, self and recipient both admitted, metadata resolved, and a
 * MessageBox host that matches whatever the test's own config uses (override
 * per test when that comparison matters).
 */
export function assetStatusOf(over: Partial<TokenAssetStatus> = {}): TokenAssetStatus {
  return {
    paused: false,
    frozenUnits: 0n,
    selfAdmitted: true,
    recipientAdmitted: async () => true,
    metadataResolved: true,
    messageBoxUrl: 'https://messagebox.example',
    ...over
  }
}

/** A `color_transfers` row, as `stuck()` and the journal return it. */
export function transferRow(over: Partial<ColorTransferRow> = {}): ColorTransferRow {
  return {
    txid: 'b'.repeat(64),
    role: 'received',
    assetId: USDX.assetId,
    units: 4000n,
    outputIndex: 0,
    rail: 'handle',
    state: 'held',
    delivered: false,
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
  assetStatus: jest.Mock
  refreshAssetStatus: jest.Mock
  rememberDeploy: jest.Mock
  recipientRefusal: jest.Mock
  subscribe: jest.Mock
  /**
   * One row's settlement. Answers `'handed_over'` by default — "asked,
   * nothing changed yet" — so a screen that fires it and forgets keeps its
   * "settling" copy; override with `settleNow` to drive the settled branch.
   */
  settleNow: jest.Mock
  settleAll: jest.Mock
  reviewTokenHoldings: jest.Mock
  isHandoverAdmitted: jest.Mock
  reconcileHeld: jest.Mock
  sendToHandle: jest.Mock
  receiveFromInbox: jest.Mock
  resendTransfer: jest.Mock
  tick: jest.Mock
  nearby: { handover: jest.Mock; onHandedOver: jest.Mock; accept: jest.Mock; onReceived: jest.Mock }
  /** Fire every subscriber, as the real runtime does when money moves. */
  emit(): void
}

export function makeFakeMandala(
  over: Partial<{
    available: boolean
    balances: TokenBalance[]
    activity: TokenActivityRow[]
    stuck: ColorTransferRow[]
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
    endpoints: {
      overlayUrl: FAKE_OVERLAY_URL,
      overlayIdentityKey: FAKE_OVERLAY_KEY,
      messageBoxUrl: status.messageBoxUrl
    },
    journal: {} as MandalaRuntime['journal'],
    listAssets: jest.fn(async () => (over.balances ?? [balanceOf()]).map(b => b.asset)),
    balances: jest.fn(async () => over.balances ?? [balanceOf()]),
    activity: jest.fn(async () => over.activity ?? []),
    stuck: jest.fn(async () => over.stuck ?? []),
    assetStatus: jest.fn(async () => status),
    refreshAssetStatus: jest.fn(async () => status),
    rememberDeploy: jest.fn(async () => {}),
    recipientRefusal: jest.fn(() => over.refusal ?? null),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    settleNow: jest.fn(async () => over.settleNow ?? 'handed_over'),
    settleAll: jest.fn(async () => 0),
    reviewTokenHoldings: jest.fn(async () => ({ settled: 0, refused: 0, pending: 0, unreachable: false })),
    isHandoverAdmitted: jest.fn(async () => undefined),
    reconcileHeld: jest.fn(async () => {}),
    sendToHandle: jest.fn(
      async () => over.send ?? { kind: 'sent', txid: 'c'.repeat(64), settled: false, notified: true }
    ),
    receiveFromInbox: jest.fn(async () => ({ credited: 0, failed: 0 })),
    resendTransfer: jest.fn(async () => 'resent' as const),
    tick: jest.fn(async () => {}),
    nearby: {
      handover: jest.fn(),
      // PAYER, at park/hold. A no-op by default; a test that cares asserts on it.
      onHandedOver: jest.fn(async () => {}),
      accept: jest.fn(),
      onReceived: jest.fn(async () => {})
    },
    emit: () => listeners.forEach(l => l())
  }
  return runtime as unknown as FakeMandala
}
