# BSV Broadcaster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BSV Broadcaster (`broadcast.bsvblockchain.tech`) the wallet's primary broadcast, SSE and chaintracks endpoint on all 4 networks, post every unconfirmed transaction of a BEEF as EF in topological order, and drop Taal.

**Architecture:** `core/networks.ts` holds the endpoint table. `core/services/arcadeBroadcastProvider.ts` holds the providers, the topological walk and the answer classification. A new pure function registers the providers in order, so `WalletContext.tsx` only calls it. `walletServiceConfig.ts` sets the toolbox's `UntilSuccess` soft timeout to a flat 30 s.

**Tech Stack:** TypeScript, React Native/Expo, `@bsv/sdk` 4.x (`Beef`, `Transaction`), `@bsv/wallet-toolbox-mobile` 2.15.x (`Services`), jest-expo, pnpm (hoisted).

**Spec:** `docs/superpowers/specs/2026-11-05-bsv-broadcaster-design.md`

## Global Constraints

- Prerequisite: bsv-blockchain/bsv-wallet#94 is merged to master. This plan modifies its `postingOrder` and `postEachTransaction` in `arcadeBroadcastProvider.ts`. If #94 is not on master, stop.
- Primary URLs: main `https://broadcast.bsvblockchain.tech`, test `https://broadcast.bsvblockchain.tech/testnet`, teratest `https://broadcast.bsvblockchain.tech/ttn`, scaletest `https://broadcast.bsvblockchain.tech/tstn`.
- GorillaPool URLs: main `https://arcade.gorillapool.io`, test `https://testnet.arcade.gorillapool.io`; none on teratest or scaletest. GorillaPool posts to `/tx`.
- Provider order: BSV Broadcaster → GorillaPool → WhatsOnChain → Bitails, each only where `NETWORKS` says it serves the network.
- No Taal anywhere in `packages/expo-wallet-toolbox/core` or `app/` (code, config, tests).
- Provider ids and notes stay: `Arcade`, `ArcadePostEF`, `GorillaPoolArc`, `WhatsOnChain`, `Bitails`. Only UI and preset labels say "BSV Broadcaster".
- Final-rejection allow-list: HTTP 400, body `txid` equal to the posted txid, ARC code (body `status`) in `{461, 464}`. Every other non-success answer is a retryable service error, except the existing `doubleSpend` mapping for `DOUBLE_SPEND_ATTEMPTED`.
- Time budget: 30 000 ms per provider, flat (`postBeefUntilSuccessSoftTimeoutMs = 30000`, `...PerKbMs = 0`, `...MaxMs = 30000`), and the walk inside a provider stops at the same 30 000 ms.
- No changes to `@bsv/wallet-toolbox-mobile`, `@bsv/sdk` or `patches/`.
- Run jest and tsc in this worktree after `pnpm install --frozen-lockfile --ignore-scripts`. Known baseline jest flakes: `enrollWizard`, `vaultScreen`.

## Review Focus

1. A user-entered primary URL with a trailing slash (`https://broadcast.bsvblockchain.tech/testnet/`) must post to `.../testnet/tx`, not `.../testnet//tx`. Test in Task 2.
2. An unconfirmed ancestor whose own parent is a txid-only entry in the BEEF cannot be built as EF. The walk must not throw: that ancestor and its descendants get retryable errors. Test in Task 3.
3. ARC sends the code as a number, but a proxy can turn it into a string (`"461"`). Both must classify the same. Test in Task 4.
4. A user who picks GorillaPool's URL by hand as the primary must not get GorillaPool registered twice. Test in Task 2.
5. When the walk deadline passes mid-chain, the requested txids that were not reached get retryable errors, and no further request goes out. Test in Task 3.

---

### Task 0: Start from master with #94

**Files:** none.

- [ ] **Step 1:** Check that #94 is merged.
  Run: `gh pr view 94 --repo bsv-blockchain/bsv-wallet --json state --jq .state`
  Expected: `MERGED`. Otherwise stop and report.
- [ ] **Step 2:** Rebase this branch (it holds only the spec and this plan) onto master.
  Run: `git fetch origin && git rebase origin/master`
  Expected: clean rebase; `git grep -n 'function postEachTransaction' packages/expo-wallet-toolbox/core/services/arcadeBroadcastProvider.ts` prints one line.
- [ ] **Step 3:** Install.
  Run: `pnpm install --frozen-lockfile --ignore-scripts`
  Expected: `Done in …`.

