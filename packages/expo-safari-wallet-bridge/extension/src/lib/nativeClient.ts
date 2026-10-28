/**
 * Typed client over the appex messages (spec 6.11 operation table). Each op times out after
 * `timeoutMs` and is attempted up to `retries` times in total; only a timeout or a transport failure is
 * retried (a typed failure from the appex is deterministic). Every failure is a P1 `ConnectionError`;
 * `cause` carries the native code (`KEY_MISSING`, `timeout`, ...) so staging (Task 15) can tell them apart.
 * The delivery on these errors is `not-sent`, which is only the truth for ops that stage nothing;
 * `stage*` and `withdraw` callers decide their own delivery.
 */
import { NATIVE_RETRIES, NATIVE_TIMEOUT_MS } from '../../../shared/constants'
import type { BridgeReply, BridgeReplyMap, BridgeRequest, ContinuityContext } from '../../../shared/native'
import { configurationError, protocolError, type ConnectionError } from './errors'

export type NativeRequest = BridgeRequest
export type NativeReply = BridgeReply<BridgeRequest['op']>

type Op = BridgeRequest['op']
type Args<O extends Op> = Omit<Extract<BridgeRequest, { op: O }>, 'op'>
type Ok<O extends Op> = BridgeReplyMap[O]

export interface NativeClient {
  call<O extends Op>(op: O, args: Args<O>): Promise<Ok<O>>
  sync(cursor: number): Promise<Ok<'sync'>>
  identity(context: ContinuityContext): Promise<Ok<'identity'>>
  sign(context: ContinuityContext, preimage: string): Promise<Ok<'sign'>>
  stage(id: string, bytes: string): Promise<Ok<'stage'>>
  stageBegin(id: string, parts: number, size: number, digest: string): Promise<Ok<'stageBegin'>>
  stageChunk(id: string, n: number, bytes: string): Promise<Ok<'stageChunk'>>
  stageEnd(id: string): Promise<Ok<'stageEnd'>>
  withdraw(id: string): Promise<Ok<'withdraw'>>
  results(ids: { id: string; part?: number }[], maxPartBytes?: number): Promise<Ok<'results'>>
  ack(ids: string[]): Promise<Ok<'ack'>>
  nudge(): Promise<Ok<'nudge'>>
}

export interface NativeClientOptions {
  timeoutMs: number
  /** Total attempts per op. */
  retries: number
}

function failureToError(code: string, message: string): ConnectionError {
  switch (code) {
    case 'BAD_REQUEST':
    case 'BAD_PREIMAGE':
    case 'EXISTS_DIFFERENT':
      return { ...protocolError(message), cause: code }
    default:
      // KEY_MISSING (wake before first unlock), UNAVAILABLE (reset, io) and anything new.
      return configurationError(message, code)
  }
}

class Timeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Timeout('timeout')), ms)
    p.then(
      v => {
        clearTimeout(t)
        resolve(v)
      },
      e => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function createNativeClient(
  send: (m: NativeRequest) => Promise<NativeReply>,
  opts: NativeClientOptions = { timeoutMs: NATIVE_TIMEOUT_MS, retries: NATIVE_RETRIES }
): NativeClient {
  const attempts = Math.max(1, opts.retries)

  async function call<O extends Op>(op: O, args: Args<O>): Promise<Ok<O>> {
    const request = { op, ...args } as unknown as NativeRequest
    let last: ConnectionError | undefined
    for (let i = 0; i < attempts; i++) {
      let reply: NativeReply
      try {
        reply = await withTimeout(send(request), opts.timeoutMs)
      } catch (e) {
        last = configurationError(
          e instanceof Timeout ? 'The wallet app did not answer in time' : 'The wallet app could not be reached',
          e instanceof Timeout ? 'timeout' : 'transport'
        )
        continue
      }
      if (typeof reply !== 'object' || reply === null || typeof (reply as { ok?: unknown }).ok !== 'boolean') {
        return Promise.reject(protocolError('The wallet app sent an unreadable reply'))
      }
      if (reply.ok === false) return Promise.reject(failureToError(reply.code, reply.message))
      return reply as Ok<O>
    }
    return Promise.reject(last as ConnectionError)
  }

  return {
    call,
    sync: cursor => call('sync', { cursor }),
    identity: context => call('identity', { context }),
    sign: (context, preimage) => call('sign', { context, preimage }),
    stage: (id, bytes) => call('stage', { id, bytes }),
    stageBegin: (id, parts, size, digest) => call('stageBegin', { id, parts, size, digest }),
    stageChunk: (id, n, bytes) => call('stageChunk', { id, n, bytes }),
    stageEnd: id => call('stageEnd', { id }),
    withdraw: id => call('withdraw', { id }),
    results: (ids, maxPartBytes) => call('results', maxPartBytes === undefined ? { ids } : { ids, maxPartBytes }),
    ack: ids => call('ack', { ids }),
    nudge: () => call('nudge', {})
  }
}
