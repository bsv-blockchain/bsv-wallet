// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceIsAuthenticated(runner) {
  const wallet = conformanceWallet()
  const authenticated = await wallet.isAuthenticated({})
  if (authenticated.authenticated !== true) {
    throw new Error('isAuthenticated did not report an authenticated session')
  }
  runner.log({ authenticated: true })
}
