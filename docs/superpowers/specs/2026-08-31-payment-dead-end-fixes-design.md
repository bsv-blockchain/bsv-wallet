# Payment Dead-End Fixes — Design

**Date:** 2026-08-31
**Status:** Ready for planning
**Source:** [Payment Dead-End Audit](../Payment%20Dead-End%20Audit.mhtml) (master @ dfa97d0). PDF/HTML copies of the same artifact sit next to it.

## Goal

A person who wants to pay someone, or get paid, must never end up stuck with no in-app way out they can find or understand. When the wallet cannot credit or complete a payment by itself, it must either recover automatically or give both parties a one-tap corrective action — never discard the only copy of the derivation data, never celebrate a broadcast that did not happen, and never hide a broken payment behind a screen the user has no reason to reopen.

## Non-goals

- Rebuilding the send/receive machinery. Persist-before-deliver, credit-then-ack, receiver-side `refetchAtomicBeef`, `TaskSendOffline`, `checkUtxoSpendability`, and `releaseStuckReservations` stay. This change connects them and fills the silent stubs.
- Patching `@bsv/message-box-client` or `@bsv/wallet-toolbox-mobile` in `node_modules`. Lib footguns are avoided by not calling those APIs (`PeerPayClient.acceptPayment`, `rejectPayment`, `listMessages` auto-internalize). Upstream issues are out of this change.
- Headless iOS/Android background fetch (`BGAppRefreshTask`). Proof collection while the app is closed is latency, not a dead end; it recovers on next open. Defer.
- Raising `MAX_RECOVERY_DAYS` to 365 in the day-to-day receive UI. The Check Wallet flow scans the existing 30-day window, then offers a further lookback as an explicit extra step.
- Deleting `LogsScreen`. It remains the `__DEV__`/Advanced raw terminal. Users get Check Wallet instead.
- Auto-spending new UTXOs to “resend” a payment whose original transaction is dead. A resend of a live txid rebuilds the *token* (same tx, fresh AtomicBEEF). A double-spent/cancelled payment is a new pay, initiated by the sender after a NACK, not minted silently.

## Product requirements this change satisfies

1. No silent dead end: every failure the wallet cannot self-repair is visible on the home screen with a plain-language action.
2. Automatic recovery where safe: inbox credit, outbox drain, UTXO validation after restore, reorg proof repair, header rewind.
3. A return channel: the receiver can tell the sender “this token is unusable”; the sender can re-deliver the same payment’s details without paying twice.
4. One-button repair: Settings → Check Wallet.

---

## 1. Two systemic gaps

### 1.1 Payments have no return channel

When credit fails, every path terminates on the receiver’s phone. Discard acknowledges the message and destroys the only copy of the BRC-29 derivation data the receiver will ever see. The sender’s outbox entry is pruned the moment `HandleSend` next loads (`status === 'sent'`). Sending again mints a *new* payment. The original satoshis stay locked at a key neither party can derive.

Corrupt / undecryptable inbox bodies never appear at all (`listIncomingPayments` safeParse-filters them). The sender sees success; the receiver sees an empty screen.

Everything needed for a resend already exists: the message-box rail is bidirectional, `payment.sender` is on every incoming payment, the sender’s wallet keeps `customInstructions` on output 0 and the tx in storage, and `refetchAtomicBeef` can rebuild a fresh AtomicBEEF by txid.

### 1.2 Recovery machinery is disconnected or stubbed

| Break | File | Effect |
|---|---|---|
| `reviewStatus` returns `{ log: '' }` | `StorageExpoSQLite.ts:1645` | Invalid reqs never fail their txs; phantom balance; `specOpInvalidChange`’s restore half is a no-op |
| `sqlUpdate` drops `undefined` | `StorageExpoSQLite.ts:513` | `spentBy: undefined` never becomes SQL NULL; released inputs still look double-spent |
| Monitor created with 3 args; `monitor.ready` never awaited; `TaskReviewProvenTxs` spliced out | `WalletContext.tsx:1153, 1275` | `TaskReorg` never receives events; stale proofs live forever |
| Header window is append-only | `headerStore.ts:154–196` | One orphaned tip wedges header sync |
| Inbox / outbox / offline banners are screen-local | `HandleReceive`, `HandleSend`, `PayScreen` | Close the screen and the wallet goes inert |

