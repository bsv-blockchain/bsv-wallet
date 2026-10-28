/**
 * Numbers the app side and the Safari extension side agree on (spec 6.11 and the plan's Global
 * Constraints). Pure: no app imports, so the extension bundle can use this file.
 */
import {
  MAX_BINDINGS_PER_ORIGIN,
  MAX_BINDINGS_TOTAL,
  MAX_IN_FLIGHT_BYTES,
  MAX_IN_FLIGHT_PER_BINDING,
  MAX_IN_FLIGHT_TOTAL
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'

/** Bytes per staged chunk. Default until Task 13 measures the native-messaging channel (spike S2). */
export const STAGE_CHUNK_BYTES = 48 * 1024
/** One handoff per this long, however many calls queue behind it. */
export const HANDOFF_COALESCE_MS = 3000
/** A native operation is abandoned after this long and retried. */
export const NATIVE_TIMEOUT_MS = 5000
export const NATIVE_RETRIES = 3
/** An epoch whose tab went away stays answerable this long. */
export const CLOSING_GRACE_MS = 5000
/** An epoch older than this is closed at reconcile. */
export const EPOCH_HORIZON_MS = 24 * 60 * 60 * 1000
/** Result poll steps; the last one repeats. */
export const POLL_STEPS_MS = [1000, 2000, 5000]

/** Extension-side caps on calls that have been sent and not yet resolved, across all tabs. */
export const UNRESOLVED_CAPS = {
  perEpoch: MAX_IN_FLIGHT_PER_BINDING,
  total: MAX_IN_FLIGHT_TOTAL,
  bytes: MAX_IN_FLIGHT_BYTES
}

/** Extension-side caps on live bindings. */
export const BINDING_CAPS = {
  perOrigin: MAX_BINDINGS_PER_ORIGIN,
  total: MAX_BINDINGS_TOTAL
}

/** The registered transport id; the app requires it to start with `safari`. */
export const TRANSPORT_ID = 'safari-extension'
