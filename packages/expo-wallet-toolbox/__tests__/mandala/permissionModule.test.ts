/**
 * MandalaTokenModule — the WalletPermissionsManager P-module for the
 * `'p mandala'` basket (spec offline-settlement-final.md §8.3, §8.6).
 *
 * Pins the invariants the spec calls out explicitly:
 *  - the admin originator gets zero prompts, for every method;
 *  - a foreign originator is prompted, at most once per 60s session window
 *    for the access methods, and denial throws;
 *  - amounts are decoded per-output via MandalaToken.decode, summing send vs
 *    change by whether the output carries the basket, and a script that
 *    fails to decode is skipped rather than thrown on.
 */
import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-mobile'
import {
  MandalaTokenModule,
  wrapCreateActionForTokenInputs,
  listAllOutpoints,
  resolveMandalaOutput
} from '../../core/mandala/permissionModule'
import { MANDALA_BASKET } from '../../core/mandala/types'
import { guardVaultAccess } from '../../core/services/vault/guard'

const ADMIN_ORIGINATOR = 'admin.example.com'
const FOREIGN_ORIGINATOR = 'foreign-app.example.com'
const ASSET_ID = 'a'.repeat(64) + '.0'
const ASSET_ID_2 = 'b'.repeat(64) + '.0'
const PKH = new Array(20).fill(7)
const TOKEN_OUTPOINT = 'c'.repeat(64) + '.0'

const mandalaTemplate = new MandalaToken()

/** A real, decodable Mandala token locking script for `amount` of ASSET_ID (or `assetId` if given). */
function mandalaScriptHex(amount: number, assetId: string = ASSET_ID): string {
  return mandalaTemplate.lock(assetId, amount, PKH).toHex()
}

/** A script that is not a Mandala token at all: OP_FALSE OP_RETURN <'hi'>. */
const NOT_MANDALA_SCRIPT_HEX = '006a026869'

/** A real AtomicBEEF wrapping a single-output, zero-input transaction. */
function atomicBeefOf(outputs: { satoshis: number; scriptHex: string }[]): number[] {
  const tx = new Transaction()
  for (const o of outputs) {
    tx.addOutput({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.scriptHex) })
  }
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return beef.toBinaryAtomic(tx.id('hex'))
}

function makeModule(overrides?: {
  requestTokenAccess?: jest.Mock
  resolveAssetMetadata?: jest.Mock
  listTokenOutpoints?: jest.Mock
  resolveMandalaOutput?: jest.Mock
}) {
  const requestTokenAccess = overrides?.requestTokenAccess ?? jest.fn().mockResolvedValue(true)
  const resolveAssetMetadata = overrides?.resolveAssetMetadata ?? jest.fn().mockResolvedValue(null)
  const listTokenOutpoints = overrides?.listTokenOutpoints ?? jest.fn().mockResolvedValue(new Set<string>())
  // XR-041: a resolvable default so every existing relinquishOutput test —
  // none of which care about the resolved identity — keeps passing; tests
  // that DO care override it (including to `null`/a throw, to prove the
  // fail-closed path).
  const resolveMandalaOutput =
    overrides?.resolveMandalaOutput ?? jest.fn().mockResolvedValue({ assetId: ASSET_ID, amount: 500 })
  const mod = new MandalaTokenModule({
    adminOriginator: ADMIN_ORIGINATOR,
    requestTokenAccess,
    resolveAssetMetadata,
    listTokenOutpoints,
    resolveMandalaOutput
  })
  return { mod, requestTokenAccess, resolveAssetMetadata, listTokenOutpoints, resolveMandalaOutput }
}

