// @ts-nocheck
import type { WalletInterface } from '@bsv/sdk'
import type { SnippetRunner } from '../../lib/snippet-runner'
import { check, reliabilityWallet } from '../reliability/support'
import { runCases } from './support'

export async function branchMetadataSequence(runner: SnippetRunner, wallet: WalletInterface = reliabilityWallet()) {
  await runCases(runner, [
    { id: 'authentication/isAuthenticated-before', run: async () => {
      const { authenticated } = await wallet.isAuthenticated({})
      check(typeof authenticated === 'boolean', 'Invalid authentication state')
      runner.log({ authenticatedBeforeWaiting: authenticated })
    } },
    { id: 'authentication/wait-then-check', run: async () => {
      check((await wallet.waitForAuthentication({})).authenticated === true, 'Authentication did not complete')
      check((await wallet.isAuthenticated({})).authenticated === true, 'Wallet did not stay authenticated')
    } },
    { id: 'metadata/version-network-repeat', run: async () => {
      const version = (await wallet.getVersion({})).version
      check(typeof version === 'string' && version.length >= 7, 'Invalid wallet version')
      check((await wallet.getVersion({})).version === version, 'Wallet version changed during the run')
      const network = (await wallet.getNetwork({})).network
      check(network === 'mainnet' || network === 'testnet', 'Unknown wallet network')
      check((await wallet.getNetwork({})).network === network, 'Wallet network changed during the run')
      runner.log({ walletVersion: version, network })
    } },
    { id: 'metadata/height-headers', run: async () => {
      const height = (await wallet.getHeight({})).height
      check(Number.isInteger(height) && height >= 1, 'Invalid chain height')
      for (const requested of [1, height]) {
        const { header } = await wallet.getHeaderForHeight({ height: requested })
        check(/^[0-9a-fA-F]{160}$/.test(header), 'Header must be 80 bytes')
        check((await wallet.getHeaderForHeight({ height: requested })).header === header, 'Header changed for a fixed height')
      }
    } },
  ])
}
