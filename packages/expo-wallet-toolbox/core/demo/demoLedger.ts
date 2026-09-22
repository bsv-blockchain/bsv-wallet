/**
 * The demo wallet's whole world: one mutable, in-memory ledger.
 *
 * DEV-ONLY. Holds a BSV balance with its action history and a base-unit
 * balance per demo stablecoin with its settlement history, and mutates both
 * when the UI "sends". Nothing here touches SQLite, the keychain, an overlay
 * or the network, so a demo send can never become a real one — and everything
 * is gone at reload, which is what makes the mode safe to hand to someone.
 *
 * Figures are integers throughout (satoshis, token base units) for the same
 * reason `ui/tokenFormat.ts` is: a float balance prints money that is not
 * owned.
 */
import type { TokenActivityRow, TokenActivityStatus } from '../mandala/runtime'
import type { WalletAction } from '@bsv/sdk'
import {
  DEMO_CHF,
  DEMO_COUNTERPARTIES,
  DEMO_OPENING_SATS,
  DEMO_OPENING_TOKEN_BASE_UNITS,
  DEMO_USD,
  demoAssetById
} from './demoAssets'

/** `ActivityAction` without importing the UI layer from core. */
export type DemoAction = WalletAction & {
  reference?: string
  created_at?: string | number | Date
  senderIdentityKey?: string
}

interface DemoState {
  satoshis: number
  actions: DemoAction[]
  tokenBaseUnits: Record<string, number>
  tokenActivity: TokenActivityRow[]
}

const listeners = new Set<() => void>()

/** Deterministic 64-hex txid, so a demo row looks like a row and never collides. */
let txidCounter = 0
function demoTxid(): string {
  txidCounter += 1
  return txidCounter.toString(16).padStart(8, '0').repeat(8)
}

function daysAgo(n: number, hour = 12): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, (n * 7) % 60, 0, 0)
  return d.toISOString()
}

function bsvAction(over: Partial<DemoAction> & { satoshis: number; description: string }): DemoAction {
  return {
    txid: demoTxid(),
    status: 'completed',
    isOutgoing: over.satoshis < 0,
    labels: [],
    version: 1,
    lockTime: 0,
    ...over,
    // `satoshis` on a WalletAction is the signed delta to the balance, which
    // is what the row renders; keep the caller's sign.
    satoshis: over.satoshis
  }
}

function tokenRow(
  assetId: string,
  role: 'sent' | 'received',
  baseUnits: number,
  at: string,
  counterpartyKey?: string,
  status: TokenActivityStatus = 'settled'
): TokenActivityRow {
  const asset = demoAssetById(assetId)
  if (!asset) throw new Error(`demo: unknown assetId ${assetId}`)
  return { txid: demoTxid(), role, asset, baseUnits, counterpartyKey, status, at }
}

/**
 * The opening history: money in and out, on all three rails, spread over the
 * last three weeks so the home list has day headers to group under.
 */
function seed(): DemoState {
  const [sofia, marco, lena, store] = DEMO_COUNTERPARTIES
  txidCounter = 0
  return {
    satoshis: DEMO_OPENING_SATS,
    actions: [
      bsvAction({ satoshis: 12_000_000, description: 'Salary — October', created_at: daysAgo(18, 9) }),
      bsvAction({ satoshis: -2_400_000, description: `Paid ${store.name}`, created_at: daysAgo(14, 18) }),
      bsvAction({ satoshis: 6_500_000, description: `From ${sofia.name}`, created_at: daysAgo(11, 10) }),
      bsvAction({ satoshis: -850_000, description: 'Coffee', created_at: daysAgo(7, 8) }),
      bsvAction({ satoshis: -3_250_000, description: `Paid ${marco.name}`, created_at: daysAgo(4, 16) }),
      bsvAction({ satoshis: 15_000_000, description: `From ${lena.name}`, created_at: daysAgo(2, 13) }),
      bsvAction({ satoshis: -1_000_000, description: 'Lunch', created_at: daysAgo(0, 12) })
    ],
    tokenBaseUnits: { ...DEMO_OPENING_TOKEN_BASE_UNITS },
    tokenActivity: [
      tokenRow(DEMO_USD.assetId, 'received', 50_000, daysAgo(16, 11), sofia.key),
      tokenRow(DEMO_CHF.assetId, 'received', 40_000, daysAgo(13, 15), lena.key),
      tokenRow(DEMO_USD.assetId, 'sent', 12_500, daysAgo(9, 19), store.key),
      tokenRow(DEMO_CHF.assetId, 'sent', 7_450, daysAgo(6, 12), marco.key),
      tokenRow(DEMO_USD.assetId, 'received', 86_500, daysAgo(3, 14), marco.key),
      tokenRow(DEMO_CHF.assetId, 'received', 53_500, daysAgo(1, 17), sofia.key),
      // One row mid-flight, so the "settling" copy has something to render.
      tokenRow(DEMO_USD.assetId, 'sent', 2_000, daysAgo(0, 11), lena.key, 'settling')
    ]
  }
}

