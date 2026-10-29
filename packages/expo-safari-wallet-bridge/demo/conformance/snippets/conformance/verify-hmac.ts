// @ts-nocheck
import { Utils } from '@bsv/sdk'
import { conformanceWallet, keyID, message, protocolID } from './support'

export async function conformanceVerifyHmac(runner) {
  const wallet = conformanceWallet()
  const data = Utils.toArray(message, 'utf8')
  const hmac = await wallet.createHmac({ data, protocolID, keyID, counterparty: 'self' })
  const hmacCheck = await wallet.verifyHmac({
    data,
    hmac: hmac.hmac,
    protocolID,
    keyID,
    counterparty: 'self'
  })
  if (hmacCheck.valid !== true) {
    throw new Error('verifyHmac rejected a freshly created HMAC')
  }
  runner.log({ valid: true })
}
