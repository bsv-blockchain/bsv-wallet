// useIdentitySearch imports validatePeerPayURI from the package root, which
// pulls LocalStorageProvider's secrets stack (expo-secure-store /
// expo-local-authentication) at module load.
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import { classifyIdentitySearchError } from '../../ui/components/pay/useIdentitySearch'

describe('classifyIdentitySearchError', () => {
  it('treats any thrown overlay lookup failure as an outage, not “no such person”', () => {
    expect(classifyIdentitySearchError(new Error('timeout'))).toBe(true)
  })
})
