// @ts-nocheck
import { Utils } from '@bsv/sdk'
import { conformanceWallet, keyID, message, protocolID } from './support'

export async function conformanceCreateSignature(runner) {
  const wallet = conformanceWallet()
  const signed = await wallet.createSignature({
    data: Utils.toArray(message, 'utf8'),
    protocolID,
    keyID,
    counterparty: 'self'
  })
  if (!signed.signature || signed.signature.length === 0) {
    throw new Error('createSignature did not return a signature')
  }
  runner.log({ signatureBytes: signed.signature.length })
}
