# Multi-profile Follow-ups Implementation Plan

> For agentic workers: implement task-by-task, TDD, one commit per task. Each task is followed by an independent review before the next starts.

**Goal:** per-profile backup preference, profile rename, zero-balance profile removal, and push notifications for every profile (server + app).

**Spec:** `docs/superpowers/specs/2026-10-01-multi-profile-followups-design.md`. Evidence for every touched site, with file:line, is in `docs/superpowers/research/2026-10-01-multi-profile-followups/`. Read the relevant report before starting a task.

## Global constraints

- Wallet repo: `/Users/personal/git/bsv-wallet`, branch `feat/multi-profile`. Code lives mostly in `packages/expo-wallet-toolbox`.
- Server repo: `/Users/personal/git/go/go-message-box-server`. New branch `feat/multi-identity-push` from `main`, in its own worktree at `/Users/personal/git/go/worktrees/mbs-multi-identity-push`. Never push and never open PRs.
- Run jest from the wallet repo root: `npx jest <path> --forceExit`. Typecheck with `npx tsc --noEmit -p .`. Both must stay clean.
  - For WalletContext provider tests that call rebuild/switch flows, use the two-act pattern from `__tests__/context/switchProfile.test.tsx`. A single act deadlocks against `waitForRebuild`.
- Every new user-facing string goes into all 12 locales in `core/i18n/translations.tsx` (parity test). Strings that are deliberately identical are listed in `__tests__/i18n/translationParity.test.ts`'s `allowedUntranslated`.
- Prettier only on new files, or on files that were prettier-clean on master. Never run `npm run fix`.
- No migration or backward-compatibility code for wallet client data (pre-launch). The server is in production, though: server migrations must be safe on existing data.
- Stage only your own files. Commit messages use conventional commits and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Tasks

### A. Per-profile backup preference (spec §1)
- Files: `core/backup/preference.ts`, `push.ts`, `erase.ts`, `status.ts` (optional explicit index); `core/context/WalletContext.tsx` (pass `profileIndex` to `pushOnce`; logout removes the bare key); `ui/screens/WalletConfigScreen.tsx` (effect deps, erase index).
- Tests:
  - `__tests__/backup/preference.test.ts`: per-profile cases with `__resetProfilesForTests`.
  - `push.test.ts`: a cross-profile opt-out.
  - `erase.test.ts`: profile 1 erase leaves profile 0 ON.
  - `__tests__/profiles/scopedState.test.ts`.
  - The logout test, for the bare key.
  - Keep the vault mocked-module tests green, so `transfers.ts` gets no new imports from `preference.ts`.

### B. Profile store: name + tombstone (spec §2, §3 store semantics)
- `core/profiles/profileStore.ts`:
  - `name` (trim, 24 chars, drop empty) and `deleted?: true` in the type, parse whitelist and `updateProfile` equality.
  - `active` clamps to a live profile.
  - `setActiveProfile` refuses tombstones, and `getActiveProfile` skips them.
  - `liveProfiles()` helper.
  - `profileLabel(record, t)` in a small module, e.g. `core/profiles/profileLabel.ts`.
- Update WalletContext `switchProfile`/`switchProfileImpl` to refuse tombstones, and make discovery register idempotently around tombstones.
- Tests: `profileStore.test.ts` additions and a `profileLabel` test.

### C. Rename UI (spec §2)
- `ui/screens/ProfileScreen.tsx`: a "Profile name" PencilEditField section that writes `updateProfile(active, {name})`, with a private-on-device hint.
- Switch label call sites to `profileLabel`:
  - `ProfileSwitcherPopover.tsx` (rows, a11y, cover);
  - `WalletConfigScreen.tsx` (scope note);
  - the WalletContext toast.
- Popover filters tombstones.
- i18n: new strings in all 12 locales.
- Tests: popover label with name, tombstone hidden; ProfileScreen rename if the existing harness allows.

### D. Removal core (spec §3)
- `assertProfileEmpty(storage, userId, deps)` in `core/profiles/assertProfileEmpty.ts`.
  - Raw SQL on `storage.sqliteDb` plus the KV and mandala checks.
  - Returns `{ ok: true } | { ok: false, reasons: RemovalBlocker[] }`.
  - Fails closed: any thrown error becomes the blocker `'check-failed'`.
- `releaseHandle` in `core/identity/handleRegistry/registration.ts`:
  - `release` intent;
  - `released` result kind;
  - `runJournal` mapping.
- Tests: one test per blocker and fail-closed; the `releaseHandle` journal and replay.

### E. Removal flow + UI (spec §3 steps, startup purge retry)
- WalletContext `removeProfile(): Promise<RemoveProfileResult>`, exposed on the context, with the ordered steps.
  - Abort paths leave the store untouched.
  - Runs under `runProfileTransition`, so the cover shows.
  - Startup purge retry for tombstones.
- ProfileScreen "Remove profile" row:
  - pre-check;
  - blocker explanations;
  - confirm dialog with cooldown copy;
  - success routes back to Home on profile 0.
- i18n in all 12 locales.
- Tests: the removal flow (ordering, abort when not empty, abort when release fails, switch failure leaves no tombstone, purge after success, never profile 0); startup retry.

### F. Push: app side (spec §4 App)
- `core/push/registration.ts`:
  - `syncPushRegistrations({ adapter, targets: [{ identityKey, host, makeClient }], ... })`, ordering the active profile last;
  - per-identity marker map;
  - `unregisterPushIdentity` best-effort, calling `POST /unregisterDevice` through an AuthFetch built from the identity's ProtoWallet. It must tolerate a 404 from the old server.
- WalletContext:
  - derive targets for live profiles from the mnemonic in `buildWalletFromMnemonic`, using one HD root and a ProtoWallet per identity;
  - pass them into `buildWallet`'s push wiring (WIF wallets keep a single target);
  - the token refresh and foreground triggers re-run with all targets.
- `core/push/events.ts`:
  - tap with `data.recipient` matching a non-active live profile → `switchProfile` then open Activity;
  - a foreground message for an inactive profile skips the inbox pass.
- Removal (E) and logout call unregister for the affected identities.
- Tests: ordering, markers, ProtoWallet identity equals the profile identity, routing, unregister tolerance.

### G. Push: server side (spec §4 Server)
- In the server worktree:
  - SQL schema migration for sqlite and postgres, safe on existing rows;
  - Mongo backfill and index;
  - upsert on the pair;
  - token-keyed deactivate and last-used across rows;
  - `recipient` + `messageBox` in the FCM data;
  - `POST /unregisterDevice`;
  - storagetest conformance updates, handler tests, payload test.
- `go build ./... && go test ./...` must pass. Use `go vet` if it is part of the repo's CI.
- Update docs or README if the repo documents the API.

Ordering: G runs in parallel with A–F. A, B, C, D, E and F run in sequence, because they share WalletContext, translations and profileStore.

## Verification
- Full wallet jest and tsc; Go tests.
- Whole-branch adversarial review of both repos.
- Simulator: rename; remove a zero-balance profile; blocked removal with funds.
