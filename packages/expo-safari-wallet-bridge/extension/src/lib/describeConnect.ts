/**
 * BRC-185 describe and connect on the window handle (spec 6.9). Describe is noninteractive and needs no
 * wallet; connect stamps an epoch binding from the mirror and returns no proof (spec 6.8 (a)).
 */
import { b64uDecode } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/base64url'
import {
  signDescribe,
  validateDescriptor,
  type DescribeResponse,
  type Descriptor
} from '@bsv/expo-wallet-toolbox/core/bridge/protocol/descriptor'
import { CHALLENGE_BYTES, MAX_PROOF_RESPONSE_BYTES } from '@bsv/expo-wallet-toolbox/core/bridge/protocol/limits'
import { Utils } from '@bsv/sdk'
import { TRANSPORT_ID } from '../../../shared/constants'
import type { AttestedFrame } from './attest'
import {
  bindingKey,
  checkBindingCaps,
  loadBindings,
  saveBindings,
  withSessionLock,
  type EpochBinding
} from './bindings'
import { asConnectionError, configurationError, protocolError } from './errors'
import { isUuidV4 } from './ids'
import { reconcile, type ExtDeps } from './reconcile'

const utf8Length = (s: string): number => new TextEncoder().encode(s).length

/** The page-supplied origin must equal the attested frame origin (P1's frame rule). */
function frameRule(frame: AttestedFrame, origin: unknown): void {
  if (typeof origin !== 'string' || origin !== frame.origin) {
    throw protocolError('The origin does not match the frame that sent the call')
  }
}

function bridgeName(deps: ExtDeps): { name: string; vendor: string } {
  return {
    name: deps.name ?? (typeof BRIDGE_NAME === 'string' ? BRIDGE_NAME : ''),
    vendor: deps.vendor ?? (typeof BRIDGE_VENDOR === 'string' ? BRIDGE_VENDOR : '')
  }
}

/** A describe response over the cap is refused, never truncated. */
export function assertDescribeSize(resp: DescribeResponse, max = MAX_PROOF_RESPONSE_BYTES): void {
  if (utf8Length(JSON.stringify(resp)) > max) {
    throw configurationError('The provider description is too large')
  }
}

export async function describe(
  deps: ExtDeps,
  args: { frame: AttestedFrame; origin: string; challenge: string }
): Promise<DescribeResponse> {
  const { frame, origin, challenge } = args
  frameRule(frame, origin)
  try {
    if (typeof challenge !== 'string' || b64uDecode(challenge).length !== CHALLENGE_BYTES) throw new Error('length')
  } catch {
    throw protocolError('The challenge must be 32 bytes of canonical base64url')
  }

  const id = await deps.native.identity(frame.context) // a missing key rejects CONFIGURATION_ERROR / not-sent
  const { name, vendor } = bridgeName(deps)
  const descriptor: Descriptor = {
    version: 1,
    instanceId: id.instanceId,
    name,
    instanceLabel: '',
    vendor,
    continuityKey: id.continuityKey,
    endpoints: [{ id: 'window', type: 'window', address: TRANSPORT_ID }]
  }
  try {
    validateDescriptor(descriptor)
  } catch (e) {
    throw configurationError(`The provider description is invalid: ${(e as Error).message}`)
  }

  const response = await signDescribe(
    {
      sign: async preimage => {
        const r = await deps.native.sign(frame.context, Utils.toBase64(Array.from(preimage)))
        return b64uDecode(r.signature)
      }
    },
    { origin, challenge, descriptor }
  ).catch(e => {
    throw asConnectionError(e, () => configurationError('The provider description could not be signed'))
  })
  assertDescribeSize(response)
  return response
}

export async function connect(
  deps: ExtDeps,
  args: { frame: AttestedFrame; origin: string; epoch: string }
): Promise<void> {
  const { frame, origin, epoch } = args
  frameRule(frame, origin)
  if (!isUuidV4(epoch)) throw protocolError('The epoch must be a lowercase UUIDv4')

  const state = await reconcile(deps)
  const mirror = state.mirror
  // Absent, none, or written while building (no account context): the wallet cannot take a connection.
  if (state.kind !== 'present' || !mirror || !mirror.snapshot.accountContext) {
    throw configurationError('The wallet is not ready for a connection')
  }

  const id = await deps.native.identity(frame.context)
  await withSessionLock(deps.session, async () => {
    const bindings = await loadBindings(deps.session)
    const key = bindingKey(id.instanceId, epoch)
    const existing = bindings[key]
    if (existing) {
      if (existing.tabId !== frame.tabId || existing.frameId !== frame.frameId || existing.origin !== origin) {
        throw protocolError('The epoch is already in use')
      }
      return // the same frame asking again: idempotent
    }
    const capped = checkBindingCaps(bindings, origin)
    if (capped) throw capped
    const binding: EpochBinding = {
      instanceId: id.instanceId,
      epoch,
      tabId: frame.tabId,
      frameId: frame.frameId,
      origin,
      continuityKey: id.continuityKey,
      accountContext: mirror.snapshot.accountContext,
      walletRevision: mirror.snapshot.walletRevision,
      boundAt: deps.now()
    }
    bindings[key] = binding
    await saveBindings(deps.session, bindings)
  })
}
