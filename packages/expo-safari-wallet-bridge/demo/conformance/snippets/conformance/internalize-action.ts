// @ts-nocheck
import { Hash, KeyDeriver, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk'
import { brc29ProtocolID } from '@bsv/wallet-toolbox-client'
import { conformanceWallet } from './support'

export async function conformanceInternalizeAction(runner) {
  const wallet = conformanceWallet()
  // The page is a separate payer. Asking the wallet for a BRC-29 key toward its
  // own identity is refused by the wallet vault.
  const payer = PrivateKey.fromRandom()
  const { publicKey: walletIdentityKey } = await wallet.getPublicKey({ identityKey: true })
  const prefixBytes = Random(12)
  const derivationPrefix = Utils.toBase64(prefixBytes)
  const derivationSuffix = Utils.toBase64(Hash.sha512hmac(prefixBytes, 'output_0'))
  const keyID = `${derivationPrefix} ${derivationSuffix}`
  const paymentKey = new KeyDeriver(payer).derivePublicKey(brc29ProtocolID, keyID, walletIdentityKey)
  const lockingScript = new P2PKH().lock(paymentKey.toAddress()).toHex()

  // Broadcasts a 1-satoshi payment from the page key into this wallet.
  const created = await wallet.createAction({
    description: 'conformance incoming payment',
    outputs: [{
      satoshis: 1,
      lockingScript,
      outputDescription: 'conformance incoming payment'
    }],
    options: {
      acceptDelayedBroadcast: false,
      randomizeOutputs: false
    }
  })
  if (created.tx == null) throw new Error('createAction did not return the payment transaction')

  const tx = Array.from(created.tx)
  const transaction = Transaction.fromAtomicBEEF(tx)
  const target = paymentKey.toHash('hex')
  let outputIndex = -1
  transaction.outputs.forEach((output, vout) => {
    if (Utils.toHex(output.lockingScript.chunks[2].data) === target) outputIndex = vout
  })
  if (outputIndex < 0) throw new Error('Could not find the conformance payment output')

  const response = await wallet.internalizeAction({
    description: 'conformance internalize',
    tx,
    outputs: [{
      outputIndex,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix,
        derivationSuffix,
        senderIdentityKey: payer.toPublicKey().toString()
      }
    }]
  })
  if (response.accepted !== true) {
    throw new Error('internalizeAction did not accept the payment')
  }
  runner.log({ txid: created.txid, outputIndex, accepted: true })
}
