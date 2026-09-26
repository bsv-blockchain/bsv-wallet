/**
 * The payee's SPV check on a nearby frame, with the payee OFFLINE.
 *
 * `verifyFramePayment` reaches the chain tracker through
 * `getServices().getChainTracker()`; in the app that is the storage manager's
 * services, whose tracker `installOfflineChainTracker` points at an
 * `OfflineFirstChaintracks`. These tests wire exactly that — a real header
 * store, a real offline-first tracker with `online()` false, and a remote that
 * fails the test if it is ever consulted — so they pin what an offline payee
 * can and cannot accept, and that a refusal for a missing header is reported
 * as `root_unverified` ("go online briefly") rather than as a bad frame.
 */
import { Beef, Hash, LockingScript, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import type { Services } from '@bsv/wallet-toolbox-mobile'
import { FrameVerifyError, verifyFramePayment, type DerivingWallet } from '../../core/localpay/verify'
import type { PaymentFrame } from '../../core/localpay/codec'
import { OfflineFirstChaintracks } from '../../core/headers/OfflineFirstChaintracks'
import { HeaderStore } from '../../core/headers/headerStore'
import { memoryHeaderFs } from '../../core/headers/fs'
import { installOfflineChainTracker } from '../../core/services/walletServiceConfig'

const ANCHOR = { height: 0, hash: '00'.repeat(32) }
const ANCESTOR_HEIGHT = 5000

const payeeKey = PrivateKey.fromRandom().toPublicKey()
const payerKey = PrivateKey.fromRandom()

/** A mined transaction paying `payerKey`, at index 1 of a two-leaf block (so
 * `MerklePath.verify`'s coinbase-maturity rule, which only applies at index 0,
 * does not come into play — a payer's ordinary coin is never the coinbase). */
function minedAncestor(satoshis: number): Transaction {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: '11'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('') })
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(payerKey.toAddress()) })
  tx.merklePath = new MerklePath(ANCESTOR_HEIGHT, [
    [
      { offset: 0, hash: '22'.repeat(32) },
      { offset: 1, hash: tx.id('hex'), txid: true }
    ]
  ])
  return tx
}

function rootOf(ancestor: Transaction): string {
  return (ancestor.merklePath as MerklePath).computeRoot(ancestor.id('hex'))
}

async function spend(
  source: Transaction,
  outputs: { satoshis: number; script: LockingScript }[]
): Promise<Transaction> {
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(payerKey)
  })
  for (const o of outputs) tx.addOutput({ satoshis: o.satoshis, lockingScript: o.script })
  await tx.sign()
  return tx
}

function frameOf(tx: Transaction): PaymentFrame {
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return {
    version: 1,
    kind: 'bsv',
    senderIdentityKey: '02' + 'ab'.repeat(32),
    outputIndex: 0,
    derivationPrefix: 'cHJlZml4',
    derivationSuffix: 'c3VmZml4',
    transaction: new Uint8Array(beef.toBinaryAtomic(tx.id('hex')))
  } as PaymentFrame
}

const toPayee = () => new P2PKH().lock(payeeKey.toAddress())

/** The payee as NearbyFlow composes it: keys from the wallet, services (and so
 * the chain tracker) from storage, with the offline tracker installed. */
async function offlinePayee(cachedRoots: { height: number; root: string }[]) {
  const store = await HeaderStore.open(memoryHeaderFs(), 'ttn', ANCHOR)
  for (const { height, root } of cachedRoots) await store.putExtraRoot(height, root)
  const remote = {
    findHeaderForHeight: jest.fn(async () => {
      throw new Error('an offline payee must not reach the network')
    }),
    currentHeight: jest.fn(async () => {
      throw new Error('an offline payee must not reach the network')
    })
  }
  const tracker = new OfflineFirstChaintracks(remote as never, async () => false)
  tracker.setStore(store)
  const services = {} as Services
  installOfflineChainTracker(services, tracker)
  const wallet: DerivingWallet = {
    getPublicKey: async () => ({ publicKey: payeeKey.toString() }),
    getServices: () => services
  }
  return { wallet, tracker, remote }
}

describe('verifyFramePayment — payee offline', () => {
  it('accepts a payment whose mined ancestor root is already in the local header store', async () => {
    const ancestor = minedAncestor(10_000)
    const tx = await spend(ancestor, [{ satoshis: 9_000, script: toPayee() }])
    const { wallet, remote } = await offlinePayee([{ height: ANCESTOR_HEIGHT, root: rootOf(ancestor) }])

    await expect(verifyFramePayment(wallet, frameOf(tx), 'admin.test')).resolves.toEqual({
      kind: 'bsv',
      satoshis: 9_000
    })
    expect(remote.findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('accepts an offline re-spend: an unmined parent that itself bottoms out at a known root', async () => {
    const ancestor = minedAncestor(10_000)
    const parent = await spend(ancestor, [{ satoshis: 9_500, script: new P2PKH().lock(payerKey.toAddress()) }])
    const tx = await spend(parent, [{ satoshis: 9_000, script: toPayee() }])
    const { wallet } = await offlinePayee([{ height: ANCESTOR_HEIGHT, root: rootOf(ancestor) }])

    await expect(verifyFramePayment(wallet, frameOf(tx), 'admin.test')).resolves.toEqual({
      kind: 'bsv',
      satoshis: 9_000
    })
  })

  it('refuses as root_unverified when the ancestor height is not in the local header store', async () => {
    const ancestor = minedAncestor(10_000)
    const tx = await spend(ancestor, [{ satoshis: 9_000, script: toPayee() }])
    const { wallet, tracker, remote } = await offlinePayee([])
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const err = await verifyFramePayment(wallet, frameOf(tx), 'admin.test').catch(e => e)
    warn.mockRestore()

    expect(err).toBeInstanceOf(FrameVerifyError)
    expect((err as FrameVerifyError).kind).toBe('root_unverified')
    expect(tracker.peekLastMissHeight()).toBe(ANCESTOR_HEIGHT)
    expect(remote.findHeaderForHeight).not.toHaveBeenCalled()
  })

  it('refuses a root that disagrees with the one the store holds', async () => {
    const ancestor = minedAncestor(10_000)
    const tx = await spend(ancestor, [{ satoshis: 9_000, script: toPayee() }])
    const wrongRoot = Utils.toHex(Hash.sha256(Utils.toArray('not the block', 'utf8')))
    const { wallet } = await offlinePayee([{ height: ANCESTOR_HEIGHT, root: wrongRoot }])
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const err = await verifyFramePayment(wallet, frameOf(tx), 'admin.test').catch(e => e)
    warn.mockRestore()

    expect((err as FrameVerifyError).kind).toBe('root_unverified')
  })
})
