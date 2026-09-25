/**
 * XR-073 review follow-up: resolveAvatarURL was named in-scope for XR-073
 * (SEC2-057, SEC2-076) but shipped unguarded — any http(s) URL from an
 * untrusted BRC-100 identity certificate was returned verbatim, straight into
 * HandleReceive/ContactSigil/RecipientField's native <Image> loader, with no
 * isPublicHttpsUrl gate. A UHRP-resolved hostedFileLocation can name a
 * loopback/private address too (the SDK's own UHRP-advertisement validation
 * only requires https + no credentials), so that path needs the same gate.
 */
const mockResolve = jest.fn()
jest.mock('@bsv/sdk', () => ({
  ...jest.requireActual('@bsv/sdk'),
  StorageDownloader: jest.fn().mockImplementation(() => ({
    resolve: (...args: unknown[]) => mockResolve(...args)
  }))
}))

import { resolveAvatarURL } from '../../ui/resolveIdentity'

beforeEach(() => {
  jest.clearAllMocks()
})

it('XR-073: refuses a loopback avatarURL from an identity certificate', async () => {
  expect(await resolveAvatarURL(['http://127.0.0.1:9999/avatar.png'])).toBeUndefined()
  expect(await resolveAvatarURL(['https://127.0.0.1/avatar.png'])).toBeUndefined()
})

it('XR-073: refuses a plain http:// avatarURL (not just private hosts)', async () => {
  expect(await resolveAvatarURL(['http://example.com/avatar.png'])).toBeUndefined()
})

it('XR-073: refuses an RFC1918/link-local avatarURL', async () => {
  expect(await resolveAvatarURL(['https://192.168.1.5/avatar.png'])).toBeUndefined()
  expect(await resolveAvatarURL(['https://169.254.1.1/avatar.png'])).toBeUndefined()
})

it('still accepts an ordinary public https avatarURL', async () => {
  expect(await resolveAvatarURL(['https://example.com/avatar.png'])).toBe('https://example.com/avatar.png')
})

it('falls through to a later safe candidate when an earlier one is unsafe', async () => {
  expect(await resolveAvatarURL(['http://127.0.0.1/evil.png', 'https://example.com/avatar.png'])).toBe(
    'https://example.com/avatar.png'
  )
})

it('XR-073: refuses a UHRP-resolved hostedFileLocation that names a loopback address', async () => {
  mockResolve.mockResolvedValue(['https://127.0.0.1:4873/blob'])
  expect(await resolveAvatarURL(['uhrp://deadbeef'])).toBeUndefined()
})

it('still resolves a UHRP hash to an ordinary public https location', async () => {
  mockResolve.mockResolvedValue(['https://storage.example.com/blob'])
  expect(await resolveAvatarURL(['uhrp://deadbeef'])).toBe('https://storage.example.com/blob')
})

it('resolves to undefined (not a throw) when storage resolution fails', async () => {
  mockResolve.mockRejectedValue(new Error('network down'))
  expect(await resolveAvatarURL(['uhrp://deadbeef'])).toBeUndefined()
})
