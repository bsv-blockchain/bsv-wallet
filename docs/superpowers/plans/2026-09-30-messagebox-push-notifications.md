# MessageBox Payment Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a system notification on iOS and Android when a payment lands in the user's MessageBox inbox, including when the app is backgrounded or killed, and credit it when the user opens the app.

**Architecture:** The MessageBox server already stores FCM device tokens (`registerDevice`) and sends pushes through `firebase-admin`; a separate server plan (`2026-09-30-messagebox-server-payment-push.md`) makes it push for `payment_inbox` and `mandala-payments`. On the wallet side, `@bsv/expo-wallet-toolbox` gets a host-supplied `PushAdapter` seam (no Firebase import inside the package), a registration sync, a one-time permission advisory on **Get paid › Share remote link**, and tap/foreground handling that reuses `TaskCreditInbox`. The app implements the adapter with `@react-native-firebase/messaging`. No wallet key material ever leaves the main app; the notification text is generic.

**Tech Stack:** Expo SDK 57 / RN 0.86.3, `@react-native-firebase/app` + `@react-native-firebase/messaging` (22.x+), `@bsv/message-box-client` 2.5.3 (`registerDevice`, `listenForLivePayments`), jest.

**Spec:** Tracker doc "Real-time Payment Notifications — Feature Tracker", https://claude.ai/code/artifact/35f53cc9-4547-4a35-a61a-f9d6fecbb818 (engineering tasks E2–E12; E1 is the server plan).

## Global Constraints

- Scope is MessageBox delivery only (`payment_inbox`, `mandala-payments`). Address-to-address payments get no push, no background task, no server watcher.
- Notification text is generic ("Payment received"). No amount, no key material, no wallet snapshot in any extension, App Group, or push payload.
- Permission is requested ONLY the first time the user picks **Share remote link** on **Get paid** (`RequestHub` → `onPick('get-handle')`), preceded by an in-app advisory modal. Never at launch, never anywhere else. Ask once; remember the answer. Settings offers a way to turn it on later.
- Production MessageBox host: `https://messagebox.bsvblockchain.tech`.
- The user-set MessageBox URL setting stays as-is (it is removed next version); do not design around custom hosts.
- `@bsv/expo-wallet-toolbox` must not import Firebase or read `process.env` (host config seam: `configureToolbox`).
- Firebase config files are committed at the repo root: `GoogleService-Info.plist`, `google-services.json` (Firebase project `bsv-wallet-a8f1d`).
- Bundle ID / package: `org.bsvblockchain.wallet`. Apple team `SV8SWTHA2H`.
- `SWEEP_INTERVAL_MS` becomes `5_000`, foreground-only as today.
- Every new user-visible string is added in all 12 locales in `packages/expo-wallet-toolbox/core/i18n/translations.tsx` (translation parity test enforces it).
- Formatting: run targeted `npx prettier --write <files>` only — never `npm run fix` (rewrites ~364 files).
- Deviation from tracker E2: do NOT add `expo-notifications`. It installs its own `UNUserNotificationCenter` delegate on iOS, which conflicts with RN Firebase messaging. RN Firebase alone covers token, permission (iOS), tap and foreground events; Android 13+ permission uses `PermissionsAndroid`.
- Do not port the old bsv-browser `with-fcm-headless` / `with-fcm-manifest-fixes` plugins; RN Firebase 22's own Expo plugin and manifest merge register the messaging service. Task 6 verifies the merged manifest instead.

## Review Focus

