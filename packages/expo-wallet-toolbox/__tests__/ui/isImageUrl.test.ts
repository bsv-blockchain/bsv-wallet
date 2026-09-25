/**
 * XR-073 (SEC2-057, SEC2-076): a trust manifest's icon URL is exactly as
 * untrusted as the rest of the manifest, so prefetching it must not be able
 * to reach a loopback or private-network service.
 */
const mockPrefetch = jest.fn()
jest.mock('expo-image', () => ({ Image: { prefetch: (...a: unknown[]) => mockPrefetch(...a) } }))

import isImageUrl from '../../ui/isImageUrl'

beforeEach(() => {
  jest.clearAllMocks()
  mockPrefetch.mockResolvedValue(true)
})

it('refuses to prefetch a loopback URL, without calling Image.prefetch at all', async () => {
  expect(await isImageUrl('https://127.0.0.1/icon.png')).toBe(false)
  expect(mockPrefetch).not.toHaveBeenCalled()
})

it('still prefetches an ordinary public https icon', async () => {
  expect(await isImageUrl('https://example.com/icon.png')).toBe(true)
  expect(mockPrefetch).toHaveBeenCalledWith('https://example.com/icon.png')
})