---

## 2. Architecture — four workstreams, four shippable phases

Workstreams A–D are the *design*. Phases P0–P3 are the *ship order*. P0 is the money-loss stop. Later phases make recovery automatic and visible.

```
P0  Stop losing money     (A-lite + B-lite + nearby orphans)
P1  The resend loop       (A complete)
P2  Check Wallet          (C)
P3  Always-on recovery    (B complete + D)
```

Each phase produces working, testable software and can merge on its own.

---

## 3. Workstream A — payment control channel

### 3.1 Box and types

A dedicated MessageBox name, not `payment_inbox` and not the unused `payment_requests` rail.

```ts
// packages/expo-wallet-toolbox/core/peerpay/control.ts
export const PAYMENT_CONTROL_BOX = 'payment_control'

export type ResendReason =
  | 'corrupt'           // body would not parse / decrypt / shape-check
  | 'uncreditible'      // internalize exhausted, not environmental
  | 'double_spent'      // payment tx is failed / doubleSpend
  | 'bounced_offline'   // nearby/offline row rejected by the network

export type PaymentControlMessage =
  | {
      type: 'resend_request'
      txid: string
      reason: ResendReason
      /** Present when the broken inbox item had a message id. */
      messageId?: string
    }
  | { type: 'payment_cancelled'; txid: string }
```

Send with the existing `MessageBoxClient.sendMessage` (authenticated, same hosts). Do **not** call `PeerPayClient.acceptPayment` / `rejectPayment`.

Unknown `type` values are ignored (forward-compatible). A message that is not JSON, or JSON without `type` and `txid`, is treated as damaged: surface it, do not crash the poll.

### 3.2 Receiver behaviour

| Event | Action |
|---|---|
| Token fails shape/parse/decrypt | Attention row “This payment arrived damaged”. Auto-send `resend_request` with `reason: 'corrupt'`. Ack the damaged inbox message **only after** the NACK is delivered. |
| Auto-credit exhausts on a *structural* error | Auto-send `resend_request` with `reason: 'uncreditible'`. Keep the inbox message until the user discards *or* a rebuilt token arrives. |
| Internalize reports double-spend / `invalid status failed` | Map copy to “This payment was cancelled or double-spent — it is safe to dismiss”. Auto-send `resend_request` with `reason: 'double_spent'`. Discard confirm copy is status-aware (does **not** say “abandoning money”). |
| User taps Discard | Send `resend_request` (if not already sent) **then** ack. If the NACK fails, Discard fails and the row stays. |
| Nearby/offline received row → `rejected` with `senderIdentityKey` | Auto-send `resend_request` with `reason: 'bounced_offline'` when online. Banner gets Request again / Copy details / Dismiss. |

Environmental failures (chaintracks down/behind, NetInfo false-offline, `lastMissHeight` set) do **not** NACK and do **not** count toward `MAX_AUTO_ATTEMPTS`.

### 3.3 Sender behaviour

On receiving `resend_request` for a txid this wallet created:

1. Look up the transaction (labels `peerpay` / activity / outbox).
2. Read `customInstructions` from output 0 (`{ derivationPrefix, derivationSuffix, type: 'BRC29' }`).
3. Build a fresh AtomicBEEF via `refetchAtomicBeef` / `getBeefForTxid` (current merkle path).
4. `sendMessage` the rebuilt token to `payment_inbox` of the original recipient (deterministic HMAC message id makes this idempotent).
5. Surface on the home screen: “N asked you to resend a payment” with a **Resend** button. One tap. Do not silently re-spend new UTXOs.

On receiving `payment_cancelled` for a txid the wallet has internalized but not seen confirm: drop the token (do not credit if still in inbox; if already internalized, leave the chain as source of truth — a cancel after broadcast cannot un-mine). The notice exists so a recipient holding an *unbroadcast* nosend token stops waiting.

A delivered-or-uncertain outbox Cancel sends `payment_cancelled` before removing the entry.

