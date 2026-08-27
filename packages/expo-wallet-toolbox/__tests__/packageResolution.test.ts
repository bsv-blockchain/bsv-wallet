jest.mock('expo-secure-store', () => require('./__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('./__mocks__/localAuthFake').fake)

import { CANARY } from '@bsv/expo-wallet-toolbox'
import { CANARY_UI } from '@bsv/expo-wallet-toolbox/ui'

describe('package resolution', () => {
  it('resolves the core entry point', () => {
    expect(CANARY).toBe('core')
  })

  it('resolves the ui entry point', () => {
    expect(CANARY_UI).toBe('ui')
  })
})
