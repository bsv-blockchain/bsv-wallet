import { storageChainFor, storageMatchesNetwork } from '../../core/net/chainMatch'

// Storage records the TOOLBOX's chain name (it is built with
// createStorageBaseOptions(walletChain)), so that is what each network expects.
it('maps each network onto the toolbox chain its storage records', () => {
  expect(storageChainFor('main')).toBe('main')
  expect(storageChainFor('test')).toBe('test')
  expect(storageChainFor('teratest')).toBe('ttn')
  expect(storageChainFor('scaletest')).toBe('regtest')
})

it('matches storage to the network it belongs to', () => {
  expect(storageMatchesNetwork({ chain: 'main' }, 'main')).toBe(true)
  // A teratest wallet's storage says 'ttn'. Expecting 'test' here kept every
  // teratest home screen treating its own wallet as the previous network's.
  expect(storageMatchesNetwork({ chain: 'ttn' }, 'teratest')).toBe(true)
  expect(storageMatchesNetwork({ chain: 'regtest' }, 'scaletest')).toBe(true)
})

// The whole point: during a switch the old chain's storage is still mounted,
// and reading it is what showed a mainnet balance under a testnet label.
it('refuses the previous chain while a switch is in flight', () => {
  expect(storageMatchesNetwork({ chain: 'main' }, 'test')).toBe(false)
  expect(storageMatchesNetwork({ chain: 'test' }, 'main')).toBe(false)
  expect(storageMatchesNetwork({ chain: 'test' }, 'teratest')).toBe(false)
  expect(storageMatchesNetwork({ chain: 'ttn' }, 'test')).toBe(false)
  expect(storageMatchesNetwork({ chain: 'ttn' }, 'scaletest')).toBe(false)
})

it('treats no storage, or an unknown network, as no match rather than as permission to read', () => {
  expect(storageMatchesNetwork(null, 'main')).toBe(false)
  expect(storageMatchesNetwork(undefined, 'main')).toBe(false)
  expect(storageMatchesNetwork({}, 'main')).toBe(false)
  expect(storageMatchesNetwork({ chain: 'test' }, 'garbage')).toBe(false)
})
