# Dead-End Fixes Review — Follow-up Design

**Date:** 2026-08-31
**Status:** Ready for planning
**Source:** [Dead-End Fixes Review](../Dead-End%20Fixes%20Review.mhtml) (master @ 4c1b3b1)
**Parent:** [2026-08-31-payment-dead-end-fixes-design.md](./2026-08-31-payment-dead-end-fixes-design.md)

## Goal

The first dead-end change put the right mechanisms in place. This change stops those mechanisms failing open: a forged `payment_cancelled` must not delete someone else's derivation data; Check Wallet must not mark good coins unspendable on a network error; `reviewStatus` must not roll back a whole repair because one completed row throws; a header miss must not auto-NACK a healthy payment; a check that did nothing must not say “Everything looks good”.

## Non-goals

- Re-doing persist-before-deliver, credit-then-ack, NACK-before-ack, the `payment_control` box, or Check Wallet as a product. Those stay.
- Patching `@bsv/message-box-client` or `@bsv/wallet-toolbox-mobile` in `node_modules`. Avoid the spec-op auto-release API instead of changing the library.
- The 68-finding remainder that is not in §2 (deferred; listed in §10).
- Headless iOS/Android background fetch.

## Product requirements this change satisfies

1. Destructive writes need a **positive confirmation**, not an absence of contradiction. (`m.sender === controlMsg.sender`; `getUtxoStatus.status === 'success' && isUtxo === false`.)
2. A Check Wallet run that could not finish a step is distinguishable from a run that found nothing wrong. Retry is reachable in both the error and the “couldn’t check” states.
3. Environmental credit failures (offline, headers behind, network) never increment `MAX_AUTO_ATTEMPTS` and never auto-NACK.
4. Apple HIG from the parent spec §11 still binds every new string and surface.

---

## 1. Verified against 4c1b3b1

The review is technically correct on the ordered items:

| Claim | Code |
|---|---|
| `payment_cancelled` drops inbox tokens by txid alone | `dropInboxTokenForTxid` filters `txidFromInboxBody(m.body) === txid` and never compares `m.sender` |
| Resend falls back to the requester | `rebuildAndDeliver`: `entry?.recipient \|\| recipientFromLabels(listed?.labels) \|\| args.recipient`; `handleResendRequests` passes `recipient: sender` |
| Send labels are only `peerpay` | `createAction({ labels: ['peerpay'] })` — `recipientFromLabels` never matches |
| Spec-op auto-release on Check Wallet | `listOutputs({ basket: specOpInvalidChange, tags: ['all','release'] })` |
| `checkUtxoSpendability` includes `nosend`/`unproven` | `txStatus: ['completed', 'unproven', 'nosend']`; BEEF-fetch failure still `updateOutput({ spendable: false })` |
| `reviewStatus` invalid-req query includes completed txs | `WHERE r.status = 'invalid' AND t.status <> 'failed'` — no `provenTxId IS NULL`, no `status <> 'completed'` |
| Shipping `reviewStatus` uses `updateTransactionStatus` | `StorageExpoSQLite.reviewStatus` — tests call `reviewStatusOnDb` only |
| `takeLastMissHeight` is consume-once, snapshotted pre-pass | `makeCreditClassifier` calls it once before any payment |
| Check ports swallow errors and Done says OK | `WalletCheckScreen` port wrappers `catch { return zeros }`; Done uses `wallet_check_ok` whenever counts are zero |
| `cancelOutboxPayment` uses the caller’s snapshot | `if (mode !== 'abandon' && (entry.delivered \|\| entry.delivering))` — no re-read |
| Corrupt `PENDING_KEY` is never replaced with a valid empty/repaired blob | `readAll` copies aside and throws; original key stays corrupt forever |
| Completed nearby entries stay in the blob | `getUnprocessed` filters them in memory; `writeAll` never drops `completed` |

---

## 2. What to fix (authoritative order)

Copied from the review’s “What to fix, in order”. This is the entire in-scope list.

### 2.1 Blocker — authenticate `payment_cancelled`

Require `m.sender === controlMsg.sender` before acknowledging any inbox token for a `payment_cancelled`. Ack the control message itself only after the authenticated drop (or when there is no matching token). A mismatched sender is left in the control box unacked so it cannot be used as a delete oracle; it is not treated as a resend.

Never fall back to the requester as the resend recipient. Record the recipient pubkey as a `createAction` label at send time (`labels: ['peerpay', recipient]` where `recipient` matches `/^(02|03)[0-9a-fA-F]{64}$/`). `rebuildAndDeliver` uses `entry?.recipient || recipientFromLabels(listed?.labels)` only — if both are missing, the request stays pending and is not delivered.

Tests must include a mismatched-sender cancel that leaves the inbox token in place.

### 2.2 Blocker — never release on an inconclusive UTXO answer

A coin is released (marked `spendable = 0`) only when **all** of:

