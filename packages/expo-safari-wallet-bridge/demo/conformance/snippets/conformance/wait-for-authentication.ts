// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceWaitForAuthentication(runner) {
  const wallet = conformanceWallet()
  const waited = await wallet.waitForAuthentication({})
  if (waited.authenticated !== true) {
    throw new Error('waitForAuthentication did not report an authenticated session')
  }
  runner.log({ authenticated: true })
}
