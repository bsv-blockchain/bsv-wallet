/**
 * XR-044 — two assets sharing an issuer-controlled ticker/label must still be
 * accessibly and visually distinguishable, by the one thing that cannot
 * collide: assetId. Renders the dropdown directly (a smaller, standalone
 * surface than the WalletHomeScreen wrapper walletHomeTokens.test.tsx uses)
 * since it needs none of that screen's scaffolding.
 */
import React from 'react'
import { render } from '@testing-library/react-native'
import { balanceOf } from '../__mocks__/fakeMandalaRuntime'
import type { TokenAssetInfo } from '../../core/mandala/runtime'

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  hitTargets: { minimum: 44 }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }))

import AssetSwitcherDropdown from '../../ui/components/wallet/AssetSwitcherDropdown'

// Two assets from DIFFERENT issuers, sharing the identical ticker AND label a
// malicious issuer would pick to impersonate a real one.
const REAL: TokenAssetInfo = {
  assetId: 'aa'.repeat(32) + '.0',
  label: 'Acme Dollar',
  ticker: 'USDX',
  decimals: 2,
  issuerName: 'Acme Bank',
  overlayUrl: 'https://overlay.example',
  overlayIdentityKey: '02'.padEnd(66, 'a')
}
const LOOKALIKE: TokenAssetInfo = {
  ...REAL,
  assetId: 'bb'.repeat(32) + '.0',
  issuerName: 'Not Acme At All'
}

describe('AssetSwitcherDropdown — look-alike assets (XR-044)', () => {
  it('renders two identical-ticker/label rows as accessibly distinct, by issuer + assetId fingerprint', () => {
    const s = render(
      <AssetSwitcherDropdown
        visible
        onClose={jest.fn()}
        top={0}
        balances={[balanceOf(REAL, 100_000), balanceOf(LOOKALIKE, 100_000)]}
        selected={null}
        onSelect={jest.fn()}
        bsv={{ value: '0', unit: 'BSV' }}
      />
    )

    const realLabel = s.getByLabelText(/Acme Dollar, Acme Bank/)
    const lookalikeLabel = s.getByLabelText(/Acme Dollar, Not Acme At All/)
    expect(realLabel).toBeTruthy()
    expect(lookalikeLabel).toBeTruthy()
    // The two rows' full labels must differ even though ticker AND label collide.
    expect(realLabel.props.accessibilityLabel).not.toBe(lookalikeLabel.props.accessibilityLabel)
    // Distinct assetId fingerprints on screen, not just in the accessibility tree.
    expect(s.getByText(/aaaaaaaa/)).toBeTruthy()
    expect(s.getByText(/bbbbbbbb/)).toBeTruthy()
  })

  it('never shows a fingerprint for the BSV row (no assetId to show)', () => {
    const s = render(
      <AssetSwitcherDropdown
        visible
        onClose={jest.fn()}
        top={0}
        balances={[balanceOf(REAL, 100_000)]}
        selected={null}
        onSelect={jest.fn()}
        bsv={{ value: '0', unit: 'BSV' }}
      />
    )
    expect(s.getByLabelText('BSV, Bitcoin SV, 0 BSV')).toBeTruthy()
  })
})