1. `getOnline()` is true.
2. The output’s transaction status is not `nosend` and not `unproven`.
3. The txid is not in a live `offline_actions` row (`queued` / `posting`).
4. `getUtxoStatus` (or the WoC `/spent` equivalent already used by `checkUtxoSpendability`) returned `status === 'success' && isUtxo === false` — for WoC: HTTP 200 with a spending txid. HTTP errors, timeouts, 404, and abort **must not** mark unspendable. A failed BEEF fetch after a confirmed spend may skip change recovery; it must not be the reason the original output is released — the confirmed-spend answer already is.

Remove Check Wallet’s `specOpInvalidChange` + `tags: ['all','release']` call. That API treats a provider error as “not a UTXO”. Do not patch the library.

Both Check Wallet coins-step call sites (`reviewSpendable` / `checkUtxoSpendability`) are gated on `getOnline()`. Offline → skip the coins network scan, report the coins step as error (so Done is not “Everything looks good”), and do not release.

### 2.3 High — `reviewStatus` must not fail completed txs and must not abort the pass

`REVIEW_INVALID_REQ_TXS_SQL` adds `AND t.provenTxId IS NULL AND t.status <> 'completed'`.

Each per-tx `updateTransactionStatus('failed', …)` is wrapped in try/catch: a throw on one row logs and continues; it does not roll back sibling repairs. The wrapping `this.transaction` stays for the SQL reads, but a per-row status write that throws is swallowed for that row only (use a nested savepoint, or catch `updateTransactionStatus` and continue — do not let one completed/proven row abort the function).

Tests must exercise the **shipping** `StorageExpoSQLite.reviewStatus` path (or a helper it actually calls), not only `reviewStatusOnDb`. Keep the SQL-helper tests; add a case: completed tx + invalid req is left `completed`.

### 2.4 High — header-miss is non-consuming and read at failure time

Add `peekLastMissHeight(): number | undefined` that returns `lastMissHeight` without clearing it. `takeLastMissHeight` may remain for tests; production classifiers must not consume.

`makeCreditClassifier` awaits `getOnline()` once per pass (keep that). It does **not** snapshot or consume last-miss. The returned function calls `peekLastMissHeight()` **inside** `classifyCreditError` at the moment of the failure, after the double-spend check.

Order inside `classifyCreditError`:

1. double_spend (unchanged regex)
2. `ctx.offline` → environmental
3. `ctx.lastMissHeight != null` → environmental
4. network / timeout / chaintracks regex → environmental
5. structural

A headers-behind miss that happens **during** the pass is therefore visible to the payment that failed because of it. A joining caller that peeks does not destroy the marker for the credit pass.

### 2.5 High — Check Wallet per-step `ok` / `error`

`runWalletCheck` records `{ id, status: 'ok' | 'error' }` for each of the four steps. A port throw is `error` for that step; later steps still run. Returned summary includes `steps` and `allOk: steps.every(s => s.status === 'ok')`.

Ports in `WalletCheckScreen` stop swallowing into zero counts: they throw (or return a rejected promise) so the orchestrator can mark the step.

Done copy:

- `allOk && freedCoins === 0 && recoveredPayments === 0` → existing `wallet_check_ok` (“Everything looks good”) + success haptic.
- `allOk && (freedCoins > 0 || recoveredPayments > 0)` → existing `wallet_check_summary`.
- `!allOk` → new `wallet_check_couldnt` (“Couldn't check”) + `wallet_check_couldnt_body` (“A repair step didn't finish. Nothing was assumed about your coins.”) + **Retry** button + error haptic. No success haptic.

Retry remains the existing control; it must render in the `!allOk` state, not only when `runWalletCheck` itself throws.

### 2.6 High — cancel re-read, broader environmental regex, pending repair, prune

**Cancel:** `cancelOutboxPayment` re-reads the outbox entry by `entry.id` from storage before the undelivered abort. If the stored row is now `delivered` or `delivering`, return `{ aborted: false, needsAbandon: true }` and do not abort. The caller’s stale snapshot is not authority.

**Environmental regex:** extend `classifyCreditError` (and `isMessageBoxNetworkError` where the same strings appear) to also match `database-locked`, `failed to retrieve messages`, and `not found on refresh` as environmental. Those are conditions the sender cannot fix; they must not burn auto-attempts.

**PENDING_KEY repair:** after a successful quarantine copy, write a valid `[]` (or a repaired parse) back to `PENDING_KEY` so later `savePending` is not permanently blocked. Keep the quarantine copy. `PendingCorruptError` is still thrown to the caller of that read so the notice can show once; the next read of `PENDING_KEY` sees valid JSON.

**Prune:** when writing the nearby queue, drop entries with `status === 'completed'`. Failed entries stay (they are retryable). Bound home-screen parse cost.

### 2.7 Medium — performance pass

