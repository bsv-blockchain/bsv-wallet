/**
 * The three hops of a call and the names they share (spec 6.8).
 *
 *   page world (`provider-main`)  --MessagePort-->  content script (isolated, per frame)
 *   content script  --runtime.sendMessage-->  background (one message per request, so `sender` is fresh)
 *
 * Page to content script: the BRC-185 `brc185:invoke` envelope as is, plus three control calls. Content script
 * to page: `brc185:result` | `brc185:error` | `brc185:closed`, plus one `reply` per control call. Nothing here
 * carries authority: the origin and the frame come only from the background's `sender`.
 */
import type { CloseReason } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import type { ConnectionError } from './errors'
import type { PickupItem } from './pickup'

export const EVENT_REQUEST_PROVIDER = 'brc185:request-provider'
export const EVENT_ANNOUNCE_PROVIDER = 'brc185:announce-provider'

/** `window.postMessage` handshake between the two worlds of one frame (either side may start first). */
export const MSG_MAIN_READY = 'bsv-bridge:main-ready'
export const MSG_CONTENT_READY = 'bsv-bridge:content-ready'
export const MSG_PORT = 'bsv-bridge:port'

/** Name of the content script's long-lived port to the background (keepalive and close detection). */
export const BACKGROUND_PORT_NAME = 'bsv-bridge'

/** Page world to content script, besides the invoke envelope. */
export type PageControl =
  | { kind: 'describe'; rid: number; origin: unknown; challenge: unknown }
  | { kind: 'connect'; rid: number; origin: unknown; epoch: unknown }
  | { kind: 'disconnect'; rid: number; origin: unknown; epoch: unknown }

export type PageReply =
  | { kind: 'reply'; rid: number; ok: true; value: unknown }
  | { kind: 'reply'; rid: number; ok: false; error: unknown }

export interface ClosedNotice {
  instanceId: string
  epoch: string
  reason: CloseReason
}

/** Content script to background. */
export type BackgroundRequest =
  | { bsv: 'describe'; origin: unknown; challenge: unknown }
  | { bsv: 'connect'; origin: unknown; epoch: unknown }
  | { bsv: 'disconnect'; origin: unknown; epoch: unknown }
  | { bsv: 'invoke'; instanceId: unknown; epoch: unknown; id: unknown; method: unknown; params: unknown }
  | { bsv: 'poll'; ids: unknown; epochs: unknown }

export type BackgroundReply<T = unknown> = { ok: true; value: T } | { ok: false; error: ConnectionError }

export type InvokeValue = { kind: 'staged'; recordId: string } | { kind: 'local'; result: unknown }

export interface PollValue {
  items: PickupItem[]
  closed: ClosedNotice[]
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
