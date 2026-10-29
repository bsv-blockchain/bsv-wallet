// @ts-nocheck
import { Utils } from '@bsv/sdk'
import { conformanceWallet, keyID, message, protocolID } from './support'

export async function conformanceDecrypt(runner) {
  const wallet = conformanceWallet()
  const encrypted = await wallet.encrypt({
    plaintext: Utils.toArray(message, 'utf8'),
    protocolID,
    keyID,
    counterparty: 'self'
  })
  const decrypted = await wallet.decrypt({
    ciphertext: encrypted.ciphertext,
    protocolID,
    keyID,
    counterparty: 'self'
  })
  if (Utils.toUTF8(decrypted.plaintext) !== message) {
    throw new Error('decrypt did not return the encrypted plaintext')
  }
  runner.log({ plaintext: message })
}