### 3.4 Outbox retention

Stop pruning `status === 'sent'` on `HandleSend` load. `outbox.ts` already documents “persist until dismissed”; the UI contradicts it.

- Keep `sent` entries for **30 days** (`SENT_RETENTION_MS`), then prune.
- The outgoing card on Pay → handle still lists only `unsent` (retry/cancel). History resend lives on the activity row: “Send the payment details again”.
- `canSend` still blocks on `unsent.length > 0`, not on retained `sent` entries.
- When `unsent.length > 0` and the form is otherwise valid, show “Finish or cancel the payment below before sending a new one” above the CTA.

### 3.5 Rebuild primitive

```ts
// packages/expo-wallet-toolbox/core/peerpay/rebuildToken.ts
export async function rebuildPeerPayToken(args: {
  wallet: { listActions(...): Promise<{ actions: ... }> }
  adminOriginator: string
  txid: string
  recipient: string
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<{
  token: OutboxEntry['token']
  recipient: string
} | undefined>
```

Returns undefined when the action, output 0 instructions, or fresh BEEF cannot be found. The UI then says the original payment cannot be re-delivered and offers **Send again** (a *new* `sendViaHandle` / `sendToAddress` with the same recipient and amount) instead.

---

## 4. Workstream B — wallet-wide recovery

### 4.1 Broadcast result is authoritative

`broadcastNoSend` currently ignores `createAction`’s return. Delayed mode never throws on a failed share (`Wallet.js:609`); it returns `sendWithResults` with `status: 'failed'`.

```ts
async function broadcastNoSend(...): Promise<void> {
  const result = await wallet.createAction(
    { description: 'PeerPay payment broadcast', options: { sendWith: [txid] } },
    adminOriginator
  )
  const outcomes = (result as { sendWithResults?: { txid: string; status: string }[] }).sendWithResults ?? []
  const failed = outcomes.find(o => o.txid === txid && o.status === 'failed')
  if (failed) throw new Error('broadcast_failed')
}
```

Treat `failed` as thrown so the entry stays `unsent` with `lastError` and Retry/Cancel apply. Do **not** show `PaymentSuccessOverlay`.

### 4.2 Crash windows on send

| Gap | Fix |
|---|---|
| `createAction({ noSend: true })` succeeds, `saveOutboxEntry` throws | `abortAction` the fresh txid in a `finally`/`catch` before rethrowing |
| `sendMessage` succeeds, `delivered: true` write is lost | Persist `delivering: true` *before* `sendMessage`. Uncertain state: Retry is the default (idempotent). Cancel sends `payment_cancelled` and does not abort until the box confirms the message is gone *or* the user confirms abandon |
| Orphaned `peerpay`-labeled nosend with no outbox row at startup | Reconcile: auto-abort (never delivered) |

`sendViaHandle` records `lastAttemptAt` / `lastError` on the first failure, not only inside `retryDelivery`.

Cancel on a **delivered** entry is two choices: Finish payment (retry broadcast) and Abandon payment (abort + `payment_cancelled`). The UI must not use the same Cancel for both.

### 4.3 Refresh must not fail a queued offline payment

In `refreshProof`, before `updateTransactionStatus('failed')`:

```ts
const queued = await findOfflineActions(db, { txid, status: ['queued', 'posting'] })
if (queued.length > 0) {
  TaskSendOffline.requestNow()
  return 'pending'
}
```

`ActivityRow` hides Refresh (or relabels it Send now) when `offlineStatus` is `queued`/`posting`.

### 4.4 Amount is the transaction, not the JSON

```ts
// packages/expo-wallet-toolbox/core/pay/tokenAmount.ts
export function satoshisFromToken(token: {
  transaction: number[]
  outputIndex?: number
  amount?: number
}): { satoshis: number; claimedAgrees: boolean } | undefined
```

`Transaction.fromAtomicBEEF(token.transaction).outputs[outputIndex ?? 0].satoshis` is the displayed amount. If `token.amount` is a finite number and disagrees, flag the payment (do not announce the claimed figure). Overlay, attention rows, and success copy all use this helper. Sender-side `handle.ts:332` already does this for send-max; receive must match.

