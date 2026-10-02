/**
 * The Home avatar's profile switcher: rows per profile, the active one opens
 * Profile, another switches, Add adds — and a recovered-key wallet (no
 * profiles) keeps going straight to Profile.
 */
import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'

const mockPush = jest.fn()
const mockWallet = {
  profilesSupported: true,
  profiles: [
    { index: 0, network: 'main' },
    { index: 1, network: 'test' }
  ],
  activeProfile: 0,
  switchProfile: jest.fn(async () => {}),
  addProfile: jest.fn(async () => {}),
  walletBuilding: false,
  switchingProfile: false,
  removingProfile: null as number | null
}

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  hitTargets: { minimum: 44 },
  useUserAvatarIcon: () => null,
  haptics: new Proxy({}, { get: () => () => {} }),
  useWallet: () => mockWallet
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'profile_label'
        ? `profile${String(params?.number)}`
        : key === 'profile_switching'
          ? `switching:${String(params?.profile)}`
          : key === 'profile_removing'
            ? `removing:${String(params?.profile)}`
            : key
  })
}))

import ProfileSwitcherPopover from '../../ui/components/wallet/ProfileSwitcherPopover'
import ProfileButton from '../../ui/components/wallet/ProfileButton'

function renderPopover(overrides: Partial<React.ComponentProps<typeof ProfileSwitcherPopover>> = {}) {
  const props = {
    visible: true,
    onClose: jest.fn(),
    anchor: { x: 16, y: 50, height: 34 },
    profiles: mockWallet.profiles as never,
    active: 0,
    avatar: null,
    busy: false,
    onSelect: jest.fn(),
    onOpenProfile: jest.fn(),
    onAdd: jest.fn(),
    ...overrides
  }
  return { ...render(<ProfileSwitcherPopover {...props} />), props }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockWallet.profilesSupported = true
  mockWallet.switchingProfile = false
})

describe('ProfileSwitcherPopover', () => {
  it('lists every profile with the active one selected and the network shown off mainnet', () => {
    const { getByTestId, getByText } = renderPopover()
    expect(getByText('profile1')).toBeTruthy()
    expect(getByText('profile2')).toBeTruthy()
    expect(getByText('testnet')).toBeTruthy()
    expect(getByTestId('profile-row-0').props.accessibilityState).toMatchObject({ selected: true })
    expect(getByTestId('profile-row-1').props.accessibilityState).toMatchObject({ selected: false })
  })

  it('shows a private name where there is one, in the row and in its accessibility label', () => {
    const profiles = [
      { index: 0, network: 'main' },
      { index: 1, network: 'test', name: 'Savings' }
    ] as never
    const { getByTestId, getByText, queryByText } = renderPopover({ profiles })
    expect(getByText('profile1')).toBeTruthy()
    expect(getByText('Savings')).toBeTruthy()
    // The name replaces the default; it is not shown beside it.
    expect(queryByText('profile2')).toBeNull()
    expect(getByTestId('profile-row-1').props.accessibilityLabel).toBe('Savings, testnet')
    expect(getByTestId('profile-row-0').props.accessibilityLabel).toBe('profile1')
  })

  it('hides a removed profile, leaving the others on their own numbers', () => {
    const profiles = [
      { index: 0, network: 'main' },
      { index: 1, network: 'main', deleted: true },
      { index: 2, network: 'main' }
    ] as never
    const { getByText, queryByTestId, queryByText } = renderPopover({ profiles, active: 2 })
    expect(queryByTestId('profile-row-1')).toBeNull()
    expect(queryByText('profile2')).toBeNull()
    expect(getByText('profile1')).toBeTruthy()
    expect(getByText('profile3')).toBeTruthy()
  })

  it('the active row opens Profile; another row switches; Add adds', () => {
    const { getByTestId, props } = renderPopover()
    fireEvent.press(getByTestId('profile-row-0'))
    expect(props.onOpenProfile).toHaveBeenCalledTimes(1)
    expect(props.onSelect).not.toHaveBeenCalled()
    fireEvent.press(getByTestId('profile-row-1'))
    expect(props.onSelect).toHaveBeenCalledWith(1)
    fireEvent.press(getByTestId('profile-add'))
    expect(props.onAdd).toHaveBeenCalledTimes(1)
  })

  it('is inert while a build is in flight', () => {
    const { getByTestId, props } = renderPopover({ busy: true })
    fireEvent.press(getByTestId('profile-row-1'))
    fireEvent.press(getByTestId('profile-add'))
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onAdd).not.toHaveBeenCalled()
  })
})

