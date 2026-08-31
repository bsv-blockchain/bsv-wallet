# Payment Dead-End Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every payment dead end the 2026-08-31 audit confirmed: no discarded derivation data, no silent inbox drops, no false send success, no Refresh-induced double-spend of queued offline payments, a resend loop both wallets can use, a one-button Check Wallet, and reorg/header repair that actually runs.

**Architecture:** Four sequential phases. P0 stops burning funds on the existing rails. P1 adds a `payment_control` MessageBox channel and sender-side token rebuild. P2 implements the stubbed SQL repair and productizes it as Check Wallet. P3 moves inbox credit, outbox drain, and reorg handling into Monitor tasks and the home screen. Do not start P1 until P0’s outbox retention and NACK-before-ack exist; do not ship the Check Wallet *screen* until `reviewStatus` and the `spentBy` NULL fix exist. New screens and dialogs follow Apple HIG (spec §11).

**Tech Stack:** TypeScript, React Native / Expo Router, Jest (`jest-expo` at repo root), `node:sqlite` for storage SQL tests, `@bsv/sdk`, `@bsv/message-box-client`, `@bsv/wallet-toolbox-mobile`.

**Spec:** [docs/superpowers/specs/2026-08-31-payment-dead-end-fixes-design.md](../specs/2026-08-31-payment-dead-end-fixes-design.md)

**Audit:** [docs/superpowers/Payment Dead-End Audit.mhtml](../Payment%20Dead-End%20Audit.mhtml)

## Global Constraints

