/**
 * The two stablecoins demo mode holds, plus the BSV opening balance.
 *
 * DEV-ONLY. Nothing here describes a real issuer, a real overlay or a real
 * asset: the genesis outpoints are obviously-fake repeated bytes so that a
 * figure from this file can never be mistaken for one from an overlay, and
 * the overlay URLs point at `.invalid`, which by RFC 2606 can never resolve.
 *
 * Naming follows the stablecoin UX spec, which uses `USDX` / "Acme Dollar" /
 * "Acme Bank" throughout; the CHF asset copies that shape rather than
 * inventing a second convention.
 */
import type { TokenAssetInfo } from '../mandala/runtime'

/** Demo overlay identity — 66 hex chars, the length a real one has. */
const DEMO_OVERLAY_KEY = '02' + 'de'.repeat(32)
const DEMO_OVERLAY_URL = 'https://overlay.demo.invalid'

export const DEMO_USD: TokenAssetInfo = {
  assetId: 'd0'.repeat(32) + '.0',
  label: 'Acme Dollar',
  ticker: 'USDX',
  decimals: 2,
  issuerName: 'Acme Bank',
  overlayUrl: DEMO_OVERLAY_URL,
  overlayIdentityKey: DEMO_OVERLAY_KEY
}

export const DEMO_CHF: TokenAssetInfo = {
  assetId: 'cf'.repeat(32) + '.0',
  label: 'Helvetia Franc',
  ticker: 'CHFX',
  decimals: 2,
  issuerName: 'Helvetia Bank',
  overlayIdentityKey: DEMO_OVERLAY_KEY,
  overlayUrl: DEMO_OVERLAY_URL
}

export const DEMO_ASSETS: TokenAssetInfo[] = [DEMO_USD, DEMO_CHF]

export function demoAssetById(assetId: string): TokenAssetInfo | undefined {
  return DEMO_ASSETS.find(a => a.assetId === assetId)
}

/** Opening BSV balance, in satoshis. 0.25 BSV — enough to read as funded. */
export const DEMO_OPENING_SATS = 25_000_000

/** Opening token balances, in base units (2 dp): 1,240.00 USDX / 860.50 CHFX. */
export const DEMO_OPENING_TOKEN_BASE_UNITS: Record<string, number> = {
  [DEMO_USD.assetId]: 124_000,
  [DEMO_CHF.assetId]: 86_050
}

/** Counterparties the demo history is transacted against. */
export const DEMO_COUNTERPARTIES = [
  { name: 'Sofia Berger', key: '02' + 'a1'.repeat(32) },
  { name: 'Marco Ferrari', key: '02' + 'b2'.repeat(32) },
  { name: 'Lena Vogt', key: '02' + 'c3'.repeat(32) },
  { name: 'Corner Store', key: '02' + 'd4'.repeat(32) }
]
