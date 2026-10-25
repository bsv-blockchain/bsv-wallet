# 1Color / BRC-207 in bsv-wallet: final report (plan 07)

Branch `feat/1color` in `/Users/personal/git/bsv-wallet-wt/1color`, written by
plan 07 Task 19 on 2026-10-22. `@bsv/expo-wallet-toolbox` moves to **0.21.0**:
1Color/BRC-207 tokens through `@bsv/color-permission-module`, with no Mandala
0.4 compatibility. Plan: `docs/superpowers/plans/2026-10-22-1color-07-bsv-wallet.md`
in the mandala worktree. The seam contract is `2026-10-22-1color-00-interfaces.md`
(IC, Revision 2).

## Gates against the baseline (`docs/superpowers/1color-baseline.md`)

| Gate                           | Baseline (ae9dec61, before 1Color)       | Final (this branch)                          |
| ------------------------------ | ---------------------------------------- | -------------------------------------------- |
| `npx jest` suites              | 2 failed, 2 skipped, 370 passed (374)    | **0 failed**, 2 skipped, 377 passed (379)    |
| `npx jest` tests               | 2 failed, 10 skipped, 6403 passed (6415) | **0 failed**, 10 skipped, 6304 passed (6314) |
| `npx tsc --noEmit -p .`        | 0 `error TS`                             | **0** `error TS`                             |
| Leftover grep (Task 19 Step 1) | n/a                                      | only allowed hits (below)                    |
| `expo export` ios              | n/a                                      | `Exported:` (3356 modules)                   |
| `expo export` android          | n/a                                      | `Exported:` (3435 modules)                   |

The final column is the re-run after the whole-plan review fixes (below):
6297 → 6304 tests, the seven new pins.

The baseline's two failures were load-sensitive 5000 ms timeouts
(`vaultScreen`, `enrollWizard`); both pass in the final full run. The test
count drops because the σI suites (P-module, basket migration, settlement
store, drain, bundle, token frames, settlement ack) were deleted with their
code.

The full run just before Task 19 had one failure:
`__tests__/networks.test.ts › scaletest is wired but not offered › cannot
build its services on the installed toolbox yet`. That test was a canary that
threw on toolbox 2.14.x, which had no `'regtest'` chain. The 2.15.0 upgrade
(Task 2) set it off as intended. Task 19 replaces it with a positive test
that builds the services, and `NETWORKS.scaletest.available` stays `false`.
Offering scaletest in the picker is a product call outside 1Color.

**Leftover grep.** `grep -rnE "p mandala|MANDALA_BASKET|token_settlements|FT_PROTOCOL|MandalaTokenModule|settlementAck|coverFromFrame|baseUnits|overlayIdentityKey.*session" core ui __tests__`
(excluding `core/toolboxConfig.ts`) still matches lines, and every match is
deliberate:

- `core/mandala/transferJournal.ts`: `LEGACY_MANDALA_TABLES`, the migration's
  drop list.
- `__tests__/storage/colorMigration.test.ts` and
  `__tests__/ui/importDatabases.test.ts`: legacy tables seeded to prove the
  migration drops them and a pre-1Color backup is refused.
- `colorRegistration`, `colorBarrel`, `nearbyRail` and `PermissionSheet`
  tests: negative pins asserting the old names are absent or refused.
- `colorSigningGate.test.ts`: a doc comment on the audit pins.

Task 19 fixed the stale hits: `vault/guard.test.ts` now uses the module's
`colorProtocolID`/`assetBasket` instead of `[2, 'p mandala token']` and the
`'p mandala'` basket. Stale σI comments in `nearbyFlowToken.test.tsx`,
`payerHold.test.ts`, `core/localpay/types.ts` (`not_covered`) and
`NearbyFlow.tsx` were rewritten.

**Metro smoke, verbatim tails** (`CI=1 npx expo export --platform <p>`; the
output dir is in the session scratchpad, not `$TMPDIR`):

```
iOS Bundled 23013ms index.js (3356 modules)
Exported: …/scratchpad/1color-export
Android Bundled 20483ms index.js (3435 modules)
Exported: …/scratchpad/1color-export-a
```

The only warning is from before 1Color: `@bsv/btms-permission-module`
"listed in the exports … however no match was resolved … Falling back to
file-based resolution". It comes from that package's own `exports` map, now
that `unstable_enablePackageExports` is asserted. It is harmless.

## Vendored inputs (IC §9)

