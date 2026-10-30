// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceGetHeight(runner) {
  const wallet = conformanceWallet()
  const { height } = await wallet.getHeight({})
  if (!Number.isInteger(height) || height < 1) {
    throw new Error('getHeight did not return a positive integer')
  }
  runner.log({ height })
}