### Task 1: Endpoint table, presets and config without Taal

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/networks.ts` (`NetworkProfile`, `NETWORKS`)
- Modify: `packages/expo-wallet-toolbox/core/constants.ts` (`KNOWN_ARC_URLS`)
- Modify: `packages/expo-wallet-toolbox/core/services/walletServiceConfig.ts` (`createServiceOptions`)
- Modify: `packages/expo-wallet-toolbox/core/toolboxConfig.ts` (remove `taalApiKey`)
- Modify: `app/_layout.tsx` (remove the 2 `taalApiKey` entries and the Taal comment lines)
- Test: `packages/expo-wallet-toolbox/__tests__/services/walletServiceConfig.test.ts`, new `packages/expo-wallet-toolbox/__tests__/networks/broadcasterEndpoints.test.ts`

**Interfaces:**
- Produces: `NetworkProfile.arcadeUrl: string` (front-door URL, no trailing slash); `NetworkProfile.gorillaPoolArcUrl?: string` (GorillaPool BSV Broadcaster root); no `taalArcUrl`; `WalletServicesOptions` from `createServiceOptions` has no `taalApiKey` key.

- [ ] **Step 1: Write the failing tests**

In `broadcasterEndpoints.test.ts`:
```ts
it.each([
  ['main', 'https://broadcast.bsvblockchain.tech', 'https://arcade.gorillapool.io'],
  ['test', 'https://broadcast.bsvblockchain.tech/testnet', 'https://testnet.arcade.gorillapool.io'],
  ['teratest', 'https://broadcast.bsvblockchain.tech/ttn', undefined],
  ['scaletest', 'https://broadcast.bsvblockchain.tech/tstn', undefined]
])('%s uses the BSV Broadcaster front door', (net, primary, gorilla) => {
  expect(NETWORKS[net].arcadeUrl).toBe(primary)
  expect(NETWORKS[net].gorillaPoolArcUrl).toBe(gorilla)
  expect('taalArcUrl' in NETWORKS[net]).toBe(false)
})
it('presets list only BSV Broadcaster instances', () => {
  expect(KNOWN_ARC_URLS.main.map(p => p.url)).toEqual([
    'https://broadcast.bsvblockchain.tech',
    'https://arcade-us-1.bsvblockchain.tech',
    'https://arcade-eu-1.bsvblockchain.tech'
  ])
  for (const net of ['test', 'teratest', 'scaletest'] as const)
    expect(KNOWN_ARC_URLS[net].map(p => p.url)).toEqual([NETWORKS[net].arcadeUrl])
  expect(KNOWN_ARC_URLS.main[0].label).toBe('BSV Broadcaster (default)')
  for (const list of Object.values(KNOWN_ARC_URLS)) for (const p of list) expect(p.requiresToken).toBe(false)
})
```
In `walletServiceConfig.test.ts`: change the `chaintracksUrlFor` and default-arcade tables to the 4 primary URLs (`…/chaintracks/v1` appended); replace the XR-066 `describe` and the "teratest/scaletest takes no TAAL key" tests with one test: `expect('taalApiKey' in createServiceOptions('main', 't', rate)).toBe(false)`.

- [ ] **Step 2: Run to see them fail**
  Run: `npx jest packages/expo-wallet-toolbox/__tests__/networks/broadcasterEndpoints.test.ts packages/expo-wallet-toolbox/__tests__/services/walletServiceConfig.test.ts`
  Expected: FAIL on the old `arcade-v2-*` URLs and `taalArcUrl`.
- [ ] **Step 3: Implement.** Set the URLs from Global Constraints. Remove `taalArcUrl` (field, doc comment, values) and `taalApiKey` (`toolboxConfig.ts` type, `createServiceOptions` return, the XR-066 comment, `app/_layout.tsx`). Update the `arcadeUrl` doc comment to "Default BSV Broadcaster origin (broadcast, SSE, and `/chaintracks/v1`)." Set `KNOWN_ARC_URLS` labels: `'BSV Broadcaster (default)'`, `'BSV Broadcaster US'`, `'BSV Broadcaster EU'`. Update the scaletest comment in `networks.ts`: the `/tstn` chaintracks now reports `tstn`; `available` stays `false`.
- [ ] **Step 4: Run the tests and tsc**
  Run: the jest command from Step 2, then `npx tsc --noEmit -p .`
  Expected: PASS; 0 errors (any tsc error naming `taalArcUrl`/`taalApiKey` means a leftover user, fix it here).
- [ ] **Step 5: Commit** — `feat(toolbox): point every network at BSV Broadcaster; drop Taal`

### Task 2: Provider factories and ordered registration

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/arcadeBroadcastProvider.ts` (remove `createTaalBroadcastService`; GorillaPool to `/tx`; URL join; new `registerBroadcastProviders`)
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (the `postBeefServices` block, about line 1638–1666)
- Test: `packages/expo-wallet-toolbox/__tests__/services/arcadeBroadcastProvider.test.ts`, new `packages/expo-wallet-toolbox/__tests__/services/registerBroadcastProviders.test.ts`

