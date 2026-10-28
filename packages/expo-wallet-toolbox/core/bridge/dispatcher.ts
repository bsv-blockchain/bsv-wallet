/**
 * The dispatch pipeline (spec 6.6): one BRC-185 request in, one `Outcome` out.
 *
 * Order, as in the spec: transport bounds, binding, method, probes, arguments, wallet state and
 * consent, readiness again, a synchronous re-check, the call, the result. Steps 6 and 7 may park a
 * request for as long as it takes (BRC-219 sets no timeout on a pending prompt); a parked request
 * wakes on two signals, a snapshot change and the close of its own binding, so a profile switch
 * settles it instead of letting it proceed onto the new wallet.
 *
 * `Outcome.walletError` carries `delivery`, which the plan's type omitted but spec 6.11 assigns:
 * `not-sent` for a refusal before the call, and for a call that failed on a read-only method
 * (nothing can have changed); `unknown` for a call that failed on a mutating method.
 *
 * Production wiring of the `ConsentStore` (it needs the admin-scoped wallet) is not done here: the
 * host creates the store and hands it to `createDispatcher`, then `installDispatcher`.
 */
import { WERR_INVALID_PARAMETER, normalizeBRC100WalletByteFields, stringifyBRC100 } from '@bsv/sdk'
import { snapshotWalletResultRequest, validateWalletArgs, validateWalletResult } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { WalletArgTooLarge, capWalletArgs, tierLimits } from '../services/capWalletArgs'
import { checkWalletArgs, type WalletArgLimits } from '../services/walletArgLimits'
import type { Binding } from './bindings'
import type { ConsentStore } from './consent'
import { findTokenModuleVariant, isValidVersionString } from './policy'
import { encodeWalletError, type WireError } from './protocol/errorCodec'
import { connectionError, isConnectionError, type ConnectionError, type Delivery } from './protocol/connectionError'
import {
  MAX_BRIDGE_REQUEST_BYTES,
  MAX_IN_FLIGHT_BYTES,
  MAX_IN_FLIGHT_PER_BINDING,
  MAX_IN_FLIGHT_TOTAL
} from './protocol/limits'
import { BRIDGE_METHODS, isBridgeMethod, type WalletMethodName } from './protocol/methods'
import { assertCanonicalOriginator } from './protocol/origin'
import type { CloseEvent } from './bindings'
import {
  assertBridgeHost,
  getBindingRegistry,
  getBridgeSnapshot,
  getPublishedManagers,
  getTransport,
  onBindingClosed,
  onSnapshotChange,
  type AttentionReason
} from './runtime'

export interface DispatchRequest {
  epoch: string
  instanceId: string
  continuityKey: string
  origin: string
  accountContext?: string
  method: string
  args: unknown
  sizeBytes: number
  /**
   * Awaited once, after consent and before the final readiness wait and the synchronous re-check.
   * The durable inbox claims its record here (spec 6.8): the claim is the at-most-once point, and
   * the re-check then runs after it. A rejection with a `ConnectionError` settles the request with
   * it; the wallet is not called.
   */
  beforeCall?: () => Promise<void>
}

export type Outcome =
  | { ok: true; result: unknown }
  | { ok: false; walletError: WireError; delivery: Delivery }
  | { ok: false; connectionError: ConnectionError }

export interface DispatcherDeps {
  consent: ConsentStore
  /** Defaults to the device tier's limits, the same ones `capWalletArgs` applies. */
  walletArgLimits?: WalletArgLimits
  /** Nudges the backup log after a mutating call. Defaults to `TaskBackupPush.noteChanged`. */
  noteChanged?: () => void
}

export interface Dispatcher {
  dispatch(input: { transport: string | { id: string }; request: DispatchRequest }): Promise<Outcome>
}

/** A settled outcome reached mid-pipeline. */
class Early {
  constructor(readonly outcome: Outcome) {}
}

const refuse = (e: ConnectionError): Early => new Early({ ok: false, connectionError: e })
const walletRefusal = (wire: WireError): Early => new Early({ ok: false, walletError: wire, delivery: 'not-sent' })

