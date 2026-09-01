# Dead-End Fixes Review Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the first dead-end change failing open: authenticate `payment_cancelled`, never release coins on an inconclusive UTXO answer, make `reviewStatus` and credit classification and Check Wallet tell the truth, then the ordered highs (cancel re-read, pending repair, performance, arrival notice).

**Architecture:** Ten sequential tasks matching the review’s “What to fix, in order”. Shared files (`handleResendRequests.ts`, `creditErrors.ts`, `WalletCheckScreen.tsx`, `StorageExpoSQLite.ts`) mean one implementer at a time. Helpers stay next to the code they change.

**Tech Stack:** TypeScript, React Native / Expo, Jest (`jest-expo` at repo root), `node:sqlite` for SQL tests.

**Spec:** [docs/superpowers/specs/2026-08-31-dead-end-fixes-review-followup-design.md](../specs/2026-08-31-dead-end-fixes-review-followup-design.md)

**Review:** [docs/superpowers/Dead-End Fixes Review.mhtml](../Dead-End%20Fixes%20Review.mhtml)

**Parent spec:** [docs/superpowers/specs/2026-08-31-payment-dead-end-fixes-design.md](../specs/2026-08-31-payment-dead-end-fixes-design.md) — HIG §11 still binds. The consume-once last-miss snapshot in that spec is **replaced** by peek-at-failure-time (this spec §2.4).

## Global Constraints

- Paths below are under `packages/expo-wallet-toolbox/` unless they start with `app/` or `docs/`.
- Tests live in `packages/expo-wallet-toolbox/__tests__/`. Run from the **repo root of this worktree**: `npx jest <path> --no-coverage`.
- Do not edit `node_modules`. Do not call `PeerPayClient.acceptPayment`, `rejectPayment`, or `listMessages` auto-internalize. Do not use `specOpInvalidChange` with `tags: ['all','release']`.
- New i18n keys go in **every** locale object in `core/i18n/translations.tsx`. Non-English locales may copy the English string. English strings are spec §3 — do not invent alternate copy.
- **Apple HIG** (parent spec §11): `showAlert` for 2-button irreversible; `showChoiceSheet` for 3+; `showToast` for transients; no `Alert.alert`; no launch alerts; Check Wallet stays a pushed determinate screen; 44×44 hit targets.
- `MAX_AUTO_ATTEMPTS` stays `2`. Environmental failures must not increment it.
- A resend of a live txid rebuilds the **token**. It does not mint a second payment. It does not deliver to the requester.
- Skip txids with live `offline_actions` rows (`queued`/`posting`) in any path that would fail or release them.
- Destructive writes need a positive confirmation (`sender` match; `status === 'success' && isUtxo === false` / WoC HTTP 200 + spending txid).
- Commit after every task. Conventional commits (`fix:` / `feat:` / `test:`).
- Findings not in spec §2 are out of scope.

## File structure

| File | Responsibility |
|---|---|
| Modify: `core/peerpay/handleResendRequests.ts` | Sender check on cancel; no requester fallback |
| Modify: `core/pay/rails/handle.ts` | Recipient label on `createAction`; cancel re-read; `acceptWithRetry` cap; env regex via `isMessageBoxNetworkError` |
| Create: `core/walletRepair/shouldReleaseUtxo.ts` | Positive-confirmation release predicate |
| Modify: `core/context/WalletContext.tsx` | `checkUtxoSpendability` skip rules + online gate; `peekLastMissHeight`; CreditInbox notify; drain prune |
| Modify: `ui/screens/WalletCheckScreen.tsx` | Drop spec-op auto-release; throw from ports; render couldn’t-check |
| Modify: `core/storage/methods/reviewStatusSql.ts` | Invalid-req WHERE; bounded output scan |
| Modify: `core/storage/StorageExpoSQLite.ts` | Per-row try/catch; shipping path tests hit this |
| Modify: `core/headers/OfflineFirstChaintracks.ts` | `peekLastMissHeight` |
| Modify: `core/pay/creditErrors.ts` | Peek at failure time; broader env regex |
| Modify: `core/walletRepair/runWalletCheck.ts` | Per-step `ok`/`error` |
| Modify: `core/localpay/pending.ts` | Repair `PENDING_KEY` after quarantine; prune completed |
| Modify: `core/monitor/TaskDrainOutbox.ts` | Call `pruneExpiredSent` |
| Modify: `core/walletMonitor.ts` | ReviewProvenTxs offline gate + 10 min cadence |
| Modify: `core/monitor/TaskCreditInbox.ts` | Optional `onAccepted` port |
| Modify: `core/i18n/translations.tsx` | New keys in all 12 locales |

