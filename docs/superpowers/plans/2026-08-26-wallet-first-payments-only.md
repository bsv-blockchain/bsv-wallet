# Wallet-First, Payments-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Wallet screen the root of the nav stack, delete the in-app browser subsystem (~12k lines), and fully rename the app from "BSV Browser" to "BSV Wallet".

**Architecture:** Expo Router file-based navigation — `app/index.tsx` is the root route. The browser screen currently occupies it; the Wallet screen (`app/wallet.tsx`) replaces it. Everything that existed only to serve the browser (WebView substrate, tab/bookmark/history stores, browser chrome components, web-page permission system, Web2/Web3 mode, default-browser onboarding and entitlement) is deleted. Deep linking shrinks to `peerpay:` and `bsv-wallet://pair`.

**Tech Stack:** React Native + Expo (expo-router, prebuild for iOS), Jest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-26-wallet-first-payments-only-design.md`

## Global Constraints

- New identity: name **BSV Wallet**, slug **bsv-wallet**, scheme **bsv-wallet**, iOS bundle id / Android package **org.bsvassociation.wallet**, iOS project dir **ios/BSVWallet**.
- KEEP `react-native-webview` in `package.json` even though unused (explicit user decision).
- KEEP the BRC-100 permission flow: `managers.permissionsManager` (WalletPermissionsManager from `context/WalletContext.tsx`), `components/ui/PermissionSheet.tsx`, `hooks/usePermissionQueue.ts`. Do NOT confuse with the deleted `utils/permissionsManager.ts` (web-page device permissions).
- KEEP `utils/isImageUrl.ts` (used by `utils/validateTrust.ts`).
- KEEP `components/ui/Sheet.tsx` (generic). DELETE `context/SheetContext.tsx` (verified: consumed only by `app/index.tsx` and `components/browser/*`).
- docs/ website (landing, i18n JSON, assetlinks) is OUT OF SCOPE.
- Verification gates for every task: `npx tsc --noEmit` clean and `npx jest` green before committing.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Wallet becomes the root route

**Files:**
- Delete: `app/index.tsx` (the 1788-line Browser screen)
- Rename: `app/wallet.tsx` → `app/index.tsx` (then edit)
- Modify: `app/_layout.tsx:143-190` (Stack screens), `app/transactions.tsx:12`, `app/pay.tsx:226`, `components/pay/PaymentSuccessOverlay.tsx:114`, `components/pay/NearbyFlow.tsx:1789`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: route `/` = Wallet screen. Route `/wallet` no longer exists — every later task must reference `/`.

- [ ] **Step 1: Swap the files**

```bash
git rm app/index.tsx
git mv app/wallet.tsx app/index.tsx
```

- [ ] **Step 2: Fix the explorer action in the new `app/index.tsx`**

Remove the import `import tabStore from '@/stores/TabStore'` (old wallet.tsx line 54). Add `Linking` to the existing `react-native` import block (lines 21-29). Replace the body of `onExplorer` (old lines 370-388) with:

```tsx
  /** Open the transaction on a block explorer in the system browser. */
  const onExplorer = useCallback(
    (txid: string) => {
      const base =
        selectedNetwork === 'main'
          ? 'https://whatsonchain.com'
          : selectedNetwork === 'teratest'
            ? 'https://woc-ttn.bsvblockchain.tech'
            : 'https://test.whatsonchain.com'
      Linking.openURL(`${base}/tx/${txid}`).catch(() => {
        showToast(t('explorer_open_failed', { defaultValue: 'Could not open block explorer' }), { type: 'error' })
      })
    },
    [selectedNetwork, t]
  )
```

No navigation: the user stays on the Wallet while the OS opens the link.

- [ ] **Step 3: Update the Stack in `app/_layout.tsx`**

In the `<Stack>` block (lines 143-190):
- Delete the long "One Browser, ever" comment (lines 153-170) and replace with:

```tsx
                            {/* The Wallet (index) takes no params, so there is only
                                one identity to collapse — `dangerouslySingular` keeps
                                repeated navigations to '/' returning to the existing
                                screen instead of stacking live duplicates. */}
