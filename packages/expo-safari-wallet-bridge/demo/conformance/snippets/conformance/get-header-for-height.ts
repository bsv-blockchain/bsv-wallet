// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceGetHeaderForHeight(runner) {
  const wallet = conformanceWallet()
  const { height } = await wallet.getHeight({})
  if (!Number.isInteger(height) || height < 1) {
    throw new Error('getHeight did not return a height to request')
  }
  const { header } = await wallet.getHeaderForHeight({ height })
  if (!/^[0-9a-fA-F]{160}$/.test(header)) {
    throw new Error('getHeaderForHeight did not return 80 bytes of hex')
  }
  runner.log({ height, headerBytes: header.length / 2 })
}
