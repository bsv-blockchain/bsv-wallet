// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceGetPublicKey(runner) {
  const wallet = conformanceWallet()
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  if (!/^[0-9a-fA-F]{66}$/.test(publicKey)) {
    throw new Error('getPublicKey did not return a compressed public key')
  }
  runner.log({ identityKey: publicKey })
}