```

- Change `<Stack.Screen name="index" dangerouslySingular options={{ orientation: 'default' }} />` (line 171) to `<Stack.Screen name="index" dangerouslySingular />` (the wallet stays portrait like every other screen; the orientation escape hatch existed for the browser).
- Delete `<Stack.Screen name="config" />` (line 172 — no `app/config.tsx` exists).
- Delete `<Stack.Screen name="wallet" dangerouslySingular />` (line 175).
- In `screenOptions` (line 149-150), update the comment `// the Browser (index, below) follows the device.` — the whole two-line comment becomes `// Every screen stays upright.`

- [ ] **Step 4: Point old `/wallet` references at `/`**

- `app/transactions.tsx:12`: `return <Redirect href="/wallet" />` → `return <Redirect href="/" />`
- `app/pay.tsx:226`: `router.dismissTo('/wallet')` → `router.dismissTo('/')`
- `components/pay/PaymentSuccessOverlay.tsx:114`: `router.dismissTo('/wallet')` → `router.dismissTo('/')`
- `components/pay/NearbyFlow.tsx:1789`: `router.dismissTo('/wallet')` → `router.dismissTo('/')`

Then verify nothing else references the dead route:

```bash
grep -rn "'/wallet'" --include='*.ts' --include='*.tsx' app components hooks context utils | grep -v wallet-config
```

Expected: no output.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx jest`
Expected: tsc clean. Jest: the 10 browser tests still pass (their sources still exist); `render-sanity`, `pair`, `smoke`, `capWalletArgs`, `useVaultBalance` pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(nav): wallet is the root screen

The Browser screen is deleted; app/wallet.tsx becomes app/index.tsx.
The explorer row action opens WhatsOnChain in the system browser
instead of an in-app tab. All /wallet route references now point
at /.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Deep linking — peerpay and pairing only

**Files:**
- Rewrite: `app/+native-intent.ts`, `hooks/useDeepLinking.ts`
- Modify: `app/connections.tsx:40,108`
- Delete: `utils/externalUrlRouter.ts`, `__tests__/externalUrlRouter.test.ts`

**Interfaces:**
- Consumes: route `/` = Wallet (Task 1).
- Produces: `useDeepLinking(): void` (same export name, consumed by `app/_layout.tsx`'s `DeepLinkHandler`). Pairing scheme is now `bsv-wallet://pair`.

- [ ] **Step 1: Rewrite `app/+native-intent.ts`**

Replace the whole file with:

```ts
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path?.toLowerCase().startsWith('peerpay:')) {
      return `/pay?cell=pay-handle&peerpay=${encodeURIComponent(path)}`
    }
    return path || '/'
  } catch {
    return '/'
  }
}
```

- [ ] **Step 2: Rewrite `hooks/useDeepLinking.ts`**

Replace the whole file with:

```ts
import { useCallback, useEffect } from 'react'
import { Linking } from 'react-native'
import { router } from 'expo-router'

/**
 * Deep linking for a payments-only wallet:
 *  - peerpay:            → /pay (PeerPay payment handles)
 *  - bsv-wallet://pair   → /connections (pairing QR codes scanned outside the app)
 */
export function useDeepLinking() {
  const handlePeerPayLink = useCallback((url: string) => {
    router.replace({ pathname: '/pay', params: { cell: 'pay-handle', peerpay: url } })
  }, [])

  /**
   * Handle bsv-wallet://pair?topic=...&backendIdentityKey=...&protocolID=...&origin=...&expiry=...&sig=...
   * Parses pairing parameters and navigates to /connections with them.
   */
  const handlePairingLink = useCallback((url: string) => {
    try {
      // URL constructor needs a host to parse search params
      const parsed = new URL(url.replace('bsv-wallet://', 'bsv-wallet://host/'))
      const get = (key: string) => parsed.searchParams.get(key) ?? undefined

      const topic = get('topic')
      const backendIdentityKey = get('backendIdentityKey')
      const protocolID = get('protocolID')
      const origin = get('origin')
      const expiry = get('expiry')
      const sig = get('sig')

      if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
        console.warn('[Deep Link] Pairing link missing required params, ignoring:', url)
        return
      }

      router.push({
        pathname: '/connections',
        params: { topic, backendIdentityKey, protocolID, origin, expiry, sig }
      })
    } catch (error) {
      console.error('[Deep Link] Error handling pairing link:', error)
    }
  }, [])

  useEffect(() => {
    let active = true

    const handleUrl = (url: string) => {
      if (!url) return
      if (url.startsWith('bsv-wallet://pair')) {
        handlePairingLink(url)
      } else if (url.toLowerCase().startsWith('peerpay:')) {
        handlePeerPayLink(url)
      }
    }

    Linking.getInitialURL()
      .then(url => {
        if (active && url) handleUrl(url)
      })
      .catch(error => console.error('[Deep Link] Failed to read initial URL:', error))

    const subscription = Linking.addEventListener('url', event => handleUrl(event.url))
    return () => {
      active = false
      subscription.remove()
    }
  }, [handlePairingLink, handlePeerPayLink])
}
```

Note: the old file's deprecated exports (`setPendingUrl`, `getPendingUrl`, `clearPendingUrl`) are dropped. Verify nothing imports them:

```bash
grep -rn "setPendingUrl\|getPendingUrl\|clearPendingUrl" --include='*.ts' --include='*.tsx' app components hooks context utils services
```

Expected: no output.

- [ ] **Step 3: Update the pairing scheme in `app/connections.tsx`**

- Line 40: `if (url.protocol !== 'bsv-browser:') return { params: null, error: 'Not a bsv-browser:// URI' }` → `if (url.protocol !== 'bsv-wallet:') return { params: null, error: 'Not a bsv-wallet:// URI' }`
- Line 108: the template literal starting `` `bsv-browser://pair?topic=...` `` → change prefix to `bsv-wallet://pair`.
- Search the file for any other `bsv-browser` occurrences and update them:

```bash
grep -n "bsv-browser" app/connections.tsx
```

Expected after edits: no output.

- [ ] **Step 4: Delete the external URL router**

```bash
git rm utils/externalUrlRouter.ts __tests__/externalUrlRouter.test.ts
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx jest`
Expected: clean/green. `__tests__/pair.test.tsx` must still pass — if it asserts on the `bsv-browser://` scheme, update the fixture to `bsv-wallet://`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(deeplink): drop http/https handling, pairing scheme becomes bsv-wallet://

Deep links now cover only peerpay: payment handles and
bsv-wallet://pair pairing QR codes. The external-browser URL router
is gone with the browser.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Remove Web2/Web3 mode and browser onboarding

**Files:**
- Delete: `context/BrowserModeContext.tsx`, `components/onboarding/DefaultBrowserPrompt.tsx`, `components/onboarding/Web3BenefitsModal.tsx`, `components/onboarding/Web3BenefitsModalHandler.tsx`
- Modify: `app/_layout.tsx`, `app/settings.tsx:7,24,94`, `app/wallet-config.tsx:9,56,450,454`

**Interfaces:**
- Consumes: nothing.
- Produces: `useBrowserMode`/`isWeb2Mode` no longer exist anywhere.

- [ ] **Step 1: Strip `app/_layout.tsx`**

- Delete imports: `DefaultBrowserPrompt` (line 30), `BrowserModeProvider` (line 32), `Web3BenefitsModalHandler` (line 33).
- Delete JSX: `<BrowserModeProvider>` open/close (lines 128, 196), `<Web3BenefitsModalHandler />` (line 136), `<DefaultBrowserPrompt />` (line 138).
- Delete the commented-out `DebuggerDisplay` block (lines 97-112) — it references `useBrowserMode`.