### 4.5 Damaged inbox items are visible

`listIncomingPayments` will keep filtering unparseable bodies — that is library behaviour we do not patch. App-side:

```ts
export async function listDamagedInboxMessages(args: {
  client: { listMessages(args: { messageBox: string }): Promise<{ messageId: string; sender: string; body: unknown }[]> }
  parsed: { messageId: string }[]
}): Promise<{ messageId: string; sender: string; reason: 'unparseable' | 'bad_shape' }[]>
```

Diff `listMessages({ messageBox: 'payment_inbox' })` (or `listMessagesLite`) against parseable tokens. A JSON object missing `customInstructions.derivationPrefix` / `derivationSuffix` strings, `transaction` number[], is `bad_shape`. Both become attention rows.

Also poll without a host override (library default+advertised merge) **in addition to** the configured URL. When the user saves a custom host, `anointHost` it. On host change, one final sweep of the previous host.

### 4.6 Credit failure classification

```ts
export type CreditFailureKind = 'environmental' | 'double_spend' | 'structural'

export function classifyCreditError(
  e: unknown,
  ctx: { lastMissHeight?: number; getOnline?: () => boolean }
): CreditFailureKind
```

- Environmental: network / timeout / chaintracker / `lastMissHeight` set / “valid AtomicBEEF” while offline or headers behind. Does not increment `MAX_AUTO_ATTEMPTS`. Copy: “Waiting for the network to confirm this payment”. Retry on connectivity change and app foreground.
- Double-spend: `invalid status failed`, `doubleSpend`. See §3.2.
- Structural: everything else. Counts toward the ceiling, then NACK.

Ack-failure after a successful `internalizeAction` is **not** a credit failure: count accepted, fire the overlay, queue ack for background retry.

`creditInbox` is the mutex: a Retry while a poll is in flight joins the in-flight pass instead of starting a second one.

Attempt state is persisted in `key_value_store` under `peerpay_inbox_attempts` (same pattern as the outbox), keyed by messageId.

### 4.7 Monitor tasks

Same pattern as `TaskSendOffline` in `WalletContext.tsx`.

- **`TaskCreditInbox`**: when online, `listIncomingPayments` + damaged diff + `autoAcceptInbox` (with beefRepair) on an interval and on app foreground. Newly credited amounts use the existing overlay/notification path. Needs-attention count is stored so the home screen can badge.
- **`TaskDrainOutbox`**: retry `unsent` entries with the same backoff as `TaskSendOffline` (10 s doubling to 5 min). Delivery is idempotent. After N failures, the home screen badges; it does not stay Pay → handle only.
- **`TaskSendWaiting` vs offline queue**: if a request’s input txids intersect `offline_actions` rows in `queued`/`posting`, skip this pass and `TaskSendOffline.requestNow()`.

Do not use `listenForLivePayments` in this change (nice-to-have; the poll is sufficient).

### 4.8 Nearby / offline orphans (P0 because they burn funds)

| Gap | Fix |
|---|---|
| Online QR **Done** broadcasts with no durable `framePayload` | Persist the sealed frame on **every** Done (insert `offline_actions` first; drain broadcasts). “Show code” remains available after an online send. Gate Done copy: only tap once the other phone shows Received |
| Exit `send_qr` without Done | Ask “Did the other person scan your code?” No → `abortAction`. Yes / Not sure → same hold path as Done |
| Unseal failure on QR mints a new session | Treat like session mismatch: keep `hostedSession`, return to `receive_wait`, re-arm scanner |
| `localpay_pending` parse failure returns `[]` then the next write destroys the blob | Quarantine the raw value under `localpay_pending_corrupt_<ts>` **before** any `writeAll`. Surface “we found damaged payment data”. Do not treat parse failure as empty |
| `tryProcess` gated on `getOnline()` | Remove the gate; `internalizeAction` decides. Surface KV pending in `OfflineNotice` |
| Failed `abortAction` after a decline | Durable `pending_aborts` KV list, retried on wallet build / foreground |

---

## 5. Workstream C — Check Wallet

### 5.1 Storage prerequisites (must land before the UI)

