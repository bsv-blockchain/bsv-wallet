/**
 * The nearby rail — in-person, device-to-device over AWDL, Nearby, BLE or QR.
 *
 * A pass-through, on purpose. localpay/* is device-proven with 210 tests
 * behind it and its money-safety invariants were verified line by line, so this
 * rail adds NOTHING: no wrappers, no defaults, no convenience. Its only job is
 * to be the single import site for nearby, so a future change cannot quietly
 * grow a second implementation between the screen and the transport.
 *
 * If you find yourself wanting to add a function here, add it to the caller
 * instead.
 */
export { decodeSession, encodeSession, mintSession, type Session } from '../../localpay/session'
export {
  FRAME_BLOCK_BYTES,
  SEAL_VERSION,
  frameBytesFromQr,
  frameToQr,
  sealedToQr,
  sealFrame,
  unsealFrame,
  type PaymentFrame
} from '../../localpay/codec'
/**
 * The animated-QR transport is `@bsv/air-gap` (BRC-141), not app code. It was
 * grown here first and upstreamed; the published library adds what a local
 * copy could not justify carrying — a wire version byte, per-stream session
 * ids with switch hysteresis so one stray frame cannot erase a scan in
 * progress, and explicit decoder resource budgets. Display cadence stays with
 * the renderer, because the library deliberately has no opinion on it.
 */
export {
  AIR_GAP_PREFIX,
  AirGapDecoder,
  AirGapEncoder,
  MAX_MESSAGE_BYTES,
  estimatePartCharLength,
  isAirGapPart
} from '@bsv/air-gap'
export {
  isSessionSpent,
  markSessionSpent,
  processPending,
  savePending,
  type PendingPayment,
  type TokenReceiveHook
} from '../../localpay/pending'
/**
 * The token half of the rail (plan 07 Tasks 15–16).
 *
 * Same three moves the BSV path makes — build, hand over, hold — with the
 * color module doing the token work:
 *
 *  · PAYER: `buildPaymentFrame` with `TokenBuildDeps` frames the runtime's
 *    `nearby.handover` (lib `sendHandover`, bound to the session's own
 *    remittance strings) as a v7 frame carrying the v4 hand-over body's
 *    members (IC §7.3). It submits NOTHING — hand-over comes first,
 *    unconditionally.
 *    `finalizeDelivery` then holds and returns `broadcast: 'pending'` for
 *    every token payment, online or off (guard #1); the screen calls
 *    `settleNow` after the payee's positive ack (W5), and only a verified
 *    admission ever releases the tx.
 *  · PAYEE: `verifyFramePayment` checks the frame (a value output of the
 *    session's asset, paying this device's `p color` key, with evidence that
 *    reaches σ by this device's K under offline COVER), and `processPending`
 *    hands it to the runtime's `nearby.accept` (lib `acceptHandover`: online
 *    submit or COVER, host-ledger record, then the plain BRC-207 receipt into
 *    `p color <assetTag>`); `nearby.onReceived` journals it held, settled or
 *    refused (Task 16, B7).
 */
export {
  buildPaymentFrame,
  finalizeDelivery,
  type BuiltPayment,
  type DeliveryOutcome,
  type TokenBuildDeps
} from '../../localpay/build'
export {
  FrameVerifyError,
  declineReasonFor,
  verifyFramePayment,
  type DerivingWallet,
  type FrameVerifyDeps,
  type FrameVerifyKind,
  type VerifiedPayment
} from '../../localpay/verify'
/**
 * The payer's three durability moves, all from one place.
 *
 * `holdSentPaymentOffline` was the only one re-exported here while
 * `parkSentPaymentOffline` and `releaseParkedPayment` were reached through the
 * package root — which is the second implementation path this module exists to
 * prevent. All three take the runtime's `nearby.onHandedOver` on the token
 * rail, which moves the payment's `color_transfers` row forward (parked, then
 * handed_over). All three are the same fork of one decision (confirm now, keep
 * for later, confirm later), so they belong on one import site.
 */
export {
  holdSentPaymentOffline,
  parkSentPaymentOffline,
  releaseParkedPayment,
  type TokenHandoverDeps
} from '../../offline/payerHold'
export { awdlTransport } from '../../localpay/transport/awdl'
export { nearbyTransport } from '../../localpay/transport/nearby'
export { bleTransport } from '../../localpay/transport/ble'
export { raceReceivers, type RaceWinner, type RadioKind } from '../../localpay/transport/race'
export {
  describeFloor,
  localSupportsAwdl,
  localSupportsBle,
  localSupportsNearby,
  selectTransport,
  type FloorReason,
  type TransportKind
} from '../../localpay/transport/select'
export { requestNearbyPermissions } from '../../localpay/nearbyPermissions'
export { requestBlePermissions } from '../../localpay/blePermissions'
export {
  capsFromProbe,
  prepareBle,
  probeDeviceCaps,
  readBluetoothState,
  type BluetoothState,
  type DeviceProbe
} from '../../localpay/deviceCaps'
export { isDeclineReason, type Ack, type ConfirmDelivery, type DeclineReason } from '../../localpay/types'
export { CAP_BLE, CAP_NEARBY } from '../../localpay/session'