- [ ] **Step 2: Strip `app/settings.tsx`**

- Delete line 7 import and line 24 `const { isWeb2Mode } = useBrowserMode()`.
- Line 94: unwrap the `{!isWeb2Mode && ( ... )}` conditional around the Balance block — the balance always renders now. Keep the inner `<View style={localStyles.balanceContainer}>...</View>` as-is.

- [ ] **Step 3: Strip `app/wallet-config.tsx`**

- Delete line 9 import and line 56 `const { isWeb2Mode } = useBrowserMode()`.
- Line 450: `onPress={isWeb2Mode ? undefined : () => setNetworkExpanded(e => !e)}` → `onPress={() => setNetworkExpanded(e => !e)}`
- Line 454: `{networkExpanded && !isWeb2Mode && (` → `{networkExpanded && (`
- Check for any other `isWeb2Mode` uses in the file and remove the web2 branch (keeping the web3/full behavior):

```bash
grep -n "isWeb2Mode" app/wallet-config.tsx app/settings.tsx
```

Expected after edits: no output.

- [ ] **Step 4: Delete the files**

```bash
git rm context/BrowserModeContext.tsx components/onboarding/DefaultBrowserPrompt.tsx components/onboarding/Web3BenefitsModal.tsx components/onboarding/Web3BenefitsModalHandler.tsx
```

- [ ] **Step 5: Verify**

```bash
grep -rn "BrowserMode\|Web3Benefits\|DefaultBrowserPrompt" --include='*.ts' --include='*.tsx' app components hooks context utils services stores
```

Expected: no output. Then `npx tsc --noEmit && npx jest` — clean/green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: remove Web2/Web3 mode and default-browser onboarding

A payments-only wallet has one mode. The balance in settings and the
network switcher in wallet-config are no longer gated.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Delete the browser subsystem