**`sqlUpdate` NULL.** For the `outputs` table, `spentBy: undefined` is written as SQL NULL. Upstream `releaseInputsAllocatedToFailedTransaction` passes `spentBy: undefined` intending a clear. A naive `reviewStatus` port that writes the same object currently no-ops the clear.

Scope the translation to `outputs.spentBy` (and any other column whose documented intent is “clear”), not a global “every undefined becomes NULL” (that would change skip-means-leave-alone semantics for other fields).

**`reviewStatus`.** Implement by mirroring `reviewStatusIdb.js`:

1. Fail transactions whose `proven_tx_reqs.status = 'invalid'` via `updateTransactionStatus('failed', id)` so release/mark hooks run.
2. Restore outputs whose `spentBy` is a *terminal-failed* tx (`req` is `invalid` or `doubleSpend`) to `spendable = 1`, `spentBy = NULL`.
3. Mark outputs generated by terminal-failed txs `spendable = 0`, `spentBy = NULL`.

Skip txids that have a live `offline_actions` row in `queued`/`posting` (queue-safe). Extract SQL into `core/storage/methods/reviewStatusSql.ts` and unit-test against `node:sqlite` the way `releaseStranded.test.ts` does.

### 5.2 User-facing flow

Settings (not buried under Debugging) → **Check Wallet**, subtitle “Run this if something doesn't look right”. Route `app/wallet-check.tsx` → `ui/screens/WalletCheckScreen.tsx`. Pushed full screen (not a sheet — HIG: prolonged multi-step work is a destination, not a modal interruption). Narrated with **determinate** step progress (4 of 4), never a lone unlabeled spinner:

1. Checking your coins — `reviewSpendableOutputs(true, true)` / `specOpInvalidChange` + existing `checkUtxoSpendability`. For each funding txid of a spendable output, also `GET /tx/hash/{txid}`; if absent, try rebroadcast of stored rawTx before marking failed.
2. Checking your payments have the right proof — `CheckForProofs` + bounded proven_txs re-prove (recent heights, see §6).
3. Repairing payment records — implemented `reviewStatus` + `releaseStuckReservations` (invalid-req guard, skip live offline_actions) + `unfail` invalid requests.
4. Looking for missed payments — one `TaskCreditInbox` pass + `sweepAddress` over `MAX_RECOVERY_DAYS` (30) day-addresses. Optional second step: scan further (365) behind a confirmation.

Done copy is words, never txids: “Everything looks good” or “Freed 2 stuck coins · Recovered 1 payment”.

Keep `LogsScreen` as the Advanced/Debugging terminal.

Offer Check Wallet contextually when a send fails with `WERR_REVIEW_ACTIONS` / reservation errors.

### 5.3 After restore-from-backup

`restoreOnImport` currently hands the wallet over with no chain check. After restore succeeds and services are wired, run one `reviewSpendableOutputs(false, true)` (or specOpInvalidChange with `['release']`) with progress “Checking your coins…” before declaring ready.

### 5.4 Address rail

- Per-UTXO isolation in `sweepAddress`: `resp.ok` + hex-shape before merge; one bad tx must not skip the address’s whole pass. Fall back to `refetchAtomicBeef` on repeated beef failure.
- `touchWatched` when a sweep *attempt* found on-chain UTXOs even if import failed, so known-funded addresses never TTL out.
- Watchlist TTL: keep never-swept addresses for `MAX_WATCH_DAYS` (7), not 24 h.
- Persistent `failureCount > 0` is a notice with “try again now”.

---

## 6. Workstream D — chain-state correctness

### 6.1 Reorg pipeline actually runs

- Pass the app’s `OfflineFirstChaintracks` (already implements `subscribeReorgs`) as the 4th argument to `Monitor.createDefaultWalletMonitorOptions`.
- `await monitor.ready` before `startTasks`, so `_init` registers the subscription.
- Do **not** splice `TaskReviewProvenTxs` out. If the library crawl is too heavy, replace the splice with a bounded wrapper: last ~100 heights (or last 6 blocks plus any height whose stored root disagrees with `headerStore.rootForHeight`), using existing `findStaleMerkleRoots` + `reproveHeightMerkleRoot`. Include the same pass in Check Wallet.

