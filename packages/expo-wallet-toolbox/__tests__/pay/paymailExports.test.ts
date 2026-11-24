/**
 * The package barrel carries the paymail send surface that the app (plan 3)
 * imports from '@bsv/expo-wallet-toolbox'.
 */
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

import * as toolbox from '../../core'

describe('paymail public exports', () => {
  it.each([
    'classifyPaymailDomain',
    'classifyPaymailDomainDetailed',
    'createRegistryResolver',
    'createLegacyPaymailClient',
    'sendViaPaymail',
    'PaymailSendError',
    'statusFnFromStorage',
    'isPaymailEntry'
  ])('exports %s', name => {
    expect(typeof (toolbox as Record<string, unknown>)[name]).toBe('function')
  })
})