describe('switch cover', () => {
  it('covers the screen with the target profile while a switch runs, and the card is gone', () => {
    const { getByTestId, getByText, queryByTestId } = renderPopover({ switchingTo: 1 })
    expect(getByTestId('profile-switch-cover')).toBeTruthy()
    expect(getByText('switching:profile2')).toBeTruthy()
    expect(queryByTestId('profile-switcher')).toBeNull()
  })

  it('names the target by its private name', () => {
    const profiles = [
      { index: 0, network: 'main' },
      { index: 1, network: 'test', name: 'Savings' }
    ] as never
    const { getByText } = renderPopover({ profiles, switchingTo: 1 })
    expect(getByText('switching:Savings')).toBeTruthy()
  })

  // Add runs a transition toward the index the new profile WILL get, before the
  // store has a record for it.
  it('falls back to the default label for a profile that is not in the list yet', () => {
    const { getByText } = renderPopover({ switchingTo: 2 })
    expect(getByText('switching:profile3')).toBeTruthy()
  })

  it('says the profile is being removed, not switched to, when a removal is what runs', () => {
    const { getByText, queryByText } = renderPopover({ switchingTo: 1, removing: true })
    expect(getByText('removing:profile2')).toBeTruthy()
    expect(queryByText('switching:profile2')).toBeNull()
  })

  it('ProfileButton names the profile being removed on the cover, though no row was tapped', () => {
    // A removal starts on the Profile screen: the button never recorded a target,
    // and the active profile is the one being removed until the switch away lands.
    mockWallet.switchingProfile = true
    mockWallet.removingProfile = 1
    mockWallet.activeProfile = 1
    const { getByText } = render(<ProfileButton />)
    expect(getByText('removing:profile2')).toBeTruthy()
    mockWallet.switchingProfile = false
    mockWallet.removingProfile = null
    mockWallet.activeProfile = 0
  })

  it('ProfileButton shows the cover for as long as the wallet reports a switch', () => {
    mockWallet.switchingProfile = true
    const { getByTestId, rerender, queryByTestId } = render(<ProfileButton />)
    expect(getByTestId('profile-switch-cover')).toBeTruthy()
    mockWallet.switchingProfile = false
    rerender(<ProfileButton />)
    expect(queryByTestId('profile-switch-cover')).toBeNull()
  })
})

describe('ProfileButton', () => {
  it('opens the switcher for a mnemonic wallet, and switching runs switchProfile', () => {
    const { getByLabelText, getByTestId } = render(<ProfileButton />)
    fireEvent.press(getByLabelText('profile_switcher_a11y'))
    expect(mockPush).not.toHaveBeenCalled()
    fireEvent.press(getByTestId('profile-row-1'))
    expect(mockWallet.switchProfile).toHaveBeenCalledWith(1)
  })

  it('the active row navigates to Profile', () => {
    const { getByLabelText, getByTestId } = render(<ProfileButton />)
    fireEvent.press(getByLabelText('profile_switcher_a11y'))
    fireEvent.press(getByTestId('profile-row-0'))
    expect(mockPush).toHaveBeenCalledWith('/profile')
    expect(mockWallet.switchProfile).not.toHaveBeenCalled()
  })

  it('a recovered-key wallet has no switcher: the avatar goes straight to Profile', () => {
    mockWallet.profilesSupported = false
    const { getByLabelText, queryByTestId } = render(<ProfileButton />)
    fireEvent.press(getByLabelText('profile'))
    expect(mockPush).toHaveBeenCalledWith('/profile')
    expect(queryByTestId('profile-switcher')).toBeNull()
  })
})