### 6.2 Header store

- **Rewind on tip reorg.** When `append` fails the linkage check on the first header of a chunk, truncate the last K headers (walk back until the remote header at `tipHeight` names our stored hash as previous; cap K at 144) and re-append. Last resort: delete the `.bin` and resync from the checkpoint.
- **Crash-mid-append.** `open()`: if `bin.length > meta.count * 80`, truncate the file to `count * 80` before building the index.
- `HeaderFs` gains `writeBytes(path, bytes)` (full replace). `appendBytes` stays. `memoryHeaderFs` implements both.

### 6.3 Proof writes

- `refreshProof` verifies the WoC BUMP via `offlineChaintracks.isValidRootForHeight(root, height)` before persisting.
- Store the real `blockHash` from the header store / `findHeaderForHeight`, never `''`.
- Do not `putExtraRoot` for heights `> currentHeight - 6`.
- `rootForHeight` prefers an extra entry when one exists for an in-window height (so a logged “heal” is actually consulted).
- Wire `lastMissHeight` into credit-error classification (§4.6).

---

## 7. User-facing surfaces

Home screen (`WalletHomeScreen`) is the place stuck work is announced:

- Needs-attention inbox count (deep-link to Get paid → handle attention queue).
- Unsent outbox count (deep-link to Pay → handle outgoing card).
- Compact `OfflineNotice` (queued / stalled / rejected) above the activity list, not only on `/pay`’s chooser grid.
- Rejected received/sent banners: Request again / Send again / Copy details / Dismiss (`acknowledged` status on `offline_actions`).
- Failed outbound activity row: **Send again** chip that prefills the pay cell (or calls `retryDelivery` when an outbox entry exists).
- `abortAction` returning `{ aborted: false }` toasts failure, not success.
- `fetchActions` catch: “Couldn't load activity — tap to retry”, never an unlabelled spinner.
- `getPublicKey` rejection on receive: retriable error, not an eternal spinner.
- Identity search outage: “Search is unavailable right now”, not an empty list.
- Retry with no message-box client: open the config panel and show the unreachable copy; retry may use `entry.messageBoxUrl` as fallback host.
- Before broadcasting a handle payment, if `resolveHostForRecipient` fell back to the sender’s own host **and** the recipient has no overlay advertisement, warn/block.
- Redirect orphaned `/settings` to `/` (or `/wallet-config`).
- Error translation layer: map `WERR_REVIEW_ACTIONS` / insufficient-funds / AtomicBEEF-while-offline to i18n keys. Reservation errors offer one-tap Check Wallet.

All new copy is added to every locale block in `core/i18n/translations.tsx` (this file does not fall back per-key). Non-English locales may use the English string as an interim value.

Receipt `broadcast` flag is derived from the req status after internalize (`alreadySentStatuses` in `plan.ts`), not from `getOnline()`.

---

## 8. Findings coverage

Every confirmed or partially-confirmed finding from the audit maps to a phase. The one **refuted** finding (proof-provider outage driving mined txs to failed) is out of scope.

| Phase | Finding titles (abbrev.) |
|---|---|
| **P0** | Prune sent outbox; `broadcastNoSend` discards `sendWithResults`; Discard strands funds; unparseable inbox dropped; token.amount fraud; Refresh vs offline queue; online QR Done without frame; `localpay_pending` parse-as-empty; first-failure `lastError`; mint-without-outbox abort; delivering checkpoint |
| **P1** | No resend-request message; no NACK on inbound failure; double-spent wedged row; Request again on rejected nearby; rebuild-from-customInstructions; activity “Send the payment details again”; cancel delivered entry |
| **P2** | `reviewStatus` stub; `sqlUpdate` NULL; Check Wallet; restore-from-backup UTXO check; address sweep isolation / TTL / 30-day lookback in repair; `specOpInvalidChange` unwired; completed-tx-vanishes existence check |
| **P3** | Inbox only while HandleReceive focused; outbox retry only by hand; environmental attempts; home badges; OfflineNotice only on `/pay`; TaskReorg starved; header rewind; crash-mid-append; `refreshProof` `blockHash ''`; `lastMissHeight` unread; `TaskSendWaiting` vs queue; persist attempts; credit mutex; host mismatch / `anointHost`; stalled-queue repair; pending `tryProcess` online gate; error translation; abort `{aborted:false}`; identity search outage; receive spinner; activity fetch spinner; `canSend` silent disable |

