// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceGetNetwork(runner) {
  const wallet = conformanceWallet()
  const network = await wallet.getNetwork({})
  if (network.network !== 'mainnet' && network.network !== 'testnet') {
    throw new Error(`Network "${String(network.network)}" is not mainnet or testnet`)
  }
  runner.log({ network: network.network })
}