- Paths below are under `packages/expo-wallet-toolbox/` unless they start with `app/`.
- Tests live in `packages/expo-wallet-toolbox/__tests__/`. Run from the **repo root**: `npx jest <path> --no-coverage`.
- Do not edit `node_modules`. Do not call `PeerPayClient.acceptPayment`, `rejectPayment`, or `listMessages` auto-internalize.
- New i18n keys go in **every** locale object in `core/i18n/translations.tsx` (no per-key fallback). Non-English locales may copy the English string as an interim value. English strings are the table in spec §11.5 — do not invent alternate marketing copy.
- **Apple HIG is mandatory for every new UI surface** ([HIG](https://developer.apple.com/design/human-interface-guidelines), spec §11). Use existing primitives: `showAlert` / `AlertCard` (2-button decisions), `showToast` (transient notices), `PressableScale` (press states), `GroupedSection` + `ListRow` (Settings), 44×44 pt hit targets, `haptics.warning` on destructive present. Do not call `Alert.alert`. Do not toast a problem that is still true after the toast expires. Do not alert on app foreground — update the home list instead.
- **Action sheets for 3+ choices the person just initiated.** Add `showChoiceSheet` (`ui/components/ui/ChoiceSheet.ts`): iOS `ActionSheetIOS.showActionSheetWithOptions` (destructive index first, cancel last); Android falls back to stacked `showAlert` (AlertCard already stacks 3). Used for send-QR exit and Finish vs Abandon.
- User-facing repair name is **Check Wallet** (`t('check_wallet')`), not “Check my wallet”. Progress is determinate (step N of 4) with a specific label, never “Loading”. The screen is a **pushed** Stack route, not a sheet. Do not use `Celebration` here.
- `MAX_AUTO_ATTEMPTS` stays `2`. Environmental failures must not increment it.
- A resend of a live txid rebuilds the **token** (same tx, fresh AtomicBEEF). It does not mint a second payment.
- `sqlUpdate` skip-undefined semantics stay for every column except `outputs.spentBy`, which translates `undefined` to SQL NULL.
- Skip txids with live `offline_actions` rows (`queued`/`posting`) in any path that would fail/release them.
- Verification gate per task: the listed Jest file(s) green. After any `WalletContext.tsx` / `handle.ts` / storage change also run `npx tsc --noEmit` if it is cheap; do not skip a failing typecheck.
- Commit after every task. Conventional commits (`fix:` / `feat:` / `test:`).
- The one refuted audit finding (proof-provider outage driving mined txs to failed) is out of scope.

## File structure

| File | Responsibility |
|---|---|
| Create: `core/pay/tokenAmount.ts` | Satoshis from AtomicBEEF bytes; claimed-vs-actual |
| Create: `core/localpay/sessionPolicy.ts` | Unseal-failure phase and send_qr exit choice |
| Create: `core/pay/creditErrors.ts` | `classifyCreditError` → environmental / double_spend / structural |
| Create: `core/pay/damagedInbox.ts` | Diff raw inbox messages against parseable tokens |
| Create: `core/peerpay/control.ts` | `payment_control` types, send, list, ack |
| Create: `core/peerpay/rebuildToken.ts` | Rebuild a PaymentToken from output `customInstructions` + fresh BEEF |
| Create: `core/storage/methods/reviewStatusSql.ts` | The three `reviewStatus` rules as testable SQL/helpers |
| Create: `core/monitor/TaskCreditInbox.ts` | Background list + `autoAcceptInbox` |
| Create: `core/monitor/TaskDrainOutbox.ts` | Background retry of `unsent` outbox entries |
| Create: `core/walletRepair/runWalletCheck.ts` | Ordered Check-my-wallet steps, queue-safe |
| Create: `ui/screens/WalletCheckScreen.tsx` | Pushed Check Wallet screen, determinate 4-step progress |
| Create: `app/wallet-check.tsx` | Expo Router route |
| Create: `ui/components/ui/ChoiceSheet.ts` | `showChoiceSheet` — iOS action sheet, Android stacked alert |
| Modify: `core/peerpay/outbox.ts` | Retention, `delivering`, first-failure error fields, prune API |
| Modify: `core/pay/rails/handle.ts` | `broadcastNoSend` result, discard NACK, abort-on-outbox-fail, lastError |
| Modify: `ui/components/pay/HandleSend.tsx` | Stop pruning sent; Cancel vs Abandon; canSend copy |
| Modify: `ui/components/pay/HandleReceive.tsx` | Damaged rows, classified errors, amount-from-bytes, mutex |
| Modify: `core/context/WalletContext.tsx` | Monitor 4th arg, `ready`, no splice of ReviewProvenTxs, `refreshProof` guards, tasks |
| Modify: `core/storage/StorageExpoSQLite.ts` | `spentBy` NULL; real `reviewStatus` |
| Modify: `core/headers/fs.ts`, `headerStore.ts`, `syncHeaders.ts` | Truncate, rewind, too-long `.bin` |
| Modify: `core/localpay/pending.ts`, `build.ts`; `ui/components/pay/NearbyFlow.tsx` | Quarantine, persist frame on every Done, unseal non-terminal |
| Modify: `ui/screens/WalletHomeScreen.tsx`, `WalletConfigScreen.tsx`, `PayScreen.tsx`, `OfflineNotice.tsx`, `ActivityRow.tsx` | Inline home rows, Check Wallet row, Send again, Refresh vs queued |

---

# Phase P0 — Stop losing money

Ship this first. After P0: Discard cannot destroy the only token copy without a NACK attempt; sent outbox entries survive; a failed delayed broadcast is not shown as success; Refresh cannot fail a queued offline payment; the overlay cannot lie about satoshis; corrupt inbox messages are visible; nearby Done always persists the frame; a corrupt pending blob is quarantined, not overwritten.

---

### Task 1: Displayed amount comes from transaction bytes

**Files:**
- Create: `packages/expo-wallet-toolbox/core/pay/tokenAmount.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/tokenAmount.test.ts`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx` (overlay sum around 556–564, attention-row amount around 312–316)

**Interfaces:**
- Consumes: `@bsv/sdk` `Transaction.fromAtomicBEEF`, `Beef`.
- Produces: `satoshisFromToken(token: { transaction: number[]; outputIndex?: number; amount?: number }): { satoshis: number; claimedAgrees: boolean } | undefined`

- [ ] **Step 1: Write the failing test**

```ts
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { satoshisFromToken } from '../../core/pay/tokenAmount'

function tokenWithOutput(satoshis: number, claimed?: number) {
  const tx = new Transaction()
  tx.addOutput({ satoshis, lockingScript: new P2PKH().lock(new PrivateKey(1).toPublicKey().toAddress()) })
  return {
    transaction: tx.toAtomicBEEF(),
    outputIndex: 0,
    amount: claimed ?? satoshis
  }
}

describe('satoshisFromToken', () => {
  it('reads satoshis from the output, not the JSON claim', () => {
    const r = satoshisFromToken(tokenWithOutput(1, 50000))
    expect(r?.satoshis).toBe(1)
    expect(r?.claimedAgrees).toBe(false)
  })

  it('agrees when the claim matches the output', () => {
    const r = satoshisFromToken(tokenWithOutput(700, 700))
    expect(r?.satoshis).toBe(700)
    expect(r?.claimedAgrees).toBe(true)
  })

  it('returns undefined when the bytes will not parse', () => {
    expect(satoshisFromToken({ transaction: [1, 2, 3], amount: 500 })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/tokenAmount.test.ts --no-coverage`

Expected: FAIL — `Cannot find module` / `satoshisFromToken` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
import { Transaction } from '@bsv/sdk'

export function satoshisFromToken(token: {
  transaction: number[]
  outputIndex?: number
  amount?: number
}): { satoshis: number; claimedAgrees: boolean } | undefined {
  try {
    const tx = Transaction.fromAtomicBEEF(token.transaction)
    const satoshis = tx.outputs[token.outputIndex ?? 0]?.satoshis
    if (typeof satoshis !== 'number' || satoshis < 0) return undefined
    const claimed = token.amount
    const claimedAgrees = typeof claimed !== 'number' || !Number.isFinite(claimed) || claimed === satoshis
    return { satoshis, claimedAgrees }
  } catch {
    return undefined
  }
}
```

In `HandleReceive.tsx`, replace every `p.token?.amount` used for display / overlay totals with `satoshisFromToken(p.token)?.satoshis`. If `claimedAgrees === false`, still show the **output** figure; do not announce the claim. If the helper returns undefined, show the attention treatment from Task 6 (damaged), not `AmountDisplay` of undefined.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/tokenAmount.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/tokenAmount.ts \
        packages/expo-wallet-toolbox/__tests__/pay/tokenAmount.test.ts \
        packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx
git commit -m "$(cat <<'EOF'
fix(pay): show received amount from transaction bytes, not token JSON

A sender-asserted token.amount can disagree with the BRC-29 output.
The overlay and attention rows now read satoshis from AtomicBEEF.
EOF
)"
```

---

### Task 2: Keep sent outbox entries for 30 days

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/peerpay/outbox.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/outbox.test.ts`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx:199-210`

**Interfaces:**
- Consumes: existing `OutboxEntry`, `getOutboxEntries`, `removeOutboxEntry`.
- Produces:
  - `SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000`
  - `isSentExpired(entry: OutboxEntry, now?: number): boolean` — `status === 'sent'` and `createdAt` older than retention. Entries missing `createdAt` expire immediately once sent (legacy).
  - `pruneExpiredSent(storage, now?: number): Promise<number>` — removes only expired sent rows; returns count removed.
  - `unsentEntries(entries: OutboxEntry[]): OutboxEntry[]` — `status !== 'sent'` (the Retry/Cancel list).

- [ ] **Step 1: Write the failing test**

```ts
import {
  SENT_RETENTION_MS,
  getOutboxEntries,
  saveOutboxEntry,
  markOutboxSent,
  pruneExpiredSent,
  unsentEntries
} from '../../core/peerpay/outbox'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getKeyValue: async (k: string) => map.get(k),
    setKeyValue: async (k: string, v: string) => void map.set(k, v)
  }
}

const token = {
  customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
  transaction: [1],
  amount: 7
}

describe('sent outbox retention', () => {
  it('does not prune a sent entry younger than 30 days', async () => {
    const s = fakeStorage()
    const id = await saveOutboxEntry(s, { recipient: '02aa', token, messageBoxUrl: 'https://mb', txid: 'ab' })
    await markOutboxSent(s, id)
    expect(await pruneExpiredSent(s)).toBe(0)
    expect(await getOutboxEntries(s)).toHaveLength(1)
    expect(unsentEntries(await getOutboxEntries(s))).toHaveLength(0)
  })

  it('prunes a sent entry older than 30 days and leaves unsent alone', async () => {
    const s = fakeStorage()
    const oldId = await saveOutboxEntry(s, { recipient: '02aa', token, messageBoxUrl: 'https://mb', txid: 'ab' })
    await markOutboxSent(s, oldId)
    const entries = await getOutboxEntries(s)
    entries[0].createdAt = new Date(Date.now() - SENT_RETENTION_MS - 1000).toISOString()
    await s.setKeyValue('peerpay_outbox', JSON.stringify(entries))
    await saveOutboxEntry(s, { recipient: '02bb', token, messageBoxUrl: 'https://mb', txid: 'cd' })
    expect(await pruneExpiredSent(s)).toBe(1)
    const left = await getOutboxEntries(s)
    expect(left).toHaveLength(1)
    expect(left[0].status).toBe('unsent')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/outbox.test.ts --no-coverage`

Expected: FAIL — `pruneExpiredSent` / `SENT_RETENTION_MS` not exported.

- [ ] **Step 3: Write minimal implementation**

In `outbox.ts` add the constants and functions. `pruneExpiredSent` reads, filters, writes back.

In `HandleSend.tsx` `loadOutbox`:

```ts
const entries = await getOutboxEntries(storage)
await pruneExpiredSent(storage)
setOutbox(unsentEntries(await getOutboxEntries(storage)))
```

Delete the loop `for (const e of delivered) await removeOutboxEntry(...)`. Update the comment: sent entries are history for resend, pruned after 30 days.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/outbox.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts --no-coverage`

Expected: PASS. Existing `handleRail` tests that expect a `sent` entry to still be readable after `sendViaHandle` continue to pass; they already assert `entry.status === 'sent'` via `getOutboxEntries`.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/peerpay/outbox.ts \
        packages/expo-wallet-toolbox/__tests__/pay/outbox.test.ts \
        packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx
git commit -m "$(cat <<'EOF'
fix(pay): keep sent PeerPay outbox entries for 30 days

Discard and inbox loss are unrecoverable if the sender's token copy
is deleted on the next send-screen open.
EOF
)"
```

---

### Task 3: `broadcastNoSend` reads `sendWithResults`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts:249-260` (and call sites 353, 436)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts` (extend `sendViaHandle` / add `retryDelivery` case)

**Interfaces:**
- Consumes: `wallet.createAction` return value. Delayed broadcast does not throw (`Wallet.js:609`).
- Produces: `broadcastNoSend` throws `Error('broadcast_failed')` when any matching `sendWithResults` item has `status === 'failed'`. Missing `sendWithResults` is success (legacy / tests that return only `{ txid, tx }`).

- [ ] **Step 1: Write the failing test**

Add to `handleRail.test.ts` inside `describe('sendViaHandle')`:

```ts
it('does not mark the entry sent when sendWithReports a failed delayed broadcast', async () => {
  const s = fakeStorage()
  const w = fakeWallet()
  const inner = w.createAction.getMockImplementation()!
  w.createAction.mockImplementation(async (args: any) => {
    if (args?.options?.sendWith) {
      return { sendWithResults: [{ txid: args.options.sendWith[0], status: 'failed' }] }
    }
    return await inner(args)
  })
  const client = { sendMessage: jest.fn().mockResolvedValue(undefined) }
  await expect(sendViaHandle(sendArgs(w, client, s))).rejects.toThrow(/broadcast_failed/)
  const entry = (await getOutboxEntries(s))[0]
  expect(entry.status).toBe('unsent')
  expect(entry.delivered).toBe(true)
})
```

`fakeWallet` currently returns a mint result for every `createAction`. The new branch must only trigger on `options.sendWith`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts -t 'does not mark the entry sent' --no-coverage`

Expected: FAIL — `sendViaHandle` resolves and `status === 'sent'` because `broadcastNoSend` ignores the result.

- [ ] **Step 3: Write minimal implementation**

Replace `broadcastNoSend`:

```ts
async function broadcastNoSend(
  wallet: Pick<HandleRailWallet, 'createAction'>,
  adminOriginator: string,
  txid: string
): Promise<void> {
  const result = (await wallet.createAction(
    { description: 'PeerPay payment broadcast', options: { sendWith: [txid] } },
    adminOriginator
  )) as { sendWithResults?: { txid?: string; status?: string }[] }
  const failed = result.sendWithResults?.find(o => o.txid === txid && o.status === 'failed')
  if (failed) throw new Error('broadcast_failed')
}
```

Extend `HandleRailWallet['createAction']` return type to include optional `sendWithResults`. Do not mark sent, and do not show the success overlay, when this throws — `HandleSend.handleSend` already catches and reloads the outbox.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts --no-coverage`

Expected: PASS, including the existing “broadcasts then marks sent” test (fake wallet has no `sendWithResults`, treated as success).

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/handle.ts \
        packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts
git commit -m "$(cat <<'EOF'
fix(pay): treat a failed delayed sendWith as a thrown broadcast error

createAction in delayed mode returns sendWithResults instead of
throwing. Ignoring that marked a dead payment as sent.
EOF
)"
```

---

### Task 4: Abort the noSend action if the outbox write fails; record first-attempt errors

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`sendViaHandle`)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts`

**Interfaces:**
- Consumes: `saveOutboxEntry`, `updateOutboxEntry`, `wallet.abortAction`, `wallet.listActions`.
- Produces: if `saveOutboxEntry` throws after a successful mint, `sendViaHandle` aborts the action (same lookup as `cancelOutboxPayment`) and rethrows. If `sendMessage` throws, the entry is updated with `lastAttemptAt` and `lastError` before rethrow.

- [ ] **Step 1: Write the failing tests**

```ts
it('aborts the minted action when the outbox write fails', async () => {
  const s = fakeStorage()
  s.setKeyValue = async () => {
    throw new Error('disk full')
  }
  const w = fakeWallet({
    abortAction: jest.fn().mockResolvedValue({ aborted: true }),
    listActions: jest.fn()
  })
  w.listActions.mockImplementation(async () => {
    const mint = w.createAction.mock.results[0]?.value as { txid?: string } | undefined
    const txid = mint && 'then' in (mint as object) ? await mint : mint
    return { actions: [{ txid: (txid as { txid: string }).txid, reference: 'ref-1' }] }
  })
  const client = { sendMessage: jest.fn() }
  await expect(sendViaHandle(sendArgs(w, client, s))).rejects.toThrow(/disk full/)
  expect(client.sendMessage).not.toHaveBeenCalled()
  expect(w.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, 'admin.com')
})

it('records lastError on the first delivery failure, not only on retry', async () => {
  const s = fakeStorage()
  const w = fakeWallet()
  const client = { sendMessage: jest.fn().mockRejectedValue(new Error('offline')) }
  await expect(sendViaHandle(sendArgs(w, client, s))).rejects.toThrow('offline')
  const entry = (await getOutboxEntries(s))[0]
  expect(entry.lastError).toBe('offline')
  expect(entry.lastAttemptAt).toBeTruthy()
})
```

`fakeWallet` already has `listActions` and `abortAction`. The test above overrides them. `createAction` is async — `mock.results[0].value` is a Promise; await it to read `txid`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts -t 'aborts the minted action|records lastError on the first' --no-coverage`

Expected: FAIL — no abort; `lastError` undefined.

- [ ] **Step 3: Write minimal implementation**

Wrap post-mint work:

```ts
let outboxId: string | undefined
try {
  outboxId = await saveOutboxEntry(storage, { recipient, token, messageBoxUrl, txid: car.txid })
} catch (e) {
  await abortPeerPayNosend(wallet, adminOriginator, car.txid)
  throw e
}
try {
  await client.sendMessage({ recipient, messageBox: PAYMENT_INBOX, body: JSON.stringify(token) })
  await updateOutboxEntry(storage, outboxId, { delivered: true })
  await broadcastNoSend(wallet, adminOriginator, car.txid)
  await markOutboxSent(storage, outboxId)
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  await updateOutboxEntry(storage, outboxId, {
    lastAttemptAt: new Date().toISOString(),
    lastError: message
  })
  throw e
}
```

Extract `abortPeerPayNosend` as a small helper used here and in `cancelOutboxPayment` (same `listActions` + `abortAction` by txid). Swallow abort failures only after logging — the throw the user sees is still the original write/delivery error.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/handle.ts \
        packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts
git commit -m "$(cat <<'EOF'
fix(pay): abort a PeerPay noSend if the outbox write fails

A mint without an outbox row locked inputs with no Retry/Cancel
card. First delivery failures now also persist lastError.
EOF
)"
```

---

### Task 5: `delivering` checkpoint before `sendMessage`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/peerpay/outbox.ts` (`OutboxEntry.delivering?: boolean`)
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`sendViaHandle`, `retryDelivery`, `cancelOutboxPayment`)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts`

**Interfaces:**
- Consumes: Task 4 helpers.
- Produces: `delivering: true` is written **before** `sendMessage`. After a crash in that window the entry has `delivering === true` and `delivered !== true`. `retryDelivery` always re-sends the token in that state (HMAC message id is idempotent). `cancelOutboxPayment` does **not** abort a `delivering` entry; it leaves the entry and the caller must use Abandon (P1 sends `payment_cancelled`). For P0: Cancel on `delivering` or `delivered` refuses to abort and returns `{ aborted: false, needsAbandon: true }`.

- [ ] **Step 1: Write the failing test**

```ts
it('sets delivering before sendMessage so a crash cannot look undelivered', async () => {
  const s = fakeStorage()
  const w = fakeWallet()
  const client = {
    sendMessage: jest.fn(async () => {
      const entry = (await getOutboxEntries(s))[0]
      expect(entry.delivering).toBe(true)
      expect(entry.delivered).not.toBe(true)
      throw new Error('lost response')
    })
  }
  await expect(sendViaHandle(sendArgs(w, client, s))).rejects.toThrow('lost response')
  const entry = (await getOutboxEntries(s))[0]
  expect(entry.delivering).toBe(true)
})

it('cancel of a delivering entry does not abort the noSend action', async () => {
  const s = fakeStorage()
  const w = fakeWallet()
  w.abortAction = jest.fn()
  const id = await saveOutboxEntry(s, {
    recipient: KEY,
    token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1], amount: 1 },
    messageBoxUrl: 'https://mb',
    txid: 'aa'
  })
  await updateOutboxEntry(s, id, { delivering: true })
  const entry = (await getOutboxEntries(s))[0]
  const result = await cancelOutboxPayment({ wallet: w as never, adminOriginator: 'admin.com', storage: s, entry })
  expect(result.aborted).toBe(false)
  expect(w.abortAction).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts -t 'delivering' --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Before `sendMessage` in `sendViaHandle` and in `retryDelivery`’s undelivered branch: `await updateOutboxEntry(storage, id, { delivering: true })`.

Change the abort guard in `cancelOutboxPayment` from `entry.delivered !== true` to `entry.delivered !== true && entry.delivering !== true`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/peerpay/outbox.ts \
        packages/expo-wallet-toolbox/core/pay/rails/handle.ts \
        packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts
git commit -m "$(cat <<'EOF'
fix(pay): checkpoint delivering before sendMessage

A crash after the box accepted the token used to look undelivered,
so Cancel aborted a transaction the recipient already held.
EOF
)"
```

---

### Task 6: Surface corrupt / unparseable inbox messages

**Files:**
- Create: `packages/expo-wallet-toolbox/core/pay/damagedInbox.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/damagedInbox.test.ts`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx` (`fetchPayments`)

**Interfaces:**
- Consumes: raw `{ messageId, sender, body }[]` plus parseable `{ messageId }[]`.
- Produces: `listDamagedInboxMessages({ raw, parsed }): { messageId: string; sender: string; reason: 'unparseable' | 'bad_shape' }[]`
- Produces: `isPaymentTokenShape(body: unknown): boolean` — object with `customInstructions.derivationPrefix` and `derivationSuffix` strings, `transaction` an array of numbers.

- [ ] **Step 1: Write the failing test**

```ts
import { isPaymentTokenShape, listDamagedInboxMessages } from '../../core/pay/damagedInbox'

describe('isPaymentTokenShape', () => {
  it('accepts a token-shaped body', () => {
    expect(
      isPaymentTokenShape({
        customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' },
        transaction: [1, 2],
        amount: 3
      })
    ).toBe(true)
  })

  it('rejects JSON that is not a token', () => {
    expect(isPaymentTokenShape({ hello: 'world' })).toBe(false)
    expect(isPaymentTokenShape(null)).toBe(false)
  })
})

describe('listDamagedInboxMessages', () => {
  it('returns raw ids that did not parse into tokens', () => {
    const damaged = listDamagedInboxMessages({
      raw: [
        { messageId: 'good', sender: '02aa', body: '{}' },
        { messageId: 'bad', sender: '02bb', body: '[Error: Failed to decrypt or parse message]' }
      ],
      parsed: [{ messageId: 'good' }]
    })
    expect(damaged).toEqual([{ messageId: 'bad', sender: '02bb', reason: 'unparseable' }])
  })

  it('marks parseable-JSON-but-wrong-shape as bad_shape when the parsed list still includes them', () => {
    // parsed list is what listIncomingPayments returned (non-null JSON).
    // We still shape-check the body.
    const damaged = listDamagedInboxMessages({
      raw: [{ messageId: 'x', sender: '02aa', body: { foo: 1 } }],
      parsed: [{ messageId: 'x' }]
    })
    expect(damaged[0].reason).toBe('bad_shape')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/damagedInbox.test.ts --no-coverage`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Implement the two functions. Body may already be an object (library parsed JSON) or a string (decrypt error sentinel). Strings that are not JSON → `unparseable`. JSON / objects failing `isPaymentTokenShape` → `bad_shape`. Ids in `parsed` that fail the shape check are included.

In `HandleReceive.fetchPayments`, after `listIncomingPayments`:

```ts
let raw: { messageId: string; sender: string; body: unknown }[] = []
try {
  raw = await (client as any).listMessages?.({ messageBox: 'payment_inbox' }) ?? []
} catch {
  raw = []
}
const damaged = listDamagedInboxMessages({ raw, parsed: list })
```

Union damaged rows into the attention list with copy `t('payment_arrived_damaged')` (“This payment arrived damaged”). Do not call `internalizeIncoming` on them. Retry is disabled; Discard (Task 7) is the action.

Add i18n key `payment_arrived_damaged` in every locale.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/damagedInbox.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/damagedInbox.ts \
        packages/expo-wallet-toolbox/__tests__/pay/damagedInbox.test.ts \
        packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "$(cat <<'EOF'
fix(pay): surface unparseable PeerPay inbox messages

Corrupt bodies were filtered out of listIncomingPayments, so the
receiver saw nothing while the sender saw success.
EOF
)"
```

---

### Task 7: Discard NACKs before it acks

**Files:**
- Create: `packages/expo-wallet-toolbox/core/peerpay/control.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/control.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`discardIncoming`)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx` (replace two-tap arm with `showAlert`; pass sender + txid into discard)

**Interfaces:**
- Consumes: `MessageBoxClient.sendMessage`, `acknowledgeMessage`.
- Produces:

```ts
export const PAYMENT_CONTROL_BOX = 'payment_control'
export type ResendReason = 'corrupt' | 'uncreditible' | 'double_spent' | 'bounced_offline'
export type PaymentControlMessage =
  | { type: 'resend_request'; txid: string; reason: ResendReason; messageId?: string }
  | { type: 'payment_cancelled'; txid: string }

export function parseControlMessage(body: unknown): PaymentControlMessage | undefined
export async function sendControlMessage(
  client: { sendMessage(args: { recipient: string; messageBox: string; body: string }): Promise<unknown> },
  args: { recipient: string; message: PaymentControlMessage }
): Promise<void>
```

- Produces: `discardIncoming` now requires `sender` and `txid` (txid may be `undefined` for unparseable bodies — send `txid: ''` is forbidden; if no txid, still send `resend_request` with `txid` omitted only when we truly do not have one — prefer `safeAtomicTxid` / messageId-only). Spec: `txid` is required on the wire. For corrupt bodies without a parseable txid, send `{ type: 'resend_request', txid: messageId, reason: 'corrupt', messageId }` so the sender can at least match an outbox row by message metadata later. Prefer a real txid when `safeAtomicTxid` works.

P0 does **not** handle inbound control messages on the sender (that is P1). Sending is enough to stop evidence destruction.

- [ ] **Step 1: Write the failing tests**

```ts
import { PAYMENT_CONTROL_BOX, parseControlMessage, sendControlMessage } from '../../core/peerpay/control'

describe('parseControlMessage', () => {
  it('accepts a resend_request', () => {
    expect(parseControlMessage({ type: 'resend_request', txid: 'aa', reason: 'corrupt' })).toEqual({
      type: 'resend_request',
      txid: 'aa',
      reason: 'corrupt'
    })
  })
  it('ignores unknown types', () => {
    expect(parseControlMessage({ type: 'nope', txid: 'aa' })).toBeUndefined()
  })
})

describe('sendControlMessage', () => {
  it('posts JSON to payment_control', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined)
    await sendControlMessage(
      { sendMessage },
      { recipient: '02aa', message: { type: 'resend_request', txid: 'aa', reason: 'uncreditible' } }
    )
    expect(sendMessage).toHaveBeenCalledWith({
      recipient: '02aa',
      messageBox: PAYMENT_CONTROL_BOX,
      body: JSON.stringify({ type: 'resend_request', txid: 'aa', reason: 'uncreditible' })
    })
  })
})
```

Update `handleInbox.test.ts` `discardIncoming`:

```ts
it('sends a resend_request before acknowledging', async () => {
  const client = {
    acknowledgeMessage: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined)
  }
  await discardIncoming(client as never, { ...payment('a'), sender: KEY })
  expect(client.sendMessage).toHaveBeenCalled()
  expect(client.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
    client.acknowledgeMessage.mock.invocationCallOrder[0]
  )
})