---

### Task 1: Authenticate `payment_cancelled` before dropping inbox tokens

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/peerpay/handleResendRequests.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts`

**Interfaces:**
- Consumes: `listControlMessages`, `parseControlMessage`, existing `dropInboxTokenForTxid`.
- Produces: `dropInboxTokenForTxid(client, txid, sender: string)` — only acks inbox rows whose `m.sender === sender` AND `txidFromInboxBody(m.body) === txid`. `consumePaymentCancelled` passes `msg.sender`.

- [ ] **Step 1: Write the failing test**

Add to `handleResendRequests.test.ts` (reuse `atomicInboxToken`, `PAYMENT_CONTROL_BOX`, `fakeStorage`):

```ts
it('does not drop an inbox token when payment_cancelled sender does not match the token sender', async () => {
  const { txid, token } = atomicInboxToken()
  const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
  const listMessages = jest.fn(async ({ messageBox }: { messageBox: string }) => {
    if (messageBox === PAYMENT_CONTROL_BOX) {
      return [{ messageId: 'c1', sender: '02ff', body: { type: 'payment_cancelled', txid } }]
    }
    return [{ messageId: 'p1', sender: '02aa', body: token }]
  })
  await listPendingResendRequests({
    client: { listMessages, acknowledgeMessage } as never,
    storage: fakeStorage()
  })
  expect(acknowledgeMessage).not.toHaveBeenCalledWith({ messageIds: ['p1'] })
})
```

Keep the existing matching-sender test (`sender: '02aa'` on both) green.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts --no-coverage`
Expected: FAIL — inbox `p1` is currently acked by txid alone.

- [ ] **Step 3: Write minimal implementation**

In `handleResendRequests.ts`, change `dropInboxTokenForTxid` to take `sender: string` and filter `m.sender === sender && txidFromInboxBody(m.body) === txid`. Pass `typeof msg.sender === 'string' ? msg.sender : ''` from `consumePaymentCancelled`. An empty sender matches nothing (fail closed).

When no authenticated token matches, still ack the control message if the inbox has no matching txid **from that sender** (token already gone). Do **not** ack the control message after refusing a mismatched-sender token that **does** exist for that txid from someone else — leave it so it cannot be used as a delete confirmation. Spec: “A mismatched sender is left in the control box unacked”.

So: if any inbox row has this txid but none with matching sender → do not ack control, do not ack inbox. If no inbox row has this txid → ack control (already gone). If matching sender+txid → drop those ids then ack control.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts --no-coverage`
Expected: PASS including the existing matching-sender and already-gone tests.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/peerpay/handleResendRequests.ts packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts
git commit -m "fix(pay): require matching sender before dropping a cancelled inbox token"
```

---

### Task 2: Never resend to the requester; label the recipient at send time

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/peerpay/handleResendRequests.ts` (`rebuildAndDeliver`)
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`createAction` labels around the `labels: ['peerpay']` call)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts` (assert labels on createAction)

**Interfaces:**
- Consumes: `recipientFromLabels`, `PUBKEY_LABEL`.
- Produces: `createAction` labels `['peerpay', recipient]`. `rebuildAndDeliver` recipient = `entry?.recipient || recipientFromLabels(listed?.labels)` only — **no** `args.recipient` fallback.

- [ ] **Step 1: Write the failing tests**

