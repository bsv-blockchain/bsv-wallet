/**
 * Staging (spec 6.11): turn one page invoke into a sealed record in the App Group queue.
 *
 * - The record id is a UUIDv4 minted here, never the page's invoke id (ids are install-wide create-exclusive,
 *   so a page could otherwise squat a known one). The mapping `(instanceId, epoch, invokeId) -> recordId` is
 *   the unresolved table in `storage.session`; it is written BEFORE the appex is called, so a background that
 *   dies between stage and reply finds the same id on the page's repeat and does not stage a second record.
 *   A resolved call leaves the table, so the mapping lives exactly as long as the call is outstanding.
 * - Over `STAGE_CHUNK_BYTES` the record travels as stageBegin / stageChunk / stageEnd.
 * - When the outcome of `stage` / `stageEnd` is unknown (every attempt timed out), `withdraw` decides: won means
 *   the app never saw it (`CONFIGURATION_ERROR`, `not-sent`), lost means the app has it (keep waiting), and an
 *   unconfirmed withdraw is `CONNECTION_CLOSED`, `unknown` with the id kept to be withdrawn at the next wake.
 *   A failure before `stageEnd` created nothing, so it is `not-sent` without a withdraw.
 */
import { isUuidV4 } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import type { InboxRecord } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/envelopes'
import { INBOX_MAX_VALIDITY_MS, MAX_BRIDGE_REQUEST_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'
import { STAGE_CHUNK_BYTES } from '../../../shared/constants'
import type { AttestedFrame } from './attest'
import { bindingKey, loadBindings, withSessionLock, type EpochBinding } from './bindings'
import { sha256Hex, toBase64, utf8Bytes } from './bytes'
import { configurationError, connectionError, isConnectionError, protocolError, type ConnectionError } from './errors'
import { uuidv4 } from './ids'
import { checkLimits, loadUnresolved, saveUnresolved, type UnresolvedEntry } from './limits'
import type { ExtDeps } from './reconcile'
import { loadWithdrawals, markStaged, reregister, saveWithdrawals } from './tabs'

export type StageOutcome = { kind: 'staged'; recordId: string } | { kind: 'error'; error: ConnectionError }

export interface StageDeps extends ExtDeps {
  /** Overrides the record id generator (tests). */
  newId?: () => string
}

export interface StageArgs {
  frame: AttestedFrame
  binding: EpochBinding
  invokeId: string
  method: string
  params: unknown
}

const fail = (error: ConnectionError): StageOutcome => ({ kind: 'error', error })

/** True when a native failure leaves it open whether the appex executed the op (no reply, not a typed refusal). */
const isAmbiguous = (e: ConnectionError): boolean => e.cause === 'timeout' || e.cause === 'transport'

async function dropEntry(deps: ExtDeps, recordId: string, keepForWithdraw: boolean): Promise<void> {
  await withSessionLock(deps.session, async () => {
    const unresolved = await loadUnresolved(deps.session)
    delete unresolved[recordId]
    await saveUnresolved(deps.session, unresolved)
    if (keepForWithdraw) {
      const ids = await loadWithdrawals(deps.session)
      if (!ids.includes(recordId)) await saveWithdrawals(deps.session, [...ids, recordId])
    }
  })
}

/** Sends the record bytes; `ambiguous` is set once an op whose half-failure could have created the record runs. */
async function send(deps: ExtDeps, id: string, bytes: Uint8Array, mark: () => void): Promise<void> {
  const { native } = deps
  if (bytes.length <= STAGE_CHUNK_BYTES) {
    mark()
    await native.stage(id, toBase64(bytes))
    return
  }
  const parts = Math.ceil(bytes.length / STAGE_CHUNK_BYTES)
  await native.stageBegin(id, parts, bytes.length, sha256Hex(bytes))
  for (let n = 0; n < parts; n++) {
    await native.stageChunk(id, n, toBase64(bytes.subarray(n * STAGE_CHUNK_BYTES, (n + 1) * STAGE_CHUNK_BYTES)))
  }
  mark()
  await native.stageEnd(id)
}

export async function stageInvoke(deps: StageDeps, args: StageArgs): Promise<StageOutcome> {
  const { frame, binding, invokeId, method, params } = args

  // Local checks first: nothing below touches storage or the appex for a call that cannot be sent.
  if (!isUuidV4(invokeId) || typeof method !== 'string' || method === '') {
    return fail(protocolError('The call is malformed'))
  }
  if (frame.origin !== binding.origin || frame.tabId !== binding.tabId || frame.frameId !== binding.frameId) {
    return fail(protocolError('The call does not come from the frame that connected'))
  }
  let requestBytes: number
  try {
    if (params !== undefined && typeof JSON.stringify(params) !== 'string') throw new Error('not JSON')
    const body = JSON.stringify({ method, params })
    requestBytes = utf8Bytes(body).length
  } catch {
    return fail(protocolError('The call arguments cannot be sent'))
  }
  if (requestBytes > MAX_BRIDGE_REQUEST_BYTES) return fail(protocolError('The request is too large'))

  const key = bindingKey(binding.instanceId, binding.epoch)
  const decided = await withSessionLock(
    deps.session,
    async (): Promise<{ entry: UnresolvedEntry } | { error: ConnectionError }> => {
      const held = (await loadBindings(deps.session))[key]
      if (!held) {
        return {
          error: connectionError('CONNECTION_CLOSED', 'The connection is closed', 'not-sent', { epoch: binding.epoch })
        }
      }
      const unresolved = await loadUnresolved(deps.session)
      const existing = Object.values(unresolved).find(
        e => e.instanceId === binding.instanceId && e.epoch === binding.epoch && e.invokeId === invokeId
      )
      if (existing) return { entry: existing } // a repeat of an outstanding call reuses its record id
      const limit = checkLimits(unresolved, binding, requestBytes)
      if (limit) return { error: limit }
      const recordId = deps.newId ? deps.newId() : uuidv4()
      const entry: UnresolvedEntry = {
        recordId,
        instanceId: binding.instanceId,
        epoch: binding.epoch,
        invokeId,
        tabId: binding.tabId,
        size: requestBytes,
        state: 'staging',
        createdAt: deps.now()
      }
      unresolved[recordId] = entry
      await saveUnresolved(deps.session, unresolved)
      return { entry }
    }
  )
  if ('error' in decided) return fail(decided.error)
  const { entry } = decided
  if (entry.state === 'staged') return { kind: 'staged', recordId: entry.recordId }

  // A frame that is calling again is alive: it is not closing.
  await reregister(deps, key)

  // The same bytes on every attempt and every re-stage (createdAt is stored), so the digest never changes.
  const record: InboxRecord = {
    v: 1,
    id: entry.recordId,
    kind: 'invoke',
    epoch: binding.epoch,
    instanceId: binding.instanceId,
    continuityKey: binding.continuityKey,
    origin: binding.origin,
    accountContext: binding.accountContext,
    walletRevision: binding.walletRevision,
    boundAt: binding.boundAt,
    method,
    ...(params === undefined ? {} : { args: params }),
    createdAt: entry.createdAt,
    notAfter: entry.createdAt + INBOX_MAX_VALIDITY_MS
  }
  const bytes = utf8Bytes(JSON.stringify(record))

  let ambiguous = false
  try {
    await send(deps, entry.recordId, bytes, () => (ambiguous = true))
  } catch (e) {
    const error = isConnectionError(e) ? e : configurationError('The wallet app could not be reached')
    if (!ambiguous || !isAmbiguous(error)) {
      // Another digest under this id means a record of the same id exists already: it is not ours to drop.
      if (error.cause !== 'EXISTS_DIFFERENT') await dropEntry(deps, entry.recordId, false)
      return fail(error)
    }
    try {
      const { won } = await deps.native.withdraw(entry.recordId)
      if (!won) return await markStagedOutcome(deps, entry, binding)
      await dropEntry(deps, entry.recordId, false)
      return fail(configurationError('The wallet app could not be reached', error.cause))
    } catch {
      await dropEntry(deps, entry.recordId, true)
      return fail(
        connectionError('CONNECTION_CLOSED', 'It is not known whether the wallet app received the call', 'unknown', {
          epoch: binding.epoch
        })
      )
    }
  }
  return markStagedOutcome(deps, entry, binding)
}

async function markStagedOutcome(deps: ExtDeps, entry: UnresolvedEntry, binding: EpochBinding): Promise<StageOutcome> {
  await withSessionLock(deps.session, async () => {
    const unresolved = await loadUnresolved(deps.session)
    const current = unresolved[entry.recordId]
    if (current) {
      current.state = 'staged'
      await saveUnresolved(deps.session, unresolved)
    }
  })
  await markStaged(deps.session, binding.instanceId, binding.epoch)
  return { kind: 'staged', recordId: entry.recordId }
}

/**
 * At a wake: withdraw the records whose earlier withdrawal could not be confirmed. Won or lost, the id has
 * done its job (lost means the app has the record and it runs as the earlier call asked).
 */
export async function retryWithdrawals(deps: ExtDeps): Promise<void> {
  const ids = await loadWithdrawals(deps.session)
  if (ids.length === 0) return
  const left: string[] = []
  for (const id of ids) {
    try {
      await deps.native.withdraw(id)
    } catch {
      left.push(id)
    }
  }
  await withSessionLock(deps.session, () => saveWithdrawals(deps.session, left))
}
