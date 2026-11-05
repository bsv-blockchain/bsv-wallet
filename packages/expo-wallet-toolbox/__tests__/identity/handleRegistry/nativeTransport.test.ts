import { createHandleRegistryClient } from '../../../core/identity/handleRegistry/client'
import { createRegistryResolver, REGISTRY_MAX_BODY_BYTES } from '../../../core/identity/handleRegistry/resolver'

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) }), { virtual: true })

const mockRequest = jest.fn()
jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({ request: mockRequest, cancel: jest.fn(async () => {}) })
}), { virtual: true })

beforeEach(() => mockRequest.mockReset())

it('uses the native receive ceiling for foreign-domain DNS and capability discovery', async () => {
  mockRequest.mockImplementation(async ({ url }: { url: string }) => ({
    status: 200,
    headers: [],
    body: Buffer.from(JSON.stringify(url.includes('dns-query') ? { Status: 3 } : {
      capabilities: {
        '0ace65da5987': 'https://registry.example/api/handle/{query}',
        '43dcf83ddc5f': 'https://registry.example/api/identityKey/{pubkey}'
      }
    })).toString('base64')
  }))
  const result = await createRegistryResolver({}).resolve('registry.example')
  expect(result?.search('alice')).toBe('https://registry.example/api/handle/alice')
  expect(mockRequest).toHaveBeenCalledTimes(2)
  for (const [options] of mockRequest.mock.calls) expect(options.maxBytes).toBe(REGISTRY_MAX_BODY_BYTES)
})

it('does not fall back to buffering global fetch if the native receiver rejects', async () => {
  mockRequest.mockRejectedValue(new Error('ERR_RESPONSE_TOO_LARGE'))
  const unbounded = jest.spyOn(global, 'fetch').mockImplementation(async () => { throw new Error('unbounded') })
  try {
    expect(await createRegistryResolver({}).resolve('registry.example')).toBeNull()
    expect(mockRequest).toHaveBeenCalledTimes(2)
    expect(unbounded).not.toHaveBeenCalled()
  } finally { unbounded.mockRestore() }
})

it('bounds pinned registry search responses in the native receiver before JSON parsing', async () => {
  mockRequest.mockResolvedValue({ status: 200, headers: [], body: Buffer.from(JSON.stringify({ results: [] })).toString('base64') })
  const client = createHandleRegistryClient({ pinned: { domain: 'registry.example', url: 'https://registry.example' } })
  expect(await client.search('alice')).toEqual([])
  expect(mockRequest).toHaveBeenCalledTimes(1)
  expect(mockRequest.mock.calls[0][0]).toMatchObject({ url: 'https://registry.example/api/handle/alice', maxBytes: REGISTRY_MAX_BODY_BYTES })
})