**Files (all deletions):**
- `components/browser/` — entire directory (17 files)
- `utils/webview/` — entire directory (12 files)
- `stores/TabStore.tsx`, `stores/BookmarkStore.tsx`, `stores/uiStore.ts`
- `hooks/useHistory.ts`, `hooks/useWebAppManifest.ts`, `hooks/useAddressBarAnimation.ts`, `hooks/usePermissions.ts`
- `utils/permissionsManager.ts`, `utils/permissionScript.ts`, `utils/thumbnailService.ts`, `utils/getApps.ts`, `utils/fetchAndCacheAppData.ts`, `utils/parseAppManifest.ts`
- `context/SheetContext.tsx`
- `shared/types/browser.ts`
- Tests: `__tests__/documentStartScript.test.ts`, `__tests__/iframeWalletRoundTrip.test.ts`, `__tests__/injectedPolyfills.test.ts`, `__tests__/messageSizeCeiling.test.ts`, `__tests__/walletByteJson.test.ts`, `__tests__/walletOrigin.test.ts`, `__tests__/walletResponseScript.test.ts`, `__tests__/webAppManifest.test.ts`, `__tests__/manual/manifestProbe.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (removed every importer of these files).
- Produces: nothing — pure deletion.

- [ ] **Step 1: Pre-flight — prove nothing living imports the doomed files**

```bash
grep -rn "components/browser\|utils/webview\|stores/TabStore\|stores/BookmarkStore\|stores/uiStore\|hooks/useHistory\|useWebAppManifest\|useAddressBarAnimation\|hooks/usePermissions\|utils/permissionsManager\|utils/permissionScript\|thumbnailService\|utils/getApps\|fetchAndCacheAppData\|parseAppManifest\|SheetContext\|shared/types/browser" --include='*.ts' --include='*.tsx' app components hooks context utils services stores shared storage | grep -v "^components/browser\|^utils/webview\|^stores/TabStore\|^stores/BookmarkStore\|^stores/uiStore\|^hooks/useHistory\|^hooks/useWebAppManifest\|^hooks/useAddressBarAnimation\|^hooks/usePermissions\|^utils/permissionsManager\|^utils/permissionScript\|^utils/thumbnailService\|^utils/getApps\|^utils/fetchAndCacheAppData\|^utils/parseAppManifest\|^context/SheetContext"
```

Expected: no output (matches only inside the files being deleted). If anything else shows up, STOP — fix that call site first (the Explore pass says there are none, but verify).

- [ ] **Step 2: Delete**

```bash
git rm -r components/browser utils/webview
git rm stores/TabStore.tsx stores/BookmarkStore.tsx stores/uiStore.ts
git rm hooks/useHistory.ts hooks/useWebAppManifest.ts hooks/useAddressBarAnimation.ts hooks/usePermissions.ts
git rm utils/permissionsManager.ts utils/permissionScript.ts utils/thumbnailService.ts utils/getApps.ts utils/fetchAndCacheAppData.ts utils/parseAppManifest.ts
git rm context/SheetContext.tsx shared/types/browser.ts
git rm __tests__/documentStartScript.test.ts __tests__/iframeWalletRoundTrip.test.ts __tests__/injectedPolyfills.test.ts __tests__/messageSizeCeiling.test.ts __tests__/walletByteJson.test.ts __tests__/walletOrigin.test.ts __tests__/walletResponseScript.test.ts __tests__/webAppManifest.test.ts __tests__/manual/manifestProbe.test.ts
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx jest && npx eslint app components hooks context utils stores shared`
Expected: all clean. Remaining test suites: `pair`, `capWalletArgs`, `useVaultBalance`, `render-sanity`, `smoke` (plus any untouched others) — all green.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat!: delete the in-app browser subsystem

Removes the WebView substrate (CWI provider, injected polyfills,
message router), browser chrome, tab/bookmark/history stores, the
web-page device-permission system, and their tests — ~12k lines.
The BRC-100 WalletPermissionsManager flow is untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Rename — config, strings, dependencies

**Files:**
- Modify: `app.json`, `package.json`, `eas.json`, `app/_layout.tsx:125`, `context/UserContext.tsx:85`, `context/WalletConnectionContext.tsx:356,408`, `context/theme/tokens.ts:2`, `utils/backupShares.ts:245`
- Delete: `plugins/withWebBrowserEntitlement.js`

**Interfaces:**
- Consumes: Tasks 1-4 done (no browser code left to reference old names).
- Produces: the identity in Global Constraints. Task 6 prebuild reads `app.json`.

- [ ] **Step 1: `app.json`**

- `"name": "BSV Browser"` → `"BSV Wallet"`; `"slug": "bsv-browser"` → `"bsv-wallet"`; `"scheme": "bsv-browser"` → `"bsv-wallet"`.
- Remove `"./plugins/withWebBrowserEntitlement"` from `plugins` (line 16). Remove `"expo-web-browser"` from `plugins` (line 46).
- `android.package`: `org.bsvassociation.browser` → `org.bsvassociation.wallet`.
- `android.intentFilters`: delete the first filter (http/https VIEW/BROWSABLE with `autoVerify`); keep the `peerpay` filter.
- `ios.bundleIdentifier`: `org.bsvassociation.browser` → `org.bsvassociation.wallet`.
- `ios.infoPlist.CFBundleURLTypes`: delete the `org.bsvassociation.browser.web` entry (https/http). Rename the remaining two: `org.bsvassociation.browser.peerpay` → `org.bsvassociation.wallet.peerpay`; `org.bsvassociation.browser.pair` → `org.bsvassociation.wallet.pair` with `CFBundleURLSchemes: ["bsv-wallet"]`.
- `ios.infoPlist.LSApplicationQueriesSchemes`: remove `https`, `http`, `blob`. Keep `data` only if something still opens `data:` URLs — nothing does after Task 4, so delete the whole key.
- Usage strings: in `NSLocationWhenInUseUsageDescription`, `NSLocalNetworkUsageDescription`, `NFCReaderUsageDescription`, replace "BSV Browser" with "BSV Wallet".
- Keep: NFC select-identifiers, NSBonjourServices, camera/photo/mic/FaceID strings, `withNfcReaderEntitlement` plugin, everything else.

- [ ] **Step 2: `eas.json` and the entitlement plugin**

- Remove every `EXPO_NO_WEB_BROWSER_ENTITLEMENT` env entry from `eas.json`.
- `git rm plugins/withWebBrowserEntitlement.js`

- [ ] **Step 3: `package.json`**

- `"name": "bsv-browser"` → `"bsv-wallet"`.
- Remove dependencies: `@callstack/liquid-glass`, `react-native-permissions`, `expo-web-browser` (verified: after Task 4 nothing imports any of them).
- KEEP `react-native-webview` (Global Constraints).
- Run `npm install` to refresh `package-lock.json`.

- [ ] **Step 4: In-app strings**

- `app/_layout.tsx:125`: `appName="BSV Browser"` → `appName="BSV Wallet"`.
- `context/UserContext.tsx:85`: default `appName = 'BSV Browser'` → `'BSV Wallet'`.
- `context/WalletConnectionContext.tsx:356` and `:408`: `walletMeta: { name: 'BSV Browser', platform: 'mobile' }` → `name: 'BSV Wallet'`.
- `context/theme/tokens.ts:2`: comment "…for the BSV Browser." → "…for BSV Wallet."
- `utils/backupShares.ts:245`: recovery instruction `<p>To recover: In BSV Browser, go to Enable Web3 → Import Existing Wallet → Scan Backup Shares.</p>` — the "Enable Web3" path no longer exists. Replace with: `<p>To recover: In BSV Wallet, go to Import Existing Wallet &rarr; Scan Backup Shares.</p>` — then open the surrounding file and confirm the named menu path matches the actual post-change onboarding flow (`app/auth/scan-shares.tsx` is the scanner); adjust wording to the real path if it differs.
- Sweep for stragglers in app code (docs/, funding-app/, GROK_REVIEW.md, BENCHMARKS.md are out of scope):

```bash
grep -rn -i "bsv.browser" --include='*.ts' --include='*.tsx' --include='*.json' app components hooks context utils services stores shared storage types package.json app.json eas.json
```

Expected: no output (i18n translation files under `context/i18n` or similar: update any "BSV Browser" strings to "BSV Wallet" in ALL languages — the English source string plus its translations; browser-feature-only strings that no screen references anymore may be deleted).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx jest`
Expected: clean/green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat!: rename BSV Browser to BSV Wallet

