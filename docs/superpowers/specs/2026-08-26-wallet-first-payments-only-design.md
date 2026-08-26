# Wallet-First, Payments-Only — Design

**Date:** 2026-08-26
**Status:** Approved for planning

## Goal

Invert the app's focus. The Wallet screen becomes the root of the navigation
stack. The in-app browser is removed entirely. The app becomes a payments-only
BSV wallet, fully renamed from "BSV Browser" to "BSV Wallet".

## Non-Goals

- The docs/ website (landing pages, i18n JSON, assetlinks.json, support pages)
  is NOT rebranded in this change. Separate follow-up task.
- No new wallet features. This change deletes and rewires; it does not add.
- `react-native-webview` stays in package.json even though nothing imports it
  after this change (explicit user decision, for possible future embedded web).

## 1. Deletion — browser subsystem (~60 files, ~12,000 lines)

Delete outright:

| Group | Files |
|---|---|
| Browser screen | `app/index.tsx` (1788 lines: WebView hosts, warm pool, tab UI, message routing) |
| Browser components | `components/browser/*` — all 17 files (AddressBar, AddressBarRow, BookmarkList, BookmarkTabs, BrowserPage, FindInPageBar, GlassPill, HistoryList, HistoryPopover, LoadProgressBar, MenuPopover, PermissionModal, SheetRouter, SuggestionsDropdown, Tabs, TabsOverview) |
| WebView substrate | `utils/webview/*` — all 12 files (bsvPaymentHandler, cwiProvider, documentStartScript, downloadHandler, errorPages, injectedPolyfills, mediaSourcePolyfill, messageRouter, messageSizeCeiling, walletByteJson, walletOrigin, walletResponseScript) |
| Stores | `stores/TabStore.tsx`, `stores/BookmarkStore.tsx`, `stores/uiStore.ts` |
| Hooks | `hooks/useHistory.ts`, `hooks/useWebAppManifest.ts`, `hooks/useAddressBarAnimation.ts`, `hooks/usePermissions.ts` |
| Utils | `utils/permissionsManager.ts` (web-page device permissions — distinct from the BRC-100 WalletPermissionsManager), `utils/permissionScript.ts`, `utils/thumbnailService.ts`, `utils/externalUrlRouter.ts`, and dead files `utils/getApps.ts`, `utils/fetchAndCacheAppData.ts`, `utils/parseAppManifest.ts` |
| Context / onboarding | `context/BrowserModeContext.tsx`, `components/onboarding/DefaultBrowserPrompt.tsx`, `components/onboarding/Web3BenefitsModal.tsx`, `components/onboarding/Web3BenefitsModalHandler.tsx` |
| Types | `shared/types/browser.ts` |
| Native plugin | `plugins/withWebBrowserEntitlement.js` plus its wiring in `app.json` and the `EXPO_NO_WEB_BROWSER_ENTITLEMENT` gate in `eas.json` |
| Tests | `__tests__/documentStartScript.test.ts`, `iframeWalletRoundTrip.test.ts`, `injectedPolyfills.test.ts`, `messageSizeCeiling.test.ts`, `walletByteJson.test.ts`, `walletOrigin.test.ts`, `walletResponseScript.test.ts`, `webAppManifest.test.ts`, `externalUrlRouter.test.ts`, `manual/manifestProbe.test.ts` |

Explicitly KEEP (shared, name-collision hazards):

- `managers.permissionsManager` — the BRC-100 `WalletPermissionsManager` from
  `context/WalletContext.tsx`. Used by pay, vault, connections, pair, settings.
- `components/ui/PermissionSheet.tsx` + `hooks/usePermissionQueue.ts` — the
  BRC-100 protocol/basket/spending/certificate approval flow.
- `utils/isImageUrl.ts` — used by `utils/validateTrust.ts` → `app/trust.tsx`.
- `components/ui/Sheet.tsx` — generic. `context/SheetContext.tsx`: delete only
  if its sole provider/consumers were in `app/index.tsx`; verify at
  implementation time.
- `react-native-webview` dependency (see Non-Goals).

## 2. Navigation

- Move `app/wallet.tsx` content to `app/index.tsx`. `/` = Wallet. Root of the
  stack, `dangerouslySingular`. Delete `app/wallet.tsx`; update all
  `router.push('/wallet')`-style call sites to `/`.