/**
 * Initialised here rather than beside `listeners` above: `seed()` assigns
 * `txidCounter`, so calling it any earlier reads that binding inside its
 * temporal dead zone and throws on import.
 */
let state: DemoState = seed()

function notify(): void {
  listeners.forEach(l => l())
}

export function subscribeDemoLedger(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ── reads ──────────────────────────────────────────────────────────────

export function demoSatoshis(): number {
  return state.satoshis
}

/** Newest first — the order the activity list renders in. */
export function demoActions(limit?: number, offset = 0): DemoAction[] {
  const sorted = [...state.actions].sort(
    (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
  )
  return limit == null ? sorted.slice(offset) : sorted.slice(offset, offset + limit)
}

export function demoTotalActions(): number {
  return state.actions.length
}

export function demoTokenBaseUnits(assetId: string): number {
  return state.tokenBaseUnits[assetId] ?? 0
}

export function demoTokenActivity(limit?: number): TokenActivityRow[] {
  const sorted = [...state.tokenActivity].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  return limit == null ? sorted : sorted.slice(0, limit)
}

/** Base units awaiting settlement — what the UI shows as not-yet-final. */
export function demoUnsettledBaseUnits(assetId: string): number {
  return state.tokenActivity
    .filter(r => r.asset.assetId === assetId && r.role === 'received' && r.status === 'settling')
    .reduce((sum, r) => sum + r.baseUnits, 0)
}

// ── writes ─────────────────────────────────────────────────────────────

/** Spend BSV. Returns the new row, or null when the balance cannot cover it. */
export function demoSendBsv(satoshis: number, description: string): DemoAction | null {
  if (!Number.isFinite(satoshis) || satoshis <= 0) return null
  if (satoshis > state.satoshis) return null
  const action = bsvAction({
    satoshis: -Math.round(satoshis),
    description: description || 'Demo payment',
    created_at: new Date().toISOString()
  })
  state = { ...state, satoshis: state.satoshis - Math.round(satoshis), actions: [...state.actions, action] }
  notify()
  return action
}

/** Receive BSV — for demonstrating an incoming payment on cue. */
export function demoReceiveBsv(satoshis: number, description: string): DemoAction | null {
  if (!Number.isFinite(satoshis) || satoshis <= 0) return null
  const action = bsvAction({
    satoshis: Math.round(satoshis),
    description: description || 'Demo receipt',
    created_at: new Date().toISOString()
  })
  state = { ...state, satoshis: state.satoshis + Math.round(satoshis), actions: [...state.actions, action] }
  notify()
  return action
}

/** Spend a token. Returns the new row, or null when the balance cannot cover it. */
export function demoSendToken(
  assetId: string,
  baseUnits: number,
  counterpartyKey?: string
): TokenActivityRow | null {
  if (!demoAssetById(assetId)) return null
  if (!Number.isFinite(baseUnits) || baseUnits <= 0) return null
  const held = demoTokenBaseUnits(assetId)
  const amount = Math.round(baseUnits)
  if (amount > held) return null
  const row = tokenRow(assetId, 'sent', amount, new Date().toISOString(), counterpartyKey, 'settled')
  state = {
    ...state,
    tokenBaseUnits: { ...state.tokenBaseUnits, [assetId]: held - amount },
    tokenActivity: [...state.tokenActivity, row]
  }
  notify()
  return row
}

/** Receive a token — for demonstrating an incoming payment on cue. */
export function demoReceiveToken(
  assetId: string,
  baseUnits: number,
  counterpartyKey?: string
): TokenActivityRow | null {
  if (!demoAssetById(assetId)) return null
  if (!Number.isFinite(baseUnits) || baseUnits <= 0) return null
  const amount = Math.round(baseUnits)
  const row = tokenRow(assetId, 'received', amount, new Date().toISOString(), counterpartyKey, 'settled')
  state = {
    ...state,
    tokenBaseUnits: { ...state.tokenBaseUnits, [assetId]: demoTokenBaseUnits(assetId) + amount },
    tokenActivity: [...state.tokenActivity, row]
  }
  notify()
  return row
}

/** Back to the opening position, without a reload. */
export function resetDemoLedger(): void {
  state = seed()
  notify()
}