Partially confirmed items are in scope with the verifier’s correction applied (e.g. Cancel chip is labelled Cancel; stall text is recomputed after restart; `/settings` is an orphaned route).

---

## 9. Key decisions

1. **Dedicated `payment_control` box**, not the unused `payment_requests` API. Small typed JSON, same `sendMessage` path the app already authenticates.
2. **Resend of a live txid rebuilds the token, never a second payment.** Double-spent NACKs ask the sender to pay again as a new action.
3. **NACK-then-ack.** Discard is unsafe until the sender has been told. If NACK fails, Discard fails.
4. **30-day sent-outbox retention**, matching `MAX_RECOVERY_DAYS`. Not forever (device storage of AtomicBEEF blobs), not “until next screen-open”.
5. **`spentBy: undefined` → SQL NULL only on `outputs.spentBy`.** Preserve skip-undefined for every other column.
6. **`reviewStatus` mirrors IDB three rules** and is queue-safe (skip live `offline_actions`).
7. **Pass `OfflineFirstChaintracks` into the Monitor and await `ready`.** Bounded proven-tx audit instead of deleting `TaskReviewProvenTxs`.
8. **Do not call lib footgun APIs.** No `acceptPayment` string-return path, no `rejectPayment` refund, no `listMessages` auto-internalize.
9. **Check Wallet is a first-class Settings row** (`ListRow` + subtitle). LogsScreen stays for developers. User-facing name drops “my” ([HIG Writing](https://developer.apple.com/design/human-interface-guidelines/writing): possessive pronouns sparingly).
10. **Persist nearby frames on every Done**, including online, so a mis-scan is recoverable.
11. **New UX follows Apple HIG** (§11). No `Alert.alert`. Decisions use `showAlert` / `showChoiceSheet`. Toasts are notices only.

## 10. Open questions

None that block implementation. Defaults above are the decisions.

---

## PR Plan

| PR | Title | Depends on | Contents |
|---|---|---|---|
| 1 | fix(pay): stop losing PeerPay and nearby funds | — | P0 |
| 2 | feat(pay): payment_control resend loop | PR 1 | P1 |
| 3 | feat(wallet): Check Wallet + storage repair | — (sqlUpdate/reviewStatus can land in parallel with PR 1) | P2 |
| 4 | feat(wallet): background credit/drain + reorg heal | PR 1–3 | P3 |

P2’s storage-layer tasks have no UI dependency on P1 and may merge first if that is faster; the Check Wallet *screen* should wait until `reviewStatus` and the NULL fix exist.

---

## 11. Apple Human Interface Guidelines

Authority: [Apple HIG](https://developer.apple.com/design/human-interface-guidelines). New UX in this change must match it and the existing primitives from [2026-06-11 HIG polish](./2026-06-11-delightful-hig-polish-design.md). Do not invent a third dialog system.

### 11.1 Which surface

| Situation | HIG component | App primitive |
|---|---|---|
| Irreversible uncommon action the person might have hit by accident (Discard a live payment; Abandon after confirm) | [Alert](https://developer.apple.com/design/human-interface-guidelines/alerts) | `showAlert` (`AlertCard`) — max 2 buttons side-by-side |
| Several choices tied to an action they just took (leave send QR; Finish vs Abandon a delivered payment) | [Action sheet](https://developer.apple.com/design/human-interface-guidelines/action-sheets) | `showChoiceSheet` — iOS `ActionSheetIOS`; Android stacked `showAlert` |
| Transient FYI (copied, retry failed, host unreachable) | not an alert | `showToast` |
| Persistent stuck work while the app is open | [in-context, not an interruption](https://developer.apple.com/design/human-interface-guidelines/alerts) (“Avoid using an alert merely to provide information”) | Inline home/pay rows. Not a launch alert. Not a fake app-icon badge. |
| Multi-step repair | [Sheet](https://developer.apple.com/design/human-interface-guidelines/sheets): prolonged flows are **not** sheets | Pushed `WalletCheckScreen` |

Never `Alert.alert`. Never a custom modal that looks like navigation. Never a toast for a problem that is still true after the toast expires.

### 11.2 Alerts

- Use sparingly. Title names the **situation**, not “Error”. Sentence-style capitalization if the title is a complete sentence; no wrapping past two lines.
- Buttons: one- or two-word **verbs** that match the title (“Discard”, “Resend”). Never “OK” to confirm a destructive action. Always a **Cancel** button titled exactly `Cancel`. Cancel is leading / not the default. Destructive style is system red (`colors.error`).
- Two buttons only on an alert. Three or more choices → action sheet.
- Do not present an alert when the app becomes active. Background credit that finds work updates the home list (Mail’s “insert into the current view” rule from [Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)).

### 11.3 Action sheets

- Short title, one line. Message only if the title is not enough.
- Destructive option **first**. **Cancel last**. No scrolling.
- `send_qr` exit and delivered-outbox Finish/Abandon are action sheets, not alerts.

### 11.4 Buttons, progress, settings, copy

- Hit region ≥ 44×44 pt. Press state via `PressableScale`. One prominent button per view.
- In-progress: spinner **inside** the button and a progressive label (“Resend” → “Resending…”), per [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons).
- Check Wallet: [determinate](https://developer.apple.com/design/human-interface-guidelines/progress-indicators) 4-step progress with a specific label per step (“Checking coins…” not “Loading”). Do not switch a spinner into a bar. Keep the indicator moving. Back is always available; there is no trapped modal.
- Settings row uses `GroupedSection` + `ListRow` like the rest of Wallet Config. Label **Check Wallet**; subtitle does the explaining. Repair that belongs to a payment stays on that payment (Retry, Resend), not only in Settings ([Settings](https://developer.apple.com/design/human-interface-guidelines/settings)).
- [Writing](https://developer.apple.com/design/human-interface-guidelines/writing): active verbs; no “we”; no “oops”; errors next to the problem with a fix. Empty states include the next step and a control. “Tap” not “click”.
- Celebration (`Celebration.tsx`) stays the three existing moments. Check Wallet Done is quiet summary copy + `haptics.success`, not a new celebration.

### 11.5 Copy for new UX (English)

| Key | English |
|---|---|
| `check_wallet` | Check Wallet |
| `check_wallet_subtitle` | Run this if something doesn't look right |
| `wallet_check_ok` | Everything looks good |
| `wallet_check_summary` | Freed {{freed}} stuck coins · Recovered {{recovered}} payments |
| `discard_payment_title` | Discard this payment? |
| `discard_payment_body` | The sender will be asked to send the details again. The money stays on the chain until they do. |
| `discard_void_title` | This payment didn't go through |
| `discard_void_body` | It was cancelled or spent elsewhere. It's safe to dismiss. |
| `did_they_scan_title` | Did they scan your code? |
| `did_they_scan_no` | No, cancel payment |
| `did_they_scan_yes` | Yes, keep it queued |
| `did_they_scan_unsure` | Not sure, keep it queued |
| `abandon_payment` | Abandon payment |
| `finish_payment` | Finish payment |
| `resend` | Resend |
| `resending` | Resending… |
| `request_again` | Request again |
| `send_again` | Send again |
| `send_payment_details_again` | Send details again |
| `finish_or_cancel_outgoing` | Finish or cancel the payment below before sending a new one |
| `identity_search_unavailable` | Search is unavailable right now. Try again in a moment. |
| `payment_arrived_damaged` | This payment arrived damaged |
| `waiting_network_confirm` | Waiting for the network to confirm this payment |
| `recipient_message_box_unknown` | Can't find where to deliver this. Ask them to open BSV Wallet once so their inbox is listed. |
| `activity_load_failed` | Couldn't load activity |
| `activity_load_retry` | Tap to retry |
| `resend_requested` | They asked you to resend a payment |