1. **Token rotates or identity changes while app is closed** — on next launch the device must re-register, not rely on the cached "already registered" marker. Test in Task 4 (`re-registers when token changes`, `re-registers when identity changes`).
2. **Permission denied at the OS prompt** — the link flow must still continue and the advisory must never show again; registration must not be attempted. Tests in Task 3 and Task 4 (`skips when permission not granted`).
3. **Tap on a notification from a cold start** — `getInitialNotification()` must be consumed once, route to Activity, and trigger an inbox pass; it must not re-fire on every foreground. Test in Task 7 (`consumes initial notification once`).
4. **Push arrives while app is foreground on Receive screen** — no system banner, no duplicate toast (existing `isReceiveInboxFocused()` suppression still applies). Test in Task 7 (`foreground message only requests an inbox pass`).
5. **MessageBox host unreachable / registerDevice throws** — must not crash, must not write the cache marker, must retry on the next trigger. Test in Task 4 (`does not cache on failure`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `GoogleService-Info.plist`, `google-services.json` (root) | Firebase app config, committed |
| `packages/expo-wallet-toolbox/core/push/types.ts` | `PushAdapter` interface + `PushPermission` type |
| `packages/expo-wallet-toolbox/core/toolboxConfig.ts` | add `push?: PushAdapter` to `ToolboxConfig`, `getPushAdapter()` |
| `packages/expo-wallet-toolbox/core/push/pushAdvisory.ts` | "advisory already shown" device flag (mirrors `nearbyAdvisory.ts`) |
| `packages/expo-wallet-toolbox/core/push/registration.ts` | `syncPushRegistration()` — idempotent registerDevice with cache marker |
| `packages/expo-wallet-toolbox/core/push/events.ts` | `attachPushHandlers()` — tap / foreground / token-refresh wiring |
| `packages/expo-wallet-toolbox/ui/components/pay/NotificationAdvisoryModal.tsx` | the pre-permission modal |
| `packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx` | show advisory on first `get-handle` |
| `packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx` | "Payment notifications" row |
| `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` | call sync + attach handlers once the wallet is up |
| `packages/expo-wallet-toolbox/core/pay/sweeper.ts` | 5 s interval |
| `packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx` | live listener with poll fallback |
| `utils/push/firebasePushAdapter.ts` (app) | RN Firebase implementation of `PushAdapter` |
| `index.js` (app) | `setBackgroundMessageHandler` no-op before app registration |
| `app/_layout.tsx` (app) | pass `push: firebasePushAdapter` to `configureToolbox` |
| `app.json`, `firebase.json`, `ios/` | plugins, entitlements, background mode, Android permission |

Tests live in `packages/expo-wallet-toolbox/__tests__/push/`. Run with `npx jest packages/expo-wallet-toolbox/__tests__/push`.

---

### Task 1: Commit Firebase config files and wire them into app.json

**Files:**
- Create: `GoogleService-Info.plist`, `google-services.json` (copied from `~/Downloads`)
- Modify: `app.json` (`expo.ios.googleServicesFile`, `expo.android.googleServicesFile`)

**Interfaces:** Produces the two files at repo root that Task 6's Expo plugins read.

- [ ] **Step 1: Copy and verify the files**

```bash
cp ~/Downloads/GoogleService-Info.plist ~/Downloads/google-services.json .
plutil -extract BUNDLE_ID raw GoogleService-Info.plist   # expect org.bsvblockchain.wallet
python3 -c "import json;d=json.load(open('google-services.json'));print(d['project_info']['project_id'])"  # expect bsv-wallet-a8f1d
```

- [ ] **Step 2: Point app.json at them**

In `app.json`, add inside `expo.ios`: `"googleServicesFile": "./GoogleService-Info.plist"`, and inside `expo.android`: `"googleServicesFile": "./google-services.json"`.

- [ ] **Step 3: Commit**

```bash
git add GoogleService-Info.plist google-services.json app.json
git commit -m "chore(push): add Firebase config for bsv-wallet-a8f1d"
```

Note for the commit body: these files hold Firebase client identifiers, not secrets; restrict the API key to the iOS bundle and Android package in Google Cloud Console later.

---

### Task 2: PushAdapter seam in the toolbox config

**Files:**
- Create: `packages/expo-wallet-toolbox/core/push/types.ts`
- Modify: `packages/expo-wallet-toolbox/core/toolboxConfig.ts`
- Modify: `packages/expo-wallet-toolbox/index.ts` (export types + `getPushAdapter`) — follow the existing export block for `configureToolbox`
- Test: `packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
// core/push/types.ts
export type PushPermission = 'granted' | 'denied' | 'undetermined'

export interface PushOpenedEvent {
  /** Data payload from the push (messageId, originator). */
  data: Record<string, string>
}

export interface PushAdapter {
  readonly platform: 'ios' | 'android'
  getPermission(): Promise<PushPermission>
  /** Shows the OS dialog when undetermined; resolves to the result. */
  requestPermission(): Promise<PushPermission>
  /** FCM registration token, or null when unavailable. */
  getToken(): Promise<string | null>
  onTokenRefresh(cb: (token: string) => void): () => void
  /** Tap while backgrounded. */
  onNotificationOpened(cb: (e: PushOpenedEvent) => void): () => void
  /** Tap that launched the app from killed; null when not launched by a tap. */
  getInitialNotification(): Promise<PushOpenedEvent | null>
  /** Push received while app is foreground. */
  onForegroundMessage(cb: (e: PushOpenedEvent) => void): () => void
  openSettings(): Promise<void>
}
```

```ts
// toolboxConfig.ts additions
export interface ToolboxConfig { /* existing fields */ push?: PushAdapter }
export function getPushAdapter(): PushAdapter | undefined
```

- [ ] **Step 1: Write the failing test** (append to `toolboxConfig.test.ts`)

```ts
import { configureToolbox, getPushAdapter, resetToolboxConfig } from '../core/toolboxConfig'
import type { PushAdapter } from '../core/push/types'

describe('push adapter seam', () => {
  afterEach(() => resetToolboxConfig())
  it('is undefined when the host supplies none', () => {
    configureToolbox({ backupUrl: null })
    expect(getPushAdapter()).toBeUndefined()
  })
  it('returns the adapter the host supplied', () => {
    const adapter = { platform: 'ios' } as unknown as PushAdapter
    configureToolbox({ backupUrl: null, push: adapter })
    expect(getPushAdapter()).toBe(adapter)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`getPushAdapter` not exported)

`npx jest packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts -t "push adapter seam"`

- [ ] **Step 3: Implement** — create `types.ts` as above; in `toolboxConfig.ts` add `push?: PushAdapter` to `ToolboxConfig` and to the internal `current` shape, set `push: config.push` in `configureToolbox`, clear it in `resetToolboxConfig`, and add:

```ts
/** The host's push implementation, if it wired one. The package never imports a push SDK itself. */
export function getPushAdapter(): PushAdapter | undefined {
  return current.push
}
```

- [ ] **Step 4: Run it — expect PASS**, then `npx tsc --noEmit -p packages/expo-wallet-toolbox` (baseline noise allowed; no new errors in touched files).

- [ ] **Step 5: Commit** — `feat(push): host-supplied PushAdapter seam`

---

### Task 3: Advisory-shown flag

**Files:**
- Create: `packages/expo-wallet-toolbox/core/push/pushAdvisory.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/push/pushAdvisory.test.ts`

**Interfaces:** Produces `pushAdvisory.get(): Promise<boolean>`, `pushAdvisory.set(): Promise<void>`. Key `push_advisory_shown_v1`. Device-level, not per identity (same reasoning as `core/localpay/nearbyAdvisory.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { pushAdvisory } from '../../core/push/pushAdvisory'

describe('pushAdvisory', () => {
  beforeEach(() => AsyncStorage.clear())
  it('is false until set', async () => {
    expect(await pushAdvisory.get()).toBe(false)
    await pushAdvisory.set()
    expect(await pushAdvisory.get()).toBe(true)
  })
  it('reads false when storage throws', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('boom'))
    expect(await pushAdvisory.get()).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (module missing): `npx jest packages/expo-wallet-toolbox/__tests__/push/pushAdvisory.test.ts`

- [ ] **Step 3: Implement** — copy `core/localpay/nearbyAdvisory.ts` structure verbatim with `KEY = 'push_advisory_shown_v1'`, exported as `pushAdvisory`, header comment explaining it gates the one-time notification advisory on Share remote link.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `feat(push): remember the notification advisory was shown`

---

### Task 4: Device registration sync

**Files:**
- Create: `packages/expo-wallet-toolbox/core/push/registration.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/push/registration.test.ts`

**Interfaces:**
- Consumes: `PushAdapter` (Task 2).
- Produces:

```ts
export const PUSH_REGISTRATION_KEY = 'push_registration_v1'

export interface RegisterDeviceClient {
  registerDevice(params: { fcmToken: string; platform?: 'ios' | 'android'; deviceId?: string }, overrideHost?: string): Promise<unknown>
}

export type SyncResult = 'registered' | 'unchanged' | 'skipped' | 'failed'

export async function syncPushRegistration(args: {
  adapter: PushAdapter | undefined
  host: string | undefined
  identityKey: string | undefined
  makeClient: (host: string) => RegisterDeviceClient
  storage?: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> }
}): Promise<SyncResult>
```

Behavior: `skipped` when no adapter, no host, no identity, permission ≠ `granted`, or no token. Marker = `${host}|${identityKey}|${token}`; equal to stored → `unchanged` (no network). Otherwise call `registerDevice({ fcmToken, platform }, host)`; on success store marker → `registered`; on throw → `failed`, marker untouched. Never throws.

- [ ] **Step 1: Write the failing tests**

```ts
import { syncPushRegistration, PUSH_REGISTRATION_KEY } from '../../core/push/registration'
import type { PushAdapter } from '../../core/push/types'

const mem = () => {
  const m = new Map<string, string>()
  return { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => void m.set(k, v), m }
}
const adapter = (over: Partial<PushAdapter> = {}): PushAdapter =>
  ({
    platform: 'ios',
    getPermission: async () => 'granted',
    getToken: async () => 'tok1',
    ...over
  }) as PushAdapter
const HOST = 'https://messagebox.bsvblockchain.tech'
const ID = '02'.padEnd(66, 'a')

describe('syncPushRegistration', () => {
  it('registers and caches the marker', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({ status: 'success' })
    const r = await syncPushRegistration({ adapter: adapter(), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice }), storage })
    expect(r).toBe('registered')
    expect(registerDevice).toHaveBeenCalledWith({ fcmToken: 'tok1', platform: 'ios' }, HOST)
    expect(storage.m.get(PUSH_REGISTRATION_KEY)).toBe(`${HOST}|${ID}|tok1`)
  })
  it('is unchanged on a second call', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({})
    const args = { adapter: adapter(), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice }), storage }
    await syncPushRegistration(args)
    expect(await syncPushRegistration(args)).toBe('unchanged')
    expect(registerDevice).toHaveBeenCalledTimes(1)
  })
  it('re-registers when token changes', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({})
    await syncPushRegistration({ adapter: adapter(), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice }), storage })
    const r = await syncPushRegistration({ adapter: adapter({ getToken: async () => 'tok2' }), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice }), storage })
    expect(r).toBe('registered')
  })
  it('re-registers when identity changes', async () => {
    const storage = mem()
    const registerDevice = jest.fn().mockResolvedValue({})
    await syncPushRegistration({ adapter: adapter(), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice }), storage })
    const r = await syncPushRegistration({ adapter: adapter(), host: HOST, identityKey: '03'.padEnd(66, 'b'), makeClient: () => ({ registerDevice }), storage })
    expect(r).toBe('registered')
  })
  it('skips when permission not granted', async () => {
    const registerDevice = jest.fn()
    const r = await syncPushRegistration({ adapter: adapter({ getPermission: async () => 'denied' }), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice }), storage: mem() })
    expect(r).toBe('skipped')
    expect(registerDevice).not.toHaveBeenCalled()
  })
  it('skips without adapter or host', async () => {
    const makeClient = jest.fn()
    expect(await syncPushRegistration({ adapter: undefined, host: HOST, identityKey: ID, makeClient, storage: mem() })).toBe('skipped')
    expect(await syncPushRegistration({ adapter: adapter(), host: undefined, identityKey: ID, makeClient, storage: mem() })).toBe('skipped')
    expect(makeClient).not.toHaveBeenCalled()
  })
  it('does not cache on failure', async () => {
    const storage = mem()
    const r = await syncPushRegistration({ adapter: adapter(), host: HOST, identityKey: ID, makeClient: () => ({ registerDevice: jest.fn().mockRejectedValue(new Error('503')) }), storage })
    expect(r).toBe('failed')
    expect(storage.m.has(PUSH_REGISTRATION_KEY)).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**: `npx jest packages/expo-wallet-toolbox/__tests__/push/registration.test.ts`

- [ ] **Step 3: Implement**

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { PushAdapter } from './types'

export const PUSH_REGISTRATION_KEY = 'push_registration_v1'

export interface RegisterDeviceClient {
  registerDevice(
    params: { fcmToken: string; platform?: 'ios' | 'android'; deviceId?: string },
    overrideHost?: string
  ): Promise<unknown>
}

export type SyncResult = 'registered' | 'unchanged' | 'skipped' | 'failed'

/**
 * Make sure the MessageBox host knows this device's FCM token for this
 * identity. Idempotent: the last successful (host, identity, token) triple is
 * remembered, so the common case is no network call at all. Never throws —
 * push is an enhancement and must not take any caller down with it.
 */
export async function syncPushRegistration(args: {
  adapter: PushAdapter | undefined
  host: string | undefined
  identityKey: string | undefined
  makeClient: (host: string) => RegisterDeviceClient
  storage?: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> }
}): Promise<SyncResult> {
  const { adapter, host, identityKey, makeClient } = args
  const storage = args.storage ?? AsyncStorage
  if (!adapter || !host || !identityKey) return 'skipped'
  try {
    if ((await adapter.getPermission()) !== 'granted') return 'skipped'
    const token = await adapter.getToken()
    if (!token) return 'skipped'
    const marker = `${host}|${identityKey}|${token}`
    if ((await storage.getItem(PUSH_REGISTRATION_KEY)) === marker) return 'unchanged'
    await makeClient(host).registerDevice({ fcmToken: token, platform: adapter.platform }, host)
    await storage.setItem(PUSH_REGISTRATION_KEY, marker)
    return 'registered'
  } catch {
    return 'failed'
  }
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `feat(push): idempotent MessageBox device registration`

---

### Task 5: Notification advisory modal on Share remote link

**Files:**
- Create: `packages/expo-wallet-toolbox/ui/components/pay/NotificationAdvisoryModal.tsx`
- Modify: `packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx` (state near `nearbyAdvisorySeen`, ~line 289; modal next to `<NearbyAdvisoryModal>`, ~line 586)
- Modify: `packages/expo-wallet-toolbox/ui/index.ts` (export beside `NearbyAdvisoryModal`, line 61)
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx` (4 keys × 12 locales)
- Test: `packages/expo-wallet-toolbox/__tests__/ui/notificationAdvisory.test.tsx`

**Interfaces:**
- Consumes: `pushAdvisory` (Task 3), `getPushAdapter()` (Task 2).
- Produces: `NotificationAdvisoryModal: React.FC<{ visible: boolean; onNotNow: () => void; onContinue: () => void }>`.

Copy (English; translate for the other 11 locales in the same style as `pay_address_watching`):
- `push_advisory_title`: "Get notified when you're paid"
- `push_advisory_body`: "Next, your phone will ask to allow notifications. This lets BSV Wallet tell you when a payment arrives, even while the app is in the background."
- `push_advisory_continue`: "Continue"
- `push_advisory_not_now`: "Not now"

Behavior in PayScreen: when `method === 'get-handle'` and the advisory has not been shown AND an adapter exists AND `getPermission()` is `'undetermined'`, show the modal over the handle flow (the flow keeps mounting underneath; it does not wait). **Continue** → `pushAdvisory.set()`, hide, then `adapter.requestPermission()` (result ignored here; Task 7's sync picks it up). **Not now** → `pushAdvisory.set()`, hide. Both paths leave the link flow running. If permission is already granted or denied, never show.

- [ ] **Step 1: Write the failing test** — render `PayScreen` gating as a pure helper so it is testable without the screen:

```ts
// in NotificationAdvisoryModal.tsx, exported
export function shouldShowNotificationAdvisory(s: {
  method: string | null
  advisorySeen: boolean | null
  permission: 'granted' | 'denied' | 'undetermined' | null
}): boolean {
  return s.method === 'get-handle' && s.advisorySeen === false && s.permission === 'undetermined'
}
```

```ts
import { shouldShowNotificationAdvisory as show } from '../../ui/components/pay/NotificationAdvisoryModal'

describe('shouldShowNotificationAdvisory', () => {
  it('shows only on first get-handle with undetermined permission', () => {
    expect(show({ method: 'get-handle', advisorySeen: false, permission: 'undetermined' })).toBe(true)
  })
  it.each([
    [{ method: 'get-nearby', advisorySeen: false, permission: 'undetermined' }],
    [{ method: 'get-address', advisorySeen: false, permission: 'undetermined' }],
    [{ method: 'get-handle', advisorySeen: true, permission: 'undetermined' }],
    [{ method: 'get-handle', advisorySeen: null, permission: 'undetermined' }],
    [{ method: 'get-handle', advisorySeen: false, permission: 'granted' }],
    [{ method: 'get-handle', advisorySeen: false, permission: 'denied' }],
    [{ method: 'get-handle', advisorySeen: false, permission: null }]
  ] as const)('hides for %j', s => expect(show(s)).toBe(false))
})
```

- [ ] **Step 2: Run — expect FAIL**: `npx jest packages/expo-wallet-toolbox/__tests__/ui/notificationAdvisory.test.tsx`

- [ ] **Step 3: Implement the modal** by copying `NearbyAdvisoryModal.tsx` (same Modal/backdrop/card/hero-icon/PressableScale structure and styles), icon `notifications-outline`, title/body/buttons from the keys above, `onRequestClose` and backdrop press → `onNotNow`. Add the helper above.

- [ ] **Step 4: Wire PayScreen**

```tsx
import { pushAdvisory } from '../../core/push/pushAdvisory'
import { getPushAdapter } from '../../core/toolboxConfig'
import { NotificationAdvisoryModal, shouldShowNotificationAdvisory } from '../components/pay/NotificationAdvisoryModal'

// beside nearbyAdvisorySeen state
const [pushAdvisorySeen, setPushAdvisorySeen] = useState<boolean | null>(null)
const [pushPermission, setPushPermission] = useState<'granted' | 'denied' | 'undetermined' | null>(null)
useEffect(() => {
  if (method !== 'get-handle' || pushAdvisorySeen !== null) return
  let cancelled = false
  const adapter = getPushAdapter()
  void Promise.all([pushAdvisory.get(), adapter ? adapter.getPermission() : Promise.resolve(null)]).then(([seen, perm]) => {
    if (cancelled) return
    setPushAdvisorySeen(seen)
    setPushPermission(perm)
  })
  return () => {
    cancelled = true
  }
}, [method, pushAdvisorySeen])

// beside <NearbyAdvisoryModal>
<NotificationAdvisoryModal
  visible={shouldShowNotificationAdvisory({ method, advisorySeen: pushAdvisorySeen, permission: pushPermission })}
  onNotNow={() => {
    void pushAdvisory.set()
    setPushAdvisorySeen(true)
  }}
  onContinue={() => {
    void pushAdvisory.set()
    setPushAdvisorySeen(true)
    void getPushAdapter()?.requestPermission().then(setPushPermission)
  }}
/>
```

- [ ] **Step 5: Add the 4 keys to all 12 locales**, then run tests: `npx jest packages/expo-wallet-toolbox/__tests__/ui/notificationAdvisory.test.tsx packages/expo-wallet-toolbox/__tests__/i18n` — expect PASS.

- [ ] **Step 6: Commit** — `feat(push): advisory before the notification prompt on Share remote link`

---

### Task 6: App-side Firebase adapter and native config

**Files:**
- Create: `utils/push/firebasePushAdapter.ts`
- Create: `firebase.json`
- Modify: `index.js` (background handler, before app registration)
- Modify: `app/_layout.tsx:66` (`configureToolbox({... push: firebasePushAdapter })`)
- Modify: `app.json` (plugins, `ios.entitlements`, `ios.infoPlist.UIBackgroundModes`, `android.permissions`, `expo-build-properties.ios.forceStaticLinking`)
- Modify: `package.json`, `package-lock.json`
- Regenerate: `ios/` via prebuild

**Interfaces:** Consumes `PushAdapter` type (Task 2). Produces `firebasePushAdapter: PushAdapter`.

- [ ] **Step 1: Install**

```bash
npx expo install @react-native-firebase/app @react-native-firebase/messaging
```

- [ ] **Step 2: app.json** — add to `plugins`: `"@react-native-firebase/app"`, `"@react-native-firebase/messaging"`. In the existing `expo-build-properties` ios block add `"forceStaticLinking": ["RNFBApp", "RNFBMessaging"]`. In `expo.ios` add `"entitlements": { "aps-environment": "development" }` (Xcode export switches it to production for App Store builds) and `"infoPlist": { "UIBackgroundModes": ["remote-notification"] }` (merge with any existing `infoPlist`). Append `"android.permission.POST_NOTIFICATIONS"` to `expo.android.permissions`.

- [ ] **Step 3: firebase.json** (root) — keep iOS from showing its own banner while foreground (the in-app toast handles that) and turn off auto-init analytics collection:

```json
{
  "react-native": {
    "messaging_ios_foreground_presentation_options": [],
    "analytics_auto_collection_enabled": false
  }
}
```

- [ ] **Step 4: Adapter**

```ts
// utils/push/firebasePushAdapter.ts
import { Linking, PermissionsAndroid, Platform } from 'react-native'
import {
  getMessaging,
  getToken,
  onTokenRefresh,
  onMessage,
  onNotificationOpenedApp,
  getInitialNotification,
  requestPermission,
  hasPermission,
  AuthorizationStatus
} from '@react-native-firebase/messaging'
import type { PushAdapter, PushPermission, PushOpenedEvent } from '@bsv/expo-wallet-toolbox'

const toEvent = (m: { data?: Record<string, unknown> } | null): PushOpenedEvent | null =>
  m ? { data: Object.fromEntries(Object.entries(m.data ?? {}).map(([k, v]) => [k, String(v)])) } : null

function fromIos(status: number): PushPermission {
  if (status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL) return 'granted'
  if (status === AuthorizationStatus.DENIED) return 'denied'
  return 'undetermined'
}

async function androidPermission(request: boolean): Promise<PushPermission> {
  if (Number(Platform.Version) < 33) return 'granted'
  const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
  if (await PermissionsAndroid.check(perm)) return 'granted'
  if (!request) return 'undetermined'
  const r = await PermissionsAndroid.request(perm)
  return r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied'
}

const m = () => getMessaging()

export const firebasePushAdapter: PushAdapter = {
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  async getPermission() {
    return Platform.OS === 'ios' ? fromIos(await hasPermission(m())) : androidPermission(false)
  },
  async requestPermission() {
    return Platform.OS === 'ios' ? fromIos(await requestPermission(m())) : androidPermission(true)
  },
  async getToken() {
    try {
      return await getToken(m())
    } catch {
      return null
    }
  },
  onTokenRefresh: cb => onTokenRefresh(m(), cb),
  onNotificationOpened: cb => onNotificationOpenedApp(m(), msg => cb(toEvent(msg)!)),
  getInitialNotification: async () => toEvent(await getInitialNotification(m())),
  onForegroundMessage: cb => onMessage(m(), msg => cb(toEvent(msg)!)),
  openSettings: () => Linking.openSettings()
}
```

Note: on Android < 13, `androidPermission(false)` returns `'granted'` (no runtime permission exists), which is correct; the advisory therefore never shows there (Task 5 requires `'undetermined'`).

- [ ] **Step 5: index.js** — before the app entry registration line, add:

```js
import { getMessaging, setBackgroundMessageHandler } from '@react-native-firebase/messaging'
// The server sends notification+data messages; the OS displays them itself.
// A registered handler stops RN Firebase warning and keeps a headless
// wake-up cheap. Crediting happens when the user opens the app.
setBackgroundMessageHandler(getMessaging(), async () => {})
```

- [ ] **Step 6: _layout.tsx** — `import { firebasePushAdapter } from '@/utils/push/firebasePushAdapter'` and add `push: firebasePushAdapter` to the `configureToolbox({...})` call at line 66.

- [ ] **Step 7: Prebuild and inspect**

```bash
npx expo prebuild --platform ios --clean
grep -n "aps-environment" ios/BSVWallet/BSVWallet.entitlements
grep -n -A3 "UIBackgroundModes" ios/BSVWallet/Info.plist
npx expo prebuild --platform android --clean
grep -n "MESSAGING_EVENT\|POST_NOTIFICATIONS" android/app/src/main/AndroidManifest.xml android/app/build/intermediates/merged_manifests -r | head
```

Expected: entitlement present, `remote-notification` in background modes, POST_NOTIFICATIONS in manifest. (`MESSAGING_EVENT` appears in the merged manifest after the first Gradle build — confirm in Task 10's device build.) Check the ios diff keeps `withNfcReaderEntitlement` output (NFC entitlement still present).

- [ ] **Step 8: Typecheck** — `npx tsc --noEmit` (baseline noise only).

- [ ] **Step 9: Commit** — `feat(push): RN Firebase messaging adapter and native config` (stage `ios/` tracked files, `app.json`, `firebase.json`, `index.js`, `app/_layout.tsx`, `utils/push/`, `package*.json`).

---

### Task 7: Wire registration and push events into WalletContext

**Files:**
- Create: `packages/expo-wallet-toolbox/core/push/events.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (after `TaskCreditInbox.noteEnqueued()` ~line 2045; AppState foreground handler ~line 3031)
- Test: `packages/expo-wallet-toolbox/__tests__/push/events.test.ts`

**Interfaces:**
- Consumes: `PushAdapter`, `syncPushRegistration`, `TaskCreditInbox.requestNow()`.
- Produces:

```ts
export function attachPushHandlers(args: {
  adapter: PushAdapter
  requestInboxPass: () => void
  openActivity: () => void
  onTokenRefresh: () => void
}): () => void
```

Behavior: `getInitialNotification()` consumed once per process (module-level flag) → `requestInboxPass()` + `openActivity()`; `onNotificationOpened` → same; `onForegroundMessage` → `requestInboxPass()` only (existing toast/sound path in `TaskCreditInbox`'s `onCredited` fires once the credit lands); `onTokenRefresh` → `onTokenRefresh()`. Returns an unsubscribe that removes all listeners.

- [ ] **Step 1: Write the failing tests**

```ts
import { attachPushHandlers, __resetInitialNotificationForTests } from '../../core/push/events'
import type { PushAdapter, PushOpenedEvent } from '../../core/push/types'

function fakeAdapter(initial: PushOpenedEvent | null) {
  const handlers: Record<string, (e?: any) => void> = {}
  const adapter = {
    platform: 'ios',
    getInitialNotification: jest.fn().mockResolvedValue(initial),
    onNotificationOpened: jest.fn(cb => ((handlers.opened = cb), () => delete handlers.opened)),
    onForegroundMessage: jest.fn(cb => ((handlers.fg = cb), () => delete handlers.fg)),
    onTokenRefresh: jest.fn(cb => ((handlers.tok = cb), () => delete handlers.tok))
  } as unknown as PushAdapter
  return { adapter, handlers }
}
const flush = () => new Promise(r => setImmediate(r))

describe('attachPushHandlers', () => {
  beforeEach(() => __resetInitialNotificationForTests())
  it('consumes initial notification once', async () => {
    const { adapter } = fakeAdapter({ data: { messageId: 'm1' } })
    const requestInboxPass = jest.fn(), openActivity = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })
    await flush()
    expect(openActivity).toHaveBeenCalledTimes(1)
    expect(requestInboxPass).toHaveBeenCalledTimes(1)
  })
  it('tap while backgrounded opens activity and requests a pass', () => {
    const { adapter, handlers } = fakeAdapter(null)
    const requestInboxPass = jest.fn(), openActivity = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })
    handlers.opened({ data: {} })
    expect(openActivity).toHaveBeenCalled()
    expect(requestInboxPass).toHaveBeenCalled()
  })
  it('foreground message only requests an inbox pass', () => {
    const { adapter, handlers } = fakeAdapter(null)
    const requestInboxPass = jest.fn(), openActivity = jest.fn()
    attachPushHandlers({ adapter, requestInboxPass, openActivity, onTokenRefresh: jest.fn() })
    handlers.fg({ data: {} })
    expect(requestInboxPass).toHaveBeenCalled()
    expect(openActivity).not.toHaveBeenCalled()
  })
  it('unsubscribe removes every listener', () => {
    const { adapter, handlers } = fakeAdapter(null)
    attachPushHandlers({ adapter, requestInboxPass: jest.fn(), openActivity: jest.fn(), onTokenRefresh: jest.fn() })()
    expect(Object.keys(handlers)).toEqual([])
  })
})
```

- [ ] **Step 2: Run — expect FAIL**: `npx jest packages/expo-wallet-toolbox/__tests__/push/events.test.ts`

- [ ] **Step 3: Implement `events.ts`**

```ts
import type { PushAdapter } from './types'

let initialConsumed = false
/** Test-only. */
export function __resetInitialNotificationForTests(): void {
  initialConsumed = false
}

/**
 * Route push events into the existing inbox machinery. A push only ever means
 * "look at the inbox now": the credit, sound and toast come from the normal
 * TaskCreditInbox pass, so nothing is shown or credited twice.
 */
export function attachPushHandlers(args: {
  adapter: PushAdapter
  requestInboxPass: () => void
  openActivity: () => void
  onTokenRefresh: () => void
}): () => void {
  const { adapter, requestInboxPass, openActivity, onTokenRefresh } = args
  const opened = () => {
    requestInboxPass()
    openActivity()
  }
  if (!initialConsumed) {
    initialConsumed = true
    void adapter
      .getInitialNotification()
      .then(e => {
        if (e) opened()
      })
      .catch(() => {})
  }
  const offs = [
    adapter.onNotificationOpened(opened),
    adapter.onForegroundMessage(() => requestInboxPass()),
    adapter.onTokenRefresh(() => onTokenRefresh())
  ]
  return () => offs.forEach(off => off())
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: WalletContext** — after `TaskCreditInbox.noteEnqueued()` add a sync function in the same closure (reuse the same host resolution as `TaskCreditInbox`), and attach handlers once:

```ts
const syncPush = async () => {
  const saved = await AsyncStorage.getItem(MESSAGE_BOX_URL_KEY)
  const host =
    saved === NO_MESSAGE_BOX ? undefined : !saved || saved === LEGACY_MESSAGE_BOX_URL ? DEFAULT_MESSAGE_BOX_URL : saved
  const { publicKey } = await permissionsManager.getPublicKey({ identityKey: true }, adminOriginator)
  await syncPushRegistration({
    adapter: getPushAdapter(),
    host,
    identityKey: publicKey,
    makeClient: h => new MessageBoxClient({ host: h, walletClient: permissionsManager as never, originator: adminOriginator })
  })
}
pushSyncRef.current = syncPush
void syncPush()
const pushAdapter = getPushAdapter()
pushDetachRef.current?.()
pushDetachRef.current = pushAdapter
  ? attachPushHandlers({
      adapter: pushAdapter,
      requestInboxPass: () => TaskCreditInbox.requestNow(),
      openActivity: () => loadExpoRouter().router.push('/transactions'),
      onTokenRefresh: () => void syncPush()
    })
  : undefined
```

Declare `const pushSyncRef = useRef<(() => Promise<void>) | undefined>()` and `const pushDetachRef = useRef<(() => void) | undefined>()` with the other refs; call `pushDetachRef.current?.()` in the same teardown that stops the monitor. In the AppState foreground branch (next to `TaskCreditInbox.requestNow()` ~line 3031) add `void pushSyncRef.current?.()` so a permission granted from OS Settings registers on return. Use the file's existing lazy `expo-router` loader if one exists; otherwise add one in the same style as `SettingsScreen.tsx` lines 12–25. Import `MessageBoxClient` from `@bsv/message-box-client`.

- [ ] **Step 6: Run the push + monitor tests and typecheck**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/push packages/expo-wallet-toolbox/__tests__/monitor
npx tsc --noEmit -p packages/expo-wallet-toolbox
```

- [ ] **Step 7: Commit** — `feat(push): register device and route taps into the inbox pass`

---

### Task 8: Settings row

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx` (new `GroupedSection` after Activity)
- Modify: `translations.tsx` (3 keys × 12 locales)

**Interfaces:** Consumes `getPushAdapter()`, `pushAdvisory`.

Keys: `push_settings_row` "Payment notifications"; `push_settings_on` "On"; `push_settings_off` "Off".

Behavior: hidden when no adapter. `value` = On/Off from `getPermission()`, refreshed on focus. Press: if `'undetermined'` → `pushAdvisory.set()` then `requestPermission()` then `void` a refresh; otherwise → `openSettings()`.

- [ ] **Step 1: Implement**

```tsx
const pushAdapter = getPushAdapter()
const [pushPermission, setPushPermission] = useState<'granted' | 'denied' | 'undetermined' | null>(null)
useFocusEffect(
  useCallback(() => {
    void pushAdapter?.getPermission().then(setPushPermission)
  }, [pushAdapter])
)
// …
{pushAdapter && (
  <GroupedSection header={t('notifications')}>
    <ListRow
      label={t('push_settings_row')}
      icon="notifications-outline"
      iconColor={colors.accent}
      value={pushPermission === 'granted' ? t('push_settings_on') : t('push_settings_off')}
      onPress={async () => {
        if (pushPermission === 'undetermined') {
          await pushAdvisory.set()
          setPushPermission(await pushAdapter.requestPermission())
        } else {
          await pushAdapter.openSettings()
        }
      }}
      isLast
    />
  </GroupedSection>
)}
```

Use the screen's existing lazy expo-router loader for `useFocusEffect`. If `t('notifications')` does not exist, add `notifications: 'Notifications'` in all 12 locales too.

- [ ] **Step 2: Run** `npx jest packages/expo-wallet-toolbox/__tests__/i18n` — PASS.

- [ ] **Step 3: Commit** — `feat(push): payment notifications row in Settings`

---

### Task 9: Live inbox listener on the Receive screen (E7)

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx` (poll loop ~lines 680–705, `INBOX_POLL_MS` line 159)

**Interfaces:** Consumes `PeerPayClient.listenForLivePayments({ onPayment, overrideHost })` from `@bsv/message-box-client`.

Behavior: while the screen is focused and the app active, start `listenForLivePayments`; each `onPayment` triggers the same `tick()` the poll uses (do not accept inside the callback — keep one crediting path). Keep the 5 s poll running as fallback but at 15 s while the socket is connected. On blur/background, stop both. Wrap the listener start in try/catch; on failure stay at 5 s.

- [ ] **Step 1: Implement** — inside the existing focus effect, create the client the same way the tick does, then:

```ts
let live = false
void client
  .listenForLivePayments({ onPayment: () => void tick(), overrideHost: messageBoxUrl })
  .then(() => {
    live = true
  })
  .catch(() => {
    live = false
  })
const interval = setInterval(() => {
  if (!live || ++slowCounter % 3 === 0) void tick()
}, INBOX_POLL_MS)
return () => {
  clearInterval(interval)
  void client.disconnectWebSocket?.()
}
```

(`let slowCounter = 0` above it.) Confirm the exact disconnect method name in `node_modules/@bsv/message-box-client/dist/src/MessageBoxClient.d.ts` before writing it.

- [ ] **Step 2: Run** `npx jest packages/expo-wallet-toolbox/__tests__/ui -t HandleReceive` (and the pay suite) — PASS.

- [ ] **Step 3: Commit** — `feat(pay): live inbox listener on Receive with poll fallback`

---

### Task 10: Address sweep at 5 s with WoC key and backoff (E8)

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/pay/sweeper.ts:17`
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/address.ts` (`getUtxosForAddress` fetch ~line 204; BEEF fetch ~line 399)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/sweeper.test.ts` (extend or create)

**Interfaces:** `wocConfigFor(chain)` already carries the WoC config into the address rail (see `WalletContext.tsx` `makeBeefRepair({ woc: wocConfigFor(chain) })`); thread `apiKey` from `getServiceConfig(chain).whatsOnChainApiKey`.

- [ ] **Step 1: Failing test**

```ts
import { SWEEP_INTERVAL_MS } from '../../core/pay/sweeper'
it('sweeps every 5 s', () => expect(SWEEP_INTERVAL_MS).toBe(5_000))
```

Plus a test that `getUtxosForAddress` sends header `woc-api-key` when the config has a key and throws a typed `WocRateLimited` on HTTP 429 (mock `global.fetch`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — `SWEEP_INTERVAL_MS = 5_000`; add `headers: apiKey ? { 'woc-api-key': apiKey } : undefined` to both fetches; on `res.status === 429` throw `new WocRateLimited()`. In the WalletContext sweep effect (~line 2913), catch `WocRateLimited` and skip the next 6 ticks (30 s).

- [ ] **Step 4: Run — PASS.** Run the whole pay suite: `npx jest packages/expo-wallet-toolbox/__tests__/pay`.

- [ ] **Step 5: Commit** — `feat(pay): 5 s address sweep with WoC key and 429 backoff`

---

### Task 11: Switch default MessageBox host (E12) — BLOCKED on an ops answer

**Do not start until the user answers:** do `gmb.bsvblockchain.tech` and `messagebox.bsvblockchain.tech` share one database? If yes, this is a constant change. If no, messages already waiting on gmb must be drained first (keep polling gmb as a secondary host until empty), and recipients' anointed host on the overlay must be updated — that becomes its own plan.

**Files (same-database case):**
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts:29-32` — `DEFAULT_MESSAGE_BOX_URL = 'https://messagebox.bsvblockchain.tech'`; add `'https://gmb.bsvblockchain.tech'` to the legacy set so a saved gmb preference follows the default (turn `LEGACY_MESSAGE_BOX_URL` into `LEGACY_MESSAGE_BOX_URLS: readonly string[]` and update its 2 call sites in WalletContext + Task 7's `syncPush`).
- Modify: `app/_layout.tsx:80,88` fallbacks; `eas.json` production `EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL` and all `*_MANDALA_MESSAGEBOX_URL` values.
- Test: update any test asserting the old constant (`grep -rn "gmb.bsvblockchain.tech" packages/expo-wallet-toolbox/__tests__`).

- [ ] **Step 1:** Update tests to the new host — FAIL.
- [ ] **Step 2:** Change constants/env — PASS: `npx jest packages/expo-wallet-toolbox/__tests__/pay`.
- [ ] **Step 3: Commit** — `feat(pay): default MessageBox host messagebox.bsvblockchain.tech`

---

### Task 12: Release bookkeeping and device check

- [ ] **Step 1:** Bump `packages/expo-wallet-toolbox/package.json` minor version and add a CHANGELOG entry per the repo's toolbox release convention (new `PushAdapter` seam is additive → minor).
- [ ] **Step 2:** Build dev clients: `npm run ios-dev-physical` and `npm run android-dev-physical`.
- [ ] **Step 3:** Hand the device matrix (tracker E10/U6) to the user: iOS + Android × foreground / background / killed / force-quit × satoshi payment and Mandala token. Requires the server plan deployed and U2 (.p8 upload) + U3 (service account) done.
- [ ] **Step 4: Commit** — `chore(toolbox): release push notifications`