```ts
it('does not deliver a rebuilt token to the resend requester when the outbox and labels are missing', async () => {
  const sendMessage = jest.fn()
  const r = await handleResendRequests({
    client: {
      listMessages: async () => [
        { messageId: 'c1', sender: '02attacker', body: { type: 'resend_request', txid: 'aa'.repeat(32) } }
      ],
      acknowledgeMessage: jest.fn(),
      sendMessage
    } as never,
    storage: fakeStorage(),
    listPeerPayAction: async () => ({ txid: 'aa'.repeat(32), labels: ['peerpay'], outputs: [{ customInstructions: '{}' }] }),
    refetch: async () => [1]
  })
  expect(sendMessage).not.toHaveBeenCalled()
  expect(r.pending).toEqual([{ txid: 'aa'.repeat(32), sender: '02attacker' }])
})
```

In `handleRail.test.ts`, on the existing send path that calls `createAction`, add:

```ts
expect(createAction.mock.calls[0][0].labels).toEqual(['peerpay', KEY])
```

(`KEY` is the recipient compressed pubkey already used in that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts --no-coverage`
Expected: FAIL — `args.recipient` (the requester) is used; labels are `['peerpay']`.

- [ ] **Step 3: Write minimal implementation**

`rebuildAndDeliver`:

```ts
const recipient = entry?.recipient || recipientFromLabels(listed?.labels)
if (!action || !recipient) return undefined
```

Remove the `recipient?: string` argument from `rebuildAndDeliver` and stop passing `recipient: sender` from `handleResendRequests`. Keep `resendPaymentDetails`’s optional `recipient` **only** if an explicit user-facing “Send details again” on a known activity row supplies the outbox/action recipient — not the control-message sender. If `resendPaymentDetails` still takes `recipient`, it may use it only when it already equals `entry.recipient` or a label; do not use the control sender.

`handle.ts` `createAction`: `labels: ['peerpay', recipient]`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/peerpay/handleResendRequests.ts packages/expo-wallet-toolbox/core/pay/rails/handle.ts packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts
git commit -m "fix(pay): label the recipient at send and never resend to the requester"
```

---

### Task 3: Release a UTXO only on a confirmed-spent answer

**Files:**
- Create: `packages/expo-wallet-toolbox/core/walletRepair/shouldReleaseUtxo.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/walletRepair/shouldReleaseUtxo.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (`checkUtxoSpendability`)
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx` (remove spec-op auto-release)

**Interfaces:**
- Consumes: `getOnline()`, output `txStatus`, live offline txids, UTXO probe result.
- Produces:

```ts
export type UtxoProbe = { status: 'success' | 'error'; isUtxo?: boolean }

export function shouldReleaseUtxo(args: {
  online: boolean
  txStatus: string
  txid: string
  liveOfflineTxids: Set<string>
  probe: UtxoProbe
}): boolean
```

Returns true only when `online && txStatus !== 'nosend' && txStatus !== 'unproven' && !liveOfflineTxids.has(txid) && probe.status === 'success' && probe.isUtxo === false`.

WoC mapping in `checkUtxoSpendability`: HTTP 200 + spending txid → `{ status: 'success', isUtxo: false }`; 404 → `{ status: 'success', isUtxo: true }`; timeout / !ok / throw → `{ status: 'error' }`. Call `storage.updateOutput({ spendable: false })` only when `shouldReleaseUtxo` is true. Do **not** mark unspendable because a later BEEF fetch failed.

Remove the `wallet.listOutputs({ basket: sdk.specOpInvalidChange, tags: ['all','release'] })` block from `reviewSpendable`. If `!(await getOnline())`, `checkUtxoSpendability` returns immediately without scanning and without writes (the coins port will throw or the orchestrator in Task 6 will mark error — for this task, throw `new Error('offline')` when offline so Task 6 can distinguish).

- [ ] **Step 1: Write the failing test**

```ts
import { shouldReleaseUtxo } from '../../core/walletRepair/shouldReleaseUtxo'

const spent = { status: 'success' as const, isUtxo: false }
const base = { online: true, txStatus: 'completed', txid: 'aa', liveOfflineTxids: new Set<string>(), probe: spent }

it('releases only on a confirmed spent probe while online', () => {
  expect(shouldReleaseUtxo(base)).toBe(true)
})
it.each([
  { online: false },
  { txStatus: 'nosend' },
  { txStatus: 'unproven' },
  { liveOfflineTxids: new Set(['aa']) },
  { probe: { status: 'error' as const } },
  { probe: { status: 'success' as const, isUtxo: true } }
])('does not release %#', extra => {
  expect(shouldReleaseUtxo({ ...base, ...extra })).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletRepair/shouldReleaseUtxo.test.ts --no-coverage`
Expected: FAIL — file not found.

- [ ] **Step 3: Write minimal implementation**

Implement `shouldReleaseUtxo` exactly as specified. Wire `checkUtxoSpendability` to it. Delete spec-op auto-release from `WalletCheckScreen`. Filter `findOutputs` `txStatus` to `['completed']` only (unproven/nosend excluded by the predicate even if a caller passes them).

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletRepair/shouldReleaseUtxo.test.ts --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/walletRepair/shouldReleaseUtxo.ts packages/expo-wallet-toolbox/__tests__/walletRepair/shouldReleaseUtxo.test.ts packages/expo-wallet-toolbox/core/context/WalletContext.tsx packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx
git commit -m "fix(wallet): release a coin only when the network confirms it is spent"
```

---

### Task 4: `reviewStatus` skips completed txs and survives a per-row throw

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/storage/methods/reviewStatusSql.ts` (`REVIEW_INVALID_REQ_TXS_SQL`)
- Modify: `packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts` (`reviewStatus`)
- Test: `packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts`

**Interfaces:**
- Consumes: existing `reviewStatusOnDb` helpers.
- Produces: `REVIEW_INVALID_REQ_TXS_SQL` includes `AND t.provenTxId IS NULL AND t.status <> 'completed'`. Shipping `reviewStatus` catches `updateTransactionStatus` per row.

- [ ] **Step 1: Write the failing tests**

Add a `provenTxId` column to the in-memory schema (`INTEGER`).

```ts
it('does not fail a completed transaction that has an invalid req', () => {
  const d = seeded()
  d.prepare('INSERT INTO transactions VALUES (1, ?, ?, ?)').run(TX1, 'completed', 99) // provenTxId 99
  d.prepare('INSERT INTO proven_tx_reqs VALUES (1, ?, ?)').run(TX1, 'invalid')
  reviewStatusOnDb(d, { skipTxids: new Set() })
  expect(txStatus(d, 1)).toBe('completed')
})
```

Adjust `seeded()` / inserts so existing tests still set `provenTxId` NULL.

Add a unit test of a small helper exported from `reviewStatusSql.ts`:

```ts
export async function failInvalidReqTxs(args: {
  rows: { transactionId: number; txid: string | null }[]
  skipTxids: Set<string>
  fail: (transactionId: number) => Promise<void>
}): Promise<{ failed: number; skipped: number }>
```

```ts
it('continues after fail() throws on one row', async () => {
  const seen: number[] = []
  const r = await failInvalidReqTxs({
    rows: [{ transactionId: 1, txid: 'aa' }, { transactionId: 2, txid: 'bb' }],
    skipTxids: new Set(),
    fail: async id => {
      seen.push(id)
      if (id === 1) throw new Error('already completed')
    }
  })
  expect(seen).toEqual([1, 2])
  expect(r.failed).toBe(1)
  expect(r.skipped).toBe(1)
})
```

`StorageExpoSQLite.reviewStatus` must call `failInvalidReqTxs` (so the shipping path is the tested helper, not a twin).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts --no-coverage`
Expected: FAIL — completed tx is failed; helper missing.

- [ ] **Step 3: Write minimal implementation**

Update SQL. Implement `failInvalidReqTxs`. In `StorageExpoSQLite.reviewStatus`, replace the raw fail loop with the helper. Keep output restore/unspend as they are.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/storage/methods/reviewStatusSql.ts packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts
git commit -m "fix(storage): do not fail a completed tx and do not abort reviewStatus on one throw"
```

---

### Task 5: Peek header-miss at classification time, do not consume it

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks.ts`
- Modify: `packages/expo-wallet-toolbox/core/pay/creditErrors.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (expose `peekLastMissHeight`)
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx` and `ui/components/pay/HandleReceive.tsx` (pass peek, not take)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts`

**Interfaces:**
- Produces: `peekLastMissHeight(): number | undefined` — returns `lastMissHeight`, does not clear.
- `makeCreditClassifier({ getOnline, peekLastMissHeight })` — `getOnline` awaited once; each `classify(e)` calls `peekLastMissHeight()` at that moment.

- [ ] **Step 1: Write the failing tests**

Replace the “takes lastMissHeight once” test:

```ts
it('reads lastMissHeight at failure time so a miss during the pass is environmental', async () => {
  let miss: number | undefined
  const classify = await makeCreditClassifier({
    getOnline: async () => true,
    peekLastMissHeight: () => miss
  })
  const beefErr = new Error('The tx parameter must be valid AtomicBEEF')
  expect(classify(beefErr)).toBe('structural')
  miss = 900000
  expect(classify(beefErr)).toBe('environmental')
})

it('does not consume the miss marker', async () => {
  const peek = jest.fn().mockReturnValue(7)
  const classify = await makeCreditClassifier({ getOnline: async () => true, peekLastMissHeight: peek })
  classify(new Error('The tx parameter must be valid AtomicBEEF'))
  classify(new Error('The tx parameter must be valid AtomicBEEF'))
  expect(peek).toHaveBeenCalledTimes(2)
})
```

In `offlineChaintracks.test.ts`:

```ts
it('peekLastMissHeight returns the miss without clearing it', async () => {
  // after a recorded miss:
  expect(ct.peekLastMissHeight()).toBe(5)
  expect(ct.peekLastMissHeight()).toBe(5)
  expect(ct.lastMissHeight).toBe(5)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts --no-coverage`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Add `peekLastMissHeight`. Change `makeCreditClassifier` args from `takeLastMissHeight` to `peekLastMissHeight`. Update all call sites (`WalletContext` credit path, `HandleReceive`, `WalletCheckScreen`). Keep `takeLastMissHeight` on the class for tests; do not call it from classifiers.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks.ts packages/expo-wallet-toolbox/core/pay/creditErrors.ts packages/expo-wallet-toolbox/core/context/WalletContext.tsx packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts
git commit -m "fix(pay): classify header-miss at failure time without consuming it"
```

---

### Task 6: Check Wallet reports per-step ok/error and can Retry

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/walletRepair/runWalletCheck.ts`
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx`
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx` (all 12 locales)
- Test: `packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts`

**Interfaces:**

```ts
export type WalletCheckStepStatus = 'ok' | 'error'
export type WalletCheckStepResult = { id: WalletCheckStepId; status: WalletCheckStepStatus }

// runWalletCheck return adds:
steps: WalletCheckStepResult[]
allOk: boolean
```

A port throw → that step `error`; later steps still run. `allOk = steps.every(s => s.status === 'ok')`.

Screen: if `!allOk`, show `t('wallet_check_couldnt')` and `t('wallet_check_couldnt_body')` and the Retry button; `haptics.error()`; do not `haptics.success()`. Ports in `useWalletCheckPorts` rethrow instead of returning zeros.

English:

- `wallet_check_couldnt`: Couldn't check
- `wallet_check_couldnt_body`: A repair step didn't finish. Nothing was assumed about your coins.

- [ ] **Step 1: Write the failing test**

```ts
it('marks a throwing coins port as error and still runs later steps', async () => {
  const order: string[] = []
  const ports: WalletCheckPorts = {
    reviewSpendable: async () => {
      order.push('coins')
      throw new Error('offline')
    },
    checkProofs: async () => (order.push('proofs'), { repaired: 0 }),
    reviewStatus: async () => (order.push('records-status'), { failedTxs: 0, restoredInputs: 0 }),
    releaseStuck: async () => (order.push('records-release'), { released: 0 }),
    creditInbox: async () => (order.push('inbox'), { accepted: 0 }),
    sweepAddresses: async () => (order.push('sweep'), { imported: 0 })
  }
  const summary = await runWalletCheck(ports, () => {})
  expect(order).toEqual(['records-status', 'records-release', 'coins', 'proofs', 'inbox', 'sweep'])
  expect(summary.allOk).toBe(false)
  expect(summary.steps.find(s => s.id === 'coins')?.status).toBe('error')
  expect(summary.steps.find(s => s.id === 'proofs')?.status).toBe('ok')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts --no-coverage`
Expected: FAIL — throw currently rejects the whole run.

- [ ] **Step 3: Write minimal implementation**

Wrap each step’s port calls in try/catch inside `runWalletCheck`. Update the screen Done branch. Add i18n keys to every locale object (search `wallet_check_ok` and add the two new keys next to it in each).

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/walletRepair/runWalletCheck.ts packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts
git commit -m "fix(wallet): distinguish a failed Check Wallet step from nothing wrong"
```

---

### Task 7: Re-read the outbox before abort; treat more failures as environmental

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`cancelOutboxPayment`)
- Modify: `packages/expo-wallet-toolbox/core/pay/creditErrors.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts`

**Interfaces:**
- `cancelOutboxPayment` loads `getOutboxEntries(storage).find(e => e.id === entry.id)` before the undelivered abort. Missing row → `{ aborted: false }` and no abort. Stored `delivered`/`delivering` → `{ aborted: false, needsAbandon: true }`.
- `classifyCreditError` environmental regex also matches `database-locked`, `failed to retrieve messages`, `not found on refresh` (case-insensitive).

- [ ] **Step 1: Write the failing tests**

```ts
it('re-reads storage and does not abort if the row became delivered after the snapshot', async () => {
  const s = fakeStorage()
  const w = fakeWallet()
  const entry = await undeliveredEntry(s)
  await updateOutboxEntry(s, entry.id, { delivered: true })
  const stale = { ...entry, delivered: false, delivering: false }
  const result = await cancelOutboxPayment({ wallet: w as never, adminOriginator: 'admin.com', storage: s, entry: stale })
  expect(result.aborted).toBe(false)
  expect(result.needsAbandon).toBe(true)
  expect(w.abortAction).not.toHaveBeenCalled()
})
```

```ts
it.each(['database-locked', 'failed to retrieve messages', 'Payment not found on refresh'])(
  'classifies %s as environmental',
  msg => {
    expect(classifyCreditError(new Error(msg))).toBe('environmental')
  }
)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts --no-coverage`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Re-read in `cancelOutboxPayment`. Extend the environmental regex in `classifyCreditError` (single regex, keep existing alternatives).

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/handle.ts packages/expo-wallet-toolbox/core/pay/creditErrors.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts
git commit -m "fix(pay): re-read the outbox before abort and treat more failures as environmental"
```

---

### Task 8: Repair a corrupt pending blob and prune completed entries

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/localpay/pending.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts`

**Interfaces:**
- After quarantine copy in `readAll`’s catch: `await storage.setKeyValue(PENDING_KEY, '[]')` then throw `PendingCorruptError` (notice still true for this read). Next `readAll` parses `[]`.
- `writeAll` filters out `status === 'completed'` before serialising. Failed entries stay.

- [ ] **Step 1: Write the failing tests**

```ts
it('replaces PENDING_KEY with [] after quarantining corrupt JSON so a later save can proceed', async () => {
  const s = fakeStorage()
  s.map.set(PENDING_KEY, '{not json')
  await expect(getPending(s)).rejects.toBeInstanceOf(PendingCorruptError)
  expect(JSON.parse(s.map.get(PENDING_KEY)!)).toEqual([])
  expect([...s.map.keys()].some(k => k.startsWith('localpay_pending_corrupt_'))).toBe(true)
  const saved = await savePending(s, frame)
  expect(saved.status).toBe('pending')
})

it('drops completed entries on write', async () => {
  const s = fakeStorage()
  const a = await savePending(s, frame)
  await updateStatus(s, a.id, 'completed')
  const b = await savePending(s, frame)
  const all = JSON.parse(s.map.get(PENDING_KEY)!) as { id: string; status: string }[]
  expect(all.map(e => e.id)).toEqual([b.id])
})
```

Use the file’s existing `frame` / `fakeStorage` fixtures. Adjust if `savePending`’s frame helper has a different name.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts --no-coverage`
Expected: FAIL — corrupt key stays `{not json`; completed rows remain.

- [ ] **Step 3: Write minimal implementation**

In `readAll` catch, after the quarantine `setKeyValue`, write `[]` to `PENDING_KEY`. In `writeAll`, `list.filter(p => p.status !== 'completed')`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts --no-coverage`
Expected: PASS. Existing quarantine tests that assert the original blob remains must be updated to expect `[]` on `PENDING_KEY` plus a `localpay_pending_corrupt_*` copy — that is the spec, not a test weakening.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay/pending.ts packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts
git commit -m "fix(pay): repair a corrupt nearby queue and drop completed entries"
```

---

### Task 9: Bound reviewStatus scans, cap inbox relist, slow ReviewProvenTxs, prune outbox in the drain

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/storage/methods/reviewStatusSql.ts` (`REVIEW_OUTPUTS_SQL`)
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`acceptWithRetry`)
- Modify: `packages/expo-wallet-toolbox/core/walletMonitor.ts` (`boundReviewProvenTxs`)
- Modify: `packages/expo-wallet-toolbox/core/monitor/TaskDrainOutbox.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (pass `getOnline` into boundReviewProvenTxs; call prune from drain)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts` (or new `acceptWithRetry` describe in handleRail)
- Test: `packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/monitor/taskDrainOutbox.test.ts`

**Interfaces:**
- `REVIEW_OUTPUTS_SQL`: `SELECT … FROM outputs WHERE NOT (spendable = 0 AND spentBy IS NULL)`.
- `acceptWithRetry`: retry `internalize(payment)` once on catch; do **not** call `listIncomingPayments`. If the second attempt throws, rethrow. (Spec: at most one list per **pass** — dropping the list entirely is the smallest change that meets the cap of one.)
- `boundReviewProvenTxs(task, { getOnline, now })`: `trigger` returns `{ run: false }` when `getOnline()` is false. Cadence: run at most every `REVIEW_PROVEN_TXS_MIN_INTERVAL_MS = 600_000` (10 minutes). Keep the 100-height cap.
- `TaskDrainOutbox.runTask` (or the WalletContext drain closure) calls `pruneExpiredSent(storage)` each successful pass.

- [ ] **Step 1: Write the failing tests**

`acceptWithRetry`: first internalize throws, second succeeds — `listIncomingPayments` must not be called.

```ts
it('retries the same payment without relisting the inbox', async () => {
  const listIncomingPayments = jest.fn()
  let n = 0
  await acceptWithRetry({} as never, 'https://mb', payment, 'd', async () => {
    n++
    if (n === 1) throw new Error('stale')
  })
  expect(n).toBe(2)
  expect(listIncomingPayments).not.toHaveBeenCalled()
})
```

Adapt to the current `acceptWithRetry(client, url, payment, description, internalize)` signature — pass a client whose `listIncomingPayments` is the jest fn.

`boundReviewProvenTxs`: trigger is false when `getOnline` returns false; when online, a second trigger 60s later is false, 10min later is true (use a fake `now`).

Drain: after `runTask`, `pruneExpiredSent` was invoked — spy or assert a sent-expired fixture disappeared. If the drain task does not currently receive storage, add an optional `prune?: () => Promise<void>` port and have WalletContext pass `() => pruneExpiredSent(storage)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts packages/expo-wallet-toolbox/__tests__/monitor/taskDrainOutbox.test.ts --no-coverage`
Expected: FAIL on the new cases.

- [ ] **Step 3: Write minimal implementation**

SQL WHERE. `acceptWithRetry` second `internalize(payment)` without list. Bound trigger + interval. Drain prune port.

- [ ] **Step 4: Run tests**

Run the same jest command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/storage/methods/reviewStatusSql.ts packages/expo-wallet-toolbox/core/pay/rails/handle.ts packages/expo-wallet-toolbox/core/walletMonitor.ts packages/expo-wallet-toolbox/core/monitor/TaskDrainOutbox.ts packages/expo-wallet-toolbox/core/context/WalletContext.tsx packages/expo-wallet-toolbox/__tests__
git commit -m "fix(wallet): bound repair scans, inbox retries, proven-tx cadence, and outbox prune"
```

---

### Task 10: Notify when background credit accepts a payment

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/monitor/TaskCreditInbox.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (wire sound + toast)
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/monitor/taskCreditInbox.test.ts`

**Interfaces:**
- `TaskCreditInbox` constructor gains optional `onAccepted?: (count: number) => void`. After a successful `credit()` with `r.accepted > 0`, call `onAccepted(r.accepted)`.
- WalletContext: if receive screen is not focused (use existing focus/AppState pattern or a module flag `HandleReceive.isFocused`; if no flag exists, add `setReceiveInboxFocused(boolean)` in `creditInbox.ts` or a tiny `core/pay/receiveFocus.ts`), call `sounds.confirmation()` and `showToast(i18n.t('payment_arrived'), { type: 'success' })`. If focused, skip — HandleReceive owns the overlay.
- English: `payment_arrived`: Payment received

- [ ] **Step 1: Write the failing test**

```ts
it('notifies once when a pass accepts payments', async () => {
  const onAccepted = jest.fn()
  const task = new TaskCreditInbox(monitorStub, async () => ({ accepted: 2, attention: 0 }), Date.now, onAccepted)
  await task.runTask()
  expect(onAccepted).toHaveBeenCalledWith(2)
})

it('does not notify when accepted is 0', async () => {
  const onAccepted = jest.fn()
  const task = new TaskCreditInbox(monitorStub, async () => ({ accepted: 0, attention: 1 }), Date.now, onAccepted)
  await task.runTask()
  expect(onAccepted).not.toHaveBeenCalled()
})
```

Reuse the monitor stub already in `taskCreditInbox.test.ts`. Adapt the constructor argument order to match the current class (`monitor, credit, now = Date.now`) — add `onAccepted` as the last optional argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/monitor/taskCreditInbox.test.ts --no-coverage`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Add the port. Wire in WalletContext. Add i18n key next to `payment_arrived_damaged` in every locale. Do not import `Toast` into `TaskCreditInbox` itself.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/monitor/taskCreditInbox.test.ts --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/monitor/TaskCreditInbox.ts packages/expo-wallet-toolbox/core/context/WalletContext.tsx packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/core/pay packages/expo-wallet-toolbox/__tests__/monitor/taskCreditInbox.test.ts
git commit -m "feat(pay): play the arrival notice when background credit accepts a payment"
```

---

## Self-review

1. **Spec coverage:** §2.1→T1, §2.1 remainder+§2.1 resend→T2, §2.2→T3, §2.3→T4, §2.4→T5, §2.5→T6, §2.6 cancel+regex→T7, §2.6 pending→T8, §2.7→T9, §2.8→T10. Deferred remainder is spec §7.
2. **Placeholders:** none.
3. **Types:** `peekLastMissHeight` not `take` in T5+ call sites; `WalletCheckStepResult` consumed by T6 screen; `shouldReleaseUtxo` consumed by T3 `checkUtxoSpendability`; `onAccepted` last arg on `TaskCreditInbox`.
