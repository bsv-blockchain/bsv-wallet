# Browser Bridge Core (Project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the transport-agnostic, wallet-side BRC-185 bridge engine in `@bsv/expo-wallet-toolbox`: origin rule, site consent with reconnect tokens, a separate permissions manager for unverified origins, bindings, the 28-method dispatcher, a durable inbox contract and host wiring, with no transport yet.

**Architecture:** Pure protocol code lives in `core/bridge/protocol/` (bundle-safe for a Safari extension). Stateful pieces (`consent`, `bindings`, `inbox`, `dispatcher`, `runtime`) sit beside it and are unit-tested with fakes. WalletContext gains a permission policy object, a second `SigningPolicyPermissionsManager` for unverified originators, manager retirement, and a `withdrawPrompts` teardown; PermissionSheet gains the `connection` kind and the Unverified presentation.

**Tech Stack:** TypeScript (raw TS package), React Native/Expo, `@bsv/sdk` 2.8, `@bsv/wallet-toolbox-mobile`, `@noble/curves` (peer), jest.

**Spec:** `docs/superpowers/specs/2026-10-27-browser-bridge-core-design.md` (revision 5). Section numbers below (6.4, 6.6…) refer to it. Read the spec section named in each task before starting.

## Global Constraints

- Work on branch `feat/browser-bridge-core-impl` in worktree `.claude/worktrees/browser-bridge`. Never touch `master`.
- No `process.env` in the package; host settings go through `configureToolbox` (`core/toolboxConfig.ts`).
- `core/` must not import `ui/`. `core/bridge/protocol/` must not import React Native, Expo, `core/context`, or `@bsv/wallet-toolbox-mobile`; it may import pure `@bsv/sdk` and `@noble/curves/ed25519.js`.
- Prettier: no semicolons, single quotes, no trailing commas, `arrowParens: avoid`, width 120. Run prettier only on files you touched (`npx prettier --write <files>`), never on `.`.
- Verify from the worktree root: `npx tsc --noEmit -p .` must stay at the baseline error count; `npx jest --ci packages/expo-wallet-toolbox/<path>` without `--forceExit`.
- Commit messages are conventional (`feat(bridge): …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use bare `git stash`.
- Limits (spec 6.6): `MAX_BRIDGE_REQUEST_BYTES = 5 * 1024 * 1024`; 4 in flight per binding; 16 total; 5 MiB in-flight bytes total.
- Bindings: ≤ 8 live per origin, ≤ 64 total. Tombstone ring: 1024 entries, 24 h. Inbox: `notAfter - createdAt` ≤ 15 min, 5 min skew, results purged after 15 min. Decline backoff 30 s. Tap protection 700 ms. Grant tag `g` + 10 lowercase base32 chars. Reconnect token 32 random bytes, base64url, stored as SHA-256 hash.
- All new user-facing strings get i18n keys in all 12 locales in `core/i18n/translations.tsx` (parity test `__tests__/i18n/translationParity.test.ts`).
- The attested manager's configuration must equal today's `WalletContext.tsx` literal exactly; no attested behaviour change except the 6.9 items.

## Review Focus

1. A remembered unverified site whose page presents a wrong or missing reconnect token must get the sheet, never a silent connection (Task 7 test `rejects wrong token`).
2. A same-wallet rebuild (identity and network unchanged) must still close bindings and retire managers (Task 9 test `same-wallet rebuild bumps revision`).
3. `getVersion` from an unconnected site with the wallet locked (`blocked`) must answer immediately (Task 10 test `probes never park`).
4. A queue item answered after a profile switch must not reach the new manager (Task 5 test `stale answer goes to retired manager`).
5. A case-variant token-module basket (`P Mandala`) from an unverified binding must be refused before the wallet call (Task 10 test `pre-scan refuses variants`).

---

### Task 1: Teardown registry

**Files:**
- Create: `packages/expo-wallet-toolbox/core/context/sessionTeardown.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletConnectionContext.tsx` (`disconnectActivePairedSession` at ~218 becomes a shim)
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (logout ~3975, profile switch ~3285, network switch in `switchNetwork` ~3199 after its no-op early return)
- Test: `packages/expo-wallet-toolbox/__tests__/context/sessionTeardown.test.ts`

**Interfaces:**
- Produces: `type TeardownReason = 'logout' | 'profile' | 'network' | 'rebuild'`; `registerSessionTeardown(reasons: TeardownReason[], fn: (reason: TeardownReason) => void): () => void`; `runSessionTeardown(reason: TeardownReason): void` (synchronous, idempotent per call, each fn isolated in try/catch).

- [ ] Step 1: tests `runs registered fns for matching reasons only`, `a throwing fn does not stop the others`, `unregister removes it`, `relay registers for logout and profile only` (network runs nothing for it).
- [ ] Step 2: run, expect FAIL (module missing).
- [ ] Step 3: implement; relay registers its existing disconnect for `['logout','profile']`; `disconnectActivePairedSession()` stays exported and calls the relay's function directly (shim). WalletContext calls `runSessionTeardown` at the three sites.
- [ ] Step 4: run the new test plus `__tests__/context/walletConnectionLogout.test.tsx`; both PASS unchanged.
- [ ] Step 5: commit `feat(bridge): session teardown registry`.

### Task 2: Protocol primitives (JSON, base64url, Ed25519 proofs, descriptor)

**Files:**
- Create: `core/bridge/protocol/{json.ts,base64url.ts,descriptor.ts,continuity.ts,limits.ts}`
- Test: `__tests__/bridge/protocol/{json,base64url,descriptor}.test.ts`; fixture `__tests__/bridge/fixtures/0185-vectors.json` (copy from `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/e540ec5f-8075-4a75-9892-147b56e4116a/scratchpad/brcs/0185-vectors.json`; if absent, fetch BRC-185 vectors from github.com/bitcoin-sv/BRCs `wallet/0185-vectors.json`).

**Interfaces:**
- Produces: `parseStrictJson(text: string): unknown` (throws `StrictJsonError` on duplicate keys, lone surrogates, non-finite numbers); `canonicalize(value: unknown): string` (RFC 8785 JCS); `b64uEncode(bytes: Uint8Array): string`; `b64uDecode(s: string): Uint8Array` (throws on non-canonical: padding, whitespace, wrong alphabet, non-zero trailing bits); `validateDescriptor(d: unknown): Descriptor` (spec 6.10 rules); `signDescribe(...)`, `verifyDescribeProof(resp, { origin, challenge }): Descriptor`, `verifyConnectProof(resp, { origin, epoch, challenge, expectedIdentity }): Descriptor`; preimages `"BRC-185 descriptor v1\n" || JCS({origin, challenge, descriptor})` and `"BRC-185 connect v1\n" || JCS({origin, epoch, challenge, descriptor})`; Ed25519 via `ed25519.verify(sig, msg, pub, { zip215: false })`, rejecting small-order keys; response ≤ 16 384 bytes. `interface ContinuityStore { getOrCreate(ctx: string): Promise<{ instanceId: string; continuityKey: string; sign(preimage: Uint8Array): Promise<Uint8Array> }>; reset(ctx: string | 'all'): Promise<void> }`. `limits.ts` exports every constant from Global Constraints.

- [ ] Step 1: tests: RFC 8785 appendix vectors round-trip; duplicate key / lone surrogate / `1e999` rejected; base64url non-canonical cases rejected; every BRC-185 vector verifies verbatim; tampered signature, wrong challenge, small-order key, oversized response, unknown descriptor field, `null` optional field each rejected; invalid icon treated as absent while signature still verifies.
- [ ] Step 2: run, FAIL. Step 3: implement. Step 4: run, PASS. Step 5: commit `feat(bridge): BRC-185 protocol primitives`.

### Task 3: Origin rule, methods table, errors

**Files:**
- Create: `core/bridge/protocol/{origin.ts,methods.ts,connectionError.ts,errorCodec.ts,envelopes.ts}`, `core/bridge/unverifiedOriginator.ts` (dependency-free; re-exported by `origin.ts`)
- Test: `__tests__/bridge/protocol/{origin,methods,errorCodec}.test.ts`

**Interfaces:**
- Produces: `canonicalizeBridgeOrigin({ origin, attestation }): { applicationOrigin: string; hostname: string; attestation: 'browser' | 'unattested' }` (spec 6.3 steps 1–3; throws `OriginRefused`); `unverifiedOriginator(hostname: string, grantTag: string): string` → `${hostname}.${grantTag}.unverified.invalid`, refusing hostnames > 219 bytes; `mintGrantTag(): string` (`g` + 10 base32 lowercase, `crypto.getRandomValues`); `isUnattestedOriginator(o: string): boolean` (exactly `^<hostname>\.g[a-z2-7]{10}\.unverified\.invalid$`); `hostnameOfUnattested(o: string): string`; `assertCanonicalOriginator(o: string): void`. `BRIDGE_METHODS: Record<WalletMethodName, { mutating: boolean; probe: boolean }>` (probe true only for `getVersion`, `isAuthenticated`). `type ConnectionErrorCode = 'CONFIGURATION_ERROR' | 'SELECTION_REQUIRED' | 'USER_CANCELLED' | 'DISCOVERY_BLOCKED' | 'PROVIDER_CHANGED' | 'PAIRING_EXPIRED' | 'PAIRING_REJECTED' | 'PROTOCOL_ERROR' | 'RESOURCE_LIMIT' | 'DISCONNECTED' | 'CONNECTION_CLOSED'`; `connectionError(code, message, delivery: 'not-sent' | 'unknown', extra?: { epoch?: string; cause?: string })`; `encodeWalletError(e: unknown): WireError` and `decodeWireError(w): Error` per the 6.11 table (map by `instanceof`, numeric code, toolbox `name`, string code for 3/4; never truthiness of `code`; message ≤ 4096 bytes; `parameter` supplied for code 6).

- [ ] Step 1: tests: origin grammar table (https only; IP literals; trailing dot; uppercase; punycode accepted, non-ASCII refused; default port 443 refused; `.invalid` refused; admin originator refused; `http://localhost:3000` only with `allowLocalhostHttp`); grant-tag originator round-trips through `isUnattestedOriginator`/`hostnameOfUnattested`; `example.com.unverified.invalid` (no tag) is not unattested; `BRIDGE_METHODS` keys equal the SDK `WalletInterface` method names (28); error table cases including a toolbox error with string `code` and `WERR_REVIEW_ACTIONS` fields.
- [ ] Step 2–4: FAIL, implement, PASS. Step 5: commit `feat(bridge): origin rule, method table, error codec`.

### Task 4: Permission policy object

**Files:**
- Create: `core/bridge/permissionPolicy.ts`
- Modify: `core/toolboxConfig.ts` (add `browserBridge?: { allowLocalhostHttp?: boolean; permissionPolicy?: Partial<PermissionPolicy> }` to `ToolboxConfig`, getter `getBrowserBridgeConfig()`)
- Modify: `core/context/WalletContext.tsx` (~2047: the `seek*` literal moves to `DEFAULT_VERIFIED_SEEK_FLAGS`; the attested manager is built from `resolvePermissionPolicy().verified`)
- Test: `__tests__/bridge/permissionPolicy.test.ts`

**Interfaces:**
- Produces: `type SeekFlags` (exactly the `seek*` keys in today's literal); `DEFAULT_VERIFIED_SEEK_FLAGS: SeekFlags` (byte-identical values); `DEFAULT_UNVERIFIED_SEEK_FLAGS` (= verified + basket insertion/listing/removal `true`); `effectiveUnverified(p: PermissionPolicy): SeekFlags` (OR with verified; forces `seekSpendingPermissions`, `seekProtocolPermissionsForSigning`, `seekGroupedPermission` true); `resolvePermissionPolicy(stored?: PermissionPolicy): PermissionPolicy` (host defaults from `getBrowserBridgeConfig()` then stored user policy); `loadStoredPolicy(profileKey, adminWallet): Promise<PermissionPolicy | undefined>` and `saveStoredPolicy(profileKey, policy, adminWallet)` using AsyncStorage key `bsv-bridge-permission-policy:<profileKey>` and an HMAC tag via `computeConnectionAuthorityTag`-style helper with protocol `[2, 'bridge site authority']`, keyID `permission-policy`; tag failure → `undefined`. `SEEK_FLAG_DISCLOSURE: Record<keyof SeekFlags, { off: string; on: string }>` (i18n keys) for the connection sheet.

- [ ] Step 1: tests `verified defaults equal the old literal` (snapshot the literal values from WalletContext before editing), `unverified defaults ask for baskets`, `effective unverified never looser` (stored unverified all false → still equals verified), `forced flags`, `tampered stored policy ignored`, `every SeekFlags key has a disclosure entry`.
- [ ] Step 2–4. Step 5: commit `feat(bridge): permission policy object`.

### Task 5: Manager retirement, queue items carry their manager, identity answers, withdrawPrompts

**Files:**
- Modify: `core/services/signingPermissionPolicy.ts` (add `retire()`, `isRetired()`, `hasActiveRequest(id)`, `denyAllActiveRequests()`, `callEvent` override)
- Modify: `core/hooks/usePermissionQueue.ts` (add `removeById(id: string): boolean`, `clear(): void`; `advance` gains optional `requestID` and removes only that item when given)
- Modify: `core/context/WalletContext.tsx` (callbacks bound per manager; queue items get `manager`; spending callback re-checks `manager.hasActiveRequest` after its AsyncStorage await and targets the bound manager for the auto-grant; BTMS/Mandala prompt handlers wrapped with a build-scoped `retired` flag; `withdrawPrompts(oldManagers)` exported via context)
- Modify: `ui/components/ui/PermissionSheet.tsx` (`executeGrant`/`handleDeny` answer `request.manager`, pass `requestID` to `advance*`, drop a pending grant whose request is gone, `.catch` every manager call)
- Test: `__tests__/services/signingPermissionPolicy.test.ts` (extend), `__tests__/context/withdrawPrompts.test.tsx`, `__tests__/ui/PermissionSheet.test.tsx` (extend)

**Interfaces:**
- Produces: `SigningPolicyPermissionsManager#retire(): void`, `#isRetired(): boolean`, `#hasActiveRequest(requestID: string): boolean`, `#denyAllActiveRequests(): void`; queue item field `manager?: SigningPolicyPermissionsManager`; `withdrawPrompts(oldManagers: SigningPolicyPermissionsManager[]): void` (retire first, deny all, clear all seven queues + BTMS/Mandala resolving false + connection requests via a registered hook, release focus).

- [ ] Step 1: tests against the real manager: `retired manager denies protocol, spending and grouped prompts without calling handlers`, `grouped lock is released after retire`, `deny never throws for a missing id`; context: `profile switch withdraws prompts and retires old manager`, `spending callback released after switch enqueues nothing and records nothing`, `stale answer goes to retired manager` (new manager receives nothing); sheet: `grant after withdrawal within 400 ms drops nothing else`, `no unhandled rejection`.
- [ ] Step 2–4 (also run `__tests__/context/switchProfile.test.tsx`, `groupedPermission.test.ts`, `__tests__/ui/PermissionSheet.test.tsx` — PASS). Step 5: commit `feat(bridge): retire replaced managers and answer prompts by identity`.

### Task 6: Unverified permissions manager

**Files:**
- Create: `core/bridge/unverifiedManager.ts`
- Modify: `core/services/autoApprovePolicy.ts` (`AutoApproveReason` adds `'unattested'`; `shouldAutoApprove` returns it for `isUnattestedOriginator(originator)`; `record` ignores those)
- Create: `core/bridge/runtimeFlags.ts` (`setUnattestedTransportPresent(v: boolean)`, `hasUnattestedTransport(): boolean`, change listeners; Task 9's `registerTransport` sets it)
- Modify: `core/context/WalletContext.tsx` (build the unverified manager in the same build when `hasUnattestedTransport()` is true, and rebuild managers when it turns true; same callbacks; same wrapper stack `guardVaultAccess(wrapAbortActionForSettlements(wrapCreateActionForTokenInputs(conformWalletResults(admin, mgr), listMandalaTokenOutpoints, admin), …), admin, { lookup: phoneStorage })`; expose `managers.unverifiedPermissionsManager`)
- Test: `__tests__/bridge/unverifiedManager.test.ts`, `__tests__/services/autoApprovePolicy.test.ts` (extend)

**Interfaces:**
- Consumes: `effectiveUnverified` (Task 4), `isUnattestedOriginator`, `hostnameOfUnattested` (Task 3).
- Produces: `buildUnverifiedPermissionsManager(wallet, adminOriginator, flags: SeekFlags): SigningPolicyPermissionsManager` — `permissionModules` = `{ btms: refusingModule, mandala: refusingModule }` (`onRequest` throws an Error with `code = 'ERR_PERMISSION_DENIED'`), built-in `nosend` kept by the manager; `fetchManifestPermissions` override: strip suffix, nulls for `localhost`, single-label, all-numeric last label, and suffixes `.localhost .local .internal .lan .home.arpa .test .example .onion`; delegate to the original with the hostname; filter (ask-every-time, drop `spendingAuthorization`, drop entries whose scheme is `btms`/`mandala`) on fresh shallow copies.

- [ ] Step 1: tests against the real manager (pattern: `signingPermissionPolicy.test.ts`): `manifest fetched from real hostname` (mock `createPublicHTTPSFetch` from `@bsv/sdk`, assert URL `https://example.com/manifest.json`), special hosts give nulls with no fetch, filter cases from spec §8 Manifest, `delegate objects not mutated`, `basket listing prompts on unverified, not on attested`, `namespace tokens never satisfy example.com and vice versa`, `two grant tags isolated`, `token-module routes refused with ERR_PERMISSION_DENIED` (label `p mandala token-spend`, basket `p btms x`, protocol `[2,'p mandala token']`), `nosend label still works and its spend prompts`, `BRC-29 prompts every signature`, `autoApprove returns unattested`.
- [ ] Step 2–4. Step 5: commit `feat(bridge): unverified permissions manager`.

### Task 7: Site consent store, reconnect token, clean slate

**Files:**
- Create: `core/bridge/consent.ts`
- Test: `__tests__/bridge/consent.test.ts`

**Interfaces:**
- Consumes: `mintGrantTag`, `unverifiedOriginator` (Task 3).
- Produces: `interface SiteRecord { applicationOrigin; originator; attestation; transport; approvedAt; grantTag?; reconnectHash?; tag }`; `createConsentStore(deps: { storage: KeyValue; adminWallet: HmacCapableWallet; adminOriginator: string; profileKey: () => string; now: () => number; randomBytes: (n: number) => Uint8Array })` returning `{ lookup(origin, attestation): Promise<SiteRecord | undefined>; checkReconnect(record, token?: string): boolean (constant-time); requestConsent(input: { origin; attestation; transportId; bindingEpoch; walletRevision; connectedBefore: boolean }): { requestId: string; promise: Promise<'approved' | 'declined'> } | { refused: 'slot-held' | 'backoff' }; answerConsent(requestId, approve, ctx: { walletRevision; profileKey }): Promise<{ record: SiteRecord; reconnectToken?: string } | undefined>; dropRequestsFor(epoch: string): void; withdrawAll(): void; listConnectedSites(); revokeSite(origin, attestation); onChange(fn) }`. Store key `bsv-bridge-sites:<profileKey>`; tag via HMAC protocol `[2, 'bridge site authority']`. Pending requests are exposed to the sheet through `onChange`.

- [ ] Step 1: tests: `remembered per profile and attestation` (verified approval does not connect unverified twin), `tag failure counts as not connected`, `approve mints grantTag and token; only SHA-256 hash stored`, `rejects wrong token` and `rejects missing token` (with `connectedBefore` true), `re-approval mints new grant tag and old token fails`, `decline keeps old record`, `one slot per transport` (second gets `slot-held`), `30 s backoff after decline only for that origin+attestation`, `stale answer after revision change writes nothing`, `dropRequestsFor removes request once no binding remains`, `sweep at logout removes profile keys including profile 0 bare key`.
- [ ] Step 2–4. Step 5: commit `feat(bridge): site consent store with reconnect tokens`.

### Task 8: Bindings

**Files:**
- Create: `core/bridge/bindings.ts`
- Test: `__tests__/bridge/bindings.test.ts`

**Interfaces:**
- Produces: `interface Binding` per spec 6.7 (`epoch, transportId, applicationOrigin, originator?, attestation, instanceId, continuityKey, accountContext, walletRevision, boundAt, createdAt, state, closeReason?, launchProofVerified?, consented`); `createBindingRegistry(deps: { tombstoneStorage: KeyValue; now: () => number; onClosed: (e: CloseEvent) => void })` returning `{ connectExplicit(input): Binding (throws ConnectionError CONFIGURATION_ERROR when unattested without launchProofVerified, RESOURCE_LIMIT over 8/64); admitImplicit(record, current: { walletRevision; accountContext }): Binding | ConnectionError; resolve(transportId, request): Binding | ConnectionError; close(epoch, reason: 'account-changed' | 'revoked' | 'lost' | 'disconnected'): void; closeAll(reason): void; live(): Binding[] }`; `CloseEvent = { closeSeq: number; epoch: string; reason }`; tombstone ring with persisted `evictedThrough`.

- [ ] Step 1: tests per spec §8 Bindings: implicit creation; revision/context mismatch tombstones; A→B→A no revival; admission horizon (> 24 h `boundAt`; ≤ `evictedThrough` after 1025 closes) gives `lost`; closing A emits one event with increasing `closeSeq`, B and C stay live; launch-proof refusal takes no slot; limits; page disconnect writes tombstone and event but `onClosed` marks `notifyPage: false`.
- [ ] Step 2–4. Step 5: commit `feat(bridge): binding registry`.

### Task 9: Runtime, wallet revision, provider

**Files:**
- Create: `core/bridge/runtime.ts`, `core/bridge/BrowserBridgeProvider.tsx`, `core/bridge/index.ts`
- Modify: `core/index.ts` (export the bridge public API), `core/context/WalletContext.tsx` (publish managers; `walletRevision` persisted install-wide in AsyncStorage key `bsv-bridge-wallet-revision`)
- Test: `__tests__/bridge/runtime.test.ts`, `__tests__/bridge/BrowserBridgeProvider.test.tsx`

**Interfaces:**
- Produces: `registerTransport(t: { id; attestation; bindingMode; requestAttention(reason, binding); onClosed?(e); deliverReconnectToken?(binding, token) }): TransportHandle` (refuses `unattested`+`implicit`, refuses `unattested` without `deliverReconnectToken`); `getBridgeSnapshot(): { schema: 1; baseVersion; network; accountContext; walletRevision; readiness: 'ready' | 'building' | 'blocked' | 'none'; closeSeq }`; `onSnapshotChange(fn)`; internal `publish({ attestedManager, unverifiedManager?, readiness, network, accountContext })` from the provider; revision bump when manager object identity changes after the first build in a process → `bindings.closeAll('account-changed')`, `withdrawPrompts(old)`, `consent.withdrawAll()`. Account context = `HMAC-SHA256(installSecret, "bsv-bridge-account-context-v1" || identityKeyHex || network)`, `installSecret` 32 bytes in SecureStore key `bsv-bridge-install-secret`, deleted at logout and Delete Wallet.

- [ ] Step 1: tests `same-wallet rebuild bumps revision` (same identity+network, new manager object → bindings closed, old manager retired), `first build after launch does not bump`, `profile switch closes bindings and withdraws prompts`, `no provider → CONFIGURATION_ERROR`, `snapshot change events`, `install secret deleted at logout rotates account context`.
- [ ] Step 2–4. Step 5: commit `feat(bridge): runtime, wallet revision, provider`.

### Task 10: Dispatcher

**Files:**
- Create: `core/bridge/dispatcher.ts`, `core/bridge/policy.ts`
- Test: `__tests__/bridge/dispatcher.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6–9.
- Produces: `dispatch({ transport, request: { epoch, instanceId, continuityKey, origin, method, args, sizeBytes } }): Promise<Outcome>`; `type Outcome = { ok: true; result } | { ok: false; walletError: WireError } | { ok: false; connectionError: ConnectionError }`. Pipeline exactly spec 6.6 steps 1–10; manager chosen by `binding.attestation`; `capWalletArgs` over the manager's guarded stack read fresh per call; `TaskBackupPush.noteChanged()` for mutating methods except pre-dispatch refusals; `validateWalletResult` copy; `getVersion` BRC-205 check; pre-scan refuses names whose trimmed lowercase form starts with `p btms`/`p mandala` but whose raw form does not.

- [ ] Step 1: tests: 28-method golden table with a fake wallet (originator always from binding); typed array refused; 3 MB inputBEEF refused before allocation; snapshot failure code 6; mutating invalid result → `PROTOCOL_ERROR` unknown with txid; `probes never park` (unconnected + `blocked` → immediate answers, no consent request); `seekPermission false unconnected → permission denied, no sheet`; `parked on readiness then profile switch never reaches new wallet`; `no timeout while prompt pending`; routing attested vs unverified managers; `pre-scan refuses variants` (`P Mandala`, ` p btms x`) only for unattested.
- [ ] Step 2–4. Step 5: commit `feat(bridge): dispatcher`.

### Task 11: Durable inbox

**Files:**
- Create: `core/bridge/inbox.ts`, `core/bridge/memoryInboxStore.ts`, `__tests__/bridge/inboxContract.ts` (exported contract suite `runInboxStoreContract(makeStore)`)
- Test: `__tests__/bridge/inbox.test.ts`

**Interfaces:**
- Produces: `interface InboxStore { stat(id); read(id); accept(id); claim(id, digest); writeResult(id, bytes); readResult(id); ack(id); writeEvent(e); readEventsAfter(seq); bootId(); list(state); rawBytes(): Uint8Array[] }`; `createInboxProcessor({ store, dispatch, now, bindings })` with `processPending(): Promise<void>`; record shape per spec 6.8 including `walletRevision`, `boundAt`; sealing is the adapter's job — the memory adapter seals with AES-GCM (`@noble/ciphers` if present, otherwise Web Crypto) under a per-instance key so the raw-bytes test is meaningful.

- [ ] Step 1: contract tests: concurrent claim once; re-stage refused; size checked before read; claim fails on changed digest; `notAfter` only while pending, clamped to 15 min, future `createdAt` beyond 5 min refused; boot-id crash recovery → `CONNECTION_CLOSED` unknown; accepted returns to pending after restart; purge after 15 min then late read; raw bytes contain no plaintext marker; re-check failure after claim → `PROVIDER_CHANGED` not-sent and no wallet call.
- [ ] Step 2–4. Step 5: commit `feat(bridge): durable inbox`.

### Task 12: Connection sheet and Unverified presentation

**Files:**
- Modify: `ui/components/ui/PermissionSheet.tsx` (new kind `connection` fed from `consent.onChange`; `ActivePermission.unverified` set at the seven `deriveActive` sites and suffix stripped via `hostnameOfUnattested`; monospaced raw-origin title; quoted "This website says" block for manifest text; 700 ms approve delay for `connection` and unverified heads)
- Modify: `core/i18n/translations.tsx` (all 12 locales)
- Test: `__tests__/ui/PermissionSheet.test.tsx` (extend), `__tests__/i18n/translationParity.test.ts` (must pass)

**Interfaces:**
- Consumes: `SEEK_FLAG_DISCLOSURE`, `effectiveUnverified` (Task 4), consent store (Task 7).

- [ ] Step 1: tests: unverified badge and stripped origin on all seven kinds including `group`; connection sheet lists capabilities from the effective flags (unverified default puts basket changes under "asks first"); verified shows auto-approve line, unverified shows "Payments from your balance will ask you first"; "connected before" line; approve disabled for 700 ms; parity.
- [ ] Step 2–4. Step 5: commit `feat(bridge): connection sheet and unverified presentation`.

### Task 13: Conformance report and integration pass

**Files:**
- Create: `core/bridge/conformance.ts`, `__tests__/bridge/conformance.test.ts`, `__tests__/bridge/integration.test.ts`
- Modify: `packages/expo-wallet-toolbox/CHANGELOG.md` (Unreleased section)

- [ ] Step 1: integration test with a fake transport (explicit, unattested, with launch proof): connect → first `createAction` parks → sheet approved → token delivered → disconnect → reconnect with token → no sheet → reconnect without token → sheet with "connected before" → approve → old grant tag's token no longer satisfies a protocol check. Conformance: generated JSON lists 28 methods, refusals and spec §9 deviations; snapshot test.
- [ ] Step 2: full verification: `npx tsc --noEmit -p .` (baseline count) and `npx jest --ci packages/expo-wallet-toolbox/` (baseline failures only).
- [ ] Step 3: commit `feat(bridge): conformance report and integration test`.