- `REVIEW_OUTPUTS_SQL` and the failed-tx scan gain a `WHERE` that excludes rows that cannot change (`spendable = 0 AND spentBy IS NULL` outputs do not need to be loaded). Move the full-table output walk off the exclusive write as far as SQLite lets us: read into memory, then write only the rows that have an action, each in its own short transaction or savepoint.
- `acceptWithRetry` does not relist the whole inbox on every failure. Retry the same `payment` object once; if the error is `Payment not found on refresh` / missing message, skip. Cap: at most one `listIncomingPayments` per pass, not per payment.
- `boundReviewProvenTxs`: do not run when `getOnline()` is false. Cadence floor 10 minutes (not every monitor minute). Keep the existing 100-height cap.
- Prune sent outbox entries older than 30 days from `TaskDrainOutbox` (or a function it calls), not only when the Pay screen loads.

### 2.8 Medium — arrival notification from `TaskCreditInbox`

When a background credit pass accepts `accepted > 0` and HandleReceive is not focused, fire the same confirmation tone the nearby/address rails use (`sounds.confirmation` from `core/hooks/useConfirmationSound.ts`) and a success `showToast` with `payment_arrived` (“Payment received”). Do not present an alert. Do not full-screen overlay from the monitor task. The home list already refreshes via attention count / ledger; this is the audible + transient FYI the review asked for.

If HandleReceive is focused, it already owns the overlay — do not double-toast.

---

## 3. Copy (English) — additions only

Parent spec §11.5 still binds. New keys, all 12 locales (non-English may copy English):

| Key | English |
|---|---|
| `wallet_check_couldnt` | Couldn't check |
| `wallet_check_couldnt_body` | A repair step didn't finish. Nothing was assumed about your coins. |
| `payment_arrived` | Payment received |

No `Alert.alert`. No celebration on Check Wallet. Retry is a 44×44 `PressableScale` (or the existing retry `TouchableOpacity` already at 44×44 — do not shrink it).

---

## 4. Apple HIG

Parent spec §11 applies unchanged. Specifically for this change:

- “Couldn't check” is in-context copy on the pushed Check Wallet screen, not a launch alert.
- Background arrival is a toast + confirmation sound, not an alert on foreground.
- Destructive cancel of someone else’s payment is not a user-facing control; it is a protocol check with no new dialog.

---

## 5. Testing

TDD per task. Jest from repo root: `npx jest <path> --no-coverage`.

Must-have cases:

- Mismatched `payment_cancelled` sender: inbox token remains, control message not acked as a successful drop of that token.
- Matching sender: current drop-then-ack order preserved.
- Resend with no outbox and no recipient label: no `sendMessage` to the requester.
- `createAction` labels include the recipient pubkey.
- `shouldReleaseOutput` (or equivalent): error / timeout / 404 / nosend / unproven / live offline_action → no release; success + spent → release.
- `checkUtxoSpendability` / coins port: offline → no network, no unspendable writes.
- Invalid req on a `completed` tx: status stays `completed`.
- `updateTransactionStatus` throw on one row does not prevent restoring another row’s input.
- Peek last-miss does not clear; classify during the pass sees a miss recorded after the classifier was built.
- `runWalletCheck` with a throwing coins port: `allOk === false`; records/proofs/missed still ran.
- `cancelOutboxPayment` with a stale undelivered snapshot whose stored row is now `delivered`: no abort.
- Corrupt pending: after the throwing read, `PENDING_KEY` is valid JSON `[]` and a `localpay_pending_corrupt_*` copy exists.
- Completed nearby entries are absent after the next write.
- `acceptWithRetry` does not call `listIncomingPayments` when the first internalize succeeds; a full pass of N failures lists at most once.
- ReviewProvenTxs trigger is false when offline.
- CreditInbox `accepted > 0` invokes the notification port once.

---

## 6. Architecture notes

Keep helpers small and next to the code they change:

- `dropInboxTokenForTxid(client, txid, sender)` — sender required.
- `shouldReleaseUtxo({ online, txStatus, txid, liveOfflineTxids, utxo })` in `core/walletRepair/` or next to `checkUtxoSpendability`.
- `peekLastMissHeight` on `OfflineFirstChaintracks` and `WalletContext`.
- `runWalletCheck` owns step outcomes; the screen only renders them.

Do not introduce a second control-box parser. Do not add a new MessageBox.

---

## 7. Out of scope (deferred from the 68)

Everything not in §2, including but not limited to: extra-root cache invalidation on rewind; `TaskDrainOutbox` head-of-line blocking; credit mutex force-caller overlap; `listIncomingPayments` default `acceptPayments`; unbounded Check Wallet sweep; `sqlUpdateValue` beyond `spentBy`; overlay identity-search outage copy; resend KV prune; `inputTxidsFromRawTx` fail-open. Track them against the review MHTML; do not implement in this change.

---

## 8. Self-review

- Placeholder scan: none.
- Conflicts: parent spec said consume-once last-miss so every payment in a pass shares the snapshot. This spec **replaces** that with peek-at-failure-time because the consume-once snapshot misclassifies the first headers-behind failure and lets a joining caller steal the slot. Binding authority is this review, not the old snapshot rule.
- Scope: one plan, ten tasks, sequential because they share `handleResendRequests.ts`, `creditErrors.ts`, `WalletCheckScreen.tsx`, and `StorageExpoSQLite.ts`.