function permissionDenied(message: string): Early {
  const error = Object.assign(new Error(message), { code: 'ERR_PERMISSION_DENIED' })
  return walletRefusal(encodeWalletError(error))
}

/** A wallet error that must reach the page as code 6, whatever the validator threw. */
function invalidArgument(e: unknown): Early {
  const wire = encodeWalletError(e)
  return walletRefusal(wire.code === 6 ? wire : encodeWalletError(new WERR_INVALID_PARAMETER('request', 'valid')))
}

const MAX_SCAN_DEPTH = 64

/**
 * True when the arguments hold a typed array or an ArrayBuffer, or nest deeper than a JSON request
 * could. Byte fields on this boundary are `number[]`. A deep cycle can only come from an
 * in-process caller, and is refused the same way.
 */
function hasBinaryOrDeep(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object') return false
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return true
  if (depth > MAX_SCAN_DEPTH) return true
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const item = v[i]
      if (item !== null && typeof item === 'object' && hasBinaryOrDeep(item, depth + 1)) return true
    }
    return false
  }
  for (const value of Object.values(v)) if (hasBinaryOrDeep(value, depth + 1)) return true
  return false
}

function closedOutcome(e: CloseEvent): ConnectionError {
  if (e.reason === 'lost') {
    return connectionError('CONNECTION_CLOSED', 'This connection is closed', 'not-sent', {
      epoch: e.epoch,
      cause: 'lost'
    })
  }
  if (e.reason === 'disconnected') {
    return connectionError('DISCONNECTED', 'This connection was closed', 'not-sent', { epoch: e.epoch })
  }
  return connectionError('PROVIDER_CHANGED', 'This connection was closed', 'not-sent', {
    epoch: e.epoch,
    cause: e.reason
  })
}

function readTxid(result: unknown): string | undefined {
  const txid = (result as { txid?: unknown } | null | undefined)?.txid
  return typeof txid === 'string' && /^[0-9a-f]{64}$/i.test(txid) ? txid : undefined
}