Root `package.json` pins `file:vendor/*.tgz` with `$name` overrides:
`bsv-sdk-4.0.0-4fa68e7`, `bsv-templates-2.2.0-4fa68e7`,
`bsv-wallet-toolbox-client-2.15.0-4fa68e7`,
`bsv-wallet-toolbox-mobile-2.15.0-4fa68e7`,
`bsv-color-permission-module-0.2.0-4fa68e7` (ts-stack `feat/1color-profiles`
at 4fa68e7) and `bsv-mandala-0.5.0-07e58e3` (mandala `lib/` at 07e58e3).
`packages/expo-wallet-toolbox/package.json` keeps semver `peerDependencies`
(W9). Patches: `@bsv+sdk+4.0.0.patch` and `@bsv+wallet-toolbox-mobile+2.15.0.patch`.
The 2.8.11, 2.14.9 and `@bsv+mandala+0.4.1` patches are deleted.

## Decisions (W1–W11)

- **W1 Journal as the guard key.** `color_transfers` is the only durable host
  record. The broadcast hold (`colorHeldTxids`) holds a tx with any BRC-162
  output unless its row reads `settled`. A missing row holds, and so does
  unparseable bytes or a req with no raw tx. A read fault propagates and the
  callers hold the whole batch. The guard never reads the module's
  `color.v1.*` keys.
- **W2 Admin-originator consent.** `createColorAccessPolicy` approves every
  known message type for the admin originator. External originators prompt.
  A `color_access` approval leaves a 30-minute read grant for that originator
  only, and spend approvals grant nothing. `seekPermission:false` without a
  grant refuses with no prompt. Unknown types and bad JSON fail closed.
- **W3 Default provider.** The default `provider` is the same
  `createMandalaOverlayProvider` instance as the Mandala profile's. A
  non-Mandala 1Color asset fails closed against the Mandala overlay.
- **W4 Hand-over = delivery attempt.** On the handle rail the row moves to
  `handed_over` before `deliverHandover`. The abort guard refuses it whatever
  `delivered` says, and the tick redelivers from `handoffEvidence`.
- **W5 Nearby ACK.** The payee's positive `confirm(true)` is the ACK, and the
  payer then calls `settleNow(txid)`, even when offline (bbd88e21), so the
  module persists the submit intent. `settlementAck.ts` is deleted.
- **W6 Session v2.** `SESSION_VERSION = 2`. A token session carries `a` as a
  decimal string and no overlay url/key. A v1 session is a `CodecError`.
- **W7 Asset metadata.** Label, ticker and decimals come from lib
  `readDeploy`. The deploy tx comes from a cached receipt `declarationTx`
  (`bsvwallet.color.asset.<assetId>`), otherwise from
  `provider.admission(assetId, ['<txid>.0'])`. A deploy is filed only under
  its own txid's asset id. An unresolved answer is reused for 10 s and never
  pinned.
- **W8 Patch rebase.** The nine sdk files the native-secp patch touches are
  byte-identical between 2.8.11 and 4.0.0, so the sdk patch carries over
  unchanged. No `nobleBackend` native-routing assertion is skipped. The
  toolbox-mobile patch was regenerated against 2.15.0 with every hunk's
  content unchanged: only the offsets moved. A BRC-207 C.0 Chronicle vector
  gates it: low-S RFC 6979, with high-S accepted on verify.
- **W9 Toolbox package deps.** Semver `peerDependencies` in the package.
  `file:` specs and `overrides` only in the root `package.json`.
- **W10 Pending vs settled.** `available` is the `p color balance
<assetTag>` total. `offline` is the sum of `p color assets` value records
  tagged both `color_offline` and `color_state_available`.
  `settled = available − offline`, clamped to ≥ 0.
- **W11 Audit S2/S3 pins.** These ran in the primary form through the exact
  stack WalletContext publishes (a568251b). A bare digest or bare data under a
  `p color` key is refused with no prompt and no underlying call. A
  foreign-locked `p color` basket output is refused before any prompt, both
  when it is left out of `plan.ownedOutputs` and when it is named with a
  non-matching remittance.

## Contract gaps and deviations (for morning review)