New slug bsv-wallet, scheme bsv-wallet://, bundle id / package
org.bsvassociation.wallet. Drops the http/https intent filters, URL
types, the web-browser entitlement plugin, and the now-unused
liquid-glass, react-native-permissions, and expo-web-browser deps.

BREAKING: new bundle id = new store listing; existing installs do not
upgrade in place, and old bsv-browser:// pairing links stop working.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Regenerate iOS native project

**Files:**
- Regenerate: `ios/` (entire directory — `ios/BSVBrowser*` becomes `ios/BSVWallet*`)

**Interfaces:**
- Consumes: Task 5's `app.json`.
- Produces: buildable iOS project for `org.bsvassociation.wallet`.

- [ ] **Step 1: Record what must survive**

Before regenerating, note from `ios/BSVBrowser/BSVBrowser.entitlements`: the NFC reader session formats entitlement (`com.apple.developer.nfc.readersession.formats`). It must reappear post-prebuild via `plugins/withNfcReaderEntitlement.js`. Read that plugin first and confirm it injects the entitlement; if it does not (i.e. the old entitlements were hand-edited), extend the plugin BEFORE running prebuild.

- [ ] **Step 2: Regenerate**

```bash
npx expo prebuild --clean -p ios
```

This deletes `ios/` and regenerates as `ios/BSVWallet/` from `app.json`.

