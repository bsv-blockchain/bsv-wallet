/**
 * Audit S2/S3 regression pins (plan 07 W11), run through the exact manager
 * stack WalletContext publishes with the color module registered:
 *
 *   guardVaultAccess(wrapAbortActionForSettlements(conformWalletResults(
 *     SigningPolicyPermissionsManager(underlying, { permissionModules: { color } }))))
 *
 * The old `'p mandala'` P-module bugs died with it, but the wallet's own
 * wrappers could still route a call around the module. These pin that they
 * do not:
 *
 *  · A.13 (0207:2195-2233): a bare digest, or a bare preimage as `data`, under
 *    a `p color` key is refused with no prompt and never reaches the
 *    underlying wallet — also when two arrive at once (the per-origin
 *    ask-every-time queue must not wedge on a refusal).
 *  · S3: an app output placed in a `p color` basket but locked to a key that
 *    is not this wallet's is never kept as change: it is refused before any
 *    prompt, whether the plan leaves it out of `ownedOutputs` or names it with
 *    a remittance the wallet key does not match.
 *
 * The underlying wallet is a spy over a real `ProtoWallet`, so the module's
 * key derivation in `assertOwned` is real. The asset is a real profile-free
 * BRC-162 deploy, served to the module's default provider by a fake overlay
 * `fetch`, so the refusals tested are the module's ownership checks and not an
 * asset-resolution failure.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Beef, Hash, PrivateKey, ProtoWallet, Transaction, UnlockingScript, type WalletProtocol } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { ColorPlan, assetBasket, colorProtocolID, type ColorRemittance } from '@bsv/color-permission-module'
import { buildColorModule } from '../../core/mandala/colorModule'
import { createColorAccessPolicy } from '../../core/mandala/accessPolicy'
import { wrapAbortActionForSettlements } from '../../core/mandala/abortGuard'
import { conformWalletResults } from '../../core/services/conformWalletResults'
import { SigningPolicyPermissionsManager } from '../../core/services/signingPermissionPolicy'
import { guardVaultAccess } from '../../core/services/vault/guard'
import { openTestDb } from '../__helpers__/nodeSqlite'

const ADMIN = 'admin.example'
const APP = 'app.example'
const EP = {
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: new PrivateKey(9).toPublicKey().toString(),
  messageBoxUrl: 'https://messagebox.example'
}

/** A real profile-free BRC-162 deploy at output 0; the asset id is `<its txid>_0`. */
const deployTx = (() => {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({
    satoshis: 1,
    lockingScript: new OneColor().lock(null, 1_000_000n, PrivateKey.fromRandom().toPublicKey().toHash() as number[])
  })
  return tx
})()
const DEPLOY_TXID = deployTx.id('hex')
const ID = `${DEPLOY_TXID}_0`

/** The issuer's overlay, answering only the deploy's `color-admission`. */
const overlayFetch = (async (url: string, init?: { body?: string }) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { query?: { type?: string; outpoints?: string[] } }
  if (
    url === `${EP.overlayUrl}/lookup` &&
    body.query?.type === 'color-admission' &&
    body.query.outpoints?.length === 1 &&
    body.query.outpoints[0] === `${DEPLOY_TXID}.0`
  ) {
    const beef = new Beef()
    beef.mergeRawTx(deployTx.toBinary())
    const answer = { type: 'output-list', outputs: [{ beef: beef.toBinary(), outputIndex: 0, txid: DEPLOY_TXID }] }
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) }
  }
  throw new Error(`unexpected fetch ${url}`)
}) as unknown as typeof fetch

/** A spy over a real ProtoWallet: key derivation is real, every call is observable. */
function spyUnderlying(proto: ProtoWallet) {
  return {
    getPublicKey: jest.fn(proto.getPublicKey.bind(proto)),
    createSignature: jest.fn(proto.createSignature.bind(proto)),
    verifySignature: jest.fn(proto.verifySignature.bind(proto)),
    // The manager encrypts action metadata (description) on the underlying wallet.
    encrypt: jest.fn(proto.encrypt.bind(proto)),
    decrypt: jest.fn(proto.decrypt.bind(proto)),
    createAction: jest.fn(async () => {
      throw new Error('underlying createAction must not be reached')
    }),
    signAction: jest.fn(async () => {
      throw new Error('underlying signAction must not be reached')
    }),
    listOutputs: jest.fn(async () => ({ totalOutputs: 0, outputs: [] })),
    listActions: jest.fn(async () => ({ totalActions: 0, actions: [] })),
    getVersion: jest.fn(async () => ({ version: 'bsv-wallet-1.0.0' })),
    getNetwork: jest.fn(async () => ({ network: 'testnet' }))
  }
}

