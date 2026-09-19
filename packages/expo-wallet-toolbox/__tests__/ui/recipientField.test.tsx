/**
 * The recipient dropdown, on its own.
 *
 * Two rules live here and nowhere else: a tier still loading is a FOOTER under
 * the rows already found, never a replacement for them, and the second line of
 * a row is whatever the caller says it is (a registry paymail, a contact's
 * cached handle) with the abbreviated key only as a fallback.
 */
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
// Pulled in as a side effect of importing anything from the barrel: its
// LocalStorageProvider chain reaches these native modules at module top level.
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)
jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)

import React from 'react'
import { render } from '@testing-library/react-native'
import { ThemeProvider, useTheme } from '@bsv/expo-wallet-toolbox'
import RecipientField, { type RecipientRow } from '../../ui/components/pay/RecipientField'

const row = (over: Partial<RecipientRow> = {}): RecipientRow => ({
  identityKey: '02' + 'ab'.repeat(32),
  name: 'Dee K',
  avatarURL: '',
  abbreviatedKey: '02ab…abab',
  badgeIconURL: '',
  badgeLabel: '',
  badgeClickURL: '',
  ...over
})

/** The colours come from the provider, as every caller's do. */
function RecipientFieldHarness(props: Omit<React.ComponentProps<typeof RecipientField>, 'colors'>) {
  const { colors } = useTheme()
  return <RecipientField {...props} colors={colors} />
}

const draw = (over: Partial<React.ComponentProps<typeof RecipientField>> = {}) =>
  render(
    <ThemeProvider>
      <RecipientFieldHarness
        selectedIdentity={null}
        inputText="dee"
        target={null}
        inlineError={null}
        isSearching={false}
        searchResults={[]}
        t={((key: string) => key) as never}
        onChangeText={jest.fn()}
        onSelectIdentity={jest.fn()}
        onClear={jest.fn()}
        onOpenScanner={jest.fn()}
        {...over}
      />
    </ThemeProvider>
  )

describe('the dropdown while a remote tier is loading', () => {
  it('keeps the rows on screen and puts the spinner underneath them', () => {
    const s = draw({ isSearching: true, searchResults: [row()] })
    expect(s.getByText('Dee K')).toBeTruthy()
    expect(s.getByText('searching')).toBeTruthy()
  })

  it('still shows the spinner alone when there is nothing yet', () => {
    const s = draw({ isSearching: true, searchResults: [] })
    expect(s.getByText('searching')).toBeTruthy()
  })

  it('drops the spinner once every tier has settled', () => {
    const s = draw({ isSearching: false, searchResults: [row()] })
    expect(s.queryByText('searching')).toBeNull()
  })
})

describe('the second line of a row', () => {
  it('is the caller-supplied one when there is one', () => {
    const s = draw({ searchResults: [row({ secondaryLine: 'dee@deggen.com' })] })
    expect(s.getByText('dee@deggen.com')).toBeTruthy()
    expect(s.queryByText('02ab…abab')).toBeNull()
  })

  it('falls back to the abbreviated key, as it always did', () => {
    const s = draw({ searchResults: [row()] })
    expect(s.getByText('02ab…abab')).toBeTruthy()
  })
})