- [ ] **Step 3: Verify the regenerated project**

```bash
ls ios/
grep -A3 "web-browser" ios/BSVWallet/*.entitlements || echo "web-browser entitlement gone (good)"
grep -B2 -A5 "nfc" ios/BSVWallet/*.entitlements
grep -A10 "CFBundleURLTypes" ios/BSVWallet/Info.plist
grep -c "BSV Wallet" ios/BSVWallet/Info.plist
```

Expected: dir is `BSVWallet`; NO `com.apple.developer.web-browser` key; NFC entitlements present; URL types contain only `peerpay` and `bsv-wallet`; usage strings say "BSV Wallet".

- [ ] **Step 4: Build check**

Run the iOS simulator build the project normally uses (e.g. `npx expo run:ios` or the EAS/simulator build script in `package.json` — check `scripts` and use the established one). Expected: compiles and boots.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(ios): regenerate native project as BSVWallet

expo prebuild --clean from the renamed app.json. Web-browser
entitlement gone; NFC entitlements carried by the config plugin.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: README rewrite

**Files:**
- Rewrite: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Rewrite**

Title becomes `# BSV Wallet`. Opening paragraph: a self-custodial BSV payments wallet for iOS and Android (React Native + Expo). Remove from the features list and all sections: WebView substrate, Web2/Web3 dual mode, CWI provider for web apps, permission-gated web-app access, default-browser role, deep linking for http/https, browsing. Keep: self-custodial wallet (BIP-39, SQLite), peer-to-peer payments via MessageBox, Local Payments over BLE, P2PKH address payments, trust/identity management, Shamir backup shares, database import/export, multi-network, ARC SSE monitoring, vault (NFC/YubiKey), languages. Update the clone URL if the repo name shown is `bsv-browser` (leave the actual remote alone — just don't assert a wrong URL; use the current `git remote get-url origin` value). Update any `bsv-browser://` examples to `bsv-wallet://`. Keep Prerequisites/Getting Started/Scripts sections, updated for accuracy (e.g. project structure no longer lists `components/browser`).

- [ ] **Step 2: Verify**

```bash
grep -n -i "browser" README.md
```

Expected: only legitimate mentions ("system browser" for explorer links, if any).

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: rewrite README for BSV Wallet, payments-only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full static + test gates**

```bash
npx tsc --noEmit
npx jest
npx eslint .
```

Expected: all clean/green.

- [ ] **Step 2: Dead-reference sweep**

```bash
grep -rn -i "bsv.browser\|BrowserMode\|tabStore\|TabStore\|useBrowserMode\|externalUrlRouter" --include='*.ts' --include='*.tsx' app components hooks context utils services stores shared storage types
```

Expected: no output.

- [ ] **Step 3: Simulator smoke test**

Boot the app in the iOS simulator. Verify:
1. First screen is the Wallet (balance → Pay / Get paid / Vault → activity).
2. Pay, settings, wallet-config, vault, connections, transactions (redirects to `/`) all navigate and return.
3. An activity row's explorer action opens WhatsOnChain in Safari, app stays on Wallet.
4. Deep link `xcrun simctl openurl booted "peerpay:test"` routes to /pay.
5. Deep link `xcrun simctl openurl booted "bsv-wallet://pair?topic=t&backendIdentityKey=k&protocolID=p&origin=o&expiry=1"` routes to /connections.
6. Settings shows the balance unconditionally; wallet-config network switcher expands.

- [ ] **Step 4: Report**

No commit. Report results — any failure goes back to its owning task.