function defaultNoteChanged(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TaskBackupPush } = require('../monitor/TaskBackupPush') as typeof import('../monitor/TaskBackupPush')
  TaskBackupPush.noteChanged()
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const inFlightByEpoch = new Map<string, number>()
  let inFlightTotal = 0
  let inFlightBytes = 0

  function admit(epoch: string, size: number): (() => void) | ConnectionError {
    const per = inFlightByEpoch.get(epoch) ?? 0
    if (per >= MAX_IN_FLIGHT_PER_BINDING || inFlightTotal >= MAX_IN_FLIGHT_TOTAL) {
      return connectionError('RESOURCE_LIMIT', 'Too many requests in flight', 'not-sent', { epoch })
    }
    if (inFlightBytes + size > MAX_IN_FLIGHT_BYTES) {
      return connectionError('RESOURCE_LIMIT', 'Too many request bytes in flight', 'not-sent', { epoch })
    }
    inFlightByEpoch.set(epoch, per + 1)
    inFlightTotal += 1
    inFlightBytes += size
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (inFlightByEpoch.get(epoch) ?? 1) - 1
      if (n <= 0) inFlightByEpoch.delete(epoch)
      else inFlightByEpoch.set(epoch, n)
      inFlightTotal -= 1
      inFlightBytes -= size
    }
  }

  async function run(transportId: string, req: DispatchRequest): Promise<Outcome> {
    const argLimits = deps.walletArgLimits ?? tierLimits()
    const noteChanged = deps.noteChanged ?? defaultNoteChanged

    // Without a mounted, loaded host nothing below is safe to touch (the registry throws).
    try {
      assertBridgeHost()
    } catch (e) {
      if (isConnectionError(e)) throw refuse(e)
      throw e
    }
    const transport = getTransport(transportId)
    if (!transport) {
      throw refuse(
        connectionError('CONFIGURATION_ERROR', 'Transport is not registered', 'not-sent', { epoch: req.epoch })
      )
    }

    // 1. Transport bounds, re-checked here. Typed arrays are refused under the same code: the
    // spec lists them with the boundary rules, and a JSON transport can never produce one.
    if (typeof req.sizeBytes !== 'number' || !Number.isFinite(req.sizeBytes) || req.sizeBytes < 0) {
      throw refuse(connectionError('PROTOCOL_ERROR', 'Request size missing', 'not-sent', { epoch: req.epoch }))
    }
    if (req.sizeBytes > MAX_BRIDGE_REQUEST_BYTES) {
      throw refuse(connectionError('RESOURCE_LIMIT', 'Request too large', 'not-sent', { epoch: req.epoch }))
    }
    let binary: boolean
    try {
      binary = hasBinaryOrDeep(req.args)
    } catch (e) {
      // A hostile in-process object (a throwing getter) is an invalid argument, not a crash.
      throw invalidArgument(e)
    }
    if (binary) {
      throw refuse(
        connectionError('RESOURCE_LIMIT', 'Byte fields must be number arrays', 'not-sent', { epoch: req.epoch })
      )
    }

    // 2. Binding.
    const resolved = getBindingRegistry().resolve(transportId, {
      epoch: req.epoch,
      instanceId: req.instanceId,
      continuityKey: req.continuityKey,
      origin: req.origin,
      accountContext: req.accountContext
    })
    if (isConnectionError(resolved)) throw refuse(resolved)
    const binding: Binding = resolved

    // 3. Method.
    if (!isBridgeMethod(req.method)) {
      throw refuse(connectionError('PROTOCOL_ERROR', 'Unknown method', 'not-sent', { epoch: binding.epoch }))
    }
    const method: WalletMethodName = req.method
    const info = BRIDGE_METHODS[method]

    // 4. Probes: no gate, no wallet call, no wait. They hold no resource, so the in-flight limits
    // (which exist to bound parked work) do not apply to them.
    if (info.probe) {
      const snap = getBridgeSnapshot()
      if (method === 'isAuthenticated') {
        throw new Early({ ok: true, result: { authenticated: snap.readiness === 'ready' } })
      }
      if (!isValidVersionString(snap.baseVersion)) {
        throw refuse(
          connectionError('CONFIGURATION_ERROR', 'The wallet version string is invalid', 'not-sent', {
            epoch: binding.epoch
          })
        )
      }
      throw new Early({ ok: true, result: { version: snap.baseVersion } })
    }

    const release = admit(binding.epoch, req.sizeBytes)
    if (typeof release !== 'function') throw refuse(release)

    // Everything from here can park, so it watches this binding's close.
    let closed: CloseEvent | undefined
    const waiters = new Set<() => void>()
    let consentRequested = false
    const unsubscribeClose = onBindingClosed(e => {
      if (e.epoch !== binding.epoch) return
      closed = e
      if (consentRequested) deps.consent.dropRequestsFor(e.epoch)
      for (const w of [...waiters]) w()
    })

    /** Resolves with `p`, or rejects with the close outcome if the binding closes first. */
    function untilClosed<T>(p: Promise<T>): Promise<T> {
      if (closed) return Promise.reject(refuse(closedOutcome(closed)))
      return new Promise<T>((resolve, reject) => {
        const onClose = () => reject(refuse(closedOutcome(closed as CloseEvent)))
        waiters.add(onClose)
        p.then(
          v => {
            waiters.delete(onClose)
            resolve(v)
          },
          e => {
            waiters.delete(onClose)
            reject(e)
          }
        )
      })
    }

    function notify(reason: AttentionReason) {
      try {
        transport!.requestAttention(reason, binding)
      } catch (e) {
        console.warn('[bridge] requestAttention failed', e)
      }
    }

    /** Parks until the runtime is `ready`; `none` fails at once. */
    async function ensureReady(): Promise<void> {
      let notified = false
      for (;;) {
        if (closed) throw refuse(closedOutcome(closed))
        const readiness = getBridgeSnapshot().readiness
        if (readiness === 'ready') return
        if (readiness === 'none') {
          throw refuse(
            connectionError('CONFIGURATION_ERROR', 'No wallet is available', 'not-sent', { epoch: binding.epoch })
          )
        }
        if (!notified) {
          notified = true
          notify('wallet-not-ready')
        }
        let off = () => {}
        const changed = new Promise<void>(res => {
          off = onSnapshotChange(() => res())
        })
        try {
          await untilClosed(changed)
        } finally {
          off()
        }
      }
    }

    let started = false
    try {
      // 5. Arguments.
      let args: unknown = req.args ?? {}
      try {
        args = normalizeBRC100WalletByteFields(args)
      } catch (e) {
        throw invalidArgument(e)
      }
      const refusal = checkWalletArgs(method, args, argLimits)
      if (refusal) throw invalidArgument(new WalletArgTooLarge(refusal.field, refusal.message))
      try {
        validateWalletArgs(method as Parameters<typeof validateWalletArgs>[0], args)
      } catch (e) {
        throw invalidArgument(e)
      }
      if (binding.attestation === 'unattested' && findTokenModuleVariant(args) !== undefined) {
        throw permissionDenied('Token modules are not available to unverified origins')
      }
      let requestSnapshot: unknown
      try {
        requestSnapshot = snapshotWalletResultRequest(method as Parameters<typeof snapshotWalletResultRequest>[0], args)
      } catch (e) {
        throw invalidArgument(e)
      }

      // 6. Wallet state, then consent. The store is authenticated by the admin wallet, which
      // exists only when `ready`.
      await ensureReady()
      if (!binding.consented) {
        const record = await untilClosed(deps.consent.lookup(binding.applicationOrigin, binding.attestation))
        if (record !== undefined && binding.attestation === 'browser') {
          getBindingRegistry().markConsented(binding.epoch, record.originator)
        }
        if (!binding.consented) {
          if ((args as { seekPermission?: unknown }).seekPermission === false) {
            throw permissionDenied('Permission denied: this site is not connected')
          }
          const asked = deps.consent.requestConsent({
            origin: binding.applicationOrigin,
            attestation: binding.attestation,
            transportId,
            bindingEpoch: binding.epoch,
            walletRevision: Number(getBridgeSnapshot().walletRevision),
            connectedBefore: record !== undefined
          })
          if ('refused' in asked) {
            throw refuse(
              connectionError(
                'RESOURCE_LIMIT',
                asked.refused === 'backoff' ? 'This site was just declined' : 'A connection request is already open',
                'not-sent',
                { epoch: binding.epoch }
              )
            )
          }
          consentRequested = true
          notify('consent')
          const answer = await untilClosed(asked.promise)
          const approved =
            answer === 'approved'
              ? await untilClosed(deps.consent.lookup(binding.applicationOrigin, binding.attestation))
              : undefined
          if (approved === undefined) {
            throw refuse(
              connectionError('USER_CANCELLED', 'The connection was declined', 'not-sent', { epoch: binding.epoch })
            )
          }
          getBindingRegistry().markConsented(binding.epoch, approved.originator)
        }
      }

      if (req.beforeCall) {
        try {
          await untilClosed(req.beforeCall())
        } catch (e) {
          if (e instanceof Early) throw e
          if (isConnectionError(e)) throw refuse({ ...e, epoch: e.epoch ?? binding.epoch })
          throw e
        }
      }

      // 7 and 8. Readiness again, then the synchronous re-check and the call with no await between.
      let call: Promise<unknown>
      for (;;) {
        await ensureReady()
        const snap = getBridgeSnapshot()
        const published = getPublishedManagers()
        const manager = binding.attestation === 'unattested' ? published.unverified : published.attested
        if (snap.readiness !== 'ready') continue
        let current =
          binding.state === 'live' &&
          String(binding.walletRevision) === snap.walletRevision &&
          binding.accountContext === snap.accountContext &&
          manager !== undefined
        if (current) {
          try {
            assertCanonicalOriginator(binding.originator)
          } catch {
            current = false
          }
        }
        if (!current || manager === undefined) {
          throw refuse(
            connectionError('PROVIDER_CHANGED', 'The wallet changed since this page connected', 'not-sent', {
              epoch: binding.epoch,
              cause: 'account-changed'
            })
          )
        }
        // 9. Call, on the guarded stack read just now, never cached across builds.
        const wallet = capWalletArgs(manager.wallet as WalletInterface, argLimits)
        started = true
        try {
          call = Promise.resolve(
            (wallet as unknown as Record<string, (a: unknown, o?: string) => unknown>)[method](args, binding.originator)
          )
        } catch (e) {
          call = Promise.reject(e)
        }
        break
      }

      // 10. After the call. A mutating call nudges backup on every outcome, errors included.
      if (info.mutating) {
        const note = () => {
          try {
            noteChanged()
          } catch (e) {
            console.warn('[bridge] noteChanged failed', e)
          }
        }
        call.then(note, note)
      }
      let result: unknown
      try {
        result = await new Promise<unknown>((resolve, reject) => {
          if (closed) {
            reject(new Early(closedWhileRunning(closed)))
            return
          }
          const onClose = () => reject(new Early(closedWhileRunning(closed as CloseEvent)))
          waiters.add(onClose)
          call.then(
            v => {
              waiters.delete(onClose)
              resolve(v)
            },
            e => {
              waiters.delete(onClose)
              reject(e)
            }
          )
        })
      } catch (e) {
        if (e instanceof Early) throw e
        if (binding.state === 'closed' && closed) throw new Early(closedWhileRunning(closed))
        throw new Early({
          ok: false,
          walletError: encodeWalletError(e),
          delivery: info.mutating ? 'unknown' : 'not-sent'
        })
      }

      return finishResult(result)

      function finishResult(raw: unknown): Outcome {
        if (method === 'getVersion') {
          const v = (raw as { version?: unknown } | null)?.version
          if (!isValidVersionString(v)) return invalidResult(raw)
          return { ok: true, result: { version: v } }
        }
        try {
          if (stringifyBRC100(raw).length > MAX_BRIDGE_REQUEST_BYTES) {
            return {
              ok: false,
              connectionError: connectionError('RESOURCE_LIMIT', 'Response too large', 'unknown', {
                epoch: binding.epoch
              })
            }
          }
          const validated = validateWalletResult(
            method as Parameters<typeof validateWalletResult>[0],
            raw,
            requestSnapshot
          )
          return { ok: true, result: validated }
        } catch {
          return invalidResult(raw)
        }
      }

      function invalidResult(raw: unknown): Outcome {
        if (info.mutating) {
          return {
            ok: false,
            connectionError: connectionError('PROTOCOL_ERROR', 'The wallet returned an invalid result', 'unknown', {
              epoch: binding.epoch,
              cause: 'invalid-result',
              txid: readTxid(raw)
            })
          }
        }
        return {
          ok: false,
          walletError: encodeWalletError(new Error('The wallet returned an invalid result')),
          delivery: 'not-sent'
        }
      }
    } catch (e) {
      if (e instanceof Early) throw e
      console.warn('[bridge] dispatch failed', e)
      throw refuse(
        connectionError('CONFIGURATION_ERROR', 'The wallet bridge failed', started ? 'unknown' : 'not-sent', {
          epoch: binding.epoch
        })
      )
    } finally {
      unsubscribeClose()
      release()
    }
  }

  function closedWhileRunning(e: CloseEvent): Outcome {
    return {
      ok: false,
      connectionError: connectionError('CONNECTION_CLOSED', 'The connection closed during the call', 'unknown', {
        epoch: e.epoch,
        cause: e.reason
      })
    }
  }

  return {
    async dispatch({ transport, request }) {
      const transportId = typeof transport === 'string' ? transport : transport.id
      try {
        return await run(transportId, request)
      } catch (e) {
        if (e instanceof Early) return e.outcome
        console.warn('[bridge] dispatch failed', e)
        return {
          ok: false,
          connectionError: connectionError('CONFIGURATION_ERROR', 'The wallet bridge failed', 'not-sent', {
            epoch: request?.epoch
          })
        }
      }
    }
  }
}

let installed: Dispatcher | undefined

/** The host's dispatcher, set once the consent store exists. Transports call `dispatch`. */
export function installDispatcher(d: Dispatcher | undefined): void {
  installed = d
}

export function dispatch(input: { transport: string | { id: string }; request: DispatchRequest }): Promise<Outcome> {
  if (!installed) {
    return Promise.resolve({
      ok: false,
      connectionError: connectionError('CONFIGURATION_ERROR', 'The wallet bridge is not available', 'not-sent', {
        epoch: input.request?.epoch
      })
    })
  }
  return installed.dispatch(input)
}
