/**
 * A `MandalaRuntime` backed entirely by the demo ledger.
 *
 * DEV-ONLY. Implements the members the UI actually reads or calls; everything
 * else on the interface is settlement machinery that has nothing to settle
 * here, so it answers "nothing happened" rather than throwing — a demo must
 * never crash on a background tick.
 *
 * `endpoints` deliberately carries the `.invalid` demo overlay rather than the
 * configured one: if any code path ever did try to settle one of these rows,
 * it must fail to resolve rather than reach a real issuer. The journal refuses
 * every call for the same reason.
 */
import type {
  MandalaRuntime,
  TokenAssetInfo,
  TokenAssetStatus,
  TokenBalance,
  TokenSendResult
} from '../mandala/runtime'
import type { TransferJournal } from '../mandala/transferJournal'
import { DEMO_ASSETS, DEMO_OVERLAY_KEY, DEMO_OVERLAY_URL } from './demoAssets'
import { demoOfflineUnits, demoSendToken, demoTokenActivity, demoTokenUnits, subscribeDemoLedger } from './demoLedger'

const DEMO_MESSAGEBOX_URL = 'https://messagebox.demo.invalid'

function statusFor(): TokenAssetStatus {
  return {
    paused: false,
    frozenUnits: 0n,
    selfAdmitted: true,
    recipientAdmitted: async () => true,
    metadataResolved: true,
    messageBoxUrl: DEMO_MESSAGEBOX_URL
  }
}

function balanceFor(asset: TokenAssetInfo): TokenBalance {
  const units = demoTokenUnits(asset.assetId)
  const offline = demoOfflineUnits(asset.assetId)
  return { asset, units, offlineUnits: offline > units ? units : offline }
}

function demoJournal(): TransferJournal {
  const refuse = async (): Promise<never> => {
    throw new Error('demo mode has no color_transfers journal')
  }
  return {
    get: refuse,
    getByReference: refuse,
    list: refuse,
    insert: refuse,
    advance: refuse,
    setDelivered: refuse,
    statesOf: refuse
  }
}

export function createDemoMandalaRuntime(): MandalaRuntime {
  const runtime: MandalaRuntime = {
    available: true,
    endpoints: {
      overlayUrl: DEMO_OVERLAY_URL,
      overlayIdentityKey: DEMO_OVERLAY_KEY,
      messageBoxUrl: DEMO_MESSAGEBOX_URL
    },
    journal: demoJournal(),

    // ── what the UI reads ───────────────────────────────────────────
    listAssets: async () => DEMO_ASSETS,
    balances: async () => DEMO_ASSETS.map(balanceFor),
    activity: async (limit?: number) => demoTokenActivity(limit),
    stuck: async () => [],
    assetStatus: async () => statusFor(),
    refreshAssetStatus: async () => statusFor(),
    rememberDeploy: async () => {},
    recipientRefusal: () => null,
    subscribe: subscribeDemoLedger,

    // ── what the UI calls ───────────────────────────────────────────
    sendToHandle: async (args: {
      assetId: string
      recipientIdentityKey: string
      units: bigint
    }): Promise<TokenSendResult> => {
      const row = demoSendToken(args.assetId, args.units, args.recipientIdentityKey)
      if (!row) {
        return { kind: 'refused', code: 'ERR_INSUFFICIENT_FUNDS', message: 'Not enough balance in demo mode.' }
      }
      return { kind: 'sent', txid: row.txid, settled: true, notified: true }
    },
    receiveFromInbox: async () => ({ credited: 0, failed: 0 }),
    settleNow: async () => 'settled',
    resendTransfer: async () => 'unavailable',

    // ── machinery with nothing to do ────────────────────────────────
    settleAll: async () => 0,
    reviewTokenHoldings: async () => ({ settled: 0, refused: 0, pending: 0, unreachable: false }),
    isHandoverAdmitted: async () => undefined,
    reconcileHeld: async () => {},
    tick: async () => {},
    nearby: {
      handover: async () => {
        throw new Error('demo mode does not build nearby token payments')
      },
      onHandedOver: async () => {},
      accept: async () => {
        throw new Error('demo mode does not receive nearby token payments')
      },
      onReceived: async () => {}
    }
  }
  return runtime
}