const lookup = {
  anyAdminOutpoint: jest.fn(async () => false),
  anyAdminTransaction: jest.fn(async () => false)
}

let raw: DatabaseSync | undefined
const disposers: (() => void)[] = []

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!()
  raw?.close()
  raw = undefined
})

async function publishedStack() {
  const db = await openTestDb()
  raw = db.raw
  const underlying = spyUnderlying(new ProtoWallet(new PrivateKey(7)))
  const prompt = jest.fn(async () => true)
  const built = buildColorModule({
    wallet: underlying as never,
    endpoints: EP,
    kv: db.kv,
    requestTokenAccess: createColorAccessPolicy({ adminOriginator: ADMIN, prompt }),
    fetch: overlayFetch
  })
  disposers.push(() => built.module.dispose())
  const inner = new SigningPolicyPermissionsManager(underlying as never, ADMIN, {
    seekProtocolPermissionsForSigning: true,
    permissionModules: { color: built.module }
  } as never)
  const protocolPrompt = jest.fn()
  inner.bindCallback('onProtocolPermissionRequested', protocolPrompt)
  const pm = guardVaultAccess(
    wrapAbortActionForSettlements(
      conformWalletResults(ADMIN, inner),
      () => undefined,
      () => true
    ),
    ADMIN,
    { lookup }
  )
  return { pm, underlying, prompt, protocolPrompt }
}

it('A.13: a bare digest under a p color key is refused without a prompt', async () => {
  const { pm, underlying, prompt, protocolPrompt } = await publishedStack()
  const bare = {
    protocolID: colorProtocolID(ID, 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB') as WalletProtocol,
    keyID: 'color',
    counterparty: 'self' as const
  }
  await expect(pm.createSignature({ ...bare, hashToDirectlySign: Array(32).fill(17) }, APP)).rejects.toThrow(
    /hashToDirectlySign|envelope/
  )
  // 0207:2233: a bare serialized preimage as data is also insufficient.
  await expect(pm.createSignature({ ...bare, data: Array(32).fill(17) }, APP)).rejects.toThrow()
  // A double tap: two concurrent bare digests both refuse, and the per-origin
  // ask-every-time queue is not wedged by a refusal.
  const both = await Promise.allSettled(
    [1, 2].map(async () => await pm.createSignature({ ...bare, hashToDirectlySign: Array(32).fill(17) }, APP))
  )
  expect(both.map(r => r.status)).toEqual(['rejected', 'rejected'])
  expect(prompt).not.toHaveBeenCalled()
  expect(protocolPrompt).not.toHaveBeenCalled()
  expect(underlying.createSignature).not.toHaveBeenCalled()
})

it('S3: a p color basket output not locked to a wallet key is never kept change', async () => {
  const { pm, underlying, prompt, protocolPrompt } = await publishedStack()
  const foreignPkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
  const foreign = new OneColor().lock(ID, 1500n, foreignPkh).toHex()
  const out = { lockingScript: foreign, satoshis: 1, basket: assetBasket(ID, 'value'), outputDescription: 'change' }
  const plan = (ownedOutputs: ColorRemittance[]) =>
    ColorPlan.toLabels({
      version: 1,
      assets: [ID],
      ownedOutputs,
      operations: [],
      inputPositions: [],
      changePositions: [],
      sighashTypes: []
    })
  const options = { randomizeOutputs: false }
  // (a) the app puts a foreign-locked token output in p color without naming it as owned
  await expect(
    pm.createAction({ description: 'spoof change', outputs: [out], labels: plan([]), options }, APP)
  ).rejects.toThrow(/ownedOutputs/)
  // (b) the app names it as owned, with a remittance the wallet key does not match
  const self = (await underlying.getPublicKey({ identityKey: true })).publicKey
  await expect(
    pm.createAction(
      {
        description: 'spoof change',
        outputs: [out],
        labels: plan([
          {
            outputIndex: 0,
            assetId: ID,
            derivationPrefix: 'QUFBQUFBQUFBQUFBQUFBQQ==',
            derivationSuffix: 'QkJCQkJCQkJCQkJCQkJCQg==',
            senderIdentityKey: self
          }
        ]),
        options
      },
      APP
    )
  ).rejects.toThrow(/locked to this wallet/)
  expect(prompt).not.toHaveBeenCalled()
  expect(protocolPrompt).not.toHaveBeenCalled()
  expect(underlying.createAction).not.toHaveBeenCalled()
})
