import { P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction } from '@bsv/sdk'
import type { saveOutboxEntry } from '../../core/peerpay/outbox'

export const ADMIN = 'admin.test'
export const sender = new ProtoWallet(new PrivateKey(7))

export async function signedPayment(outputIndex = 0, amount = 17): Promise<Parameters<typeof saveOutboxEntry>[1]> {
  const recipient = new PrivateKey(11).toPublicKey().toString()
  const customInstructions = { derivationPrefix: 'cHJlZml4', derivationSuffix: 'c3VmZml4' }
  const { publicKey } = await sender.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${customInstructions.derivationPrefix} ${customInstructions.derivationSuffix}`,
    counterparty: recipient
  })
  const fundingKey = new PrivateKey(9)
  const source = new Transaction()
  source.addOutput({ lockingScript: new P2PKH().lock(fundingKey.toAddress()), satoshis: 100 })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(fundingKey)
  })
  if (outputIndex === 1) tx.addOutput({ lockingScript: new P2PKH().lock(fundingKey.toAddress()), satoshis: 1 })
  tx.addOutput({ lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()), satoshis: amount })
  await tx.sign()
  return {
    recipient,
    messageBoxUrl: 'https://message.example',
    txid: tx.id('hex'),
    token: { customInstructions, transaction: tx.toAtomicBEEF(), amount, ...(outputIndex ? { outputIndex } : {}) }
  }
}
