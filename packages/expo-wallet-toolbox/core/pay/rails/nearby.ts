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
  type PendingPayment
} from '../../localpay/pending'
export { buildPaymentFrame, finalizeDelivery } from '../../localpay/build'
export {
  FrameVerifyError,
  verifyFramePayment,
  type DerivingWallet,
  type FrameVerifyKind
} from '../../localpay/verify'
export { holdSentPaymentOffline } from '../../offline/payerHold'
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