it('does not ack if the NACK fails', async () => {
  const client = {
    acknowledgeMessage: jest.fn(),
    sendMessage: jest.fn().mockRejectedValue(new Error('offline'))
  }
  await expect(discardIncoming(client as never, { ...payment('a'), sender: KEY })).rejects.toThrow('offline')
  expect(client.acknowledgeMessage).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/control.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement `control.ts`. Change `discardIncoming`:

```ts
export async function discardIncoming(
  client: Pick<PeerPayClient, 'acknowledgeMessage' | 'sendMessage'>,
  payment: { messageId: string; sender?: string; token?: { transaction?: number[] } },
  reason: ResendReason = 'uncreditible'
): Promise<void> {
  const txid = payment.token?.transaction ? safeAtomicTxid(payment.token.transaction) : undefined
  if (payment.sender) {
    await sendControlMessage(client, {
      recipient: payment.sender,
      message: {
        type: 'resend_request',
        txid: txid ?? String(payment.messageId),
        reason,
        messageId: String(payment.messageId)
      }
    })
  }
  await client.acknowledgeMessage({ messageIds: [payment.messageId] })
}
```

Export `safeAtomicTxid` or keep it file-private and duplicate a one-liner in discard. Prefer exporting from `handle.ts` only if tests need it; otherwise call from discard in the same file.

HandleReceive `handleDiscard`: drop the two-tap arm (`armedDiscardId`). One tap opens `showAlert` (HIG: uncommon irreversible action). Spec §11.5 copy:

```ts
const choice = await showAlert({
  title: t('discard_payment_title'),
  message: t('discard_payment_body'),
  buttons: [
    { text: t('cancel'), style: 'cancel', key: 'cancel' },
    { text: t('discard'), style: 'destructive', key: 'discard' }
  ]
})
if (choice !== 'discard') return
await discardIncoming(client, payment)
```

If the last `classifyCreditError` for this row is `double_spend`, use `discard_void_title` / `discard_void_body` and a single `{ text: t('done'), key: 'done' }` button (not destructive — there is no money to abandon). Then ack.

If NACK throws, `showToast` the failure and keep the row. Do not use `Alert.alert`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/control.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/peerpay/control.ts \
        packages/expo-wallet-toolbox/core/pay/rails/handle.ts \
        packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx \
        packages/expo-wallet-toolbox/__tests__/pay/control.test.ts \
        packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts
git commit -m "$(cat <<'EOF'
fix(pay): NACK the sender before discarding an uncreditable payment

Acknowledge-only discard deleted the only derivation data the
receiver would ever see. The sender now gets a resend_request first.
EOF
)"
```

---

### Task 8: Guard `refreshProof` against queued offline payments

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx:2088-2105`
- Create: `packages/expo-wallet-toolbox/core/pay/refreshProofGuard.ts` (pure helper so we do not mount WalletContext in Jest)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/refreshProofGuard.test.ts`
- Modify: `packages/expo-wallet-toolbox/ui/components/wallet/ActivityRow.tsx:206`

**Interfaces:**
- Consumes: offline row status, tx status, age.
- Produces: `shouldFailUnprovenTx(args: { offlineStatus?: 'queued' | 'posting' | 'sent' | 'rejected' | 'acknowledged'; txStatus: string; updatedAtMs: number; nowMs: number }): 'pending' | 'failed'`

When `offlineStatus` is `queued` or `posting`, always `'pending'`. Existing 5-minute / in-flight rules otherwise unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { shouldFailUnprovenTx } from '../../core/pay/refreshProofGuard'

const IN_FLIGHT = { txStatus: 'nosend', updatedAtMs: 0, nowMs: 10 * 60 * 1000 }

describe('shouldFailUnprovenTx', () => {
  it('never fails a queued or posting offline row', () => {
    expect(shouldFailUnprovenTx({ ...IN_FLIGHT, offlineStatus: 'queued' })).toBe('pending')
    expect(shouldFailUnprovenTx({ ...IN_FLIGHT, offlineStatus: 'posting' })).toBe('pending')
  })

  it('still fails a stale in-flight tx with no queue row', () => {
    expect(shouldFailUnprovenTx({ ...IN_FLIGHT })).toBe('failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/refreshProofGuard.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement the helper. In `refreshProof`, after loading `tx` and before `updateTransactionStatus('failed')`:

```ts
const db = storage.sqliteDb
const rows = db ? await findOfflineActions(db, { txid, status: ['queued', 'posting'] }) : []
const offlineStatus = rows[0]?.status
if (shouldFailUnprovenTx({
  offlineStatus,
  txStatus: tx.status,
  updatedAtMs: tx.updated_at ? new Date(tx.updated_at).getTime() : 0,
  nowMs: Date.now()
}) === 'pending') {
  if (offlineStatus === 'queued' || offlineStatus === 'posting') TaskSendOffline.requestNow()
  return 'pending'
}
```

Need to import `findOfflineActions` and `TaskSendOffline` if not already in scope.

In `ActivityRow`, when `offlineStatus` is queued/posting, do not render the Refresh chip (or call the existing Send-now path if one is already passed in). Prefer hiding Refresh over adding a new chip in this task.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/refreshProofGuard.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/refreshProofGuard.ts \
        packages/expo-wallet-toolbox/__tests__/pay/refreshProofGuard.test.ts \
        packages/expo-wallet-toolbox/core/context/WalletContext.tsx \
        packages/expo-wallet-toolbox/ui/components/wallet/ActivityRow.tsx
git commit -m "$(cat <<'EOF'
fix(wallet): do not fail a queued offline payment from Refresh

Marking those txs failed released inputs the payee still held,
which could double-spend the person we just paid.
EOF
)"
```

---

### Task 9: Persist the nearby frame on every Done; quarantine corrupt pending JSON

**Files:**
- Create: `packages/expo-wallet-toolbox/ui/components/ui/ChoiceSheet.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/ui/choiceSheet.test.ts`
- Modify: `packages/expo-wallet-toolbox/ui/index.ts` — export `showChoiceSheet`
- Modify: `packages/expo-wallet-toolbox/core/localpay/build.ts` (online Done path ~262)
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` (finalizeDelivery / Done; unseal catch ~1017; send_qr back/exit)
- Modify: `packages/expo-wallet-toolbox/core/localpay/pending.ts` (`readAll`)
- Create: `packages/expo-wallet-toolbox/core/localpay/sessionPolicy.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/sessionPolicy.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/localpay/build.test.ts`

**Interfaces:**
- Consumes: existing `holdSentPaymentOffline` / `framePayload` persistence.
- Produces: `readAll` on JSON.parse failure copies the raw string to `localpay_pending_corrupt_<timestamp>` via `setKeyValue`, then throws a branded `PendingCorruptError`. `getPending` / `getUnprocessed` propagate that throw. `withQueueLock` mutators catch it and skip `writeAll`, so the original `PENDING_KEY` blob is never replaced with `[]`. `getPendingCorruptNotice(): boolean` is true after a quarantine until a successful parse.
- Produces: online Done uses the same hold/insert-offline_actions path as offline Done, then lets the drain broadcast (or broadcasts after the row exists).
- Produces: unseal failure in `onFrameScanned` returns to `receive_wait` with the existing session, matching `settleReceived`’s mismatch path.

- [ ] **Step 1: Write the failing pending test**

Add to `packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts` (it already exports `getPending`, `PENDING_KEY`, and `fakeStorage` with `.map`):

```ts
it('quarantines corrupt JSON instead of treating the queue as empty', async () => {
  const s = fakeStorage()
  s.map.set(PENDING_KEY, '{not json')
  await expect(getPending(s)).rejects.toThrow(/corrupt/i)
  const keys = [...s.map.keys()]
  expect(keys.some(k => k.startsWith('localpay_pending_corrupt_'))).toBe(true)
  expect(s.map.get(PENDING_KEY)).toBe('{not json')
})
```

Add `packages/expo-wallet-toolbox/core/localpay/sessionPolicy.ts` and `__tests__/localpay/sessionPolicy.test.ts`:

```ts
export type NearbyPhase = 'receive_wait' | 'failed'

export function nextPhaseAfterUnsealFailure(): NearbyPhase {
  return 'receive_wait'
}

export function exitSendQrChoice(scanned: 'yes' | 'no' | 'unsure'): 'hold' | 'abort' {
  return scanned === 'no' ? 'abort' : 'hold'
}
```

```ts
import { exitSendQrChoice, nextPhaseAfterUnsealFailure } from '../../core/localpay/sessionPolicy'

it('keeps the live session after an unseal failure', () => {
  expect(nextPhaseAfterUnsealFailure()).toBe('receive_wait')
})

it('aborts only when the payer is sure the code was never scanned', () => {
  expect(exitSendQrChoice('no')).toBe('abort')
  expect(exitSendQrChoice('yes')).toBe('hold')
  expect(exitSendQrChoice('unsure')).toBe('hold')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts --no-coverage`

Expected: FAIL — corrupt parse returns `[]` and a later save would overwrite.

- [ ] **Step 3: Write minimal implementation**

`pending.ts` `readAll`: on parse failure, `await storage.setKeyValue(\`localpay_pending_corrupt_${Date.now()}\`, raw)` then throw.

Mutators: do not `writeAll([])` on that throw.

`build.ts` / `NearbyFlow.tsx`: the online branch of Done/finalizeDelivery must call the same persist as `holdSentPaymentOffline` **before** `sendWith`. Read the current `finalizeDelivery` and make the hold unconditional; broadcast remains the drain’s job when online (TaskSendOffline + processOfflineActions already post when online). If the current online path calls `sendWith` directly, keep it only **after** the row exists.

Unseal catch in `NearbyFlow.tsx` `onFrameScanned`: call `nextPhaseAfterUnsealFailure()` and return to `receive_wait` with `hostedSession` still set. Do not call `reset()` and do not `fail('generic', invalid_qr)`.

On any exit from `send_qr` other than Done, call `showChoiceSheet` (HIG action sheet — this is three choices tied to Back, not an unexpected problem):

```ts
export async function showChoiceSheet(args: {
  title: string
  message?: string
  options: { key: string; label: string; destructive?: boolean }[]
  cancelKey?: string
}): Promise<string>
```

iOS: `ActionSheetIOS.showActionSheetWithOptions` with `destructiveButtonIndex` for `did_they_scan_no` and `cancelButtonIndex` last. Android: `showAlert` with the same options stacked (AlertCard already stacks 3+). Title `t('did_they_scan_title')`. Options in this order: `did_they_scan_no` (destructive), `did_they_scan_yes`, `did_they_scan_unsure`, then Cancel. Map `no` → `exitSendQrChoice('no')` → abort; `yes`/`unsure` → hold; cancel → stay on `send_qr`.

Pure test for the option-order helper:

```ts
export function choiceSheetOrder(options: { key: string; destructive?: boolean }[], cancelKey = 'cancel') {
  const destructive = options.filter(o => o.destructive)
  const rest = options.filter(o => !o.destructive)
  return [...destructive, ...rest, { key: cancelKey }]
}
```

`choiceSheetOrder([{ key: 'abort', destructive: true }, { key: 'hold' }])` → `abort`, `hold`, `cancel`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts packages/expo-wallet-toolbox/__tests__/localpay/build.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/components/ui/ChoiceSheet.ts \
        packages/expo-wallet-toolbox/ui/index.ts \
        packages/expo-wallet-toolbox/__tests__/ui/choiceSheet.test.ts \
        packages/expo-wallet-toolbox/core/localpay/pending.ts \
        packages/expo-wallet-toolbox/core/localpay/sessionPolicy.ts \
        packages/expo-wallet-toolbox/core/localpay/build.ts \
        packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx \
        packages/expo-wallet-toolbox/__tests__/localpay/pending.test.ts \
        packages/expo-wallet-toolbox/__tests__/localpay/sessionPolicy.test.ts \
        packages/expo-wallet-toolbox/__tests__/localpay/build.test.ts \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "$(cat <<'EOF'
fix(pay): persist nearby frames on Done and quarantine corrupt pending JSON

Online Done discarded the only copy of the derivation nonces. A
truncated pending blob was read as empty and then overwritten.
EOF
)"
```

---

### Task 10: P0 copy and HandleSend Retry/Cancel affordances

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx` (`canSend` notice; Retry when `!client`; `handleDismiss`)
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/useIdentitySearch.ts:76-90`
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`

**Interfaces:**
- Consumes: Task 2 `unsentEntries`; Task 5 `delivering`.
- Produces: when `unsent.length > 0` and the form is otherwise valid, render `t('finish_or_cancel_outgoing')` above the Send CTA. When Retry is tapped with no client, `setShowConfig(true)` and toast `t('message_box_unreachable')` — do not `return` silently. Identity search catch sets an error flag, not `[]` pretending to be “no matches”.

- [ ] **Step 1: Write the failing UI tests if a pattern exists**

`packages/expo-wallet-toolbox/__tests__/ui/payFormComponents.test.tsx` — add a case only if HandleSend is mounted there. If it is mocked (PayScreen tests mock `HandleSend`), put the identity-search test in a new `packages/expo-wallet-toolbox/__tests__/pay/useIdentitySearch.test.ts` by exporting a tiny `searchErrorFrom(e: unknown): 'unavailable' | 'none'`.

```ts
export function identitySearchOutcome(results: unknown[] | 'throw'): 'unavailable' | 'empty' {
  return results === 'throw' ? 'unavailable' : results.length === 0 ? 'empty' : 'empty'
}
```

Better:

```ts
export function classifyIdentitySearchError(e: unknown): boolean {
  return true // any throw from the overlay lookup is an outage, not “no such person”
}
```

Test: `classifyIdentitySearchError(new Error('timeout')) === true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/useIdentitySearch.test.ts --no-coverage`

Expected: FAIL until the helper exists.

- [ ] **Step 3: Write minimal implementation**

`useIdentitySearch.ts`: on catch, `setSearchError(true)` and `setSearchResults([])`. Render `ResultBanner` with `t('identity_search_unavailable')` when `searchError`.

HandleSend Retry: `if (!client || !storage) { config.open(); showToast(t('message_box_unreachable')); return }`. Optional: construct a client from `entry.messageBoxUrl` when the live client is null but the URL is a usable host — if `makePeerPayClient` is already a local helper, call it; if not, skip host fallback to P3 and only fix the silent return.

i18n: `finish_or_cancel_outgoing`, `identity_search_unavailable`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/useIdentitySearch.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx \
        packages/expo-wallet-toolbox/ui/components/pay/useIdentitySearch.ts \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx \
        packages/expo-wallet-toolbox/__tests__/pay/useIdentitySearch.test.ts
git commit -m "$(cat <<'EOF'
fix(pay): explain a blocked Send and a dead identity search

A stuck outbox disabled Send with no copy. A lookup outage looked
like the recipient did not exist.
EOF
)"
```

P0 is mergeable here.

---

# Phase P1 — The resend loop

Depends on P0 Tasks 2, 6, 7 (`payment_control` send + retained outbox).

---

### Task 11: Rebuild a PeerPay token from storage

**Files:**
- Create: `packages/expo-wallet-toolbox/core/peerpay/rebuildToken.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/rebuildToken.test.ts`

**Interfaces:**
- Consumes: `listActions` rows with `txid`, `outputs[].customInstructions`, recipient identity key, `refetchAtomicBeef`.
- Produces:

```ts
export function instructionsFromOutput(customInstructions: unknown): {
  derivationPrefix: string
  derivationSuffix: string
} | undefined

export async function rebuildPeerPayToken(args: {
  action: { txid?: string; outputs?: { customInstructions?: string | object }[] }
  recipient: string
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<{ token: OutboxEntry['token']; recipient: string } | undefined>
```

- [ ] **Step 1: Write the failing test**

```ts
import { instructionsFromOutput, rebuildPeerPayToken } from '../../core/peerpay/rebuildToken'

describe('instructionsFromOutput', () => {
  it('reads the JSON the send path writes', () => {
    expect(
      instructionsFromOutput(JSON.stringify({ derivationPrefix: 'p', derivationSuffix: 's', type: 'BRC29' }))
    ).toEqual({ derivationPrefix: 'p', derivationSuffix: 's' })
  })
})

describe('rebuildPeerPayToken', () => {
  it('rebuilds a token with a fresh AtomicBEEF', async () => {
    const beef = [9, 9, 9]
    const result = await rebuildPeerPayToken({
      action: {
        txid: 'aa',
        outputs: [{ customInstructions: JSON.stringify({ derivationPrefix: 'p', derivationSuffix: 's', type: 'BRC29' }) }]
      },
      recipient: '02aa',
      refetch: async () => beef
    })
    expect(result?.token.transaction).toEqual(beef)
    expect(result?.token.customInstructions).toEqual({ derivationPrefix: 'p', derivationSuffix: 's' })
    expect(result?.recipient).toBe('02aa')
  })

  it('returns undefined when the beef cannot be refetched', async () => {
    const result = await rebuildPeerPayToken({
      action: { txid: 'aa', outputs: [{ customInstructions: JSON.stringify({ derivationPrefix: 'p', derivationSuffix: 's' }) }] },
      recipient: '02aa',
      refetch: async () => undefined
    })
    expect(result).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/rebuildToken.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Parse `customInstructions` as JSON if it is a string. Require prefix/suffix strings. Call `refetch(txid)`; if missing, undefined. Amount: leave `token.amount` as `0` here if the action does not carry satoshis — the receive side uses Task 1 (`satoshisFromToken`) anyway. If the action has an outputs satoshis field, copy it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/rebuildToken.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/peerpay/rebuildToken.ts \
        packages/expo-wallet-toolbox/__tests__/pay/rebuildToken.test.ts
git commit -m "feat(pay): rebuild a PeerPay token from customInstructions and a fresh BEEF"
```

---

### Task 12: Sender consumes `resend_request` and re-delivers

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/peerpay/control.ts` — add `listControlMessages`, `ackControlMessages`
- Create: `packages/expo-wallet-toolbox/core/peerpay/handleResendRequests.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts`
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx` — banner + Resend
- Modify: `packages/expo-wallet-toolbox/ui/components/wallet/ActivityRow.tsx` — “Send the payment details again”

**Interfaces:**
- Consumes: Task 11 `rebuildPeerPayToken`; `sendMessage` to `payment_inbox`; outbox `recipient` / `txid`.
- Produces:

```ts
export async function handleResendRequests(args: {
  client: { listMessages(...); sendMessage(...); acknowledgeMessage(...) }
  storage: StorageLike
  listPeerPayAction: (txid: string) => Promise<{ txid?: string; outputs?: ... } | undefined>
  refetch: (txid: string) => Promise<number[] | undefined>
}): Promise<{ resent: number; pending: { txid: string; sender: string }[] }>
```

For each parsed `resend_request`: resolve recipient from matching outbox entry (`txid` or `token` lookup) else from the action labels. Rebuild, `sendMessage` to `PAYMENT_INBOX`, ack the control message only after send succeeds. Failures stay pending for the UI.

- [ ] **Step 1: Write the failing test**

```ts
it('re-delivers a rebuilt token and acks the control message', async () => {
  const sendMessage = jest.fn().mockResolvedValue(undefined)
  const acknowledgeMessage = jest.fn().mockResolvedValue(undefined)
  const client = {
    listMessages: jest.fn().mockResolvedValue([
      {
        messageId: 'c1',
        sender: '02bb',
        body: { type: 'resend_request', txid: 'aa', reason: 'corrupt' }
      }
    ]),
    sendMessage,
    acknowledgeMessage
  }
  const storage = fakeStorage()
  await saveOutboxEntry(storage, {
    recipient: '02bb',
    token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1], amount: 5 },
    messageBoxUrl: 'https://mb',
    txid: 'aa'
  })
  const r = await handleResendRequests({
    client: client as never,
    storage,
    listPeerPayAction: async () => undefined,
    refetch: async () => [8, 8, 8]
  })
  expect(r.resent).toBe(1)
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ messageBox: 'payment_inbox', recipient: '02bb' }))
  expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['c1'] })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement `handleResendRequests`. Home: if `pending.length` or a stored “unanswered resend” count > 0, an **inline** `ListRow` `t('resend_requested')` with trailing `t('resend')`. Tap Resend runs this function; the button shows an in-control spinner and `t('resending')` until it finishes (`haptics.success` on success, `showToast` + `haptics.error` on failure). Do not pop an alert on home focus. Activity row for a `peerpay` labeled outbound tx: chip `t('send_payment_details_again')` that rebuilds and sends without waiting for a NACK.

Wire a poll: for P1 it is acceptable to call `handleResendRequests` from `HandleSend` load and WalletHome focus. P3 moves it into `TaskDrainOutbox` / `TaskCreditInbox`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/peerpay/control.ts \
        packages/expo-wallet-toolbox/core/peerpay/handleResendRequests.ts \
        packages/expo-wallet-toolbox/__tests__/pay/handleResendRequests.test.ts \
        packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx \
        packages/expo-wallet-toolbox/ui/components/wallet/ActivityRow.tsx \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "feat(pay): re-deliver a payment token when the recipient asks"
```

---

### Task 13: Auto-NACK on exhausted / double-spent credits; status-aware Discard copy

**Files:**
- Create: `packages/expo-wallet-toolbox/core/pay/creditErrors.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`autoAcceptInbox` to accept a classifier that can skip increment)
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx`

**Interfaces:**
- Produces:

```ts
export type CreditFailureKind = 'environmental' | 'double_spend' | 'structural'
export function classifyCreditError(e: unknown, ctx?: { lastMissHeight?: number; offline?: boolean }): CreditFailureKind
```

Rules (string match on `e.message`, unanchored):
- `double_spend` if `/invalid status failed|doubleSpend|double.?spend/i`
- `environmental` if `ctx.lastMissHeight != null` OR `ctx.offline` OR `/network request failed|timed? ?out|chaintracks|valid AtomicBEEF/i` while offline or lastMissHeight set. AtomicBEEF while online with no lastMissHeight is **structural** (bad ancestry) unless `lastMissHeight` is set.
- else `structural`

`autoAcceptInbox`: add optional `classify` and `onGiveUp(payment, kind)`. Environmental: record error text but **do not** increment `attempts` (keep attempts unchanged, or store `attempts` and a `kind` so `needsAttention` stays false). Double-spend and structural still increment. When `needsAttention` becomes true, `onGiveUp` fires — HandleReceive sends `resend_request` with the matching reason (`double_spent` / `uncreditible`) **without** acking.

Discard confirm copy: if last kind is `double_spend`, `t('discard_void_payment')` (“This payment was cancelled or double-spent — it is safe to dismiss”); else keep the existing abandoning-money warning.

- [ ] **Step 1: Write the failing test**

```ts
import { classifyCreditError } from '../../core/pay/creditErrors'

describe('classifyCreditError', () => {
  it('classifies a failed-status internalize as double_spend', () => {
    expect(classifyCreditError(new Error('target transaction of internalizeAction has invalid status failed.'))).toBe(
      'double_spend'
    )
  })
  it('classifies AtomicBEEF while headers missed as environmental', () => {
    expect(classifyCreditError(new Error('The tx parameter must be valid AtomicBEEF'), { lastMissHeight: 900000 })).toBe(
      'environmental'
    )
  })
  it('classifies a missing derivation as structural', () => {
    expect(classifyCreditError(new Error("Cannot read property 'derivationPrefix' of undefined"))).toBe('structural')
  })
})
```

Extend `handleInbox.test.ts`: environmental failures do not reach `MAX_AUTO_ATTEMPTS` across two polls.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement classifier. Thread `lastMissHeight` from `OfflineFirstChaintracks` into the accept catch in HandleReceive (the instance is on WalletContext — read how HandleReceive gets wallet/services; pass a getter if the chaintracks object is already on context, otherwise pass `getOnline()` from `useOnline` and treat AtomicBEEF + offline as environmental).

Call `sendControlMessage` from `onGiveUp`. Do not ack.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/creditErrors.ts \
        packages/expo-wallet-toolbox/core/pay/rails/handle.ts \
        packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx \
        packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts \
        packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "feat(pay): auto-NACK structural failures and stop burning retries on the network"
```

---

### Task 14: Nearby rejected payments — Request again + dismiss

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/storage/methods/offlineActions.ts` — allow status `acknowledged`
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/OfflineNotice.tsx`
- Modify: `packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx`
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx` — mount a compact OfflineNotice
- Test: `packages/expo-wallet-toolbox/__tests__/ui/offlineNotice.test.tsx`

**Interfaces:**
- Consumes: `senderIdentityKey` on rejected received rows; Task 7 `sendControlMessage`.
- Produces: on rejected received row with `senderIdentityKey`, auto-send `{ type: 'resend_request', txid, reason: 'bounced_offline' }` once (record `nackSentAt` in a KV map `offline_nacks` keyed by txid so we do not spam). Buttons: Request again (re-sends), Copy details, Dismiss (`status: 'acknowledged'`). Rejected sent row: Send again prefills `/pay` with amount (from the row / tx) and Dismiss. Home screen renders the same notice the `/pay` grid does.

- [ ] **Step 1: Write the failing test**

Extend `offlineNotice.test.tsx`: rejected received card exposes a `Request again` press target (getByText / accessibility). If the component currently has no buttons, this fails.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui/offlineNotice.test.tsx --no-coverage`

Expected: FAIL — no Request again.

- [ ] **Step 3: Write minimal implementation**

Add buttons and callbacks to `OfflineNotice` props rather than importing WalletContext inside the presentational component if tests currently pass props. Follow the existing test’s render helper. Buttons are `PressableScale`, ≥ 44×44, labels `t('request_again')` / `t('send_again')` / `t('cancel')` for dismiss (use `t('done')` only if the action is purely informational). Dismiss of a rejected row is not destructive — it archives, it does not spend. Do not wrap the banner in `showAlert` on mount.

Update `findOfflineActions` callers that filter `['queued','posting','rejected']` to still show rejected until acknowledged; `acknowledged` is hidden.

i18n: `request_again`, `payment_bounced_resend`, `dismiss_rejected_payment`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui/offlineNotice.test.tsx --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/components/pay/OfflineNotice.tsx \
        packages/expo-wallet-toolbox/ui/screens/PayScreen.tsx \
        packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx \
        packages/expo-wallet-toolbox/core/storage/methods/offlineActions.ts \
        packages/expo-wallet-toolbox/__tests__/ui/offlineNotice.test.tsx \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "feat(pay): let a bounced nearby payment request a resend and leave the home screen"
```

---

### Task 15: Cancel vs Abandon on delivered outbox entries; `payment_cancelled`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/handle.ts` (`cancelOutboxPayment`)
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts`

**Interfaces:**
- Consumes: Task 5 `delivering`; Task 7 `sendControlMessage`.
- Produces: `cancelOutboxPayment` grows `mode: 'undelivered' | 'abandon'`. `undelivered` (not delivering, not delivered) aborts + removes. `abandon` (delivered or delivering) sends `payment_cancelled` to `entry.recipient`, then aborts if still nosend, then removes. HandleSend: a delivered/delivering row’s Cancel control opens `showChoiceSheet` (HIG: choices related to an intentional Cancel) with `abandon_payment` (destructive, first), `finish_payment`, then Cancel. Finish calls `retryDelivery`. Abandon then `showAlert` only if you still want a second confirm — do **not**: the action sheet is the confirmation. Undelivered Cancel stays a single `showAlert` (“Cancel this payment?” / Cancel + Cancel payment destructive) because it is one irreversible abort, not a menu of choices.

- [ ] **Step 1: Write the failing test**

```ts
it('abandon of a delivered entry sends payment_cancelled', async () => {
  const s = fakeStorage()
  const sendMessage = jest.fn().mockResolvedValue(undefined)
  const w = fakeWallet()
  w.abortAction = jest.fn().mockResolvedValue({ aborted: true })
  w.listActions = jest.fn().mockResolvedValue({ actions: [{ txid: 'aa', reference: 'r' }] })
  const id = await saveOutboxEntry(s, {
    recipient: KEY,
    token: { customInstructions: { derivationPrefix: 'p', derivationSuffix: 's' }, transaction: [1], amount: 1 },
    messageBoxUrl: 'https://mb',
    txid: 'aa'
  })
  await updateOutboxEntry(s, id, { delivered: true })
  const entry = (await getOutboxEntries(s))[0]
  await cancelOutboxPayment({
    wallet: w as never,
    adminOriginator: 'admin.com',
    storage: s,
    entry,
    client: { sendMessage } as never,
    mode: 'abandon'
  })
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    messageBox: 'payment_control',
    recipient: KEY
  }))
  expect(JSON.parse(sendMessage.mock.calls[0][0].body).type).toBe('payment_cancelled')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts -t 'abandon of a delivered' --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Thread `client` and `mode` into `cancelOutboxPayment`. HandleSend Cancel on delivered/delivering rows calls `showChoiceSheet` as specified above. Labels from spec §11.5. Buttons ≥ 44×44 via the existing outgoing-card `PressableScale`s. While `retryDelivery` runs, the Finish path uses an in-button spinner and `t('resending')`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/handle.ts \
        packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx \
        packages/expo-wallet-toolbox/__tests__/pay/handleRail.test.ts \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "fix(pay): abandoning a delivered payment tells the recipient it was cancelled"
```

P1 is mergeable here.

---

# Phase P2 — Check Wallet

Storage tasks may land in parallel with P0/P1. The screen waits for Tasks 16–17.

---

### Task 16: `outputs.spentBy: undefined` writes SQL NULL

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts` (`sqlUpdate` ~503–527, `updateOutput` ~735)
- Create: `packages/expo-wallet-toolbox/core/storage/sqlUpdateValue.ts` — pure mapper so Jest does not need Expo SQLite
- Test: `packages/expo-wallet-toolbox/__tests__/storage/sqlUpdateValue.test.ts`

**Interfaces:**
- Produces: `sqlBindValue(table: string, column: string, value: unknown): { omit: true } | { omit: false; value: unknown }`
  - default: `undefined` → `{ omit: true }` (today’s skip)
  - `table === 'outputs' && column === 'spentBy' && value === undefined` → `{ omit: false, value: null }`

- [ ] **Step 1: Write the failing test**

```ts
import { sqlBindValue } from '../../core/storage/sqlUpdateValue'

describe('sqlBindValue', () => {
  it('clears outputs.spentBy when the caller passes undefined', () => {
    expect(sqlBindValue('outputs', 'spentBy', undefined)).toEqual({ omit: false, value: null })
  })
  it('still skips undefined on other columns', () => {
    expect(sqlBindValue('outputs', 'spendable', undefined)).toEqual({ omit: true })
    expect(sqlBindValue('transactions', 'status', undefined)).toEqual({ omit: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/sqlUpdateValue.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement `sqlBindValue`. In `sqlUpdate` and `sqlUpdateComposite`, replace the `value !== undefined` skip with `sqlBindValue(table, key, value)`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/sqlUpdateValue.test.ts packages/expo-wallet-toolbox/__tests__/storage/releaseStranded.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/storage/sqlUpdateValue.ts \
        packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts \
        packages/expo-wallet-toolbox/__tests__/storage/sqlUpdateValue.test.ts
git commit -m "fix(storage): write NULL when clearing outputs.spentBy

Skipping undefined left released inputs looking like double-spends."
```

---

### Task 17: Implement `reviewStatus` in SQL

**Files:**
- Create: `packages/expo-wallet-toolbox/core/storage/methods/reviewStatusSql.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts:1645-1647`

**Interfaces:**
- Consumes: IDB three rules (`node_modules/@bsv/wallet-toolbox-client/out/src/storage/methods/reviewStatusIdb.js`).
- Produces: `reviewStatusOnDb(db, { skipTxids: Set<string> }): { log: string }` using the same `node:sqlite` style as `releaseStranded.test.ts`.
- `StorageExpoSQLite.reviewStatus` loads skip txids from `offline_actions` where status in (`queued`,`posting`), then runs the helper (via `updateTransactionStatus` for rule 1 so hooks run — if calling hooks from SQL-only is too heavy in unit tests, the helper performs the three SQL updates and the class method wraps rule 1 in `updateTransactionStatus` per id).

Rule 1 SQL (for the unit test db):

```sql
SELECT t.transactionId, t.txid, t.status
FROM transactions t
JOIN proven_tx_reqs r ON r.txid = t.txid
WHERE r.status = 'invalid' AND t.status <> 'failed'
```

Then `UPDATE transactions SET status = 'failed' WHERE transactionId = ?` for each, unless txid is in `skipTxids`.

Rule 2/3: port `collectFailedTransactionIds` logic in JS over `SELECT`s, then `UPDATE outputs SET spendable = 1, spentBy = NULL WHERE outputId = ?` / `spendable = 0, spentBy = NULL`. Safe failed = failed tx whose reqs are all `invalid` or `doubleSpend` (or no req).

- [ ] **Step 1: Write the failing test**

Seed: tx 1 unproven + req invalid; output A generated by tx 1 spendable=1; output B spendable=0 spentBy=1 (input allocated to tx 1). After `reviewStatusOnDb`: tx 1 failed; A spendable=0 spentBy NULL; B spendable=1 spentBy NULL.

Seed 2: same but `offline_actions` queued for that txid → no changes.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement helper + replace the stub. Do not implement `purgeData` in this task.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/storage/methods/reviewStatusSql.ts \
        packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts \
        packages/expo-wallet-toolbox/__tests__/storage/reviewStatusSql.test.ts
git commit -m "fix(storage): implement reviewStatus so invalid reqs fail their transactions"
```

---

### Task 18: `runWalletCheck` orchestration (queue-safe)

**Files:**
- Create: `packages/expo-wallet-toolbox/core/walletRepair/runWalletCheck.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts`

**Interfaces:**
- Consumes: injected ports so Jest does not boot a wallet.

```ts
export type WalletCheckStepId =
  | 'coins'
  | 'proofs'
  | 'records'
  | 'missed_payments'

export interface WalletCheckPorts {
  reviewSpendable: () => Promise<{ released: number; recovered: number }>
  checkProofs: () => Promise<{ repaired: number }>
  reviewStatus: () => Promise<{ failedTxs: number; restoredInputs: number }>
  releaseStuck: () => Promise<{ released: number }>
  creditInbox: () => Promise<{ accepted: number }>
  sweepAddresses: () => Promise<{ imported: number }>
}

export async function runWalletCheck(
  ports: WalletCheckPorts,
  onStep: (id: WalletCheckStepId) => void
): Promise<{
  freedCoins: number
  recoveredPayments: number
  repairedProofs: number
}>
```

Order: records (`reviewStatus` then `releaseStuck`) → coins → proofs → missed_payments. Sums feed the Done copy.

- [ ] **Step 1: Write the failing test**

```ts
it('runs records, coins, proofs, missed_payments in that order', async () => {
  const order: string[] = []
  const ports: WalletCheckPorts = {
    reviewSpendable: async () => (order.push('coins'), { released: 2, recovered: 0 }),
    checkProofs: async () => (order.push('proofs'), { repaired: 1 }),
    reviewStatus: async () => (order.push('records-status'), { failedTxs: 1, restoredInputs: 1 }),
    releaseStuck: async () => (order.push('records-release'), { released: 0 }),
    creditInbox: async () => (order.push('inbox'), { accepted: 1 }),
    sweepAddresses: async () => (order.push('sweep'), { imported: 0 })
  }
  const steps: string[] = []
  const summary = await runWalletCheck(ports, id => steps.push(id))
  expect(order).toEqual(['records-status', 'records-release', 'coins', 'proofs', 'inbox', 'sweep'])
  expect(summary.freedCoins).toBe(3) // 2 released UTXOs + 1 restored input
  expect(summary.recoveredPayments).toBe(1)
  expect(summary.repairedProofs).toBe(1)
})
```

Adjust the freedCoins rule to whatever the implementation documents; pick one and test it: **freedCoins = reviewSpendable.released + releaseStuck.released + reviewStatus.restoredInputs**.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement `runWalletCheck` with that order (records first because phantom spendable outputs poison later sends).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/walletRepair/runWalletCheck.ts \
        packages/expo-wallet-toolbox/__tests__/walletRepair/runWalletCheck.test.ts
git commit -m "feat(wallet): ordered Check-my-wallet repair steps"
```

---

### Task 19: Check Wallet screen + Settings row + post-restore pass

**Files:**
- Create: `packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx`
- Create: `app/wallet-check.tsx` (re-export the screen, same pattern as `app/logs.tsx`)
- Modify: `app/_layout.tsx` — register `wallet-check`
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx` — row above Debugging
- Modify: `packages/expo-wallet-toolbox/core/backup/restoreOnImport.ts` — after success, call a port `validateRestoredCoins?: () => Promise<void>`
- Test: `packages/expo-wallet-toolbox/__tests__/backup/restoreOnImport.test.ts` (assert the port is invoked)

**Interfaces:**
- Consumes: Task 18 `runWalletCheck`; existing `checkUtxoSpendability`, `releaseStuckReservations`, `runMonitorTask`. Inbox credit in this screen calls a port that P3’s `creditInboxOnce` will own — for P2 pass a lambda that uses the same `listIncomingPayments` + `autoAcceptInbox` HandleReceive already has, inlined in the ports hook. Do not import `HandleReceive.tsx` from the screen.
- Produces: Settings `GroupedSection` + `ListRow` labelled `t('check_wallet')` with subtitle `t('check_wallet_subtitle')`, placed with other general tools, **not** inside Debugging. Chevron. Pushed stack screen (`router.push('/wallet-check')`), not a sheet (HIG: prolonged multi-step work is a destination).
- Screen: large title Check Wallet. Determinate progress — four labeled steps matching Task 18 ids (`Checking coins…`, `Checking proofs…`, `Repairing records…`, `Looking for missed payments…`). A bar or “1 of 4”, never an unlabeled spinner and never a spinner that morphs into a bar. Back always works. Done copy: `t('wallet_check_ok')` or `t('wallet_check_summary', { freed, recovered })`. `haptics.success` on completion. Do not mount `Celebration`.
- Produces: `restoreOnImport` invokes `validateRestoredCoins` when provided. WalletContext passes `() => wallet.reviewSpendableOutputs(false, true)` (or specOpInvalidChange with `['release']` through permissionsManager — match how balance already calls spec ops).

- [ ] **Step 1: Write the failing restore test**

In `restoreOnImport.test.ts` add a case: `validateRestoredCoins` is awaited before the function resolves. If the current tests stub restore, follow their harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/backup/restoreOnImport.test.ts --no-coverage`

Expected: FAIL — extra port ignored.

- [ ] **Step 3: Write minimal implementation**

Add the screen (plain language only: no txids, no “BEEF”). Wire the route. Call `runWalletCheck` with ports that wrap the existing WalletContext methods — inject via props or a thin `useWalletCheckPorts()` hook that reads context.

Contextual: in AddressSend / HandleSend catch, if `/WERR_REVIEW_ACTIONS|review actions/i.test(message)`, `showAlert` with title that names the situation, message that says coins look stuck, buttons Cancel + `t('check_wallet')` (default, not destructive). Choosing Check Wallet `router.push('/wallet-check')`. Do not toast this — the problem is still true after a toast.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/backup/restoreOnImport.test.ts --no-coverage`

Expected: PASS. Also open the new route in the app if a simulator is already running; if not, rely on tests.

- [ ] **Step 5: Commit**

```bash
git add app/wallet-check.tsx app/_layout.tsx \
        packages/expo-wallet-toolbox/ui/screens/WalletCheckScreen.tsx \
        packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx \
        packages/expo-wallet-toolbox/core/backup/restoreOnImport.ts \
        packages/expo-wallet-toolbox/__tests__/backup/restoreOnImport.test.ts \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "feat(wallet): Check Wallet in Settings and after restore"
```

---

### Task 20: Address-rail sweep isolation, TTL, and repair lookback

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/pay/rails/address.ts` (`sweepAddress` fetch ~229)
- Modify: `packages/expo-wallet-toolbox/core/pay/sweeper.ts` (`touchWatched` ~62)
- Modify: `packages/expo-wallet-toolbox/core/pay/watchlist.ts` (`WATCH_TTL_MS`)
- Test: `packages/expo-wallet-toolbox/__tests__/pay/sweeper.test.ts`, `watchlist.test.ts`, `addressRail.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/walletRepair/runWalletCheck.ts` — `sweepAddresses` port already exists; WalletCheck ports implementation sweeps `MAX_RECOVERY_DAYS`

**Interfaces:**
- Produces: `parseWocBeefBody(resp: { ok: boolean; text: string }): number[] | undefined` — `ok`, even-length hex only. One UTXO failure does not skip siblings.
- Produces: `touchWatched` when the address had on-chain UTXOs even if import failed.
- Produces: never-swept addresses live `MAX_WATCH_DAYS` (7d), not 24h. `WATCH_TTL_MS` for *successfully imported* activity may stay 24h if that is still desired — spec says keep never-swept for 7 days. Implement `WATCH_UNSWEPT_TTL_MS = MAX_WATCH_DAYS * 86400000`.

- [ ] **Step 1: Write the failing tests**

Add to `addressRail.test.ts` / a new `parseWocBeefBody` test: `ok: false` → undefined; prose body → undefined; even hex → bytes.

`watchlist.test.ts`: an address never touched stays until 7 days.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/watchlist.test.ts packages/expo-wallet-toolbox/__tests__/pay/addressRail.test.ts --no-coverage`

Expected: FAIL on TTL / parse.

- [ ] **Step 3: Write minimal implementation**

Use `parseWocBeefBody` in `sweepAddress`. Isolate per UTXO in a loop with try/catch. `sweeper.ts`: if `foundOnChain && importedSatoshis === 0`, still `touchWatched`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/pay/watchlist.test.ts packages/expo-wallet-toolbox/__tests__/pay/sweeper.test.ts packages/expo-wallet-toolbox/__tests__/pay/addressRail.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/pay/rails/address.ts \
        packages/expo-wallet-toolbox/core/pay/sweeper.ts \
        packages/expo-wallet-toolbox/core/pay/watchlist.ts \
        packages/expo-wallet-toolbox/__tests__/pay/watchlist.test.ts \
        packages/expo-wallet-toolbox/__tests__/pay/sweeper.test.ts \
        packages/expo-wallet-toolbox/__tests__/pay/addressRail.test.ts
git commit -m "fix(pay): do not drop a funded address because one BEEF fetch failed"
```

P2 is mergeable here.

---

# Phase P3 — Always-on recovery and chain-state

Depends on P1 (credit/NACK helpers) and P2 (`reviewStatus` for TaskReviewStatus to matter).

---

### Task 21: `TaskCreditInbox` and `TaskDrainOutbox`

**Files:**
- Create: `packages/expo-wallet-toolbox/core/monitor/TaskCreditInbox.ts`
- Create: `packages/expo-wallet-toolbox/core/monitor/TaskDrainOutbox.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/monitor/taskCreditInbox.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/monitor/taskDrainOutbox.test.ts`
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` (~1186) — `monitor.addTask` next to `TaskSendOffline`
- Create: `packages/expo-wallet-toolbox/core/pay/creditInbox.ts` — extract `creditInboxOnce` used by HandleReceive and the task (HandleReceive becomes a view on the same function)

**Interfaces:**
- Mirror `TaskSendOffline`: static `checkNow`, `onlineNow`, `noteConnectivity`, `requestNow`, `resetForTests`, backoff 10s → 5 min.
- `TaskCreditInbox` run: if online, list + damaged diff + `autoAcceptInbox` + persist attempts under `peerpay_inbox_attempts`. Store `static lastAttentionCount`.
- `TaskDrainOutbox` run: if online, `unsentEntries` → `retryDelivery` per entry, stop after first thrown error (next backoff). Delivery is idempotent.

HandleReceive poll may stay as a faster 5s loop while focused; it must call the same `creditInboxOnce` and the same mutex (`acceptingRef` lives in the shared module as a module-level lock).

Persist attempts: `loadInboxAttempts(storage)` / `saveInboxAttempts(storage, map)` in `core/peerpay/inboxAttempts.ts`.

- [ ] **Step 1: Write the failing tests**

Follow `packages/expo-wallet-toolbox/__tests__/monitor/taskSendOffline.test.ts` structure: fake monitor, inject `release`/`credit` functions, assert `trigger` respects online + backoff, `runTask` calls the port.

Inbox attempts:

```ts
it('round-trips attempts through KV', async () => {
  const s = fakeStorage()
  await saveInboxAttempts(s, { m1: { attempts: 2, error: 'x' } })
  expect(await loadInboxAttempts(s)).toEqual({ m1: { attempts: 2, error: 'x' } })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/monitor/taskCreditInbox.test.ts packages/expo-wallet-toolbox/__tests__/monitor/taskDrainOutbox.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Copy `TaskSendOffline`’s trigger machinery. Register both tasks in WalletContext when `phoneStorage` exists. On app foreground / connectivity, `TaskCreditInbox.noteConnectivity` / `requestNow` same as SendOffline.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/monitor/taskCreditInbox.test.ts packages/expo-wallet-toolbox/__tests__/monitor/taskDrainOutbox.test.ts packages/expo-wallet-toolbox/__tests__/monitor/taskSendOffline.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/monitor/TaskCreditInbox.ts \
        packages/expo-wallet-toolbox/core/monitor/TaskDrainOutbox.ts \
        packages/expo-wallet-toolbox/core/pay/creditInbox.ts \
        packages/expo-wallet-toolbox/core/peerpay/inboxAttempts.ts \
        packages/expo-wallet-toolbox/core/context/WalletContext.tsx \
        packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx \
        packages/expo-wallet-toolbox/__tests__/monitor/
git commit -m "feat(pay): credit the inbox and drain the outbox in the background"
```

---

### Task 22: Home-screen badges and remaining stuck-work UI

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx`
- Modify: `packages/expo-wallet-toolbox/ui/components/wallet/ActivityRow.tsx` — Send again on failed outbound
- Modify: `packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx` abort toast (`aborted: false`)
- Modify: `app/settings.tsx` — `router.replace('/')`
- Test: extend `packages/expo-wallet-toolbox/__tests__/ui/payScreen.test.tsx` only if home tests exist; otherwise a small `walletHomeBadges.test.ts` for a pure `badgeModel`:

```ts
export function homeBadges(input: {
  attention: number
  unsent: number
  offlineQueued: number
  offlineRejected: number
}): { kind: 'attention' | 'unsent' | 'offline'; count: number }[]
```

**Interfaces:**
- Consumes: `TaskCreditInbox.lastAttentionCount`, `getOutboxEntries`, `offlineByTxid` (already fetched).
- Produces: **inline** rows above the activity list (HIG: do not alert when the app becomes active; insert into the current view). Each row is a `ListRow`/`PressableScale`, 44×44, verb title (`t('resend_requested')`, “2 payments need attention”), tap navigates. Not a fake numeric badge on a tab icon. Not `showAlert` on focus. OfflineNotice compact already mounted in Task 14 — keep one copy.

`fetchActions` wrap in try/catch, `setLoadError(true)`, empty state `t('activity_load_failed')` plus a control labelled `t('activity_load_retry')` (HIG empty states: next step + a button). Not an unlabeled spinner.

Receive `getPublicKey` `.catch` → error + retry on focus.

`retryDelivery` uses `entry.messageBoxUrl` when building a fallback client (now that P3 has time to wire `makePeerPayClient`).

Host mismatch: if `resolveHostForRecipient` returns the sender host and `queryAdvertisements` is empty, throw a typed error `recipient_host_unknown` before `sendMessage`; HandleSend maps it to `t('recipient_message_box_unknown')` and does **not** broadcast.

- [ ] **Step 1: Write the failing `homeBadges` test**

```ts
expect(homeBadges({ attention: 2, unsent: 0, offlineQueued: 1, offlineRejected: 0 })).toEqual([
  { kind: 'attention', count: 2 },
  { kind: 'offline', count: 1 }
])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui/homeBadges.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement `homeBadges` in `ui/screens/homeBadges.ts` and render from it. Redirect `app/settings.tsx`. Fix abort toast: `const r = await abortAction(...); if (!r || r.aborted === false) showToast(t('tx_abort_failed'))`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui/homeBadges.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx \
        packages/expo-wallet-toolbox/ui/screens/homeBadges.ts \
        packages/expo-wallet-toolbox/__tests__/ui/homeBadges.test.ts \
        app/settings.tsx \
        packages/expo-wallet-toolbox/ui/components/pay/HandleReceive.tsx \
        packages/expo-wallet-toolbox/ui/components/pay/HandleSend.tsx \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "feat(wallet): show stuck payments on the home screen"
```

---

### Task 23: Wire `TaskReorg` and a bounded proven-tx audit

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx:1153` and `:1272-1276`
- Test: `packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts` (extend) or a new `packages/expo-wallet-toolbox/__tests__/monitor/reorgWiring.test.ts` that tests a **pure** options helper:

```ts
export function monitorChaintracksArg(offlineFirst: object | undefined): object | undefined {
  return offlineFirst
}
export function shouldRemoveReviewProvenTxs(): false {
  return false
}
```

That is too cute. Instead extract `createWalletMonitor(args)` from WalletContext into `core/walletMonitor.ts` (file already exists — **read it** and extend).

**Interfaces:**
- Produces: `Monitor.createDefaultWalletMonitorOptions(walletChain, storageManager, services, offlineChaintracks)`.
- Produces: `await monitor.ready` before `startTasks` / `addDefaultTasks` as required so `_init` runs. Read `Monitor.js` `_init` — if `ready` is a getter returning a Promise, `await monitor.ready` once after `new Monitor`.
- Produces: **delete** the splice of `ReviewProvenTxs`. If a trigger-msecs patch is needed to bound work, patch `trigger` to no-op when the height span exceeds 100, matching TaskCheckForProofs patches already in WalletContext.

- [ ] **Step 1: Write the failing test**

Open `packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts` and `core/walletMonitor.ts`. Add an assertion on the exported factory: 4th argument is forwarded. If the factory does not exist, create `forwardMonitorOptions(chaintracks)` test first, then use it in WalletContext.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts --no-coverage`

Expected: FAIL or missing assertion.

- [ ] **Step 3: Write minimal implementation**

Pass `offlineChaintracks` into `createDefaultWalletMonitorOptions`. Await `ready`. Remove the ReviewProvenTxs splice and its comment (the comment’s premise is false).

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/context/WalletContext.tsx \
        packages/expo-wallet-toolbox/core/walletMonitor.ts \
        packages/expo-wallet-toolbox/__tests__/walletMonitor.test.ts
git commit -m "fix(wallet): subscribe TaskReorg and keep the proven-tx audit"
```

---

### Task 24: Header rewind, too-long `.bin` heal, `writeBytes`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/headers/fs.ts` — add `writeBytes(path, bytes)`
- Modify: `packages/expo-wallet-toolbox/core/headers/headerStore.ts` — `open` truncate; `rewind(n)` / `truncateToCount(count)`
- Modify: `packages/expo-wallet-toolbox/core/headers/syncHeaders.ts` — on linkage throw for the first header of a chunk, rewind and retry once; if cap (144) exceeded, `reset()`
- Test: `packages/expo-wallet-toolbox/__tests__/headers/headerStore.test.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/headers/syncHeaders.test.ts`

**Interfaces:**
- Produces: `HeaderFs.writeBytes`. `memoryHeaderFs` replaces the map entry. `expoHeaderFs` writes without `{ append: true }`.
- Produces: `open()` if `bin.length > meta.count * 80`, `writeBytes(bin.subarray(0, meta.count * 80))`.
- Produces: `truncateToCount(count: number)` rewrites `.bin` to `count * 80` bytes, rebuilds roots, updates meta. Used by rewind.

- [ ] **Step 1: Write the failing tests**

In `headerStore.test.ts`:

```ts
it('truncates a too-long bin to meta.count on open', async () => {
  const fs = memoryHeaderFs()
  const first = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
  await first.append(bytes(), 1)
  const bin = await fs.readBytes('ttn.bin')
  await fs.writeBytes?.('ttn.bin', new Uint8Array([...bin!, ...bin!.subarray(0, 80)]))
  // If writeBytes is new, use appendBytes to simulate crash-mid-append:
  await fs.appendBytes('ttn.bin', bin!.subarray(0, 80))
  const second = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
  expect(second.count).toBe(2)
  expect((await fs.readBytes('ttn.bin'))!.length).toBe(2 * 80)
})

it('rewind drops the orphaned tip so a new canonical header can append', async () => {
  const fs = memoryHeaderFs()
  const store = await HeaderStore.open(fs, 'ttn', TTN_ANCHOR)
  await store.append(bytes(), 1)
  await store.truncateToCount(1)
  expect(store.count).toBe(1)
  expect(store.tipHeight).toBe(1)
})
```

`bytes()` is the existing TTN_1_AND_2 fixture (2 headers). After truncateToCount(1), appending a header that links to header 1 should work — the second header in the fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/headers/headerStore.test.ts --no-coverage`

Expected: FAIL — too-long file is kept; no `truncateToCount`.

- [ ] **Step 3: Write minimal implementation**

Add `writeBytes` to both fs implementations. `open` truncates. `truncateToCount` slices roots and bin, `writeMeta`. `syncHeaders`: catch previous-hash error, `truncateToCount(store.count - 1)` in a loop up to 144, retry append; else `reset()`.

Also: `putExtraRoot` skip when `height > tipHeight - 6` (read tip from the store). `rootForHeight`: if `this.extra[String(height)]` exists, return it even for in-window heights.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/headers/headerStore.test.ts packages/expo-wallet-toolbox/__tests__/headers/syncHeaders.test.ts packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/headers/fs.ts \
        packages/expo-wallet-toolbox/core/headers/headerStore.ts \
        packages/expo-wallet-toolbox/core/headers/syncHeaders.ts \
        packages/expo-wallet-toolbox/__tests__/headers/
git commit -m "fix(headers): rewind an orphaned tip and truncate a crash-torn bin"
```

---

### Task 25: `refreshProof` verifies BUMPs and stores `blockHash`; `lastMissHeight` is read

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` `refreshProof` (~2046-2072)
- Modify: `packages/expo-wallet-toolbox/core/pay/creditErrors.ts` (call sites pass `takeLastMissHeight()`)
- Modify: `packages/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks.ts` — export a getter `takeLastMissHeight(): number | undefined` that reads and optionally clears
- Test: `packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts`

**Interfaces:**
- Produces: after `MerklePath.fromHex`, `await offlineChaintracks.isValidRootForHeight(merkleRoot, merklePath.blockHeight)` must be true or `refreshProof` returns `'pending'` without writing. `blockHash` from `headerStore` / `findHeaderForHeight`, not `''`.
- Produces: HandleReceive / `creditInboxOnce` calls `takeLastMissHeight()` in the catch and passes it into `classifyCreditError`.

- [ ] **Step 1: Write the failing test**

If `refreshProof` cannot be instantiated, extract:

```ts
export function provenTxWriteFromBump(args: {
  merkleRoot: string
  height: number
  blockHash: string
}): { blockHash: string } {
  if (!args.blockHash) throw new Error('blockHash required')
  return { blockHash: args.blockHash }
}
```

Prefer extracting the real write payload builder `provenTxFromBump({ merklePath, txid, headerHash })` and testing that `headerHash` is forwarded.

`takeLastMissHeight`: set `lastMissHeight` via a failed `isValidRootForHeight` in the existing offline chaintracks tests, then assert the getter returns it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts --no-coverage`

Expected: FAIL on missing getter.

- [ ] **Step 3: Write minimal implementation**

Add getter. Thread into credit path. Fill `blockHash` in `refreshProof` using the header store already on the WalletContext build (the same object passed to Monitor). If the hash is unavailable, skip the write and return `'pending'` rather than persisting `''`.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts packages/expo-wallet-toolbox/__tests__/pay/creditErrors.test.ts --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/context/WalletContext.tsx \
        packages/expo-wallet-toolbox/core/headers/OfflineFirstChaintracks.ts \
        packages/expo-wallet-toolbox/__tests__/headers/offlineChaintracks.test.ts
git commit -m "fix(wallet): verify refreshed proofs and stop storing an empty blockHash"
```

---

### Task 26: Offline drain vs `TaskSendWaiting`, stall repair, pending `tryProcess`, leftover polish

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts` (~1727) and/or WalletContext TaskSendWaiting patch — skip reqs whose inputs intersect queued offline txids
- Modify: `packages/expo-wallet-toolbox/core/storage/methods/processOfflineActions.ts` — before setting `stalledOn`, try `refetchAtomicBeef` for missing ancestors (inject fetch for tests if the function is extracted)
- Modify: `packages/expo-wallet-toolbox/core/context/WalletContext.tsx` `tryProcess` (~1738) — remove `getOnline()` early return
- Modify: `packages/expo-wallet-toolbox/ui/components/pay/NearbyFlow.tsx` — receipt `broadcast` from req status (`alreadySentStatuses` in `core/offline/plan.ts`)
- Modify: `packages/expo-wallet-toolbox/core/localpay/build.ts` — queue failed aborts to `pending_aborts` KV; replay on wallet build
- Test: `packages/expo-wallet-toolbox/__tests__/offline/plan.test.ts` (alreadySentStatuses)
- Test: new `packages/expo-wallet-toolbox/__tests__/storage/skipQueuedAncestors.test.ts` for the skip predicate:

```ts
export function shouldDeferSendWaiting(inputTxids: string[], queuedTxids: Set<string>): boolean {
  return inputTxids.some(id => queuedTxids.has(id))
}
```

**Interfaces:**
- Produces: `shouldDeferSendWaiting` used by the monitor patch. When true, `TaskSendOffline.requestNow()` and skip posting that req this pass.
- Produces: `tryProcess` runs offline. Pending failures surface through OfflineNotice (count of unprocessed KV entries) — add `getUnprocessed(storage).length` to the notice props.

- [ ] **Step 1: Write the failing tests**

```ts
expect(shouldDeferSendWaiting(['aa'], new Set(['aa']))).toBe(true)
expect(shouldDeferSendWaiting(['bb'], new Set(['aa']))).toBe(false)
```

Pending: a test that `tryProcess`’s gate function `canInternalizePending(online: boolean)` is `true` even when `online === false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/skipQueuedAncestors.test.ts --no-coverage`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Implement predicates, wire them, remove the online gate, map stall strings in OfflineNotice through i18n (`offline_stall_no_request`, `offline_stall_bad_beef`, `offline_stall_foreign_ancestor`) instead of raw txids. Keep a Copy TXID on the activity row as today.

Error translation: `core/pay/userError.ts` `userFacingPayError(e): { key: string; offerWalletCheck: boolean }` mapping `WERR_REVIEW_ACTIONS` → `{ key: 'error_review_actions', offerWalletCheck: true }`. Use in HandleSend, AddressSend, NearbyFlow failed screen, HandleReceive attention rows.

- [ ] **Step 4: Run tests**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/storage/skipQueuedAncestors.test.ts packages/expo-wallet-toolbox/__tests__/ui/offlineNotice.test.tsx --no-coverage`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts \
        packages/expo-wallet-toolbox/core/context/WalletContext.tsx \
        packages/expo-wallet-toolbox/core/pay/userError.ts \
        packages/expo-wallet-toolbox/ui/components/pay \
        packages/expo-wallet-toolbox/__tests__/storage/skipQueuedAncestors.test.ts \
        packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "fix(pay): do not post a child ahead of a queued parent, and translate engine errors"
```

---

## Self-review (planner)

**Spec coverage:** Every confirmed/partial finding in the spec’s §8 table has a task:

| Spec row | Tasks |
|---|---|
| P0 prune / broadcast / discard / damaged / amount / Refresh / nearby frame / pending / lastError / abort mint / delivering | 1–10 |
| P1 resend loop / NACK / double-spend / nearby request-again / rebuild / abandon | 11–15 |
| P2 reviewStatus / NULL / Check Wallet / restore / address sweep | 16–20 |
| P3 background credit/drain / badges / reorg / headers / proofs / stall / tryProcess / errors | 21–26 |

Refuted proof-provider finding: no task.

**Placeholders:** none intended. If an implementer finds a NearbyFlow symbol renamed, they read the current function (finalizeDelivery / onFrameScanned) rather than inventing a parallel path.

**Types:** `ResendReason`, `PaymentControlMessage`, `CreditFailureKind`, `SENT_RETENTION_MS`, `runWalletCheck` ports, `shouldFailUnprovenTx` are named once in P0/P1/P2 and reused later. `PAYMENT_INBOX` remains `'payment_inbox'`. `PAYMENT_CONTROL_BOX` is `'payment_control'`.

---

## Execution notes

Phase boundaries are PR boundaries (see the spec’s PR Plan). After P0, a user can still be stuck if they never reopen Get paid → handle — that is P3. After P1, resend works when both parties eventually open the app. After P2, a confused user has a button. After P3, the wallet works while they are on the home screen.

Do not implement P3 background tasks by calling `PeerPayClient.acceptPayment`.
