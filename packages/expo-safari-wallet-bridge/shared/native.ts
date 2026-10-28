/**
 * Types for the native bridge (spec 6.6, 6.11): the Expo module the app calls, and the JSON the
 * Safari extension handler exchanges. Binary values are base64 strings (standard alphabet, padded)
 * unless a field says base64url.
 */
import type { InboxCloseEvent } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'

export type NativeState = 'pending' | 'accepted' | 'claimed' | 'withdrawn' | 'done'
export type NativeClaimOutcome = 'claimed' | 'digest-mismatch' | 'not-accepted'
export type NativeResultRead = { kind: 'none' } | { kind: 'purged' } | { kind: 'result'; bytes: string }

/** Codes the native layer attaches to a rejection (`error.code`). */
export type NativeErrorCode = 'ERR_NOT_FOUND' | 'ERR_KEY_MISSING' | 'ERR_RESET' | 'ERR_UNAVAILABLE'

/**
 * The app-side native module. Time-dependent calls take `nowMs` last. Everything is asynchronous
 * except `reset` (synchronous on purpose: logout teardown cannot await) and `subscribeNudge`.
 */
export interface BsvBridgeNative {
  init(opts: { nowMs: number }): Promise<{ bootId: string; scheme: string }>
  create(id: string, bytes: string, nowMs: number): Promise<boolean>
  stat(id: string): Promise<{ size: number; state: NativeState; claimBootId?: string } | null>
  read(id: string): Promise<string | null>
  accept(id: string): Promise<boolean>
  release(id: string): Promise<boolean>
  claim(id: string, digest: string, nowMs: number): Promise<NativeClaimOutcome>
  writeResult(id: string, bytes: string, nowMs: number): Promise<boolean>
  readResult(id: string, nowMs: number): Promise<NativeResultRead>
  ack(id: string): Promise<void>
  list(state: NativeState, nowMs: number): Promise<string[]>
  /** `event` is the JSON of an `InboxCloseEvent`; `seq` is its `closeSeq`. */
  writeEvent(seq: number, event: string, nowMs: number): Promise<void>
  /** Each event is JSON text. */
  readEventsAfter(seq: number, nowMs: number): Promise<{ events: string[]; gap: boolean }>
  writeMirror(bytes: string): Promise<void>
  sweep(opts: { nowMs: number }): Promise<void>
  /** Deletes the key and the container; every later write rejects with `ERR_RESET` until `init`. */
  reset(): void
  /** The extension posted a Darwin notification. Delivered only while the app is active. */
  subscribeNudge(cb: () => void): () => void
  /** Debug builds only: every stored file's raw bytes, for the plaintext-marker test. */
  rawBytes(): Promise<string[]>
}

export type { InboxCloseEvent }

// ---- Extension <-> appex native messages (spec 6.11 operation table) ----

export type BridgeErrorCode = 'KEY_MISSING' | 'UNAVAILABLE' | 'EXISTS_DIFFERENT' | 'BAD_REQUEST' | 'BAD_PREIMAGE'
export type ContinuityContext = 'safari' | 'safari-private'

export type BridgeRequest =
  | { op: 'sync'; cursor: number; nowMs?: number }
  | { op: 'identity'; context: ContinuityContext }
  | { op: 'sign'; context: ContinuityContext; preimage: string }
  | { op: 'stage'; id: string; bytes: string; nowMs?: number }
  | { op: 'stageBegin'; id: string; parts: number; size: number; digest: string; nowMs?: number }
  | { op: 'stageChunk'; id: string; n: number; bytes: string; nowMs?: number }
  | { op: 'stageEnd'; id: string; nowMs?: number }
  | { op: 'withdraw'; id: string }
  | { op: 'results'; ids: { id: string; part?: number }[]; nowMs?: number; maxPartBytes?: number }
  | { op: 'ack'; ids: string[] }
  | { op: 'nudge' }

export interface BridgeFailure {
  ok: false
  code: BridgeErrorCode
  message: string
}

export type MirrorState = 'ok' | 'absent' | 'corrupt'

export interface SyncReply {
  ok: true
  mirrorState: MirrorState
  /** Present when `mirrorState` is `ok`. */
  mirror?: import('./mirror').Mirror
  events: InboxCloseEvent[]
  gap: boolean
  /** With `gap`: the highest seq the gap covers; the reader's cursor must land at least here. */
  gapThrough?: number
}
export interface IdentityReply {
  ok: true
  instanceId: string
  /** base64url, unpadded. */
  continuityKey: string
}
export interface SignReply {
  ok: true
  /** base64url, unpadded. */
  signature: string
}
export interface StageReply {
  ok: true
  status: 'created' | 'exists'
}
export interface WithdrawReply {
  ok: true
  won: boolean
}
export type ResultItem =
  | { id: string; state: 'none' }
  | { id: string; state: 'purged' }
  | { id: string; state: 'result'; part: number; parts: number; bytes: string }
export interface ResultsReply {
  ok: true
  results: ResultItem[]
}
export interface EmptyReply {
  ok: true
}

export interface BridgeReplyMap {
  sync: SyncReply
  identity: IdentityReply
  sign: SignReply
  stage: StageReply
  stageBegin: EmptyReply
  stageChunk: EmptyReply
  stageEnd: StageReply
  withdraw: WithdrawReply
  results: ResultsReply
  ack: EmptyReply
  nudge: EmptyReply
}

export type BridgeReply<Op extends BridgeRequest['op']> = BridgeReplyMap[Op] | BridgeFailure
