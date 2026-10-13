import { redirectSystemPath } from '../app/+native-intent'

// the build's link domain is inlined by Expo (EXPO_PUBLIC_LINK_DOMAIN), which
// Jest can't load; website links are covered in webLinks.test.ts
jest.mock('../src/links/linkDomain', () => ({ LINK_DOMAIN: '' }))

describe('redirectSystemPath', () => {
  test('the dev client launch link opens Home, not an unmatched route', () => {
    const link = 'bsv-wallet://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
    expect(redirectSystemPath({ path: link, initial: true })).toBe('/')
    expect(redirectSystemPath({ path: link, initial: false })).toBe('/')
  })

  test('the existing app’s schemes resolve to wallet routes', () => {
    expect(redirectSystemPath({ path: 'bsv-wallet://pay', initial: false })).toBe('/pay')
    expect(redirectSystemPath({ path: 'bsv-browser://pay', initial: false })).toBe('/pay')
  })
})