**Interfaces:**
- Consumes: `NetworkProfile` from Task 1.
- Produces:
  ```ts
  export function registerBroadcastProviders(
    services: { postBeefServices: { add(s: { name: string; service: (beef: Beef, txids: string[]) => Promise<PostBeefResult> }): void; remove(name: string): void } },
    network: NetworkProfile,
    primaryUrl: string,
    callbackToken: string,
    whatsOnChainApiKey: string | undefined,
    bitails: { postBeef: (beef: Beef, txids: string[]) => Promise<PostBeefResult> } | undefined
  ): string[]   // the registered provider names, in order
  ```
  It removes `ArcadeBeef`, `GorillaPoolArcBeef`, `TaalArcBeef`, `Bitails`, `WhatsOnChain`, then adds `Arcade` (primary), `GorillaPoolArc` (if `network.gorillaPoolArcUrl` and its normalized URL differs from the normalized `primaryUrl`), `WhatsOnChain` (if `network.woc`), `Bitails` (if `bitails` and `network.bitails`).
  `createGorillaPoolBroadcastService(url)` posts to `${url}/tx`. Every ARC-style URL is joined as `${url.replace(/\/+$/, '')}/tx`.

- [ ] **Step 1: Write the failing tests**
  - `registerBroadcastProviders` with `NETWORKS.main`, the main primary URL and a stub bitails → returns `['Arcade', 'GorillaPoolArc', 'WhatsOnChain', 'Bitails']`; with `NETWORKS.teratest` → `['Arcade', 'WhatsOnChain']`; with `NETWORKS.scaletest` → `['Arcade']`; with `NETWORKS.main` and primary `'https://arcade.gorillapool.io/'` → `['Arcade', 'WhatsOnChain', 'Bitails']` (Review Focus 4).
  - GorillaPool: `postOne(createGorillaPoolBroadcastService('https://arcade.gorillapool.io'))` → url `'https://arcade.gorillapool.io/tx'`.
  - Trailing slash (Review Focus 1): `createArcadeBroadcastService('https://broadcast.bsvblockchain.tech/testnet/', 'cb')` → url `'https://broadcast.bsvblockchain.tech/testnet/tx'`.
  - Delete the 2 TAAL tests and the `createTaalBroadcastService` import; point the remaining Arcade tests at `https://broadcast.bsvblockchain.tech`.
- [ ] **Step 2: Run to see them fail**
  Run: `npx jest packages/expo-wallet-toolbox/__tests__/services`
  Expected: FAIL (`registerBroadcastProviders` not exported; GorillaPool url ends in `/v1/tx`).
- [ ] **Step 3: Implement** the Interfaces above. In `WalletContext.tsx`, replace the remove/add lines with one call: `registerBroadcastProviders(services, network, serviceOptions.arcUrl!, callbackToken, serviceOptions.whatsOnChainApiKey, (services as any).bitails)`. Update its comment to the new order.
- [ ] **Step 4: Run the tests and tsc** — same jest command, then `npx tsc --noEmit -p .`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** — `feat(toolbox): register BSV Broadcaster, GorillaPool, WhatsOnChain, Bitails in order`