describe('MandalaTokenModule', () => {
  describe('admin pass-through', () => {
    const cases: Array<[string, object]> = [
      ['listOutputs', { basket: MANDALA_BASKET }],
      ['relinquishOutput', { basket: MANDALA_BASKET, output: 'b'.repeat(64) + '.0' }],
      ['createAction', { outputs: [{ lockingScript: mandalaScriptHex(100) }] }],
      [
        'internalizeAction',
        {
          tx: atomicBeefOf([{ satoshis: 1, scriptHex: mandalaScriptHex(50) }]),
          outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: MANDALA_BASKET } }]
        }
      ]
    ]

    it.each(cases)('%s passes through unchanged with zero prompts for the admin originator', async (method, args) => {
      const { mod, requestTokenAccess } = makeModule()
      const result = await mod.onRequest({ method, args, originator: ADMIN_ORIGINATOR })
      expect(result).toEqual({ args })
      expect(requestTokenAccess).not.toHaveBeenCalled()
    })

    it('onResponse passes through unchanged', async () => {
      const { mod } = makeModule()
      const res = { some: 'result' }
      await expect(mod.onResponse(res, { method: 'createAction', originator: ADMIN_ORIGINATOR })).resolves.toBe(res)
    })
  })

  describe('foreign originator — access prompts (listOutputs / listActions)', () => {
    it('prompts once for listOutputs, then reuses the session for a second call within the window', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      expect(requestTokenAccess).toHaveBeenCalledTimes(1)
    })

    it('listActions shares the same session window as listOutputs (adversarial-review finding 3)', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      await mod.onRequest({ method: 'listActions', args: { labels: ['p mandala x'] }, originator: FOREIGN_ORIGINATOR })
      expect(requestTokenAccess).toHaveBeenCalledTimes(1)
    })

    it('listActions prompts and denial throws, with the mandala_access message shape', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({ method: 'listActions', args: { labels: ['p mandala x'] }, originator: FOREIGN_ORIGINATOR })
      expect(requestTokenAccess).toHaveBeenCalledTimes(1)
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData).toEqual({ type: 'mandala_access', action: 'listActions' })
    })

    it('a different originator gets its own prompt (session is keyed per-originator)', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      await mod.onRequest({
        method: 'listOutputs',
        args: { basket: MANDALA_BASKET },
        originator: 'other-app.example.com'
      })
      expect(requestTokenAccess).toHaveBeenCalledTimes(2)
    })

    it('denial throws', async () => {
      const { mod } = makeModule({ requestTokenAccess: jest.fn().mockResolvedValue(false) })
      await expect(
        mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      ).rejects.toThrow('User denied permission to access Mandala tokens')
    })

    it('a denied access prompt grants no session — the very next call prompts again', async () => {
      const requestTokenAccess = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      const { mod } = makeModule({ requestTokenAccess })
      await expect(
        mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      ).rejects.toThrow()
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      expect(requestTokenAccess).toHaveBeenCalledTimes(2)
    })
  })

  describe('foreign originator — listOutputs redaction (adversarial-review finding 1, critical)', () => {
    it('forces includeCustomInstructions off even when the caller asked for it', async () => {
      const { mod } = makeModule()
      const result = await mod.onRequest({
        method: 'listOutputs',
        args: { basket: MANDALA_BASKET, includeCustomInstructions: true },
        originator: FOREIGN_ORIGINATOR
      })
      expect((result.args as { includeCustomInstructions?: boolean }).includeCustomInstructions).toBe(false)
    })

    it('still forces it off when the caller did not ask for it at all (default-false stays false)', async () => {
      const { mod } = makeModule()
      const result = await mod.onRequest({
        method: 'listOutputs',
        args: { basket: MANDALA_BASKET },
        originator: FOREIGN_ORIGINATOR
      })
      expect((result.args as { includeCustomInstructions?: boolean }).includeCustomInstructions).toBe(false)
    })

    it('preserves every other field on the args unchanged', async () => {
      const { mod } = makeModule()
      const result = await mod.onRequest({
        method: 'listOutputs',
        args: { basket: MANDALA_BASKET, includeCustomInstructions: true, limit: 50, includeTags: true },
        originator: FOREIGN_ORIGINATOR
      })
      expect(result.args).toEqual({
        basket: MANDALA_BASKET,
        includeCustomInstructions: false,
        limit: 50,
        includeTags: true
      })
    })

    it('the admin originator is NOT redacted — includeCustomInstructions passes through exactly as asked', async () => {
      const { mod, requestTokenAccess } = makeModule()
      const result = await mod.onRequest({
        method: 'listOutputs',
        args: { basket: MANDALA_BASKET, includeCustomInstructions: true },
        originator: ADMIN_ORIGINATOR
      })
      expect(result).toEqual({ args: { basket: MANDALA_BASKET, includeCustomInstructions: true } })
      expect(requestTokenAccess).not.toHaveBeenCalled()
    })
  })

  describe('foreign originator — relinquishOutput is its own authorization class (adversarial-review finding 5, low)', () => {
    it('always prompts, even when the originator already holds a listOutputs session', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      await mod.onRequest({
        method: 'relinquishOutput',
        args: { basket: MANDALA_BASKET, output: 'c'.repeat(64) + '.0' },
        originator: FOREIGN_ORIGINATOR
      })
      expect(requestTokenAccess).toHaveBeenCalledTimes(2)
    })

    it('always prompts, even when the originator already holds a createAction spend session', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({
        method: 'createAction',
        args: { outputs: [{ lockingScript: mandalaScriptHex(100) }] },
        originator: FOREIGN_ORIGINATOR
      })
      await mod.onRequest({
        method: 'relinquishOutput',
        args: { basket: MANDALA_BASKET, output: 'c'.repeat(64) + '.0' },
        originator: FOREIGN_ORIGINATOR
      })
      expect(requestTokenAccess).toHaveBeenCalledTimes(2)
    })

    it('two relinquishOutput calls back to back each prompt independently', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({
        method: 'relinquishOutput',
        args: { basket: MANDALA_BASKET, output: 'c'.repeat(64) + '.0' },
        originator: FOREIGN_ORIGINATOR
      })
      await mod.onRequest({
        method: 'relinquishOutput',
        args: { basket: MANDALA_BASKET, output: 'd'.repeat(64) + '.0' },
        originator: FOREIGN_ORIGINATOR
      })
      expect(requestTokenAccess).toHaveBeenCalledTimes(2)
    })

    it('approving relinquishOutput does not grant a session a later listOutputs call can use', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({
        method: 'relinquishOutput',
        args: { basket: MANDALA_BASKET, output: 'c'.repeat(64) + '.0' },
        originator: FOREIGN_ORIGINATOR
      })
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      expect(requestTokenAccess).toHaveBeenCalledTimes(2)
    })

    it('denial throws the same message as the other access prompts', async () => {
      const { mod } = makeModule({ requestTokenAccess: jest.fn().mockResolvedValue(false) })
      await expect(
        mod.onRequest({
          method: 'relinquishOutput',
          args: { basket: MANDALA_BASKET, output: 'c'.repeat(64) + '.0' },
          originator: FOREIGN_ORIGINATOR
        })
      ).rejects.toThrow('User denied permission to access Mandala tokens')
    })

    // XR-041: the finding's core defect — the prompt used to carry only
    // `{type:'mandala_access', action:'relinquishOutput'}`, no matter which
    // holding was being removed. It must now identify the target.
    it('XR-041: resolves the target output and includes its assetId/amount/outpoint in the prompt message', async () => {
      const outpoint = 'c'.repeat(64) + '.0'
      const { mod, requestTokenAccess, resolveMandalaOutput } = makeModule({
        resolveMandalaOutput: jest.fn().mockResolvedValue({ assetId: ASSET_ID, amount: 500 })
      })
      await mod.onRequest({
        method: 'relinquishOutput',
        args: { basket: MANDALA_BASKET, output: outpoint },
        originator: FOREIGN_ORIGINATOR
      })
      expect(resolveMandalaOutput).toHaveBeenCalledWith(outpoint)
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData).toMatchObject({
        type: 'mandala_access',
        action: 'relinquishOutput',
        assetId: ASSET_ID,
        amount: 500,
        outpoint
      })
      // Not just the bare 2-field object the finding describes.
      expect(Object.keys(promptData).length).toBeGreaterThan(2)
    })

    // XR-041's fail-closed requirement: an unresolved target must never fall
    // back to the old, generic, target-free copy.
    it('XR-041: fails closed — an unresolvable output refuses the call rather than falling back to generic copy', async () => {
      const { mod, requestTokenAccess } = makeModule({
        resolveMandalaOutput: jest.fn().mockResolvedValue(null)
      })
      await expect(
        mod.onRequest({
          method: 'relinquishOutput',
          args: { basket: MANDALA_BASKET, output: 'c'.repeat(64) + '.0' },
          originator: FOREIGN_ORIGINATOR
        })
      ).rejects.toThrow('Could not identify the Mandala holding to be removed')
      expect(requestTokenAccess).not.toHaveBeenCalled()
    })

    it('XR-041: fails closed when resolveMandalaOutput itself throws', async () => {
      const { mod, requestTokenAccess } = makeModule({
        resolveMandalaOutput: jest.fn().mockRejectedValue(new Error('storage unavailable'))
      })
      await expect(
        mod.onRequest({
          method: 'relinquishOutput',
          args: { basket: MANDALA_BASKET, output: 'c'.repeat(64) + '.0' },
          originator: FOREIGN_ORIGINATOR
        })
      ).rejects.toThrow('Could not identify the Mandala holding to be removed')
      expect(requestTokenAccess).not.toHaveBeenCalled()
    })

    it('XR-041: fails closed when the call carries no output at all', async () => {
      const { mod, requestTokenAccess, resolveMandalaOutput } = makeModule()
      await expect(
        mod.onRequest({
          method: 'relinquishOutput',
          args: { basket: MANDALA_BASKET },
          originator: FOREIGN_ORIGINATOR
        })
      ).rejects.toThrow('Could not identify the Mandala holding to be removed')
      expect(resolveMandalaOutput).not.toHaveBeenCalled()
      expect(requestTokenAccess).not.toHaveBeenCalled()
    })
  })

  describe('foreign originator — createAction spend/credit amounts', () => {
    it('sums send vs change over mixed basketed/non-basketed outputs, skipping a non-decodable one', async () => {
      const { mod, requestTokenAccess } = makeModule()
      const args = {
        outputs: [
          { lockingScript: mandalaScriptHex(700) }, // recipient output — unbasketed — counts as send
          { lockingScript: mandalaScriptHex(300), basket: MANDALA_BASKET }, // change — counts as change
          { lockingScript: NOT_MANDALA_SCRIPT_HEX } // fails to decode — must be skipped, not thrown on
        ]
      }

      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })

      expect(requestTokenAccess).toHaveBeenCalledTimes(1)
      const [, message] = requestTokenAccess.mock.calls[0]
      const promptData = JSON.parse(message)
      expect(promptData.type).toBe('mandala_spend')
      expect(promptData.sendAmount).toBe(700)
      expect(promptData.changeAmount).toBe(300)
      expect(promptData.assetId).toBe(ASSET_ID)
    })

    it('falls back to a generic prompt (never throws) when every output fails to decode', async () => {
      const { mod, requestTokenAccess } = makeModule()
      const args = { outputs: [{ lockingScript: NOT_MANDALA_SCRIPT_HEX }] }

      await expect(mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })).resolves.toEqual({
        args
      })
      expect(requestTokenAccess).toHaveBeenCalledTimes(1)
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_generic')
    })

    it('falls back to a generic prompt when there are no outputs at all', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({ method: 'createAction', args: {}, originator: FOREIGN_ORIGINATOR })
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_generic')
    })

    it('denial throws the BTMS-mirrored message', async () => {
      const { mod } = makeModule({ requestTokenAccess: jest.fn().mockResolvedValue(false) })
      const args = { outputs: [{ lockingScript: mandalaScriptHex(100) }] }
      await expect(mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })).rejects.toThrow(
        'User denied permission to spend tokens'
      )
    })

    it('always prompts even when the originator already holds a listOutputs session', async () => {
      const { mod, requestTokenAccess } = makeModule()
      await mod.onRequest({ method: 'listOutputs', args: { basket: MANDALA_BASKET }, originator: FOREIGN_ORIGINATOR })
      await mod.onRequest({
        method: 'createAction',
        args: { outputs: [{ lockingScript: mandalaScriptHex(100) }] },
        originator: FOREIGN_ORIGINATOR
      })
      expect(requestTokenAccess).toHaveBeenCalledTimes(2)
    })

    it('looks up token metadata for the display name and tolerates a throwing resolver', async () => {
      const resolveAssetMetadata = jest.fn().mockRejectedValue(new Error('registry unreachable'))
      const { mod, requestTokenAccess } = makeModule({ resolveAssetMetadata })
      const args = { outputs: [{ lockingScript: mandalaScriptHex(50) }] }
      await expect(mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })).resolves.toEqual({
        args
      })
      expect(resolveAssetMetadata).toHaveBeenCalledWith(ASSET_ID)
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.tokenName).toBeUndefined()
    })
  })

  describe('foreign originator — prompt amounts, grouped by asset and decimal-formatted (adversarial-review finding 4, medium)', () => {
    it('formats a single asset as "25.00 USDX" when decimals resolve, in both the display and the back-compat top-level fields', async () => {
      const resolveAssetMetadata = jest.fn().mockResolvedValue({ ticker: 'USDX', decimals: 2 })
      const { mod, requestTokenAccess } = makeModule({ resolveAssetMetadata })
      const args = { outputs: [{ lockingScript: mandalaScriptHex(2500) }] }

      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })

      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.tokenName).toBe('USDX')
      expect(promptData.lines).toHaveLength(1)
      expect(promptData.lines[0]).toMatchObject({
        assetId: ASSET_ID,
        sendAmount: 2500,
        changeAmount: 0,
        tokenName: 'USDX',
        decimals: 2,
        display: '25.00 USDX'
      })
    })

    it('falls back to base units + a short assetId form when decimals cannot be resolved', async () => {
      const { mod, requestTokenAccess } = makeModule() // default resolveAssetMetadata -> null
      const args = { outputs: [{ lockingScript: mandalaScriptHex(2500) }] }

      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })

      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.lines[0].decimals).toBeUndefined()
      expect(promptData.lines[0].display).toBe(`2500 ${ASSET_ID.slice(0, 8)}…${ASSET_ID.slice(-6)}`)
      expect(promptData.lines[0].display).not.toMatch(/USDX/)
    })

    it('groups a multi-asset spend into one line per asset, each independently resolved', async () => {
      const resolveAssetMetadata = jest.fn().mockImplementation(async (assetId: string) => {
        if (assetId === ASSET_ID) return { ticker: 'USDX', decimals: 2 }
        if (assetId === ASSET_ID_2) return { ticker: 'EURX', decimals: 4 }
        return null
      })
      const { mod, requestTokenAccess } = makeModule({ resolveAssetMetadata })
      const args = {
        outputs: [
          { lockingScript: mandalaScriptHex(2500, ASSET_ID) },
          { lockingScript: mandalaScriptHex(100, ASSET_ID), basket: MANDALA_BASKET },
          { lockingScript: mandalaScriptHex(1234500, ASSET_ID_2) }
        ]
      }

      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })

      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.lines).toHaveLength(2)
      expect(promptData.lines[0]).toMatchObject({
        assetId: ASSET_ID,
        sendAmount: 2500,
        changeAmount: 100,
        display: '25.00 USDX'
      })
      expect(promptData.lines[1]).toMatchObject({
        assetId: ASSET_ID_2,
        sendAmount: 1234500,
        changeAmount: 0,
        display: '123.4500 EURX'
      })
      // Back-compat top-level fields mirror only the FIRST asset.
      expect(promptData.assetId).toBe(ASSET_ID)
      expect(promptData.sendAmount).toBe(2500)
    })
  })

  describe('foreign originator — createAction gates on INPUTS too (adversarial-review finding 2, medium/high)', () => {
    it('a full-balance spend (no change output) still produces an amount-accurate mandala_spend prompt once routed', async () => {
      // The recipient output alone (no basket -> full-balance send, no
      // change) is enough for the existing output-side extraction to work;
      // this pins that reaching onRequest at all (the routing gap the
      // wrapper closes, tested separately below) is the only real gap here.
      const { mod, requestTokenAccess } = makeModule({
        listTokenOutpoints: jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      })
      const args = {
        inputs: [{ outpoint: TOKEN_OUTPOINT }],
        outputs: [{ lockingScript: mandalaScriptHex(1000) }]
      }
      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_spend')
      expect(promptData.sendAmount).toBe(1000)
    })

    it('an input spending a known token coin still prompts (mandala_spend, not the generic fallback) even when no output decodes', async () => {
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      const { mod, requestTokenAccess } = makeModule({ listTokenOutpoints })
      const args = {
        inputs: [{ outpoint: TOKEN_OUTPOINT }],
        outputs: [{ lockingScript: NOT_MANDALA_SCRIPT_HEX }]
      }
      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })
      expect(listTokenOutpoints).toHaveBeenCalled()
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_spend')
      expect(promptData.lines).toEqual([])
    })

    it('an input NOT in listTokenOutpoints, with no decodable output, still falls back to the generic prompt', async () => {
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set(['unrelated-outpoint.0']))
      const { mod, requestTokenAccess } = makeModule({ listTokenOutpoints })
      const args = {
        inputs: [{ outpoint: TOKEN_OUTPOINT }],
        outputs: [{ lockingScript: NOT_MANDALA_SCRIPT_HEX }]
      }
      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_generic')
    })

    it('a listTokenOutpoints fault never blocks the call — falls back to the generic prompt rather than throwing', async () => {
      const listTokenOutpoints = jest.fn().mockRejectedValue(new Error('storage unavailable'))
      const { mod, requestTokenAccess } = makeModule({ listTokenOutpoints })
      const args = {
        inputs: [{ outpoint: TOKEN_OUTPOINT }],
        outputs: [{ lockingScript: NOT_MANDALA_SCRIPT_HEX }]
      }
      await expect(mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })).resolves.toEqual({
        args
      })
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_generic')
    })

    it('no inputs at all never calls listTokenOutpoints (cheap path, unchanged from before)', async () => {
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set())
      const { mod, requestTokenAccess } = makeModule({ listTokenOutpoints })
      const args = { outputs: [{ lockingScript: NOT_MANDALA_SCRIPT_HEX }] }
      await mod.onRequest({ method: 'createAction', args, originator: FOREIGN_ORIGINATOR })
      expect(listTokenOutpoints).not.toHaveBeenCalled()
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_generic')
    })
  })

  describe('wrapCreateActionForTokenInputs (adversarial-review finding 2 — the manager-routing gap)', () => {
    function makeFakeManager() {
      const createAction = jest.fn().mockResolvedValue({ ok: true })
      const otherMethod = jest.fn().mockReturnValue('other-result')
      const manager = { createAction, otherMethod, someProp: 42 }
      return { manager, createAction, otherMethod }
    }

    it('injects MANDALA_ACTION_LABEL and forwards to createAction when an input matches a known token outpoint', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints)

      const args = { description: 'x', inputs: [{ outpoint: TOKEN_OUTPOINT }], outputs: [] }
      await wrapped.createAction(args, FOREIGN_ORIGINATOR)

      expect(createAction).toHaveBeenCalledTimes(1)
      const [calledArgs, calledOriginator] = createAction.mock.calls[0]
      expect(calledOriginator).toBe(FOREIGN_ORIGINATOR)
      expect(calledArgs.labels).toEqual(['p mandala token-spend'])
      // The original args object passed in is left untouched (a fresh object is forwarded).
      expect(args.inputs === calledArgs.inputs).toBe(true)
    })

    it('does not inject the label, or call listTokenOutpoints, when there are no inputs', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints)

      const args = { description: 'x', outputs: [] }
      await wrapped.createAction(args, FOREIGN_ORIGINATOR)

      expect(listTokenOutpoints).not.toHaveBeenCalled()
      expect(createAction).toHaveBeenCalledWith(args, FOREIGN_ORIGINATOR)
    })

    it('does not inject the label when no input matches a known token outpoint', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set(['unrelated.0']))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints)

      const args = { description: 'x', inputs: [{ outpoint: TOKEN_OUTPOINT }], outputs: [] }
      await wrapped.createAction(args, FOREIGN_ORIGINATOR)

      expect(createAction.mock.calls[0][0].labels).toBeUndefined()
    })

    it('does not add a duplicate label when the caller already included it', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints)

      const args = {
        description: 'x',
        inputs: [{ outpoint: TOKEN_OUTPOINT }],
        outputs: [],
        labels: ['p mandala token-spend']
      }
      await wrapped.createAction(args, FOREIGN_ORIGINATOR)

      expect(createAction.mock.calls[0][0].labels).toEqual(['p mandala token-spend'])
    })

    // XR-039: a listing fault can no longer forward the caller's args
    // unchanged — that silently drops the ONLY signal that routes an
    // input-only Mandala spend to MandalaTokenModule's own review, into the
    // manager's generic, no-token-amount-awareness review instead. With no
    // reliable read on the inputs, the wrapper fails closed and forces the
    // label so the call is still routed to a real review.
    it('XR-039: a listTokenOutpoints fault fails closed — forces the label rather than forwarding args unchanged', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockRejectedValue(new Error('storage unavailable'))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints)

      const args = { description: 'x', inputs: [{ outpoint: TOKEN_OUTPOINT }], outputs: [] }
      await expect(wrapped.createAction(args, FOREIGN_ORIGINATOR)).resolves.toEqual({ ok: true })
      expect(createAction.mock.calls[0][0].labels).toEqual(['p mandala token-spend'])
      // The original args object passed in is left untouched (a fresh object is forwarded).
      expect(args.inputs === createAction.mock.calls[0][0].inputs).toBe(true)
    })

    // A fault must not force the round trip (or the label) for a call the
    // wrapper already knows is unambiguous — a plain admin action with no
    // inputs at all never needed classifying in the first place.
    it('does not call listTokenOutpoints, or inject the label, on a fault when there are no inputs', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockRejectedValue(new Error('storage unavailable'))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints)

      const args = { description: 'x', outputs: [] }
      await wrapped.createAction(args, FOREIGN_ORIGINATOR)

      expect(listTokenOutpoints).not.toHaveBeenCalled()
      expect(createAction).toHaveBeenCalledWith(args, FOREIGN_ORIGINATOR)
    })

    // XR-039: an alternate spelling of the SAME outpoint ("00" for vout 0)
    // must still match — a spend of a real token input must not slip past the
    // Set membership check on formatting alone.
    it('matches an alternate spelling of the same outpoint ("00" vs "0")', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints)

      const args = { description: 'x', inputs: [{ outpoint: 'c'.repeat(64) + '.00' }], outputs: [] }
      await wrapped.createAction(args, FOREIGN_ORIGINATOR)

      expect(createAction.mock.calls[0][0].labels).toEqual(['p mandala token-spend'])
    })

    it('every other method/property passes through untouched', async () => {
      const { manager, otherMethod } = makeFakeManager()
      const wrapped = wrapCreateActionForTokenInputs(manager, jest.fn())
      expect(wrapped.someProp).toBe(42)
      expect(wrapped.otherMethod('a')).toBe('other-result')
      expect(otherMethod).toHaveBeenCalledWith('a')
    })

    it('short-circuits for the admin originator: no listTokenOutpoints call, no label, args untouched', async () => {
      const { manager, createAction } = makeFakeManager()
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      const wrapped = wrapCreateActionForTokenInputs(manager, listTokenOutpoints, ADMIN_ORIGINATOR)

      const args = { description: 'x', inputs: [{ outpoint: TOKEN_OUTPOINT }], outputs: [] }
      await wrapped.createAction(args, ADMIN_ORIGINATOR)

      expect(listTokenOutpoints).not.toHaveBeenCalled()
      expect(createAction).toHaveBeenCalledWith(args, ADMIN_ORIGINATOR)
    })

    it('composes safely with guardVaultAccess when wrapped INSIDE it (the required wiring order) — re-applying guardVaultAccess still dedups to the same proxy', async () => {
      // guardVaultAccess has its own idempotent-re-wrap dedup that several
      // screens rely on (see core/services/vault/guard.ts and this
      // function's WIRING doc). Wrapping the raw manager with
      // wrapCreateActionForTokenInputs FIRST, then guarding the result
      // (never the reverse), must not break that dedup.
      const mandalaModule = new MandalaTokenModule({
        adminOriginator: ADMIN_ORIGINATOR,
        requestTokenAccess: jest.fn().mockResolvedValue(true),
        resolveAssetMetadata: async () => null,
        listTokenOutpoints: async () => new Set(),
        resolveMandalaOutput: jest.fn().mockResolvedValue(null)
      })
      const underlying = { createAction: jest.fn().mockResolvedValue({}) }
      const permissionsManager = new WalletPermissionsManager(underlying as never, ADMIN_ORIGINATOR, {
        permissionModules: { mandala: mandalaModule }
      } as never)

      const published = guardVaultAccess(
        wrapCreateActionForTokenInputs(permissionsManager, async () => new Set(), ADMIN_ORIGINATOR),
        ADMIN_ORIGINATOR
      )
      // A later re-application (as PairScreen.tsx/ConnectionsScreen.tsx do)
      // must return the EXACT SAME proxy, not a fresh double-guarded one.
      const reGuarded = guardVaultAccess(published, ADMIN_ORIGINATOR)
      expect(reGuarded).toBe(published)
    })

    it('end-to-end against the real WalletPermissionsManager: a full-balance spend (no change output) reaches onRequest and prompts', async () => {
      const requestTokenAccess = jest.fn().mockResolvedValue(true)
      const listTokenOutpoints = jest.fn().mockResolvedValue(new Set([TOKEN_OUTPOINT]))
      const mandalaModule = new MandalaTokenModule({
        adminOriginator: ADMIN_ORIGINATOR,
        requestTokenAccess,
        resolveAssetMetadata: async () => null,
        listTokenOutpoints,
        resolveMandalaOutput: jest.fn().mockResolvedValue(null)
      })
      const onRequestSpy = jest.spyOn(mandalaModule, 'onRequest')
      const underlying = { createAction: jest.fn().mockResolvedValue({}) }
      const permissionsManager = new WalletPermissionsManager(underlying as never, ADMIN_ORIGINATOR, {
        // Metadata encryption needs a real underlying.encrypt -- irrelevant
        // to what this test pins (P-routing), so it is switched off rather
        // than mocked.
        encryptWalletMetadata: false,
        permissionModules: { mandala: mandalaModule }
      } as never)

      const args = {
        description: 'send my whole balance',
        inputs: [{ outpoint: TOKEN_OUTPOINT, inputDescription: 'spend', unlockingScriptLength: 108 }],
        // The recipient output carries the full value and no basket -- a
        // full-balance spend with no change. Basket-only routing would
        // never call onRequest for this at all without the wrapper.
        outputs: [{ lockingScript: mandalaScriptHex(1000), outputDescription: 'to recipient', satoshis: 1 }]
      }

      // Sanity check first: WITHOUT the wrapper, the gap is real.
      await permissionsManager.createAction(args, FOREIGN_ORIGINATOR)
      expect(onRequestSpy).not.toHaveBeenCalled()
      expect(requestTokenAccess).not.toHaveBeenCalled()

      const wrapped = wrapCreateActionForTokenInputs(permissionsManager, listTokenOutpoints)
      await wrapped.createAction(args, FOREIGN_ORIGINATOR)

      expect(onRequestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'createAction', originator: FOREIGN_ORIGINATOR })
      )
      expect(requestTokenAccess).toHaveBeenCalledTimes(1)
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_spend')
      expect(promptData.sendAmount).toBe(1000)
    })
  })

  describe('foreign originator — internalizeAction credit', () => {
    it('prompts with the credited amount decoded from the inserted output', async () => {
      const { mod, requestTokenAccess } = makeModule()
      const args = {
        tx: atomicBeefOf([{ satoshis: 1, scriptHex: mandalaScriptHex(400) }]),
        outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: MANDALA_BASKET } }]
      }

      await mod.onRequest({ method: 'internalizeAction', args, originator: FOREIGN_ORIGINATOR })

      expect(requestTokenAccess).toHaveBeenCalledTimes(1)
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_credit')
      expect(promptData.creditAmount).toBe(400)
      expect(promptData.assetId).toBe(ASSET_ID)
    })

    it('ignores a "wallet payment" insertion (not a basket credit into p mandala)', async () => {
      const { mod, requestTokenAccess } = makeModule()
      const args = {
        tx: atomicBeefOf([{ satoshis: 1, scriptHex: mandalaScriptHex(400) }]),
        outputs: [{ outputIndex: 0, protocol: 'wallet payment' }]
      }
      await mod.onRequest({ method: 'internalizeAction', args, originator: FOREIGN_ORIGINATOR })
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_generic')
    })

    it('falls back to generic on unparseable tx bytes, never throws on decode', async () => {
      const { mod, requestTokenAccess } = makeModule()
      const args = {
        tx: [1, 2, 3],
        outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: MANDALA_BASKET } }]
      }
      await expect(
        mod.onRequest({ method: 'internalizeAction', args, originator: FOREIGN_ORIGINATOR })
      ).resolves.toEqual({ args })
      const promptData = JSON.parse(requestTokenAccess.mock.calls[0][1])
      expect(promptData.type).toBe('mandala_generic')
    })

    it('denial throws', async () => {
      const { mod } = makeModule({ requestTokenAccess: jest.fn().mockResolvedValue(false) })
      const args = {
        tx: atomicBeefOf([{ satoshis: 1, scriptHex: mandalaScriptHex(400) }]),
        outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: MANDALA_BASKET } }]
      }
      await expect(
        mod.onRequest({ method: 'internalizeAction', args, originator: FOREIGN_ORIGINATOR })
      ).rejects.toThrow('User denied permission to credit Mandala tokens')
    })
  })

  describe('constructor validation', () => {
    it('requires a requestTokenAccess callback', () => {
      expect(
        () =>
          new MandalaTokenModule({
            adminOriginator: ADMIN_ORIGINATOR,
            requestTokenAccess: undefined as any,
            resolveAssetMetadata: async () => null,
            listTokenOutpoints: jest.fn().mockResolvedValue(new Set<string>()),
            resolveMandalaOutput: jest.fn().mockResolvedValue(null)
          })
      ).toThrow('requestTokenAccess callback is required')
    })

    it('requires an adminOriginator', () => {
      expect(
        () =>
          new MandalaTokenModule({
            adminOriginator: '' as any,
            requestTokenAccess: jest.fn(),
            resolveAssetMetadata: async () => null,
            listTokenOutpoints: jest.fn().mockResolvedValue(new Set<string>()),
            resolveMandalaOutput: jest.fn().mockResolvedValue(null)
          })
      ).toThrow('adminOriginator is required')
    })
  })
})

