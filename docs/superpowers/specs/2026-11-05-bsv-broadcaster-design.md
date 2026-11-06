# BSV Broadcaster as the wallet's broadcast path

Date: 2026-11-05. Owner: Deggen. Nestr: task `Z3GQGzz5nMBAtRQsY` (under "Product: non-custodial wallet").

## Why

A dApp in BSV Browser published a chain of 13 transactions with `noSend` + `sendWith`. Every transaction reached the chain, but the publish was slow. The cause has two parts:

1. Before bsv-wallet#94, each EF provider turned the BEEF into ONE transaction and returned ONE result. The toolbox's `validatePostBeefResult` (in `Services.postBeef`, `@bsv/wallet-toolbox-mobile`) wants exactly one result per requested txid, so it turned every multi-transaction batch into a service error. Arcade, Taal, GorillaPool and WhatsOnChain all failed in turn, and only Bitails (which posts the whole BEEF) succeeded.
2. #94 posts each requested txid on its own, parents first. That fixes part 1, but a serial walk of a long chain runs past the `UntilSuccess` soft timeout that the toolbox applies to each provider (5 s + 50 ms per KB, max 30 s). On a phone link at about 600 ms per round trip, a 13-transaction chain needs about 8 s.

Arcade is now called **BSV Broadcaster** (docs: https://docs.bsvblockchain.org/broadcasting/bsv-broadcaster, OpenAPI: `openapi/bsv-broadcaster.openapi.yaml` in `bsv-blockchain/broadcaster`). It has one public front door per network.

## Goals

- Every network uses the BSV Broadcaster front door as its primary endpoint for broadcast, SSE and chaintracks.
- A multi-transaction BEEF publishes on the first healthy provider, with no fall-through caused by the wallet's own posting pattern.
- The provider chain is BSV Broadcaster → GorillaPool's BSV Broadcaster → WhatsOnChain → Bitails. Taal is gone.

## Non-goals

- The `POST /txs` batch endpoint. (Owner decision. It returns only counts, and one invalid transaction fails the whole call.)
- Cross-region state. The front door sits behind Cloudflare (`x-arcade-region` header), and an instance knows only the transactions sent to it (`GET /tx/{txid}`, SSE). If a status lookup lands on another region, we accept it. Other services (WhatsOnChain, Bitails, the toolbox's proof paths) cover the gap. (Owner decision.)
- Switching the scaling testnet (`scaletest`) to `available: true`. That stays a separate, deliberate change.
- Changes to `@bsv/wallet-toolbox-mobile` or `@bsv/sdk`. If a goal needs one, stop and raise it.

## Anti-goals

- A transaction that is valid but lands in a terminal "invalid" state because of a wallet classification error. `offline/plan.ts` `applyOutcome` cascades terminal verdicts to every descendant and releases reservations, so a false terminal verdict kills a valid payment chain (see XR-062 in `arcadeBroadcastProvider.ts`).
- A child posted before its parent is accepted.

## Constraints and facts (checked 2026-11-05)

| Network (`AppChain`) | BSV Broadcaster (primary) | GorillaPool BSV Broadcaster | WhatsOnChain | Bitails |
| --- | --- | --- | --- | --- |
| `main` | `https://broadcast.bsvblockchain.tech` | `https://arcade.gorillapool.io` | yes | yes |
| `test` | `https://broadcast.bsvblockchain.tech/testnet` | `https://testnet.arcade.gorillapool.io` | yes | yes |
| `teratest` | `https://broadcast.bsvblockchain.tech/ttn` | none | yes (woc-ttn) | no |
| `scaletest` | `https://broadcast.bsvblockchain.tech/tstn` | none | none | no |

- All 4 front-door paths run v0.20.0. `/health`, `/policy` and `/chaintracks/v2/network` answer under each path prefix, so `${base}/chaintracks/v1` works with a path-prefixed base. `/chaintracks/v2/network` reports `main`, `test`, `teratestnet` and `tstn`.
- Each `/policy` reports `standardFormatSupported: false`: `POST /tx` takes **EF only** (a plain transaction gets ARC 460). BEEF gets 400.
- Mainnet `miningFee` is 100 sat/kB. On test it is 1 sat/kB, on ttn and tstn it is 0.
- GorillaPool's instances run v0.17.1 (before the rename) and serve `POST /tx` at the root, not `/v1/tx`. They return 404 on `/chaintracks/v1`. The testnet host `testnet.arcade.gorillapool.io` was found by a probe and is not in the docs.
- The wallet builds transactions at 100 sat/kB (`feeModel` in `WalletContext.tsx`), equal to the mainnet policy.
- `POST /tx` answers: `202 {txid, status, txStatus}` (a resubmit also gets 202 with the current `txStatus`, which can be `REJECTED` or `DOUBLE_SPEND_ATTEMPTED`); `400` with `{error, reason, txid, status (ARC code), title, detail, type}`; `503` with `Retry-After` (backpressure, nothing queued).
- A `400` is a verdict about the transaction bytes only for a **validator** failure. A 400 can also mean a malformed request, an empty body or an unsafe callback URL. ARC code `476` (locktime not yet final) persists no verdict and may be resubmitted later.
- The SDK's `ARC` class posts to `/v1/tx`, which BSV Broadcaster does not serve. Do not use it.
- `UntilSuccess` stops at the first provider whose result is `success`. A soft-timed-out provider's call keeps running in the background.

## Design (decided)

### 1. Endpoints

- `NETWORKS[*].arcadeUrl` becomes the front-door URL in the table above. It keeps its other roles: SSE (`/events`), the toolbox's `Arcade` provider (proofs, `GET /tx/{txid}`), and `/chaintracks/v1` (`walletServiceConfig.ts`).
- `taalArcUrl` is removed from `NetworkProfile`, `NETWORKS`, `createTaalBroadcastService`, its tests and `serviceOptions.taalApiKey` wiring. (Owner: Taal ARC is being deprecated.)
- `gorillaPoolArcUrl` points at GorillaPool's BSV Broadcaster for `main` and `test`, and GorillaPool posts to `/tx`, not `/v1/tx`.
- Provider order in `WalletContext.tsx` (the block that replaces the toolbox's providers): BSV Broadcaster → GorillaPool → WhatsOnChain → Bitails, each only where the table says it serves the network. (Owner decision.)
- User-facing names (UI labels and preset labels) change from "Arcade" to "BSV Broadcaster". Provider ids and note names (`Arcade`, `ArcadeBeef`, `ArcadePostEF`) do not change, because the toolbox and the logs match on them. (My call.)
- The primary endpoint (default or user-selected) must serve all of `POST /tx`, `/events` and `/chaintracks/v1`, because `arcUrlOverride` feeds the broadcaster, SSE, proofs and chaintracks. So the `KNOWN_ARC_URLS` presets in `core/constants.ts` list only v0.20+ BSV Broadcaster instances: the front door (default) on every network, plus `https://arcade-us-1.bsvblockchain.tech` and `https://arcade-eu-1.bsvblockchain.tech` on `main` (both v0.20.0 with chaintracks on 2026-11-05; `arcade-ap-1` did not answer and is left out). GorillaPool is NOT a preset: its v0.17.1 instances return 404 on `/chaintracks/v1`, so it is a fallback provider only. Taal and the old `arcade-us-1.bsvb.tech` preset are removed. A free-text custom URL is supported only for an endpoint that serves `POST /tx` at its root; a standard ARC that serves only `/v1/tx` is not supported. The optional API token (`arc_custom_api_token_*`) keeps its current wiring (`apiKey` of the toolbox's `Arcade` config). (My call.)
- If the primary endpoint equals GorillaPool's URL, GorillaPool is not added a second time. (My call.)

### 2. Posting a BEEF (all EF/raw providers)

- Walk the BEEF in topological order (parents first). Post every **unconfirmed** transaction (no merkle proof in the BEEF) on its own, including ancestors that are not in the requested txids. Skip transactions that already have a merkle proof. (Owner: "posting EF for each ancestor until we eventually reach the tip".)
- Post a child only after its parent is accepted. A child whose parent was not accepted is not posted, and its result is a retryable service error. This is #94's rule, now applied to the whole unconfirmed set.
- BSV Broadcaster and GorillaPool get EF as `application/octet-stream` to `/tx`. WhatsOnChain gets raw hex to `/tx/raw`, in the same order.
- The returned `PostBeefResult` has exactly one `txidResult` per **requested** txid, in the caller's order, with `txid` equal to the requested txid. Ancestor outcomes only decide whether their descendants are posted.
- A requested txid that already has a merkle proof in the BEEF is not posted, and its result is `success` (it is mined). The toolbox's `snapshotPostBeefRequest` already refuses a requested txid with no raw transaction, so a txid-only requested entry cannot occur. (My call.)
- A descendant of an ancestor that was not accepted gets a retryable service error. Its `data` names the ancestor and that ancestor's outcome (for example "parent {txid} rejected: ARC 461"). An ancestor outside the requested txids is never given a terminal verdict by this code, so a foreign ancestor cannot cascade a terminal verdict into the wallet's own transactions. The cost is repeated retries of a chain whose foreign ancestor is truly invalid. (My call.)
- The caller's `Beef` is not modified (#94's `postingOrder` sorts it in place).

This builds on #94 (`postingOrder` / `postEachTransaction`). #94 merges first, and this work starts from master after it.

### 3. Time budget

A serial walk must not lose to the `UntilSuccess` soft timeout on an ordinary chain. Target: a 25-transaction unconfirmed chain at 600 ms per round trip completes on the first provider.

The toolbox exposes the knobs as public fields on the `Services` instance: `postBeefUntilSuccessSoftTimeoutMs` (default 5,000), `postBeefUntilSuccessSoftTimeoutPerKbMs` (default 50) and `postBeefUntilSuccessSoftTimeoutMaxMs` (default 30,000), each an integer from 0 to 3,600,000. The soft timeout is also the longest the wallet waits on an unresponsive provider before it tries the next one, while the timed-out call keeps running in the background. So the time budget has two edges: long enough for a long chain, and short enough for a hung primary. Set the knobs in `walletServiceConfig.ts` for an overall cap of **30 seconds** per provider (owner decision; about 50 transactions at 600 ms each).

Inside the provider, the walk also stops at that cap: once the cap passes, the provider posts no further transactions and returns retryable service errors for the requested txids it did not reach. This bounds the background work of a timed-out walk, which `BROADCAST_TIMEOUT_MS` (30 s per request, unchanged) does not.

### 4. Reading BSV Broadcaster answers (my call, conservative)

- `202` with an accepted `txStatus` and a matching txid: success (as today).
- `202` with `REJECTED` or `DOUBLE_SPEND_ATTEMPTED` on a resubmit: as `handleArcResponse` treats those statuses today.
- `400` that is a validator verdict about the transaction bytes: invalid, that is `status: 'error'` with no `serviceError` and no `doubleSpend`. This applies only when the body's `txid` matches the posted txid AND the ARC code is on this allow-list: **461** (invalid unlocking scripts / malformed) and **464** (invalid outputs). Every other 400 is a retryable service error, including: 460 (not EF: a request-format problem), 462 (inputs: can be propagation lag), 465 (fee too low: a policy that differs per instance; the wallet builds at 100 sat/kB, equal to the mainnet policy), 466 (conflicting transaction: double spends come only from the structured `DOUBLE_SPEND_ATTEMPTED` status, as today), 476 (not final), and any 400 with no txid, a txid that does not match, or no ARC code (malformed request, unsafe callback URL). (My call: a short allow-list, because a false terminal verdict is the anti-goal.)
- `503`: retryable service error. No in-provider retry loop; the next provider takes over.
- `SEEN_IN_ORPHAN_MEMPOOL` stays retryable (XR-062).

If the toolbox gives an invalid verdict no faster path than a service error (that is, `UntilSuccess` still tries every provider), say so in the PR. The classification is still worth having for the result the wallet records.

## Done when

- Unit tests run 1-, 2- and 25-transaction BEEFs through the real `Services.postBeef` (from `@bsv/wallet-toolbox-mobile`) with mocked fetch. They show: parents-first EF posts to `/tx` on the front door; one request per unconfirmed transaction; unconfirmed ancestors outside the requested txids are posted; results pass `validatePostBeefResult`; the 25-transaction case finishes on the first provider within its soft timeout; a rejected parent stops its descendants.
- Tests cover each `400` case in §4, `503`, and GorillaPool on `/tx`.
- No `taal` broadcast code or URL is left in `packages/expo-wallet-toolbox/core` (tests included).
- tsc reports 0 errors. Jest passes, apart from the known baseline flakes (`enrollWizard`, `vaultScreen`).
- A testnet device check: publish a chain of at least 5 transactions from the app, and see each one accepted by the front door with no fall-through in the log. (Owner runs it, or it is listed as not done.)
- CHANGELOG entry under Unreleased.

## Left to the builder

- How to structure the walk and the classification code.
- How the soft-timeout knobs in §3 map to the cap (base, per-KB and max values).
- Migration of a stored custom ARC URL that points at Taal (`arc_custom_url_*`). There are no users yet (pre-launch), so dropping it is acceptable.
