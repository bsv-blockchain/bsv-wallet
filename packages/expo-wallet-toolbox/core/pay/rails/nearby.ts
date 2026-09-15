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
  type TokenCreditedHook
} from '../../localpay/pending'
/**
 * The two settlement-durability hooks the rail's callers wire (§4.2, §4.3).
 *
 * `TokenHeldHook` runs BEFORE the receiver's `internalizeAction`, so the
 * `token_settlements` row exists when guard #2 looks for it;
 * `TokenHandedOverHook` runs at the payer's park/hold with the frame still in
 * plaintext, so the payer's own row does not depend on a session key this
 * process only holds in memory. Re-exported here because the rail is the single
 * import site for nearby, and both are implemented by the Mandala runtime and
 * consumed by `processPending` / `holdSentPaymentOffline` respectively.
 */
export type {
  AdmissionVerifier,
  EvidenceFrame,
  EvidenceTokenBlock,
  TokenHandedOverHook,
  TokenHandoverState,
  TokenHeldHook
} from '../../mandala/types'
export {
  buildPaymentFrame,
  finalizeDelivery,
  selectTokenCoins,
  type BuiltPayment,
  type DeliveryOutcome,
  type LockToPayee,
  type SelectedTokenCoin,
  type TokenBuildDeps
} from '../../localpay/build'
export {
  FrameVerifyError,
  declineReasonFor,
  verifyFramePayment,
  type DerivingWallet,
  type FrameVerifyKind,
  type VerifiedPayment
} from '../../localpay/verify'
/**
 * The token half of the rail (offline-settlement spec §9).
 *
 * Same three moves the BSV path makes — build, hand over, hold — with the
 * evidence that makes them safe offline attached to each:
 *
 *  · PAYER: `buildPaymentFrame` with `TokenBuildDeps` selects from
 *    `MANDALA_BASKET`, builds `noSend`, and attaches the AdmissionBundle
 *    `assembleBundle` collected. It submits NOTHING — hand-over comes first,
 *    unconditionally, so a face-to-face payment never waits on a network.
 *    `finalizeDelivery` then holds and returns `broadcast: 'pending'` for
 *    every token payment, online or off (guard #1): the drain is the only
 *    path to a real broadcast, and only after admission.
 *  · PAYEE: `verifyFramePayment` proves the output is ours and then runs
 *    `coverFromFrame` against the injected verifier; a frame that fails COVER
 *    is refused at hand-over with `'not_covered'`, exactly like a
 *    `not_mine`/`unparseable` decode failure. A frame that passes is credited
 *    by `processPending` as a basket insertion, and `onTokenCredited` is where
 *    the settlement row and the frame's evidence are persisted.
 *  · BOTH: `readSettlementAck` reads σ_I off the confirm channel — verified
 *    before it is believed, absent if it does not (FIX H) — and
 *    `tokenSendState` turns that into the payer's 'sent-settling' /
 *    'sent-settled' copy.
 */
export {
  SETTLEMENT_ACK_PREFIX,
  decodeSettlementAck,
  encodeSettlementAck,
  readSettlementAck,
  tokenSendState,
  type SettlementAck,
  type TokenSendState,
  type VerifyAdmissionFn
} from '../../localpay/settlementAck'
export {
  MANDALA_BASKET,
  assembleBundle,
  coverFromFrame,
  tokenParentsOf,
  type AdmissionBundle,
  type BundleStore,
  type CoverBundle,
  type CoverTip,
  type CoverVerifier
} from '../../mandala/bundle'
/**
 * The session key the drain cannot hold for itself.
 *
 * A payer's `offline_actions.framePayload` is SEALED with the nearby session's
 * PSK, and the drain deliberately never persists that key — so the flow that
 * mints or scans a session hands it to `rememberSessionPsk` for this process's
 * lifetime, and the drain's decoder tries the keys it was given. See
 * `offline/tokenFrames.ts` for exactly what an unopened row costs (a race the
 * payer is always safe to lose: the RECIPIENT submits).
 */
export {
  MAX_REMEMBERED_SESSION_KEYS,
  forgetSessionPsks,
  rememberSessionPsk,
  sealedFramePayloadDecoder
} from '../../offline/tokenFrames'
/**
 * The payer's three durability moves, all from one place.
 *
 * `holdSentPaymentOffline` was the only one re-exported here while
 * `parkSentPaymentOffline` and `releaseParkedPayment` were reached through the
 * package root — which is the second implementation path this module exists to
 * prevent. `holdSentPaymentOffline` and `parkSentPaymentOffline` take the same
 * `{ frame, onTokenHandedOver }` deps (they create the settlement row from the
 * plaintext frame); `releaseParkedPayment` takes none — the row already exists
 * from the park, so it only advances it parked → handed_over. All three are the
 * same fork of one decision (confirm now, keep for later, confirm later), so
 * they belong on one import site.
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
