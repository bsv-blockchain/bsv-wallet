/**
 * A `MandalaRuntime` backed entirely by the demo ledger.
 *
 * DEV-ONLY. Implements the members the UI actually reads or calls; everything
 * else on the interface is drain/settlement machinery that has nothing to
 * drain here, so it answers "nothing happened" rather than throwing — a demo
 * must never crash on a background tick.
 *
 * `endpoints` deliberately carries the `.invalid` demo overlay rather than the
 * configured one: if any code path ever did try to settle one of these rows,
 * it must fail to resolve rather than reach a real issuer.
 */
import type { MandalaRuntime, TokenAssetInfo, TokenAssetStatus, TokenBalance } from '../mandala/runtime'
import { DEMO_ASSETS, DEMO_USD } from './demoAssets'
import {
  demoSendToken,
  demoTokenActivity,
  demoTokenBaseUnits,
  demoUnsettledBaseUnits,
  subscribeDemoLedger
} from './demoLedger'

function statusFor(): TokenAssetStatus {
  return {
    paused: false,
    frozenBaseUnits: 0,
    selfAdmitted: true,
    recipientAdmitted: async () => true,
    metadataResolved: true,
    messageBoxUrl: 'https://messagebox.demo.invalid'
  }
}

function balanceFor(asset: TokenAssetInfo): TokenBalance {
  return {
    asset,
    baseUnits: demoTokenBaseUnits(asset.assetId),
    unsettledBaseUnits: demoUnsettledBaseUnits(asset.assetId)
  }
}

export function createDemoMandalaRuntime(): MandalaRuntime {
  const runtime = {
    available: true,
    endpoints: {
      overlayUrl: DEMO_USD.overlayUrl,
      overlayIdentityKey: DEMO_USD.overlayIdentityKey,
      messageBoxUrl: 'https://messagebox.demo.invalid'
    },
    store: {} as MandalaRuntime['store'],

    // ── what the UI reads ───────────────────────────────────────────
    listAssets: async () => DEMO_ASSETS,
    balances: async () => DEMO_ASSETS.map(balanceFor),
    activity: async (limit?: number) => demoTokenActivity(limit),
    stuck: async () => [],
    assetStatus: async () => statusFor(),
    refreshAssetStatus: async () => statusFor(),
    recipientRefusal: () => null,
    subscribe: subscribeDemoLedger,

    // ── what the UI calls ───────────────────────────────────────────
    sendToHandle: async (args: { assetId: string; recipientIdentityKey: string; baseUnits: number }) => {
      const row = demoSendToken(args.assetId, args.baseUnits, args.recipientIdentityKey)
      if (!row) {
        return {
          kind: 'refused' as const,
          code: 'ERR_INSUFFICIENT_FUNDS',
          message: 'Not enough balance in demo mode.'
        }
      }
      return { kind: 'sent' as const, txid: row.txid, settled: true, notified: true }
    },
    receiveFromInbox: async () => ({ credited: 0, failed: 0 }),
    settleNow: async () => 'broadcast' as const,
    cover: async () => ({ ok: true, mustSubmit: [] }),

    // ── machinery with nothing to do ────────────────────────────────
    drainNow: async () => {},
    settlePendingSends: async () => 0,
    ensureAdmissionsForHoldings: async () => 0,
    reconcileJournals: async () => {},
    recoverStaleAdmissions: async () => 0,
    repairAdmittedAborted: async () => 0,
    pruneBlindingReservations: async () => 0,
    reviewTokenHoldings: async () => ({ settled: 0, removed: 0, unattested: 0, unreachable: false }),
    resendTransfer: async () => ({ kind: 'unavailable', message: 'Demo mode' })
  }

  // The remaining members are injection points for machinery demo mode never
  // starts (the drain, the nearby build, the frame verifier, the pending
  // queue). Casting rather than stubbing each one keeps this file honest about
  // the fact that nothing here is a real settlement path — the same approach
  // `__tests__/__mocks__/fakeMandalaRuntime.ts` takes.
  return runtime as unknown as MandalaRuntime
}
