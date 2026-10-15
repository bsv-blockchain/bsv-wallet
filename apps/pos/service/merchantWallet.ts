import { P2PKH, PublicKey, Transaction, type WalletInterface, type ChainTracker } from '@bsv/sdk'
import type { PaymentFrame } from '../../../packages/expo-wallet-toolbox/core/localpay/codec'
/** Use a merchant signing wallet, not a storage-only provider. */
export function merchantAcceptor(wallet: WalletInterface, chainTracker: ChainTracker) {
  return async (frame: PaymentFrame, amount: number): Promise<string> => {
    const tx = Transaction.fromAtomicBEEF(frame.transaction)
    const output = tx.outputs[frame.outputIndex]
    const { publicKey } = await wallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${frame.derivationPrefix} ${frame.derivationSuffix}`,
      counterparty: frame.senderIdentityKey,
      forSelf: true
    })
    const script = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
    if (!output || output.satoshis !== amount || output.lockingScript.toHex() !== script)
      throw new Error('Payment destination or amount does not match')
    if (!(await tx.verify(chainTracker))) throw new Error('Payment ancestry or scripts did not validate')
    const result = await wallet.internalizeAction({
      tx: Array.from(frame.transaction),
      outputs: [
        {
          outputIndex: frame.outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: {
            senderIdentityKey: frame.senderIdentityKey,
            derivationPrefix: frame.derivationPrefix,
            derivationSuffix: frame.derivationSuffix
          }
        }
      ],
      description: 'Point of sale payment',
      labels: ['pos ' + tx.id('hex')]
    })
    if (!result.accepted) throw new Error('Merchant wallet did not accept this payment')
    const actions = await wallet.listActions({ labels: ['pos ' + tx.id('hex')], limit: 10 })
    if (!actions.actions.some(a => a.txid === tx.id('hex') && (a.status === 'completed' || a.status === 'unproven')))
      throw new Error('Merchant payment broadcast is pending or failed')
    return tx.id('hex')
  }
}
