import { storageChainFor, storageMatchesNetwork } from '../../core/net/chainMatch'

it('maps both testnets onto the one storage chain', () => {
  expect(storageChainFor('main')).toBe('main')
  expect(storageChainFor('test')).toBe('test')
  // 'teratest' is 'ttn' to the toolbox but still a testnet database.
  expect(storageChainFor('teratest')).toBe('test')
})

it('matches storage to the network it belongs to', () => {
  expect(storageMatchesNetwork({ chain: 'main' }, 'main')).toBe(true)
  expect(storageMatchesNetwork({ chain: 'test' }, 'teratest')).toBe(true)
})

// The whole point: during a switch the old chain's storage is still mounted,
// and reading it is what showed a mainnet balance under a testnet label.
it('refuses the previous chain while a switch is in flight', () => {
  expect(storageMatchesNetwork({ chain: 'main' }, 'test')).toBe(false)
  expect(storageMatchesNetwork({ chain: 'test' }, 'main')).toBe(false)
})

it('treats no storage as no match rather than as permission to read', () => {
  expect(storageMatchesNetwork(null, 'main')).toBe(false)
  expect(storageMatchesNetwork(undefined, 'main')).toBe(false)
  expect(storageMatchesNetwork({}, 'main')).toBe(false)
})
