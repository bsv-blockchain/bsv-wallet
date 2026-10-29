// @ts-nocheck
import { brc29ProtocolID } from '@bsv/wallet-toolbox-client'
import { Hash, KeyDeriver, P2PKH, PrivateKey, Random, Script, Transaction, Utils, type InternalizeActionArgs, type WalletInterface } from '@bsv/sdk'
import type { SnippetRunner } from '../../lib/snippet-runner'
import { check, reliabilityWallet } from '../reliability/support'
import { branchBasket, branchInstructions, branchLabel, branchTags } from './lists'
import { freshID, runCases } from './support'

export async function branchInternalizeProtocols(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  await runCases(runner, ['payment', 'insertion', 'mixed'].map(mode => ({ id: `internalizeAction/${mode}`, run: async () => {
    const payer = PrivateKey.fromRandom()
    const identity = (await wallet.getPublicKey({ identityKey: true })).publicKey
    const prefix = Random(12)
    const derivationPrefix = Utils.toBase64(prefix)
    const derivationSuffix = Utils.toBase64(Hash.sha512hmac(prefix, 'output_0'))
    const paymentKey = new KeyDeriver(payer).derivePublicKey(brc29ProtocolID, `${derivationPrefix} ${derivationSuffix}`, identity)
    const paymentScript = new P2PKH().lock(paymentKey.toAddress()).toHex()
    const insertionScript = Script.fromASM('OP_TRUE').toHex()
    const basket = `${branchBasket} ${freshID()}`
    const created = await wallet.createAction({ description: 'fast branch internalize source', labels: [branchLabel], outputs: [
      { satoshis: 1, lockingScript: paymentScript, outputDescription: 'fast branch wallet payment' },
      { satoshis: 1, lockingScript: insertionScript, outputDescription: 'fast branch basket insertion' },
    ], options: { randomizeOutputs: false, acceptDelayedBroadcast: false } })
    check(created.tx != null, 'Internalization source missing AtomicBEEF')
    const tx = Transaction.fromAtomicBEEF(Array.from(created.tx))
    const paymentIndex = tx.outputs.findIndex(output => output.lockingScript.toHex() === paymentScript)
    const insertionIndex = tx.outputs.findIndex(output => output.lockingScript.toHex() === insertionScript)
    check(paymentIndex >= 0 && insertionIndex >= 0, 'Internalization source outputs missing')
    const outputs: InternalizeActionArgs['outputs'] = []
    if (mode !== 'insertion') outputs.push({ outputIndex: paymentIndex, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: payer.toPublicKey().toString() } })
    if (mode !== 'payment') outputs.push({ outputIndex: insertionIndex, protocol: 'basket insertion', insertionRemittance: { basket, tags: branchTags, customInstructions: branchInstructions } })
    const args: InternalizeActionArgs = { tx: created.tx, outputs, description: 'fast branch internalize fixture', labels: [branchLabel], seekPermission: true }
    check((await wallet.internalizeAction(args)).accepted === true, 'Internalization rejected')
    check((await wallet.internalizeAction({ ...args, seekPermission: false })).accepted === true, 'Repeat internalization rejected')
    if (mode !== 'payment') {
      const outpoint = `${tx.id('hex')}.${insertionIndex}`
      const listed = await wallet.listOutputs({ basket, include: 'locking scripts', includeTags: true, includeCustomInstructions: true })
      check(listed.outputs.filter(output => output.outpoint === outpoint).length === 1, 'Internalization duplicated or omitted the fixture')
      check((await wallet.relinquishOutput({ basket, output: outpoint })).relinquished === true, 'Fixture relinquishment failed')
      check(!(await wallet.listOutputs({ basket })).outputs.some(output => output.outpoint === outpoint), 'Relinquished fixture is still tracked')
    }
    runner.log({ mode, fixtureSatoshis: 2, repeatedInternalization: true })
  } })))
}