### Task 3: Walk every unconfirmed transaction

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/arcadeBroadcastProvider.ts` (replace #94's `postingOrder` with `postingPlan`; extend `postEachTransaction`)
- Test: `packages/expo-wallet-toolbox/__tests__/services/arcadeBroadcastProvider.test.ts` (`describe('multi-transaction BEEF')` from #94)

**Interfaces:**
- Produces:
  ```ts
  export const BROADCAST_PROVIDER_BUDGET_MS = 30_000
  function postingPlan(beef: Beef, txids: string[]): { order: string[]; proven: Set<string> }
  ```
  `order`: every txid in the BEEF that has a raw transaction and no merkle path, parents first, plus any requested txid not found (at the end, as #94 does). `proven`: requested txids whose BEEF entry has a merkle path. It sorts a copy (`Beef.fromBinary(beef.toBinary())`), never the caller's `beef`.
  `postEachTransaction(name, beef, txids, postOne, budgetMs = BROADCAST_PROVIDER_BUDGET_MS)` keeps #94's signature plus `budgetMs`.

Rules for `postEachTransaction` (spec §2–3):
- Post each `order` txid unless a parent in the BEEF was not accepted. A blocked txid's result: `{ txid, status: 'error', serviceError: true, data: 'parent <parentTxid> not accepted: <parent result data or txStatus>' }`.
- A `proven` requested txid is not posted; its result is `{ txid, status: 'success' }`.
- `findAtomicTransaction` failure or a `toEF()`/`toHex()` throw gives a retryable result for that txid (no throw out of the service).
- Before each post, if `Date.now() - start >= budgetMs`, stop; every requested txid without a result gets `{ status: 'error', serviceError: true, data: 'broadcast budget exceeded' }`.
- The returned `txidResults` hold one entry per requested txid, in the caller's order, each with `txid` set to the requested txid (overwrite whatever `postOne` returned).

- [ ] **Step 1: Write the failing tests** (reuse #94's `chainedParentChild`; add a 3-generation helper `chain(n)` that returns `{ txs, beef, ids }` with each tx spending the previous one):
  - `posts unconfirmed ancestors that are not requested`: `chain(3)`, request only `ids[2]` → fetch called 3 times, bodies equal `txs[0..2].toEF()` in order; `txidResults` is `[{ txid: ids[2], status: 'success' }]`.
  - `skips a proven ancestor`: give `txs[0]` a merkle path in the BEEF (use `MerklePath` fixture from `__tests__` if one exists, else `beef.mergeBump`) → fetch called 2 times.
  - `a proven requested txid is success and not posted`.
  - `does not mutate the caller's beef`: `const before = beef.toHex()`; call; `expect(beef.toHex()).toBe(before)`.
  - `a txid-only grandparent gives retryable errors, never throws` (Review Focus 2): build `chain(3)`, then a BEEF where `ids[0]` is txid-only (`beef.makeTxidOnly(ids[0])`) → resolves; `ids[1]` and `ids[2]` results `serviceError: true`; fetch not called for either.
  - `stops at the budget` (Review Focus 5): `chain(5)`, `postOne` mock advances a fake clock 10 000 ms per call (`jest.spyOn(Date, 'now')`), budget 30 000 → at most 3 requests; requested txids after that have `data: 'broadcast budget exceeded'`.
  - `result txid is the requested txid`: fetch answers `{ txid: 'ff'.repeat(32), txStatus: 'SEEN_ON_NETWORK' }` with 200 → result `txid` equals the posted id.
- [ ] **Step 2: Run to see them fail** — `npx jest packages/expo-wallet-toolbox/__tests__/services/arcadeBroadcastProvider.test.ts`. Expected: FAIL (ancestors not posted; beef mutated).
- [ ] **Step 3: Implement** `postingPlan` and the rules above. WhatsOnChain uses the same walk (raw hex per txid).
- [ ] **Step 4: Run the tests** — same command. Expected: PASS, including #94's 3 tests.
- [ ] **Step 5: Commit** — `feat(toolbox): post every unconfirmed BEEF transaction, parents first`

### Task 4: Classify BSV Broadcaster answers

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/arcadeBroadcastProvider.ts` (`handleArcResponse`)
- Test: `packages/expo-wallet-toolbox/__tests__/services/arcadeBroadcastProvider.test.ts`

**Interfaces:**
- Produces: `handleArcResponse(serviceName, response: { ok: boolean; status: number }, data: { txid?: string; txStatus?: string; status?: number | string }, txids: string[]): PostTxResultForTxid` (adds `status` to `data`'s type). New constant `ARC_INVALID_CODES = new Set([461, 464])`.

- [ ] **Step 1: Write the failing tests** (`describe('BSV Broadcaster answers')`, `id = 'aa'.repeat(32)`):
  - 400 `{ txid: id, status: 461 }` → `status: 'error'`, `serviceError` undefined, `doubleSpend` undefined.
  - 400 `{ txid: id, status: '464' }` → same (Review Focus 3).
  - 400 with `status` 460, 462, 465, 466 or 476 and `txid: id` → `serviceError: true` (one `it.each`).
  - 400 `{ txid: 'bb'.repeat(32), status: 461 }` → `serviceError: true`.
  - 400 `{ error: 'unsafe callback URL' }` (no txid, no code) → `serviceError: true`.
  - 503 `{ error: 'backpressure' }` → `serviceError: true`.
  - 202 `{ txid: id, txStatus: 'DOUBLE_SPEND_ATTEMPTED' }` → `doubleSpend: true` (unchanged).
- [ ] **Step 2: Run to see them fail** — same jest file. Expected: FAIL on the 461/464 cases only.
- [ ] **Step 3: Implement:** in `handleArcResponse`, before the final `else`, add the branch `response.status === 400 && data.txid === txids[0] && ARC_INVALID_CODES.has(Number(data.status))` → leave `status: 'error'` with no `serviceError`. Add a comment that names the anti-goal (XR-062 cascade) and why the list is short.
- [ ] **Step 4: Run the tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(toolbox): treat only BSV Broadcaster validator 461/464 as final rejections`

