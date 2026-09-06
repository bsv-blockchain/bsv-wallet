jest.mock('expo-image', () => ({ Image: { prefetch: jest.fn() } }), { virtual: true })

import { Image } from 'expo-image'
import isImageUrl from '../ui/isImageUrl'
import validateTrust from '../ui/validateTrust'

const prefetch = Image.prefetch as jest.Mock
const trust = {
  name: 'Sigma Identity',
  note: 'Certifies verified identity claims',
  icon: 'https://auth.sigmaidentity.com/sigma-mark.svg',
  publicKey: '02250905f0383085b53409876aefbf01fc8e7fd841922dc4ce55ae035b31341e6d'
}

beforeEach(() => prefetch.mockReset())

describe('trust icon validation', () => {
  it.each([
    trust.icon,
    'https://example.com/icon.png',
    'https://example.com/icon.jpg',
    'https://example.com/icon?format=svg'
  ])('accepts an image successfully loaded by Expo: %s', async icon => {
    prefetch.mockResolvedValue(true)
    await expect(validateTrust({ ...trust, icon })).resolves.toBe(true)
    expect(prefetch).toHaveBeenCalledWith(icon)
  })

  it('rejects an unsuccessful prefetch even when the promise resolves', async () => {
    prefetch.mockResolvedValue(false)
    await expect(validateTrust(trust)).rejects.toMatchObject({
      field: 'icon',
      message: 'Trust validation failed, icon image URL is invalid'
    })
  })

  it('rejects a download or decode exception', async () => {
    prefetch.mockRejectedValue(new Error('Unable to decode image'))
    await expect(isImageUrl(trust.icon)).resolves.toBe(false)
    await expect(validateTrust(trust)).rejects.toMatchObject({ field: 'icon' })
  })

  it('still rejects invalid public keys after loading the icon', async () => {
    prefetch.mockResolvedValue(true)
    await expect(validateTrust({ ...trust, publicKey: 'invalid' })).rejects.toMatchObject({
      field: 'publicKey'
    })
  })
})