- `app/_layout.tsx`: remove BrowserModeProvider, DefaultBrowserPrompt,
  Web3BenefitsModal/Handler mounts and imports; remove the stale
  `<Stack.Screen name="config" />` entry (no `app/config.tsx` exists); update
  the screen list so `index` is the wallet.
- Existing fallbacks `router.replace('/')` in `app/pay.tsx:197` and
  `app/+not-found.tsx:8` now land on Wallet — correct by construction.
- `app/wallet.tsx:380` explorer link (`onExplorer`): replace the
  TabStore-open-in-tab logic with `Linking.openURL(whatsOnChainUrl)` (system
  browser).
- `app/settings.tsx` and `app/wallet-config.tsx`: remove `isWeb2Mode` reads and
  the settings row that toggles it.
- Deep linking:
  - `app/+native-intent.ts`: keep `peerpay:` → `/pay?...` routing; delete
    http/https → browser routing (`isExternalBrowserUrl`,
    `setPendingInitialBrowserUrl`).
  - `hooks/useDeepLinking.ts`: rewrite, slimmed to pairing
    (`bsv-wallet://pair`) and peerpay. All TabStore driving removed.

## 3. Rename — full

New identity:

| Field | Old | New |
|---|---|---|
| Display name | BSV Browser | BSV Wallet |
| Slug | bsv-browser | bsv-wallet |
| Scheme | bsv-browser:// | bsv-wallet:// |
| iOS bundle id | org.bsvassociation.browser | org.bsvassociation.wallet |
| Android package | org.bsvassociation.browser | org.bsvassociation.wallet |
| iOS project dir | ios/BSVBrowser | ios/BSVWallet |

- `app.json`: name, slug, scheme, ids; DELETE Android http/https
  VIEW/BROWSABLE intentFilters (keep `peerpay` filter); DELETE iOS
  `CFBundleURLTypes` http/https entry; trim `LSApplicationQueriesSchemes`
  (drop https/http/blob); reword usage strings (NFC, local network, location)
  to say "BSV Wallet"; remove `withWebBrowserEntitlement` from plugins.
- iOS native: regenerate via `npx expo prebuild --clean -p ios` →
  `ios/BSVWallet/`. Verify after prebuild: web-browser entitlement GONE, NFC
  entitlements PRESENT (must be carried by config plugin / app.json, not only
  by the old hand-edited entitlements files — check before deleting old dir).
- In-app strings: `appName` prop passed to `UserContextProvider` in
  `_layout.tsx`; `context/UserContext.tsx`, `context/WalletConnectionContext.tsx`
  (connection prompts), `context/theme/tokens.ts`, `utils/backupShares.ts`
  (printed QR share labels), `utils/pay/rails/address.ts`, `app/connections.tsx`.
- `package.json` name field.
- README.md rewritten wallet-first: browser/WebView/CWI-substrate/dual-mode/
  default-browser features removed from copy; payments, vault, backup, local
  payments, pairing remain.

**Accepted consequence:** new bundle id = new App Store / Play listing.
Existing installs do not upgrade in place. Old `bsv-browser://` pairing links
stop working. User explicitly chose this.

## 4. Error handling / edge cases

- Incoming http/https links: OS no longer offers the app (intent filters and
  URL types removed). No in-app handling needed.
- `+not-found.tsx` still routes unknown paths to `/` (Wallet).
- Any residual `expo-web-browser` usage: audit; keep only if something
  (e.g. OAuth-style flows) uses it, otherwise remove dep.

## 5. Testing

- Delete the 10 browser tests listed above.
- Keep and must stay green: `__tests__/pair.test.tsx`,
  `capWalletArgs.test.ts`, `useVaultBalance.test.ts`,
  `render-sanity.test.tsx`, `smoke.test.ts`.
- Gates: `npm test` green, `npx tsc --noEmit` clean, ESLint clean on changed
  files.
- Manual verification in iOS simulator: app boots to Wallet as first screen;
  pay / settings / vault / connections / transactions navigation works;
  explorer link opens system browser; peerpay deep link routes to `/pay`;
  `bsv-wallet://pair` pairing flow reachable.