- **IC §9 vs W9.** IC §9 asks for `file:../../vendor/…` in the publishable
  package. A published package must not carry `file:` peers, so they live in
  the root `package.json` only. The IC §9 text now agrees ("Publishable host
  packages … keep semver `peerDependencies`").
- **Color module export conditions.** `@bsv/color-permission-module`'s
  `exports` has only an `import` condition. Jest's require-side resolver
  never matches it, so the wallet maps the name to `dist/index.mjs` and
  transforms `.mjs` with `babel-jest`. Every RN/Jest consumer needs the same.
  A `require`/`default` condition upstream would remove that step (T2
  follow-up).
- **D21 alias.** `@bsv/wallet-toolbox-client` → `-mobile` is needed in both
  Metro and Jest. Hosts must copy both (README, Jest configuration).
- **D4 `colorHandoff`.** The hand-over evidence rides a non-standard
  `colorHandoff` member on the `signAction` result. It survives the wallet's
  wrappers (pinned in `colorRegistration.test.ts`), but BRC-100 defines no
  carrier for it.
- **Third-party originator token sends (review finding 3).** The module
  is registered for every originator. Take an external app's published or
  BRC-177 token action that the overlay admits. The module's D24
  `sendWith` reaches the storage hold, which holds it because there is no
  journal row. The tx is left out of `sendWithResults`, and the module
  calls `removeUnsent`. `processOfflineActions` then holds that owned step
  on every pass. After `2903b7c7` reconcile no longer turns its change
  into a fake receipt, but nothing in this wallet releases it either. Its
  broadcast is the overlay's on admission (design §21), as it always was
  for an exact spend with no change. The `offline_actions` row stays
  queued. The remaining fix is a contract question for IC §8.2: release a
  held owned 1Color req once the module reports its txid admitted, keyed
  on the settle report rather than on a journal row. The alternative is
  to have the module journal through a host hook. Neither is in IC
  Revision 2.
- **Review finding 4 test shape.** The finding asked for a test that a
  send leaves no `mandala.txJournal.*` key. Every wallet test mocks the
  lib's `sendHandover`, which needs a module-hosting wallet, so the pin
  checks the call arguments instead: `journal: false` on both rails
  (`handle.test.ts`, `pendingTokenHold.test.ts`). The no-key guarantee
  then rests on the lib's documented `journal: false` behaviour. A dev
  build that ran this branch before `1d0208de` keeps its earlier
  `mandala.txJournal.*` entries, because the one-time migration only
  wipes them before its marker exists. No released build is affected.
- **Address-rail decoy.** Fixed on every rail by the custody-scoped hold
  (see "Amendment B7 re-plumb" below).
- **Inert scaffolding (Task 11).** `mandala/{token,bundle,drain}.ts` were
  kept until their last importers were rewritten. Tasks 15 and 16 deleted
  them.
- **Task 19 additions beyond the listed files.** Deliberate scope additions:
  - the scaletest canary in `networks.test.ts` was replaced (above), with its
    comment in `core/networks.ts`;
  - the README's peer table and `metro.config.js` snippet were updated
    (sdk ^4.0.0, toolbox ^2.15.0, templates ^2.2.0, the two new peers, the
    alias and the `exports`/`.mjs` settings), as well as its Jest section;
  - `package-lock.json` records the 0.21.0 version, as the 0.20.0 release
    did;
  - the core barrel now exports `buildColorModule`, `createColorModuleStore`
    and `createColorAccessPolicy` (with `colorPromptType` and
    `COLOR_PROMPT_TYPES`), so a host can build the module and runtime itself.

## Whole-plan review fixes

Five findings from the whole-plan review, one commit each, tests first:

1. **Decoy 1Color output on a nearby BSV frame** (important,
   `62561d4a`). The W1 hold parks any tx with a 1Color output until its
   journal row reads `settled`, and only token transfers get a row. A payer
   could add a 1-sat OneColor output to a valid BSV frame. The payee's
   credit would then be held for good, while the payer stayed free to
   double-spend the inputs. `verifyFramePayment`'s BSV branch now
   declines such a frame (`not_mine` → `session_mismatch`) before any
   derivation, so the payee queues nothing. It uses the hold's own
   predicate (`transactionHasColorOutput`, newly exported from
   `colorGuard.ts`), so the two cannot drift. The guard itself is
   unchanged and still fails closed.
2. **Hosted renderer token amounts** (important, `a32c55a3`). The
   contracts are widened rather than kept number-shaped. On a token
   session, `NearbyConfirm`, `NearbySending` and `NearbyShowCode` carry
   `units: bigint` and `amountText`, and `NearbyConfirm` adds
   `fixedUnits`. On a token session the number fields are fixed:
   `amount` is 0 and `fixedAmount` is undefined. This follows the
   `NearbyDone`/`NearbyReceived` precedent (number `amount` plus
   `amountText`). `NearbyConfirm.holding` is now a `bigint`, and
   `setAmount` accepts a `bigint`. `settledAmount` is 0 on every token
   exit, including the no-handle exit at the old `:2375`, as Task 18
   specifies. `grep "Number(" NearbyFlow.tsx` now finds only the BSV
   `satsFrom` parse. This is a breaking type change for any host
   renderer, recorded in the 0.21.0 CHANGELOG. No in-repo host uses
   `renderPayer`.
3. **Third-party originator token actions** (minor, `2903b7c7`; contract
   gap below). `reconcileHeldTransfers` now skips an unjournaled txid
   that the wallet funded (`transactions.isOutgoing = 1`). Its inventory
   records are the sender's own change, so it no longer shows as a
   `received`/`external` credit.
4. **Lib txJournal growth** (minor, `1d0208de`). Both rails pass
   `journal: false` to `sendHandover`. The lib's precondition is
   `reconcileWallet({ sweep: false })`, and it holds vacuously because the
   wallet runs no sweep.
5. **`settleAll` ∥ `settleNow(T)`** (minor, `60053f0a`). This is pinned
   for admitted and refused verdicts: one journal transition. The pin
   exposed a real double abort of the refused hand-over. The settler now
   coalesces aborts per reference and does not repeat an abort that
   succeeded. A failed or declined abort is still retried, by the next
   report or by a `settleNow` of the refused row. `settleNow` does not
   wait for an in-flight `settleAll`, because that would put a nearby
   ACK's settle behind a slow settle-all.

## Publish order (IC §9; the user publishes manually)

1. `@bsv/sdk` 4.0.0
2. `@bsv/templates` 2.2.0
3. `@bsv/wallet-toolbox`, `@bsv/wallet-toolbox-client`, `@bsv/wallet-toolbox-mobile` 2.15.0
4. `@bsv/color-permission-module` 0.2.0
5. `@bsv/mandala` 0.5.0
6. In this repo, swap every root `file:vendor/*.tgz` spec for the registry
   range, remove the `$name` entries from `overrides`, delete `vendor/`,
   `npm install`, and confirm `patch-package` still applies both patches.
   Then publish `@bsv/expo-wallet-toolbox` 0.21.0.

The vendored ts-stack pack is 4fa68e7. `feat/1color-profiles` has since moved
on with color-module refactors and docs (HEAD f2afb87 at report time). Before
step 4, re-pack, re-vendor (`node scripts/vendor-1color.mjs`) and re-run the
gates, or confirm the published 0.2.0 matches 4fa68e7's behaviour.

## Out of scope

- **fuelkeeper (B6).** The token-fee fuel keeper is not part of this
  migration and is not wired into the wallet.
- Switching on scaletest in the network picker.

## Amendment B7 re-plumb (2026-10-24)

Design §9 B7 / IC Revision 3 on top of the branch above:

- **Dependencies.** `@bsv/sdk` ^4.0.0 and `@bsv/wallet-toolbox-mobile` ^2.15.0
  come from npm; the module's `@bsv/wallet-toolbox-client` peer is an npm
  alias of `-mobile`. Vendored: templates 2.2.0 and color-permission-module
  0.2.0 (ts-stack 993c98b), `@bsv/mandala` 0.5.0-0af06cd. The toolbox-mobile
  patch was regenerated against the published 2.15.0 (offsets only).
- **Module.** Issuer-v1 profile only, over a host ledger
  (`createHostLedger` on `key_value_store`). No attested profile,
  `settle`, `handoffEvidence`, `colorHandoff` or `color_receive_offline`.
- **Runtime.** Sends via lib `sendHandover({hostWallet, ledger})` (the v4
  body is kept for redelivery); settlement via `settleHandover` /
  `settleReceipts`, whose `markSettled` runs `module.markSettled` and then
  moves the journal row; receive via `receiveHandovers({ledger, markSettled})`.
  `offlineUnits` = `p color balance` filtered to `color_offline`.
- **Nearby.** Frame version 7 carries the v4 body members; the payee
  pre-checks COVER against its own K and credits through lib
  `acceptHandover`.
- **Decoy outputs (plan-review finding).** The hold applies only where this
  wallet's token custody is in the tx: a journal row, a host-ledger record
  (present at hold time because the lib records before it internalizes; the
  toolbox broadcasts before it stores the receipt's outputs), or an input
  spent from a `p color` basket. Pinned per rail through each rail's own
  receive code over a real toolbox wallet (`decoyOutputHold.test.ts`). A
  foreign 1Color ancestor is held only while a descendant of ours is held.

