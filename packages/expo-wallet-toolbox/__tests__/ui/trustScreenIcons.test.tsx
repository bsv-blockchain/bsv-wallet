/**
 * The Trust Network list must draw a certifier's icon whichever field the
 * stored entry carries. The library type and every shipped default use
 * `iconUrl`; builds of this screen before 0.3.0 saved user-added providers
 * under `icon`. A wallet upgraded in place has both shapes side by side, so
 * the screen has to render both and converge them on save.
 *
 * Mocking follows __tests__/ui/payScreen.test.tsx: native modules the barrel
 * reaches at import time are stubbed, `t` returns its key, and only useWallet
 * is overridden on the package barrel. expo-image is stubbed to a bare host
 * component so the rendered `source` prop is visible in the JSON tree.
 */
import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }))
jest.mock('expo-local-authentication', () => ({
  getEnrolledLevelAsync: jest.fn(async () => 0),
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: false })),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 }
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  WHEN_UNLOCKED: 'wu',
  AFTER_FIRST_UNLOCK: 'afu',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'wudo'
}))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children
}))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}))
jest.mock('expo-router', () => ({ router: { back: jest.fn() } }))
// expo-image's entry is raw TypeScript that Jest does not transform; the screen
// requires it lazily for that reason, and here it becomes a plain host node.
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }))
// SvgUri fetches its document over the network; a bare host node keeps the
// test offline while still exposing the uri and onError props it receives.
jest.mock('react-native-svg', () => ({ ...jest.requireActual('react-native-svg'), SvgUri: 'SvgUri' }))

const SVG_SHAPED = {
  name: 'Sigma Identity',
  description: 'Certifies verified identity claims',
  iconUrl: 'https://auth.sigmaidentity.com/sigma-mark.svg',
  identityKey: '02250905f0383085b53409876aefbf01fc8e7fd841922dc4ce55ae035b31341e6d',
  trust: 2
}
const DEFAULT_SHAPED = {
  name: 'Who I Am',
  description: 'Certifies email, phone, and X account ownership',
  iconUrl: 'https://whoiam.bsvblockchain.tech/whoiam.png',
  identityKey: '02e7eeb3986273db6843b790a1595ed0ff1b2ae8f43ae2e7f1a0c9db4dd3fb9441',
  trust: 5
}
const LEGACY_SHAPED = {
  name: 'Legacy Cert',
  description: 'Saved by a build that wrote icon instead of iconUrl',
  icon: 'https://legacy.example/icon.png',
  identityKey: '03aa000000000000000000000000000000000000000000000000000000000000aa',
  trust: 4
}
const BARE = {
  name: 'Zeta Registry',
  description: 'No icon at all',
  identityKey: '02bb000000000000000000000000000000000000000000000000000000000000bb',
  trust: 3
}

const mockUpdateSettings = jest.fn()
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('@bsv/expo-wallet-toolbox'),
  useWallet: () => ({
    settings: {
      trustSettings: { trustLevel: 1, trustedCertifiers: [DEFAULT_SHAPED, LEGACY_SHAPED, BARE, SVG_SHAPED] }
    },
    updateSettings: mockUpdateSettings
  })
}))

import { TrustScreen, normaliseCertifier } from '../../ui/screens/TrustScreen'

type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] | null }
type Tree = Node | Node[] | string | null

function findAll(node: Tree, type: string, out: Node[] = []): Node[] {
  if (!node || typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  for (const c of node.children ?? []) findAll(c as Tree, type, out)
  return out
}

const iconUris = (tree: Tree): string[] =>
  findAll(tree, 'ExpoImage').map(n => (n.props.source as { uri: string }).uri)

describe('Trust Network certifier icons', () => {
  it('draws the icon for a default-shaped certifier that stores it as iconUrl', () => {
    const r = render(<TrustScreen />)
    expect(iconUris(r.toJSON() as Tree)).toContain(DEFAULT_SHAPED.iconUrl)
    // No initial-letter placeholder for a certifier that has an icon.
    expect(r.queryByText('W')).toBeNull()
    // Normalising on load must not read as an edit the user has to save.
    expect(r.queryByText('unsaved_changes')).toBeNull()
  })

  it('still draws the icon for an entry an older build saved under icon', () => {
    const r = render(<TrustScreen />)
    expect(iconUris(r.toJSON() as Tree)).toContain(LEGACY_SHAPED.icon)
    expect(r.queryByText('L')).toBeNull()
  })

  it('falls back to the initial only when there is no icon in either field', () => {
    const r = render(<TrustScreen />)
    expect(r.getByText('Z')).toBeTruthy()
    expect(iconUris(r.toJSON() as Tree)).toHaveLength(2)
  })

  it('draws an SVG icon with react-native-svg instead of the platform decoder', () => {
    // iOS's image decoder ignores percentage-positioned <text>, which is how
    // Sigma's mark is authored; react-native-svg's parser renders it right.
    const r = render(<TrustScreen />)
    const svgs = findAll(r.toJSON() as Tree, 'SvgUri')
    expect(svgs.map(n => n.props.uri)).toEqual([SVG_SHAPED.iconUrl])
    expect(iconUris(r.toJSON() as Tree)).not.toContain(SVG_SHAPED.iconUrl)
    expect(r.queryByText('S')).toBeNull()
    // A fetch or parse failure still ends in the letter, like a raster would.
    const svg = r.UNSAFE_root.findAllByType('SvgUri' as never)[0]
    fireEvent(svg, 'error', new Error('Unable to fetch'))
    expect(r.getByText('S')).toBeTruthy()
    expect(findAll(r.toJSON() as Tree, 'SvgUri')).toHaveLength(0)
  })

  it('falls back to the initial when the icon fails to load', () => {
    // Two shipped defaults point at .ico favicons the iOS decoder rejects, and
    // any provider can move its file: a load failure must not leave an empty
    // square where the letter used to be.
    const r = render(<TrustScreen />)
    expect(r.queryByText('W')).toBeNull()
    const image = r.UNSAFE_root
      .findAllByType('ExpoImage' as never)
      .find((i: { props: Record<string, unknown> }) => (i.props.source as { uri: string }).uri === DEFAULT_SHAPED.iconUrl)
    expect(image).toBeDefined()
    fireEvent(image!, 'error', { error: 'Unable to decode image' })
    expect(r.getByText('W')).toBeTruthy()
    expect(iconUris(r.toJSON() as Tree)).not.toContain(DEFAULT_SHAPED.iconUrl)
  })
})

describe('normaliseCertifier', () => {
  it('moves a legacy icon into iconUrl and drops the old key', () => {
    const out = normaliseCertifier(LEGACY_SHAPED)
    expect(out.iconUrl).toBe(LEGACY_SHAPED.icon)
    expect('icon' in out).toBe(false)
    expect(out).toMatchObject({
      name: LEGACY_SHAPED.name,
      description: LEGACY_SHAPED.description,
      identityKey: LEGACY_SHAPED.identityKey,
      trust: LEGACY_SHAPED.trust
    })
  })

  it('prefers iconUrl when an entry somehow carries both', () => {
    const out = normaliseCertifier({ ...DEFAULT_SHAPED, icon: 'https://other.example/x.png' })
    expect(out.iconUrl).toBe(DEFAULT_SHAPED.iconUrl)
    expect('icon' in out).toBe(false)
  })

  it('leaves an entry without any icon alone', () => {
    const out = normaliseCertifier(BARE)
    expect(out).toEqual(BARE)
    expect('iconUrl' in out).toBe(false)
    expect('icon' in out).toBe(false)
  })
})