describe('listAllOutpoints', () => {
  // XR-039: `listMandalaTokenOutpoints` (WalletContext.tsx) used to read a
  // single capped page and call that the whole basket. A spend of an input
  // that only shows up past that page must still be found.
  it('paginates to completion using the wallet-reported totalOutputs, past a short first page', async () => {
    const spentOnPageTwo = 'd'.repeat(64) + '.7'
    const list = jest.fn(async (limit: number, offset: number) => {
      if (offset === 0) {
        return { outputs: [{ outpoint: 'e'.repeat(64) + '.0' }], totalOutputs: 10_001 }
      }
      if (offset === 1) {
        // 10,000 filler outputs, ending with the one this test cares about.
        const outputs = Array.from({ length: limit }, (_, i) =>
          i === limit - 1 ? { outpoint: spentOnPageTwo } : { outpoint: 'f'.repeat(64) + `.${i}` }
        )
        return { outputs, totalOutputs: 10_001 }
      }
      return { outputs: [], totalOutputs: 10_001 }
    })

    const outpoints = await listAllOutpoints(list, 10_000, 10)

    expect(outpoints.has(spentOnPageTwo)).toBe(true)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('canonicalizes every outpoint it collects', async () => {
    const list = jest.fn().mockResolvedValue({ outputs: [{ outpoint: 'A'.repeat(64) + '.00' }], totalOutputs: 1 })

    const outpoints = await listAllOutpoints(list, 1000, 10)

    expect(outpoints.has('a'.repeat(64) + '.0')).toBe(true)
    expect(outpoints.has('A'.repeat(64) + '.00')).toBe(false)
  })

  it('stops on an empty page even with no totalOutputs to go by', async () => {
    const list = jest.fn().mockResolvedValue({ outputs: [] })

    const outpoints = await listAllOutpoints(list, 1000, 10)

    expect(outpoints.size).toBe(0)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('never loops past maxPages, even if the wallet ignores offset and totalOutputs lies', async () => {
    const list = jest.fn().mockResolvedValue({ outputs: [{ outpoint: 'b'.repeat(64) + '.0' }], totalOutputs: 999_999 })

    await listAllOutpoints(list, 1, 5)

    expect(list).toHaveBeenCalledTimes(5)
  })

  it('propagates a listing fault rather than returning a partial/empty Set silently', async () => {
    const list = jest.fn().mockRejectedValue(new Error('storage unavailable'))

    await expect(listAllOutpoints(list, 1000, 10)).rejects.toThrow('storage unavailable')
  })
})

describe('resolveMandalaOutput', () => {
  const TARGET = 'e'.repeat(64) + '.3'

  it('finds the target past a short first page and decodes its Mandala script', async () => {
    const list = jest.fn(async (limit: number, offset: number) => {
      if (offset === 0) return { outputs: [{ outpoint: 'f'.repeat(64) + '.0' }], totalOutputs: 2 }
      return { outputs: [{ outpoint: TARGET, lockingScript: mandalaScriptHex(750, ASSET_ID) }], totalOutputs: 2 }
    })

    const decoded = await resolveMandalaOutput(list, TARGET, 1, 10)

    expect(decoded).toEqual({ assetId: ASSET_ID, amount: 750 })
  })

  it('canonicalizes both sides — an alternate spelling of the target still matches', async () => {
    const list = jest.fn().mockResolvedValue({
      outputs: [{ outpoint: TARGET, lockingScript: mandalaScriptHex(1, ASSET_ID) }],
      totalOutputs: 1
    })

    // "03" for vout 3, same coercion `canonicalOutpoint` already applies.
    const decoded = await resolveMandalaOutput(list, 'e'.repeat(64) + '.03', 1000, 10)

    expect(decoded).toEqual({ assetId: ASSET_ID, amount: 1 })
  })

  it('returns null — never a guess — for an outpoint not in the listing', async () => {
    const list = jest.fn().mockResolvedValue({ outputs: [{ outpoint: 'f'.repeat(64) + '.0' }], totalOutputs: 1 })

    expect(await resolveMandalaOutput(list, TARGET, 1000, 10)).toBeNull()
  })

  it('returns null for a malformed target without ever calling list', async () => {
    const list = jest.fn()

    expect(await resolveMandalaOutput(list, 'not-an-outpoint', 1000, 10)).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('returns null when the matched entry does not decode as a Mandala output', async () => {
    const list = jest.fn().mockResolvedValue({
      outputs: [{ outpoint: TARGET, lockingScript: '006a026869' }], // OP_FALSE OP_RETURN 'hi'
      totalOutputs: 1
    })

    expect(await resolveMandalaOutput(list, TARGET, 1000, 10)).toBeNull()
  })

  it('never loops past maxPages', async () => {
    const list = jest.fn().mockResolvedValue({ outputs: [{ outpoint: 'f'.repeat(64) + '.0' }], totalOutputs: 999_999 })

    await resolveMandalaOutput(list, TARGET, 1, 5)

    expect(list).toHaveBeenCalledTimes(5)
  })

  it('propagates a listing fault rather than returning null silently', async () => {
    const list = jest.fn().mockRejectedValue(new Error('storage unavailable'))

    await expect(resolveMandalaOutput(list, TARGET, 1000, 10)).rejects.toThrow('storage unavailable')
  })
})
