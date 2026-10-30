/**
 * The transport-independent conformance cases (spec 6.14) run through the loopback router: HTTP framing, outcome
 * mapping and the size caps over a dispatch fake that honours the contract in `conformanceCases.ts`. (The real
 * dispatcher validates arguments and results per method, so it cannot answer `{ echo: method }`; the dispatcher's
 * own behaviour is covered by `dispatcher.test.ts` and, wired to the router, by the kit's controller tests.)
 */
import { WERR_INSUFFICIENT_FUNDS, WERR_INVALID_PARAMETER } from '@bsv/sdk'
import { b64uEncode } from '../../../core/bridge/protocol/base64url'
import { connectionError } from '../../../core/bridge/protocol/connectionError'
import { encodeWalletError } from '../../../core/bridge/protocol/errorCodec'
import { MAX_BRIDGE_REQUEST_BYTES } from '../../../core/bridge/protocol/limits'
import { launchProof } from '../../../core/bridge/loopback/launchProof'
import type { Outcome } from '../../../core/bridge/dispatcher'
import { TRANSPORT_INDEPENDENT_CASES, type CaseContext } from '../../../core/bridge/testing/conformanceCases'
import {
  CHALLENGE,
  EPOCH,
  HELLO_KEY,
  HOST4,
  NONCE,
  ORIGIN,
  done,
  identityHandle,
  makeHarness
} from './helpers/routerHarness'

function throwFor(kind: string): never {
  switch (kind) {
    case 'invalid-parameter':
      throw new WERR_INVALID_PARAMETER('x', 'valid')
    case 'insufficient-funds':
      throw new WERR_INSUFFICIENT_FUNDS(10, 5)
    case 'hmac':
      throw Object.assign(new Error('bad hmac'), { code: 'ERR_INVALID_HMAC' })
    case 'signature':
      throw Object.assign(new Error('bad sig'), { code: 'ERR_INVALID_SIGNATURE' })
    default:
      throw new Error('boom')
  }
}

async function contractDispatch(input: { request: { method: string; args: unknown } }): Promise<Outcome> {
  const { method, args } = input.request
  const a = args as { __fail?: string; __respondBytes?: number }
  try {
    if (a.__fail !== undefined) throwFor(a.__fail)
    if (a.__respondBytes !== undefined) return { ok: true, result: 'x'.repeat(a.__respondBytes) }
    return { ok: true, result: { echo: method } }
  } catch (e) {
    return { ok: false, walletError: encodeWalletError(e), delivery: 'not-sent' }
  }
}

describe('loopback router: transport-independent conformance cases', () => {
  async function context(): Promise<CaseContext> {
    const h = makeHarness({ realRegistry: true })
    await h.ready
    h.state.records = [{ epoch: EPOCH, k: HELLO_KEY, n: NONCE }]
    h.state.snapshot = { accountContext: 'acct-1', walletRevision: '1' }
    h.state.dispatch = contractDispatch as never
    const wallet = { instanceId: identityHandle.instanceId, continuityKey: identityHandle.continuityKey }
    const connect = done(
      await h.handle({
        method: 'POST',
        target: '/.well-known/brc-wallet/connect',
        headers: [
          ['host', HOST4],
          ['origin', ORIGIN],
          ['content-type', 'application/json']
        ],
        body: JSON.stringify({
          epoch: EPOCH,
          challenge: CHALLENGE,
          ...wallet,
          android: {
            launchProof: launchProof(HELLO_KEY, {
              wallet,
              epoch: EPOCH,
              origin: ORIGIN,
              challenge: CHALLENGE,
              host: HOST4,
              nonce: NONCE
            })
          }
        })
      })
    )
    expect(connect.status).toBe(200)
    const secret = b64uEncode(h.state.opened[0].secret)
    return {
      async call(method, args) {
        const plan = await h.handle({
          method: 'POST',
          target: `/brc185/v1/rpc/${method}`,
          headers: [
            ['host', HOST4],
            ['origin', ORIGIN],
            ['content-type', 'application/json'],
            ['brc-185-epoch', EPOCH],
            ['brc-185-instance', wallet.instanceId],
            ['brc-185-key', wallet.continuityKey],
            ['brc-185-android-binding', secret]
          ],
          body: JSON.stringify(args)
        })
        return plan.kind === 'hold' ? plan.settled : done(plan)
      }
    }
  }

  it.each(TRANSPORT_INDEPENDENT_CASES.map(c => [c.id, c] as const))('%s', async (_id, c) => {
    await expect(c.run(await context())).resolves.toBeUndefined()
  })

  it('the over-cap request is refused by the router before dispatch, as a 413 not-sent', async () => {
    const ctx = await context()
    const r = (await ctx.call('listActions', { pad: 'a'.repeat(MAX_BRIDGE_REQUEST_BYTES + 1) })) as {
      status: number
      body: string
    }
    expect(r.status).toBe(413)
    expect(JSON.parse(r.body)).toEqual(
      expect.objectContaining({
        code: 'RESOURCE_LIMIT',
        delivery: 'not-sent',
        domain: connectionError('RESOURCE_LIMIT', '', 'not-sent').domain
      })
    )
  })
})