### Task 5: 30-second budget and the end-to-end tests through Services.postBeef

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/walletServiceConfig.ts` (`createServices`)
- Test: new `packages/expo-wallet-toolbox/__tests__/services/postBeefThroughServices.test.ts`

**Interfaces:**
- Consumes: `BROADCAST_PROVIDER_BUDGET_MS` (Task 3), `registerBroadcastProviders` (Task 2), `createServices` (existing).
- Produces: `createServices(...).services` with `postBeefUntilSuccessSoftTimeoutMs === BROADCAST_PROVIDER_BUDGET_MS`, `postBeefUntilSuccessSoftTimeoutPerKbMs === 0`, `postBeefUntilSuccessSoftTimeoutMaxMs === BROADCAST_PROVIDER_BUDGET_MS`.

- [ ] **Step 1: Write the failing tests.** Build `const { services } = createServices('test', 'cb', rate)`, then `registerBroadcastProviders(services, NETWORKS.test, NETWORKS.test.arcadeUrl, 'cb', '', undefined)`. Mock `global.fetch` by URL: front-door `/tx` answers 202 `{ txid: <parsed from EF body>, txStatus: 'SEEN_ON_NETWORK' }` after a 600 ms timer. Use `jest.useFakeTimers()` and `jest.advanceTimersByTimeAsync`.
  - `soft timeout is a flat 30 s`: the 3 field values above, and `services.getPostBeefSoftTimeoutMs(10_000_000)` returns `30000`.
  - `1, 2 and 25 transactions publish on BSV Broadcaster alone` (`it.each([1, 2, 25])`): `await services.postBeef(beef, ids)` → `rs.length === 1`, `rs[0].name === 'Arcade'`, `rs[0].status === 'success'`, `rs[0].txidResults.map(r => r.txid)` equals `ids`; every fetch URL starts with `https://broadcast.bsvblockchain.tech/testnet/tx`; fetch count equals the unconfirmed count.
  - `a rejected parent stops its descendants and falls through`: front door answers 400 `{ txid, status: 461 }` for `ids[0]`; GorillaPool succeeds → `rs[0].txidResults[1].serviceError === true`, `rs[1].name === 'GorillaPoolArc'`.
- [ ] **Step 2: Run to see them fail** — `npx jest packages/expo-wallet-toolbox/__tests__/services/postBeefThroughServices.test.ts`. Expected: FAIL on the soft timeout (5000 default) and the 25-tx case.
- [ ] **Step 3: Implement:** in `createServices`, after `new Services(...)`, set the 3 fields to the Interfaces values.
- [ ] **Step 4: Run the whole services folder and tsc** — `npx jest packages/expo-wallet-toolbox/__tests__/services && npx tsc --noEmit -p .`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** — `feat(toolbox): give each broadcast provider a flat 30 s budget`

### Task 6: Changelog and final checks

**Files:**
- Modify: `packages/expo-wallet-toolbox/CHANGELOG.md` (under `## Unreleased`)

- [ ] **Step 1:** Add `### Changed` (front door URLs for all 4 networks; provider order; 30 s budget; every unconfirmed BEEF transaction posted parents first; 461/464 final) and `### Removed` (Taal: `taalArcUrl`, `taalApiKey`, `createTaalBroadcastService`; hosts that pass `taalApiKey` must drop it).
- [ ] **Step 2: No Taal left**
  Run: `git grep -n -i taal -- packages/expo-wallet-toolbox/core packages/expo-wallet-toolbox/__tests__ app`
  Expected: no output, except `validateArcUrl.test.ts` (it tests URL syntax with a sample host; leave it).
- [ ] **Step 3: Full checks**
  Run: `npx tsc --noEmit -p .` then `npx jest --ci`
  Expected: 0 tsc errors; jest failures only in `enrollWizard` / `vaultScreen`, or none.
- [ ] **Step 4: Commit** — `docs(toolbox): changelog for BSV Broadcaster`
- [ ] **Step 5: Owner device check (not done by the agent).** On testnet, publish a chain of at least 5 transactions from the app. The log shows one `[Arcade] POST /tx 202` per transaction and no `GorillaPoolArc`/`WhatsOnChain`/`Bitails` lines. Record the result in the PR.
