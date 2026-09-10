# R1C Vault Services Layer Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the K1 sealed-seed vault services with the 1-of-N YubiKey P-256 comb vault: meta v5 key list, hardware-free deposits, chosen-key withdrawals signed on-card in resumable batches, re-lock, and the `vaultEnabled` release gate — shipped as the breaking `@bsv/expo-wallet-toolbox` 0.5.0.

**Architecture:** Everything lives under `packages/expo-wallet-toolbox/core/services/vault/`. `vaultStore` persists a v5 key list in AsyncStorage; `CeremonyController` turns a tap into a `VaultSigner` (serial + pubkey + `sign(digest)` that retries dropped taps in place); `transfers.ts` builds every vault output from `r1comb.ts` (Plan 1) and drives withdraw/re-lock as version-2 `createAction` → on-card signatures → local strict `Spend` → `signAction`. The only native change is the NFC alert text (`startDiscovery(message)`).

**Tech Stack:** TypeScript (strict), `@bsv/sdk` 2.4.1 (`Transaction`, `Beef`, `Spend`, `Utils`), `@noble/curves/nist.js` (`p256`, tests + mock), Jest via `jest-expo` from the repo root, react-native-nitro-modules (`nitrogen` codegen), YubiKit (Swift) / yubikit-android (Kotlin).

**Spec:** `/Users/personal/git/bsv-wallet/docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md`
**Contract:** `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad/plan-contract.md` — copied verbatim below.

**Prerequisite:** Plan 1 Tasks 1–6 must be merged first (see "## Execution order" below — Plan 1 Task 7 comes LATER, after this plan's Tasks 1–11): `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` does not exist in the tree today and Tasks 6, 8, 9, 10, 11 import from it. Do not re-implement anything from it.

## Interface Contract

```markdown
# R1C vault — cross-plan interface contract

Three implementation plans share these exact names and signatures. A plan may ADD private helpers
but must not rename, re-type or omit anything here. All paths are under
`packages/expo-wallet-toolbox/` unless stated. Spec: `docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md`.
Reference implementation to port: `docs/example-txs/spike/gen2.mjs`, `unlock2.mjs`, `gen.mjs` (asm helper, DOUBLE/MADD templates, encNum/scriptNum), `unlock.mjs` (pushTxDerCheck, fullR, sighashPreimage).

## Plan 1 — template module (pure, no I/O, no React)

File: `core/services/vault/r1comb.ts`. Imports only `@bsv/sdk` and `@noble/curves/nist.js`.

```ts
export const COMB_ROWS = 6
export const COMB_COLS = 43
export const TABLE_SIZE = 32                 // entries per base point
export const COORD_WIDTH = 33                // OP_NUM2BIN width per coordinate
export const SALT_BYTES = 32
export const R1C_UNLOCK_LEN = 2560           // declared unlockingScriptLength (hard max is 2,539)
export const R1C_MAX_KEYS = 5
export function R1C_LOCK_LEN(n: number): number            // 27855 for n=1; 27831 + 25n for 2<=n<=5; throws otherwise

/** 65-byte SEC1 (04‖X‖Y) or 33-byte compressed hex in → 33-byte compressed, lowercase hex out. Throws VaultError('template-invalid') on anything else. */
export function compressPubkey(sec1Hex: string): string
/** table(Q): 32 affine points T_j·Q, T_j = 2^215 + Σ_{k<5} (bit_k(j) ? +1 : -1)·2^(43k). Memoised per pubkey (Map, max 8 entries). */
export function combTable(pubkeyHex33: string): { x: bigint; y: bigint }[]
/** le33(x_0)‖le33(y_0)‖…‖le33(y_31) — 2,112 bytes. le33 = value as exactly 33 little-endian bytes (OP_NUM2BIN 33 semantics). */
export function canonicalTableBytes(pubkeyHex33: string): number[]
/** hash160(salt ‖ canonicalTableBytes(Q)) as 40 lowercase hex chars. saltHex64 must be exactly 64 hex chars. */
export function commitment(pubkeyHex33: string, saltHex64: string): string
/** N in 1..5 commitments (40-hex each), in the order given. Byte-exact per spec §2.3. */
export function buildLock(a: { commitments: string[] }): LockingScript
/** Parse region H5 of a lock built by buildLock → the commitments in order. Throws VaultError('template-invalid') if the script is not an R1C lock. */
export function bakedCommitments(lock: Script): string[]
/** BIP143 preimage, subscript = Script.fromHex('ac'), scope 0x41, for input `inputIndex` of `tx` whose source output carried `sourceSatoshis`. 158 bytes. */
export function sighashPreimage(tx: Transaction, inputIndex: number, sourceSatoshis: number): number[]
/** reverse(hash256(preimage)) as 64 hex chars — what the P-256 signer signs (raw digest). */
export function signerDigest(preimage: number[]): string
/** D4b screen. ok=false when the OP_PUSH_TX s the lock will assemble is peel-nonminimal or zero. */
export function pushTxDerCheck(preimage: number[]): { ok: boolean; s: bigint }
/** DER → (r, s). Throws VaultError('template-invalid') on malformed DER. */
export function decodeDerSignature(der: number[]): { r: bigint; s: bigint }
/** R = u1·G + u2·Q for e = LE(hash256(preimage)); returns the FULL affine x, or null if R is the point at infinity. */
export function fullR(a: { preimage: number[]; rSig: bigint; s: bigint; pubkeyHex33: string }): bigint | null
/** The 71-push unlocking script (spec §2.4): r, u2', u1', 64 coords, salt, s, sInv, preimage. Throws VaultError('template-invalid') if fullR is null. */
export function buildUnlock(a: { preimage: number[]; derSig: number[]; pubkeyHex33: string; saltHex64: string }): UnlockingScript
/** Run @bsv/sdk Spend with EXPLICIT strict flags (MINIMALDATA on, UTXO_AFTER_CHRONICLE on, SIGHASH_FORKID, STRICTENC) — returns true or throws the interpreter error. */
export function verifyVaultInput(a: { tx: Transaction; inputIndex: number; sourceSatoshis: number; lockingScript: LockingScript; unlockingScript: UnlockingScript }): true

export interface VaultInstructionsV4 { v: 4; type: 'R1C'; salt: string /* 64 hex */; keys: string[] /* 33-byte compressed pubkeys, lowercase hex, commitment order */ }
export type VaultInstructions = VaultInstructionsV4
export function encodeVaultInstructions(i: VaultInstructionsV4): string
/** Fails closed: null for anything not exactly v4/R1C with valid salt and 1..5 valid keys. */
export function decodeVaultInstructions(ci?: string): VaultInstructionsV4 | null
```

`VaultError` / `VaultErrorCode` come from `core/services/vault/types.ts` (Plan 2 edits the code list; Plan 1 only uses `'template-invalid'`, which already exists).

Test file: `__tests__/vault/r1comb.test.ts`. Fixture path for goldens: `docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex` (read with `fs` relative to the REPO root — resolve via `path.resolve(__dirname, '../../../../docs/example-txs/…')`).

## Plan 2 — services (store, ceremony, driver, transfers, config, deletions, native alert text)

`core/services/vault/types.ts` — `VaultErrorCode` union gains: `'not-released' | 'backup-off' | 'not-enough-keys' | 'key-already-enrolled' | 'too-many-keys' | 'last-keys' | 'relock-required' | 'key-not-committed' | 'key-cannot-cover' | 'too-small-to-relock' | 'bad-version'`; loses `'seal-corrupt' | 'bad-passphrase' | 'bad-mnemonic' | 'bad-derivation-index' | 'backup-required'`. `SealedBlob` removed. Everything else unchanged.

`core/services/vault/vaultStore.ts`
```ts
export interface VaultKeyRecord { serial: string; slot: number; pubkey: string /* 33-byte compressed lowercase hex */; nickname: string; enrolledAt: number }
export interface VaultMetaV5 { v: 5; createdAt: number; lastUsedAt?: number; lastUsedSerial?: string; keys: VaultKeyRecord[] }
export type VaultMeta = VaultMetaV5
export const vaultStore: {
  isEnrolled(): Promise<boolean>                       // meta != null (meta-only)
  getMeta(): Promise<VaultMeta | null>                 // null unless v === 5
  setMeta(m: VaultMeta): Promise<void>
  addKey(k: VaultKeyRecord): Promise<VaultMeta>        // throws VaultError('too-many-keys') at 5, ('key-already-enrolled') on duplicate serial
  removeKey(serial: string): Promise<VaultMeta>        // throws VaultError('last-keys') when keys.length <= 2
  renameKey(serial: string, nickname: string): Promise<VaultMeta>
  noteLastUsed(serial: string): Promise<void>
  migrateLegacySeal(): Promise<void>                   // SecureStore.deleteItemAsync('vault_seal_v1'), swallow errors
  clear(): Promise<void>
}
```

`core/services/vault/VaultKeyService.ts`
```ts
export const VAULT_SLOT = 0x82
export const VAULT_MIN_KEYS = 2
export const VAULT_MAX_KEYS = 5
export type EnrollPhase = 'connecting' | 'pin-check' | 'generating' | 'done'
export async function enrollKey(args: {
  pendingSerials: string[]                             // serials already enrolled OR pending in this wizard run
  nickname?: string
  onPhase: (p: EnrollPhase) => void
  getPin: () => Promise<string>
  requestPinChange?: (retries: number) => Promise<{ oldPin: string; newPin: string }>
}): Promise<VaultKeyRecord>                            // one card session; generateVaultKey(0x82) with 'cached'/'once'; compressPubkey on the result; throws 'key-already-enrolled' | 'pin-locked' | 'pin-invalid' | 'no-key' | 'user-cancelled' | 'key-removed-mid-op' | 'driver-unavailable'
export async function finalizeEnrollment(records: VaultKeyRecord[]): Promise<void>   // throws 'not-enough-keys' (<2) / 'too-many-keys' (>5); writes meta v5
export async function addVaultKey(record: VaultKeyRecord): Promise<VaultMeta>        // vaultStore.addKey
export async function disableVault(): Promise<void>                                  // vaultStore.clear()
```

`core/services/vault/session.ts` — `withKeySession` now rejects: `session-failed` → `VaultError(code === 'user-cancelled' ? 'user-cancelled' : 'no-key')`; `detached` before `work` resolves → `VaultError('key-removed-mid-op')`; attach timeout (default 65_000 ms, injectable) → `VaultError('no-key')`.

`core/services/vault/driver.ts`
```ts
export interface VaultDriver {
  isSupported(): boolean
  sessionBased: boolean
  start(message?: string): void                        // message = localised NFC alert text (iOS); ignored elsewhere
  stop(): void
  onKeyEvent(cb: (e: KeyEvent) => void): () => void
  getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }>
  verifyPin(pin: string): Promise<{ ok: boolean; retriesLeft: number }>
  changePin(oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }>
  generateVaultKey(slot: number): Promise<{ publicKey: string }>   // adapter passes 'cached', 'once'
  readVaultPublicKey(slot: number): Promise<{ publicKey: string } | null>
  signEcdsa(slot: number, pin: string, digest: string): Promise<{ signature: string }>
}
// ecdh REMOVED from VaultDriver and from NativeYubiKeyPiv usage (native method may remain; unused).
```
Native: `packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts` `startDiscovery(message: string): void`; Swift sets `YubiKitExternalLocalization.nfcScanAlertMessage = message` before starting; Kotlin ignores. Regenerate nitrogen output (`npx nitrogen` in the package; commit generated files).

`core/services/vault/mockYubiKey.ts` — `MockYubiKey` keeps a `Map<serial, { priv: Uint8Array | null; pub: string | null; pin: string; pinRetries: number; pinVerified: boolean }>`; `insertKey(serial)` selects/creates a record; `setPin(pin)` applies to the current serial; `signEcdsa` signs with the current serial's key; `ecdh` and the `softwareEcdh` import removed; `start(message?)` accepted. `devMock.ts`: module-held instance; `setMockDriverEnabled(on)`, `setMockPresentKey(serial: 'MOCK-DEV-1' | 'MOCK-DEV-2' | 'MOCK-DEV-3')`, `getMockPresentKey()`.

`core/services/vault/ceremony.ts`
```ts
export type VaultProgress = { phase: 'preparing'; signed?: number; total?: number } | { phase: 'broadcasting' }
export interface CeremonyState { phase: CeremonyPhase; reason?: string; error?: { code: VaultErrorCode; retriesLeft?: number }; armedUntil?: number; progress?: { signed: number; total: number } }
export interface VaultSigner {
  readonly serial: string
  readonly pubkey: string                              // 33-byte compressed lowercase hex
  /** Sign one 32-byte digest (64 hex). Retries in place on touch-timeout / nfc-lost / key-removed-mid-op (re-opens the session on session-based transports, re-checks serial + PIN); on session-based transports re-opens a fresh session every VAULT_INPUTS_PER_TAP calls. Throws 'key-removed-mid-op' after release(). */
  sign(digestHex: string, progress?: { index: number; total: number }): Promise<number[]>   // DER bytes
  release(): void
}
export interface CeremonyStoreView { getMeta(): Promise<{ keys: { serial: string; slot: number; pubkey: string }[] } | null> }
export class CeremonyController {
  constructor(deps: { getDriver: () => VaultDriver | null; store: CeremonyStoreView; retentionMs: number; attachTimeoutMs?: number; inputsPerTap?: number })
  requestSigner(reason: string, chosenSerial: string): Promise<VaultSigner>  // 'serial-mismatch' if the tapped card is not chosenSerial; 'not-enrolled' if chosenSerial not in meta
  noteProgress(p: VaultProgress): void
  submitPin(pin: string): void; cancel(): void; retry(): void; notifyKeyDetached(): void; subscribe(cb): () => void
  onArmed?: (s: VaultSigner) => void; onRelock?: (why: 'timeout' | 'detached' | 'manual') => void
}
```
`core/services/vault/ceremonyHost.ts`: `export function requestVaultSigner(reason: string, chosenSerial: string): Promise<VaultSigner>`; `noteVaultProgress(p: VaultProgress)`; `VAULT_RETENTION_MS = 120_000`; `VAULT_INPUTS_PER_TAP = 16`.

`core/toolboxConfig.ts`: `ToolboxConfig.vaultEnabled?: boolean` (default false); `export function isVaultEnabled(): boolean` — returns `current?.vaultEnabled ?? false`, never throws.

`core/services/vault/transfers.ts`
```ts
export const VAULT_BASKET = 'admin vault'
export const VAULT_DEPOSIT_MIN = 100_000
export const VAULT_MAX_INPUTS = 32
export const VAULT_HARD_MAX_INPUTS = 48
export interface VaultTransferOptions {
  findSpendingReferences?: SpendingReferenceLookup
  isOnline?: () => Promise<boolean>
  /** Injected gates so the module stays config-free in tests. Defaults: isVaultEnabled() and isBackupPushEnabled(). */
  vaultEnabled?: () => boolean
  backupEnabled?: () => Promise<boolean>
}
export interface VaultSpendResult {
  txid: string
  cappedInputs: number                                 // left untouched by VAULT_MAX_INPUTS
  unreachable: { count: number; satoshis: number; keys: { serial?: string; pubkey: string }[] }   // outputs the chosen key is not committed to
}
export interface VaultKeyCoverage { outputs: number; stale: number /* outputs whose key set != current */; missingKeys: string[] /* current pubkeys absent from some output */; removedKeyOutputs: number /* outputs committed to a pubkey no longer in meta */ }
export async function getVaultBalance(w: VaultWallet, adminOriginator: string): Promise<number>          // decodable v4 outputs only
export async function getVaultKeyCoverage(w: VaultWallet, adminOriginator: string): Promise<VaultKeyCoverage>
export async function orphanedIfRemoved(w: VaultWallet, adminOriginator: string, pubkey: string): Promise<number>   // outputs that would lose every remaining committed key if pubkey were removed
export async function depositToVault(w: VaultWallet, adminOriginator: string, satoshis: number, opts?: VaultTransferOptions): Promise<{ txid: string }>   // NO ceremony; throws 'not-released' | 'backup-off' | 'not-enough-keys' | 'below-dust' | 'requires-online'
export async function withdrawFromVault(w: VaultWallet, adminOriginator: string, amount: number | 'all', reason: string, chosenSerial: string, opts?: VaultTransferOptions): Promise<VaultSpendResult>
export async function relockVault(w: VaultWallet, adminOriginator: string, reason: string, chosenSerial: string, opts?: VaultTransferOptions): Promise<VaultSpendResult>   // throws 'too-small-to-relock' | 'not-released'
export function estimateRelockFee(inputCount: number, lockLen: number, satPerKb?: number): number     // ceil(size/1000)*satPerKb * 1.1, size = 10 + inputCount*(41+3+R1C_UNLOCK_LEN) + (3+lockLen+8)
export interface VaultWallet { createAction(args: unknown, originator: string): Promise<CreateActionResult>; signAction(...); listOutputs(...); abortAction(...); listActions?(...) }
// Kept as legacy (unchanged API): reclaimStagingOutputs, ReclaimResult, VAULT_STAGING_BASKET. Removed: sweepVaultWithHD, VaultWallet.getPublicKey, VaultWallet.createSignature is kept ONLY because reclaimStagingOutputs uses it.
```
Withdraw internals (spec §4.2): listOutputs (limit 1000, entire transactions, includeCustomInstructions) → decode v4 → filter by chosen pubkey → sort desc → cap → per input `commitment(pubkey, salt) ∈ bakedCommitments(lock from BEEF)` else `key-not-committed` → amount checks (`key-cannot-cover`, `too-many-inputs`, `amount-exceeds-balance`) → createAction `{ version: 2, inputs: [{ outpoint, unlockingScriptLength: R1C_UNLOCK_LEN, inputDescription }], outputs (re-vault remainder ≥ VAULT_DEPOSIT_MIN with fresh salt, current keys), inputBEEF, options: { randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' } }` → parse signable tx; assert version 2 (`bad-version` + abortAction) → preimages + `pushTxDerCheck` for each (on failure abortAction and re-create with `sequenceNumber` bumped on that input; max 8 attempts) → `requestVaultSigner(reason, chosenSerial)` → sign sequentially with progress → release → buildUnlock + verifyVaultInput per input → signAction `{ reference, spends, options: { acceptDelayedBroadcast: true } }`. On any failure before signAction: abortAction.

## Plan 3 — UI (screens, components, i18n, routes, home button)

Consumes everything above. Produces:
- `ui/components/vault/EnrollWizard.tsx`: `export const EnrollWizard: React.FC<{ mode: 'enroll' | 'add-key'; onDone: () => void; onCancel: () => void }>` — steps `intro | key | more | done` (add-key mode: single `key` step then done).
- `ui/components/vault/KeyChooser.tsx`: `export const KeyChooser: React.FC<{ keys: VaultKeyRecord[]; selected?: string; onSelect: (serial: string) => void }>`.
- `ui/components/vault/vaultErrorCopy.ts`: `export function vaultErrorCopy(code: VaultErrorCode | undefined, params?: Record<string, unknown>): string` (merges `ERROR_COPY` and `translateVaultError`).
- `ui/hooks/useExportWalletData.ts`: `export function useExportWalletData(): { exportData: () => Promise<void>; exporting: boolean }` (lifted from WalletConfigScreen.handleExportData; uses `exportAllWalletDatabases(storage)`).
- `ui/hooks/useVaultCoverage.ts`: `export function useVaultCoverage(): { coverage: VaultKeyCoverage | null; refresh: () => void }`.
- `ui/screens/VaultScreen.tsx`, `ui/screens/VaultTransferScreen.tsx`, `ui/components/vault/VaultCeremonySheet.tsx` per spec §5.4; `ui/hooks/useVaultBalance.ts` unchanged API.
- Deleted: `VaultRecoverScreen.tsx`, `PassphraseField.tsx`, `PhraseBackupSheet.tsx`, `app/vault-recover.tsx`, `_layout` entry; `ui/index.ts` exports updated.
- `ui/screens/WalletHomeScreen.tsx`: Vault button rendered only when `isVaultEnabled()`; keeps `router.push('/vault')`. `SettingsScreen.tsx` `/vault` row same gate.
- i18n: all twelve locales in `core/i18n/translations.tsx`; parity test `__tests__/i18n/translationParity.test.ts` must pass; dead keys removed in the same commit as their code.
- Host wiring (repo root): `app/_layout.tsx` passes `vaultEnabled: process.env.EXPO_PUBLIC_VAULT_ENABLED === 'true'` to `configureToolbox`; `eas.json` profiles: development/dev-physical `EXPO_PUBLIC_VAULT_ENABLED=true`, production omitted (false).
```

## Global Constraints

- Curve: NIST P-256; PIV slot `0x82`; keys always freshly generated with touch policy `'cached'`, PIN policy `'once'`; the native 65-byte SEC1 pubkey is compressed via `compressPubkey` (33-byte lowercase hex) before it is stored or compared.
- `R1C_UNLOCK_LEN = 2560` (declared `unlockingScriptLength`); lock sizes `R1C_LOCK_LEN(n)` = 27,855 (n=1) / 27,831 + 25n (n=2..5); salt exactly 32 bytes (`SALT_BYTES`); 2 ≤ N ≤ 5 keys (`VAULT_MIN_KEYS`/`VAULT_MAX_KEYS`).
- `VAULT_DEPOSIT_MIN = 100_000` sat; `VAULT_MAX_INPUTS = 32`; `VAULT_HARD_MAX_INPUTS = 48`; `VAULT_INPUTS_PER_TAP = 16`; `VAULT_RETENTION_MS = 120_000`; attach watchdog 65_000 ms; `pushTxDerCheck` retry bound 8.
- Withdrawals and re-locks pass `version: 2` to `createAction` and assert `tx.version === 2` on the parsed signable transaction before the first card signature; deposits stay at the default version 1; never set `sequenceNumber` on a `spends[i]` entry.
- customInstructions v4 only: `{ v: 4, type: 'R1C', salt, keys }`; v3 `K1` records are ignored everywhere (balance, selection, coverage, disable check).
- Meta v5 in AsyncStorage key `vault_meta_v1` (name unchanged); `getMeta` returns null unless `v === 5`; the SecureStore key `vault_seal_v1` is deleted by `migrateLegacySeal()`.
- Twelve locales live in `core/i18n/translations.tsx` — this plan adds no i18n keys (all copy is Plan 3); services throw `VaultError` codes only and never import `i18n`.
- Tests: `npx jest <path>` from the REPO ROOT (`/Users/personal/git/bsv-wallet`), e.g. `npx jest packages/expo-wallet-toolbox/__tests__/vault/vaultStore.test.ts`. Existing mock conventions: own AsyncStorage/expo-secure-store `jest.mock` factories, `jest.mock('../../core/services/vault/ceremonyHost', ...)` in transfers tests.
- TypeScript strict (`packages/expo-wallet-toolbox/tsconfig.json`, `include: core/**, ui/**`). Type-check command: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json`.
- No `process.env` anywhere inside the package — the flag arrives via `configureToolbox({ vaultEnabled })`.
- Commit after every task with a conventional-commit message whose last line is the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Compile gate (read this).** Tasks 1, 2 and 12 leave `tsc` green for `core/`. Tasks 3–11 rewrite one tightly coupled module at a time in the order the orchestrator fixed (store → driver → ceremony → host → key service → transfers); each of those commits is verified by its OWN jest files (Babel does not type-check), and each task lists the exact `tsc` residual errors it is allowed to leave — every one of them is in a file a LATER task in this plan rewrites, or in a `ui/` file Plan 3 rewrites (`EnrollWizard.tsx`, `VaultTransferScreen.tsx`, `VaultRecoverScreen.tsx`, `VaultScreen.tsx`). After Task 12 the only permitted `tsc` errors are in those four `ui/` files PLUS ONE MORE that Task 12 itself introduces: `ui/components/vault/PassphraseField.tsx` (loses `normalizeVaultPassphrase` through the barrel). Never let a residual appear in a file this plan does not later touch, or outside those five files after Task 12.

## Execution order

Binding sequencing across all three plans: **P1 Tasks 1–6 → P2 Tasks 1–11 → P1 Task 7 → P2 Task 12 → P2 Task 13 → Plan 3.** P1 Tasks 1–6 ship the pure `r1comb.ts` module this plan imports from (this plan's prerequisite). This plan's Tasks 1–11 build every service on top of it while `core/services/vault/k1.ts` and `core/index.ts:269`'s `k1` export still exist — nothing in Tasks 1–11 deletes them. Only once ALL of Tasks 1–11 have landed does **P1 Task 7** run: it deletes `k1.ts`, `k1.test.ts`, `scripts/k1-spend-proof.ts` and flips `core/index.ts:269` from `export * from './services/vault/k1'` to `export * from './services/vault/r1comb'`. **Task 12** runs directly after that — it deletes `sealing.ts`/`vaultDerivation.ts`/`vaultPassphrase.ts` and their exports/tests, and must not touch the `k1` line or the k1 files (Plan 1 Task 7 owns them exclusively — see that task's preamble and this plan's Task 12 preamble). Plan 3 starts only after Task 12 lands. Task 13 runs last in this plan, directly after Task 12: it is a read-only regression test over already-landed exports (Plan 1's r1comb codec, the backup chunk codec, StorageExpoSQLite) and touches no file another task rewrites, so it has no ordering dependency beyond needing those exports to exist.

## File Structure

Repo root `/Users/personal/git/bsv-wallet`; `T` = `packages/expo-wallet-toolbox`, `Y` = `packages/react-native-yubikey`.

| Action | File | Responsibility |
|---|---|---|
| Modify | `T/core/services/vault/types.ts` | `VaultErrorCode` gains 11 R1C codes (Task 1), loses 5 seed-era codes + `SealedBlob` (Task 12) |
| Modify | `T/core/toolboxConfig.ts` | `vaultEnabled` option + `isVaultEnabled()` |
| Modify | `T/core/index.ts` | export `isVaultEnabled` (Task 2); drop `sealing`/`vaultDerivation`/`vaultPassphrase` (Task 12) — the `k1` → `r1comb` line is Plan 1 Task 7's exclusively, not touched here |
| Modify | `T/core/services/vault/vaultStore.ts` | meta v5 key list, `addKey`/`removeKey`/`renameKey`/`noteLastUsed`/`migrateLegacySeal` |
| Modify | `T/core/context/VaultContext.tsx` | call `vaultStore.migrateLegacySeal()` once on mount |
| Modify | `T/core/services/vault/driver.ts` | `start(message?)`, `'cached'/'once'`, `ecdh` removed, `startDiscovery(message)` |
| Modify | `T/core/services/vault/session.ts` | `withKeySession` rejects on session-failed / detached / attach timeout |
| Modify | `T/core/services/vault/mockYubiKey.ts` | per-serial records, no `ecdh`, `start(message?)` |
| Modify | `T/core/services/vault/devMock.ts` | module-held mock, `setMockPresentKey`/`getMockPresentKey` |
| Modify | `Y/src/specs/YubiKeyPiv.nitro.ts` | `startDiscovery(message: string)` |
| Modify | `Y/ios/HybridYubiKeyPiv.swift` | alert text from JS; stale `ALWAYS` comment |
| Modify | `Y/android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt` | accept and ignore `message`; stale `ALWAYS` comment |
| Regenerate | `Y/nitrogen/generated/**` | `npx nitrogen` output for the new signature |
| Modify | `T/core/services/vault/ceremony.ts` | `VaultSigner`, `requestSigner(reason, chosenSerial)`, batch reopen, resumable sign loop, `progress` |
| Modify | `T/core/services/vault/ceremonyHost.ts` | `requestVaultSigner`, `VAULT_INPUTS_PER_TAP`, v5 store view |
| Modify | `T/core/services/vault/VaultKeyService.ts` | `enrollKey`, `finalizeEnrollment(records)`, `addVaultKey`, `disableVault` |
| Modify | `T/core/services/vault/transfers.ts` | hardware-free deposit; chosen-key withdraw; `relockVault`; coverage; v4-only balance; legacy reclaim kept |
| Modify | `T/core/services/vault/guard.ts` | header prose (no seed / HD node) |
| Delete | `T/core/services/vault/sealing.ts`, `vaultDerivation.ts`, `vaultPassphrase.ts` | seed-era crypto (the K1 script itself, `k1.ts`, is deleted by Plan 1 Task 7, not this plan) |
| Delete | `T/__tests__/vault/sealing.test.ts`, `vaultDerivation.test.ts`, `vaultPassphrase.test.ts` | their tests (`k1.test.ts` likewise deleted by Plan 1 Task 7) |
| Create | `T/__tests__/vault/types.test.ts` | code-list regression guard |
| Modify | `T/__tests__/toolboxConfig.test.ts` | `isVaultEnabled` cases |
| Rewrite | `T/__tests__/vault/vaultStore.test.ts` | meta v5 |
| Create | `T/__tests__/context/vaultProviderMigration.test.tsx` | mount calls `migrateLegacySeal` |
| Create | `T/__tests__/vault/session.test.ts` | rejecting `withKeySession` |
| Modify | `T/__tests__/vault/mockYubiKey.test.ts` | ecdh suite removed, `'cached'`, multi-serial, `start(message)` |
| Create | `T/__tests__/vault/devMock.test.ts` | present-key selector |
| Rewrite | `T/__tests__/vault/ceremony.test.ts` | `VaultSigner` ceremony |
| Create | `T/__tests__/vault/ceremonyHost.test.ts` | singleton wiring |
| Rewrite | `T/__tests__/vault/vaultKeyService.test.ts` | multi-key enrollment |
| Rewrite | `T/__tests__/vault/transfers.test.ts` | deposit / withdraw / relock / coverage / balance / legacy reclaim |
| Create | `T/__tests__/vault/restoreSalt.test.ts` | spec §7 Restore: salts survive backup encode/decode and a database file copy |
| Modify | `T/CHANGELOG.md`, `T/package.json` | 0.5.0 breaking entry, version bump |

Files this plan does NOT touch (owned by Plan 3): everything under `T/ui/`, `T/core/i18n/translations.tsx`, `T/core/context/WalletContext.tsx`, `app/**`, `eas.json`. Kept untouched on purpose: `T/core/services/vault/backupAttestation.ts` and its test.

---

### Task 1: R1C error codes

**Files:**
- Modify: `T/core/services/vault/types.ts` (lines 23–72, the `VaultErrorCode` union; and the `VaultError` class, which gains an optional `details` field)
- Test: `T/__tests__/vault/types.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `VaultErrorCode` including `'not-released' | 'backup-off' | 'not-enough-keys' | 'key-already-enrolled' | 'too-many-keys' | 'last-keys' | 'relock-required' | 'key-not-committed' | 'key-cannot-cover' | 'too-small-to-relock' | 'bad-version'`. The five seed-era codes and `SealedBlob` stay until Task 12 so `sealing.ts`/`vaultPassphrase.ts`/`transfers.ts` keep compiling in between. `VaultError` gains an optional `details?: Record<string, string | number>` field (new 4th constructor param, after `retriesLeft`) — structured context for a failure, additive and undefined on most codes. This plan's convention (read by Plan 3): `serial-mismatch` → `{ tapped, chosen }` (Task 6), `key-already-enrolled` → `{ serial }` (Task 8), `key-cannot-cover` → `{ reachable, total }` (Task 10); `too-many-inputs` carries no `details`.

- [ ] **Step 1: Write the regression guard**

`T/__tests__/vault/types.test.ts`:

```ts
/**
 * VaultErrorCode list guard. The union is compile-time only, so the value of
 * this file is (a) the tsc pass over the package after types.ts changes and
 * (b) the runtime parse of a native rejection carrying one of the new codes.
 */
import { VaultError, VaultErrorCode, vaultErrorFromNative } from '../../core/services/vault/types'

const R1C_CODES: VaultErrorCode[] = [
  'not-released',
  'backup-off',
  'not-enough-keys',
  'key-already-enrolled',
  'too-many-keys',
  'last-keys',
  'relock-required',
  'key-not-committed',
  'key-cannot-cover',
  'too-small-to-relock',
  'bad-version'
]

describe('VaultErrorCode (R1C)', () => {
  it('constructs a VaultError for every new code and keeps the code on the instance', () => {
    for (const code of R1C_CODES) {
      const e = new VaultError(code, 'detail')
      expect(e.code).toBe(code)
      expect(e.message).toBe('detail')
      expect(e.name).toBe('VaultError')
    }
  })

  it('vaultErrorFromNative parses a new code out of a VAULT_ERR rejection', () => {
    const e = vaultErrorFromNative(new Error('VAULT_ERR:key-not-committed:abcd.0'))
    expect(e.code).toBe('key-not-committed')
    expect(e.message).toBe('abcd.0')
  })

  it('a default message falls back to the code itself', () => {
    expect(new VaultError('bad-version').message).toBe('bad-version')
  })

  it('carries structured details when given, and defaults to undefined', () => {
    expect(new VaultError('bad-version').details).toBeUndefined()
    const e = new VaultError('serial-mismatch', 'Tapped key A, chose key B', undefined, { tapped: 'A', chosen: 'B' })
    expect(e.details).toEqual({ tapped: 'A', chosen: 'B' })
  })
})
```

- [ ] **Step 2: Run it**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/types.test.ts` — passes at runtime already (codes are strings under Babel). The red signal for this task is the type-check: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json` is green now and must stay green after Step 3; the test file itself is outside `tsconfig.include`, so its type errors would only surface through an editor — that is why Step 4 re-runs tsc.

- [ ] **Step 3: Add the codes**

In `T/core/services/vault/types.ts`, replace lines 55–72 (from `  /** Vault passphrase missing or empty` through `  | 'requires-online'`) with:

```ts
  /** REMOVED IN TASK 12 of the R1C plan — seed-era codes kept only so the
   * modules deleted there (sealing.ts, vaultPassphrase.ts, vaultDerivation.ts)
   * and the pre-rewrite transfers.ts compile until their own task lands. */
  | 'bad-passphrase'
  | 'bad-mnemonic'
  | 'bad-derivation-index'
  | 'backup-required'
  /** More vault inputs would be needed than one transaction may safely carry.
   *  See VAULT_MAX_INPUTS — the remedy is a smaller withdrawal, which also
   *  consolidates the vault. */
  | 'too-many-inputs'
  /** The device is offline. Vault transfers never enter the offline queue — see
   *  VaultTransferOptions.isOnline. */
  | 'requires-online'
  // ── R1C (1-of-N comb vault) ──────────────────────────────────────────────
  /** `vaultEnabled` is off in this build (spec §0 / D15): no enrollment,
   *  deposit, re-vault or re-lock may create a vault output. */
  | 'not-released'
  /** Encrypted wallet backup push is switched off (D13): a deposit's salt lives
   *  only in the wallet DB, so no YubiKey could open it after a phone loss. */
  | 'backup-off'
  /** Fewer than VAULT_MIN_KEYS keys — defensive; the wizard cannot persist it. */
  | 'not-enough-keys'
  /** The tapped serial is already in meta.keys or in the wizard's pending list.
   *  The message carries the serial. */
  | 'key-already-enrolled'
  /** VAULT_MAX_KEYS keys already enrolled. */
  | 'too-many-keys'
  /** Removing this key would leave fewer than VAULT_MIN_KEYS. */
  | 'last-keys'
  /** Removing this key would orphan an output only it can open — re-lock first. */
  | 'relock-required'
  /** The chosen key is not among the commitments baked into an output's real
   *  lock (or no reachable output exists). The message names the outpoint. */
  | 'key-not-committed'
  /** The chosen key can open less than the requested amount while other keys
   *  could open more. */
  | 'key-cannot-cover'
  /** acc − feeEstimate < VAULT_DEPOSIT_MIN: nothing worth re-locking. */
  | 'too-small-to-relock'
  /** The signable transaction is not version 2 — refused before any signature. */
  | 'bad-version'
```

Also delete lines 41–43's stale mention of `seal-corrupt`? No — leave `'seal-corrupt'` (line 35) untouched until Task 12; only the comment block above `'template-invalid'` (lines 36–42) is rewritten now to:

```ts
  /** A vault key digest, DER signature, pubkey or script failed a structural
   * check (r1comb.ts throws it for malformed SEC1 points, DER, or a lock that
   * is not an R1C lock). Distinct from 'wrong-key', which vaultErrorFromNative
   * may reclassify to 'nfc-lost'. */
```

Also replace the `VaultError` class (today directly below the `VaultErrorCode` union) with:

```ts
export class VaultError extends Error {
  code: VaultErrorCode
  /** PIN attempts remaining, present on pin-invalid. */
  retriesLeft?: number
  /** Structured context for the specific failure — e.g. serial-mismatch's
   *  { tapped, chosen } or key-cannot-cover's { reachable, total } (see the
   *  Interfaces note above for the full convention). Additive: most codes
   *  leave it undefined, and no existing call site needs to change. */
  details?: Record<string, string | number>

  constructor(code: VaultErrorCode, message?: string, retriesLeft?: number, details?: Record<string, string | number>) {
    super(message ?? code)
    this.name = 'VaultError'
    this.code = code
    this.retriesLeft = retriesLeft
    this.details = details
  }
}
```

- [ ] **Step 4: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/types.test.ts` → `4 passed`.
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json` → no output (green).

- [ ] **Step 5: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/types.ts packages/expo-wallet-toolbox/__tests__/vault/types.test.ts
git commit -m "feat(expo-wallet-toolbox): add R1C vault error codes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `vaultEnabled` host flag

**Files:**
- Modify: `T/core/toolboxConfig.ts` (interface at lines 43–58, `ResolvedConfig` 60–63, `configureToolbox` 108–116, new export after `getServiceConfig` line 137)
- Modify: `T/core/index.ts` lines 30–36 (the `toolboxConfig` export list)
- Test: `T/__tests__/toolboxConfig.test.ts` (append a describe)

**Interfaces:**
- Produces: `ToolboxConfig.vaultEnabled?: boolean`; `export function isVaultEnabled(): boolean`.

- [ ] **Step 1: Failing tests**

Append to `T/__tests__/toolboxConfig.test.ts` (and add `isVaultEnabled` to the import list at the top):

```ts
// The vault release gate (spec §0 / D15). Default off; on only when the host
// says so; and — unlike the URL getters — never throws, because the home
// screen reads it while rendering and an unconfigured dev host must simply
// see "no vault", not a crash.
describe('isVaultEnabled', () => {
  it('is false before configureToolbox runs, without throwing', () => {
    expect(isVaultEnabled()).toBe(false)
  })

  it('defaults to false when the host omits it', () => {
    configureToolbox({ backupUrl: null })
    expect(isVaultEnabled()).toBe(false)
  })

  it('is true when the host passes true', () => {
    configureToolbox({ backupUrl: null, vaultEnabled: true })
    expect(isVaultEnabled()).toBe(true)
  })

  it('is replaced wholesale with the rest of the configuration', () => {
    configureToolbox({ backupUrl: null, vaultEnabled: true })
    configureToolbox({ backupUrl: null })
    expect(isVaultEnabled()).toBe(false)
  })
})
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts` → fails: `TypeError: (0 , _toolboxConfig.isVaultEnabled) is not a function`.

- [ ] **Step 3: Implement**

In `T/core/toolboxConfig.ts`:

Add to `ToolboxConfig` after `services?` (line 57):
```ts
  /**
   * Release gate for the YubiKey vault (spec §0, D15). Default false: the home
   * button and Settings row are hidden, the vault route shows "Not available
   * yet", and no code path may enrol hardware or create a vault output. Turned
   * on per build profile by the host (EXPO_PUBLIC_VAULT_ENABLED in eas.json),
   * never read from process.env here.
   */
  vaultEnabled?: boolean
```

Change `ResolvedConfig` to:
```ts
interface ResolvedConfig {
  backupUrl: string
  services: Partial<Record<AppChain, ToolboxServiceConfig>>
  vaultEnabled: boolean
}
```

In `configureToolbox`, the assignment becomes:
```ts
  current = {
    backupUrl: config.backupUrl == null ? '' : normalizeBackupUrl(config.backupUrl),
    services: config.services ?? {},
    vaultEnabled: config.vaultEnabled === true
  }
```

After `getServiceConfig` add:
```ts
/**
 * Whether this build may enrol vault hardware or create vault outputs.
 *
 * Deliberately NOT throwing when unconfigured: this is read while rendering
 * the home screen, and "unconfigured" must look like "vault off", not crash.
 */
export function isVaultEnabled(): boolean {
  return current?.vaultEnabled ?? false
}
```

In `T/core/index.ts` lines 30–36 add `isVaultEnabled,` after `getServiceConfig,`.

- [ ] **Step 4: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts` → all pass (existing 13 + 4 new).
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json` → green.

- [ ] **Step 5: Commit**

```
git add packages/expo-wallet-toolbox/core/toolboxConfig.ts packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/__tests__/toolboxConfig.test.ts
git commit -m "feat(expo-wallet-toolbox): vaultEnabled host flag and isVaultEnabled()" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: vaultStore meta v5 and `migrateLegacySeal`

**Files:**
- Modify: `T/core/services/vault/vaultStore.ts` (whole file, 104 lines → rewritten)
- Modify: `T/core/context/VaultContext.tsx` (imports at lines 13–18; add one `useEffect` after line 47)
- Test: `T/__tests__/vault/vaultStore.test.ts` (rewrite), `T/__tests__/context/vaultProviderMigration.test.tsx` (create)

**Interfaces:**
- Consumes: `VaultError` from `./types`.
- Produces (contract): `VaultKeyRecord`, `VaultMetaV5`, `VaultMeta`, `vaultStore.{isEnrolled,getMeta,setMeta,addKey,removeKey,renameKey,noteLastUsed,migrateLegacySeal,clear}`.
- Allowed tsc residuals after this commit: `VaultKeyService.ts` (`VaultMetaV4`, `setSeal`), `ceremonyHost.ts` (`getSeal`, `m.slot`, `m.yubiSerial`), `transfers.ts` (`takeNextIndex`), `ui/screens/VaultScreen.tsx` (`meta?.yubiSerial`). All rewritten in Tasks 7–10 / Plan 3.

- [ ] **Step 1: Rewrite the store test**

Replace `T/__tests__/vault/vaultStore.test.ts` with:

```ts
/**
 * vaultStore persistence tests — meta v5 (the enrolled key list) in
 * AsyncStorage. There is no seal any more: the only thing the store holds is
 * public data (serials, pubkeys, nicknames), and the legacy SecureStore seal
 * entry is removed by migrateLegacySeal.
 */
// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts: the vault
// suites install a different one and a global mapper makes the resolver
// recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})

const secureItems: Record<string, string> = {}
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async (k: string) => secureItems[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    secureItems[k] = v
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    delete secureItems[k]
  })
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { vaultStore, VaultKeyRecord, VaultMetaV5 } from '../../core/services/vault/vaultStore'

const key = (n: number): VaultKeyRecord => ({
  serial: `1000000${n}`,
  slot: 0x82,
  pubkey: '02' + n.toString(16).padStart(2, '0').repeat(32),
  nickname: `Key ${n}`,
  enrolledAt: 1_700_000_000_000 + n
})

const META: VaultMetaV5 = {
  v: 5,
  createdAt: 1_700_000_000_000,
  keys: [key(1), key(2)]
}

beforeEach(async () => {
  await AsyncStorage.clear()
  for (const k of Object.keys(secureItems)) delete secureItems[k]
  ;(SecureStore.deleteItemAsync as jest.Mock).mockClear()
})

describe('vaultStore v5', () => {
  it('round-trips v5 meta and reports enrolled on meta alone', async () => {
    expect(await vaultStore.isEnrolled()).toBe(false)
    await vaultStore.setMeta(META)
    expect(await vaultStore.getMeta()).toEqual(META)
    expect(await vaultStore.isEnrolled()).toBe(true)
  })

  it('reads a v4 record as not enrolled', async () => {
    // Spec §3.2 / §8: a device holding the K1-era v4 meta shows "not enrolled"
    // and can enrol fresh. Written through AsyncStorage directly — the store
    // exposes no raw-write seam just for tests.
    await AsyncStorage.setItem(
      'vault_meta_v1',
      JSON.stringify({ v: 4, enrolledAt: 1, yubiSerial: 's', nickname: 'n', slot: 0x82, nextKeyIndex: 3 })
    )
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
  })

  it('reads a v5 record without a keys array as not enrolled', async () => {
    await AsyncStorage.setItem('vault_meta_v1', JSON.stringify({ v: 5, createdAt: 1 }))
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('reads unparseable JSON as not enrolled', async () => {
    await AsyncStorage.setItem('vault_meta_v1', '{not json')
    expect(await vaultStore.getMeta()).toBeNull()
  })

  it('addKey appends and persists, returning the new meta', async () => {
    await vaultStore.setMeta(META)
    const next = await vaultStore.addKey(key(3))
    expect(next.keys.map(k => k.serial)).toEqual(['10000001', '10000002', '10000003'])
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  it('addKey refuses a duplicate serial with key-already-enrolled', async () => {
    await vaultStore.setMeta(META)
    const err = await vaultStore.addKey({ ...key(1), nickname: 'again' }).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.details).toEqual({ serial: key(1).serial })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(2)
  })

  it('addKey refuses a sixth key with too-many-keys', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3), key(4), key(5)] })
    await expect(vaultStore.addKey(key(6))).rejects.toMatchObject({ code: 'too-many-keys' })
  })

  it('addKey with no meta throws not-enrolled', async () => {
    await expect(vaultStore.addKey(key(1))).rejects.toMatchObject({ code: 'not-enrolled' })
  })

  it('removeKey drops the serial and clears lastUsedSerial when it pointed at it', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)], lastUsedSerial: '10000003', lastUsedAt: 5 })
    const next = await vaultStore.removeKey('10000003')
    expect(next.keys.map(k => k.serial)).toEqual(['10000001', '10000002'])
    expect(next.lastUsedSerial).toBeUndefined()
    expect(next.lastUsedAt).toBe(5)
  })

  it('removeKey refuses to go below two keys with last-keys', async () => {
    await vaultStore.setMeta(META)
    await expect(vaultStore.removeKey('10000001')).rejects.toMatchObject({ code: 'last-keys' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(2)
  })

  it('removeKey of an unknown serial throws not-enrolled and changes nothing', async () => {
    await vaultStore.setMeta({ ...META, keys: [key(1), key(2), key(3)] })
    await expect(vaultStore.removeKey('nope')).rejects.toMatchObject({ code: 'not-enrolled' })
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  it('renameKey changes only the nickname', async () => {
    await vaultStore.setMeta(META)
    const next = await vaultStore.renameKey('10000002', 'Safe')
    expect(next.keys[1]).toEqual({ ...key(2), nickname: 'Safe' })
    expect(next.keys[0]).toEqual(key(1))
  })

  it('noteLastUsed stamps serial and time, and is a no-op with no meta', async () => {
    await vaultStore.noteLastUsed('10000001') // nothing enrolled yet
    expect(await vaultStore.getMeta()).toBeNull()

    await vaultStore.setMeta(META)
    const before = Date.now()
    await vaultStore.noteLastUsed('10000002')
    const meta = (await vaultStore.getMeta())!
    expect(meta.lastUsedSerial).toBe('10000002')
    expect(meta.lastUsedAt).toBeGreaterThanOrEqual(before)
  })

  it('migrateLegacySeal deletes the SecureStore seal and swallows errors', async () => {
    secureItems['vault_seal_v1'] = 'legacy-sealed-blob'
    await vaultStore.migrateLegacySeal()
    expect(secureItems['vault_seal_v1']).toBeUndefined()

    ;(SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keychain locked'))
    await expect(vaultStore.migrateLegacySeal()).resolves.toBeUndefined()
  })

  it('clear() removes the meta (and any legacy seal) so isEnrolled is false', async () => {
    await vaultStore.setMeta(META)
    secureItems['vault_seal_v1'] = 'legacy'
    await vaultStore.clear()
    expect(await vaultStore.getMeta()).toBeNull()
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(secureItems['vault_seal_v1']).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/vaultStore.test.ts` → fails: `TypeError: _vaultStore.vaultStore.addKey is not a function` (and the v5 round-trip returns null).

- [ ] **Step 3: Rewrite `vaultStore.ts`**

```ts
/**
 * Vault persistence — the enrolled key list.
 *
 * Meta v5 lives in AsyncStorage under the unchanged key 'vault_meta_v1'. It is
 * PUBLIC data only: serials, compressed P-256 public keys, nicknames, and
 * timestamps. There is no seed, no seal and no passphrase anywhere in this
 * design (spec D2): the YubiKeys ARE the keys, and each output's salt lives
 * in the wallet database's customInstructions, not here.
 *
 * Anything whose `v` is not 5 reads as "not enrolled" (a K1-era v4 record is
 * ignored, spec §8). The K1 design's SecureStore seal ('vault_seal_v1') is
 * removed by `migrateLegacySeal`, which VaultProvider calls once on mount.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { VaultError } from './types'

const LEGACY_SEAL_KEY = 'vault_seal_v1'
const META_KEY = 'vault_meta_v1'

/** How many keys may be enrolled (spec D3). Mirrored by VaultKeyService's
 * VAULT_MIN_KEYS / VAULT_MAX_KEYS; kept local so this module imports no
 * service. */
const MIN_KEYS = 2
const MAX_KEYS = 5

export interface VaultKeyRecord {
  serial: string
  slot: number
  /** 33-byte compressed P-256 public key, lowercase hex (compressPubkey). */
  pubkey: string
  nickname: string
  enrolledAt: number
}

export interface VaultMetaV5 {
  v: 5
  createdAt: number
  lastUsedAt?: number
  lastUsedSerial?: string
  keys: VaultKeyRecord[]
}

export type VaultMeta = VaultMetaV5

async function requireMeta(): Promise<VaultMeta> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  return meta
}

export const vaultStore = {
  /** Meta-only: there is nothing else an enrollment consists of. */
  async isEnrolled(): Promise<boolean> {
    return (await vaultStore.getMeta()) != null
  },

  async getMeta(): Promise<VaultMeta | null> {
    const raw = await AsyncStorage.getItem(META_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; keys?: unknown }
      return parsed?.v === 5 && Array.isArray(parsed.keys) ? (parsed as VaultMeta) : null
    } catch {
      return null
    }
  },

  async setMeta(m: VaultMeta): Promise<void> {
    await AsyncStorage.setItem(META_KEY, JSON.stringify(m))
  },

  async addKey(k: VaultKeyRecord): Promise<VaultMeta> {
    const meta = await requireMeta()
    if (meta.keys.length >= MAX_KEYS) {
      throw new VaultError('too-many-keys', `The vault already has ${MAX_KEYS} keys`)
    }
    if (meta.keys.some(x => x.serial === k.serial)) {
      throw new VaultError('key-already-enrolled', k.serial, undefined, { serial: k.serial })
    }
    const next: VaultMeta = { ...meta, keys: [...meta.keys, k] }
    await vaultStore.setMeta(next)
    return next
  },

  async removeKey(serial: string): Promise<VaultMeta> {
    const meta = await requireMeta()
    if (meta.keys.length <= MIN_KEYS) {
      throw new VaultError('last-keys', `A vault needs at least ${MIN_KEYS} keys`)
    }
    if (!meta.keys.some(x => x.serial === serial)) {
      throw new VaultError('not-enrolled', `Key ${serial} is not enrolled`)
    }
    const next: VaultMeta = { ...meta, keys: meta.keys.filter(x => x.serial !== serial) }
    if (next.lastUsedSerial === serial) delete next.lastUsedSerial
    await vaultStore.setMeta(next)
    return next
  },

  async renameKey(serial: string, nickname: string): Promise<VaultMeta> {
    const meta = await requireMeta()
    const next: VaultMeta = { ...meta, keys: meta.keys.map(x => (x.serial === serial ? { ...x, nickname } : x)) }
    await vaultStore.setMeta(next)
    return next
  },

  /** Remember which key opened the vault last, so the withdraw chooser can
   * default to it. Silently skipped when nothing is enrolled. */
  async noteLastUsed(serial: string): Promise<void> {
    const meta = await vaultStore.getMeta()
    if (!meta) return
    await vaultStore.setMeta({ ...meta, lastUsedAt: Date.now(), lastUsedSerial: serial })
  },

  /** Remove the K1-era sealed blob from the Keychain. Idempotent and silent:
   * a locked Keychain must not stop the app from mounting. */
  async migrateLegacySeal(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(LEGACY_SEAL_KEY)
    } catch {
      /* best-effort */
    }
  },

  /** Forget the key list (Disable vault). The keys stay on the YubiKeys. */
  async clear(): Promise<void> {
    await vaultStore.migrateLegacySeal()
    await AsyncStorage.removeItem(META_KEY)
  }
}
```

- [ ] **Step 4: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/vaultStore.test.ts` → `16 passed`.

- [ ] **Step 5: Failing mount test for VaultProvider**

`T/__tests__/context/vaultProviderMigration.test.tsx`:

```tsx
/**
 * VaultProvider removes the K1-era SecureStore seal once, on mount (spec
 * §3.2). Everything else the provider touches is mocked away: the point is
 * the single migrateLegacySeal() call, not the ceremony wiring.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en', languageTag: 'en-US' }] }))
jest.mock('../../core/hooks/useConfirmationSound', () => ({
  sounds: { vaultOpen: jest.fn(), vaultClose: jest.fn() }
}))
jest.mock('../../core/hooks/useHaptics', () => ({
  haptics: { success: jest.fn(), confirm: jest.fn() }
}))
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  ceremony: {
    state: { phase: 'idle' },
    subscribe: (cb: (s: unknown) => void) => {
      cb({ phase: 'idle' })
      return () => {}
    },
    submitPin: jest.fn(),
    cancel: jest.fn(),
    retry: jest.fn()
  }
}))

import React from 'react'
import { act, create } from 'react-test-renderer'
import * as SecureStore from 'expo-secure-store'
import { VaultProvider } from '../../core/context/VaultContext'

test('VaultProvider deletes vault_seal_v1 once on mount', async () => {
  await act(async () => {
    create(
      <VaultProvider>
        <></>
      </VaultProvider>
    )
  })
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1)
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('vault_seal_v1')
})
```

- [ ] **Step 6: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/context/vaultProviderMigration.test.tsx` → fails: `Expected number of calls: 1, Received number of calls: 0`.

- [ ] **Step 7: Wire the mount call**

In `T/core/context/VaultContext.tsx`, add after line 15 (`import { CeremonyState } ...`):

```ts
import { vaultStore } from '../services/vault/vaultStore'
```

and after line 47 (`useEffect(() => ceremony.subscribe(setState), [])`) add:

```ts
  // One-time cleanup of the K1-era sealed blob (spec §3.2). Fire-and-forget:
  // migrateLegacySeal swallows its own errors.
  useEffect(() => {
    void vaultStore.migrateLegacySeal()
  }, [])
```

Also replace the comment at lines 49–54 with:

```ts
  // Effects of a completed ceremony: the open cue, and nothing else. `onArmed`
  // deliberately ignores its VaultSigner argument — the signer is owned by the
  // transfer that requested it (transfers.ts obtains it from ceremonyHost) and
  // must never reach React state (see VaultSigner in services/vault/ceremony.ts).
```

- [ ] **Step 8: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/context/vaultProviderMigration.test.tsx packages/expo-wallet-toolbox/__tests__/vault/vaultStore.test.ts` → all pass.
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'VaultKeyService.ts\|ceremonyHost.ts\|transfers.ts\|ui/screens/VaultScreen.tsx'` → empty (only the allowed residuals remain).

- [ ] **Step 9: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/vaultStore.ts packages/expo-wallet-toolbox/core/context/VaultContext.tsx packages/expo-wallet-toolbox/__tests__/vault/vaultStore.test.ts packages/expo-wallet-toolbox/__tests__/context/vaultProviderMigration.test.tsx
git commit -m "feat(expo-wallet-toolbox)!: vault meta v5 key list, migrateLegacySeal" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: driver `start(message?)` / `'cached'`, rejecting `withKeySession`, multi-serial mock, dev present-key selector

**Files:**
- Modify: `T/core/services/vault/driver.ts` (interface lines 27–50; `NativeYubiKeyPiv` 54–67; `adaptNative` 111–169)
- Modify: `T/core/services/vault/session.ts` (whole file)
- Modify: `T/core/services/vault/mockYubiKey.ts` (whole file)
- Modify: `T/core/services/vault/devMock.ts` (whole file)
- Test: `T/__tests__/vault/mockYubiKey.test.ts` (edit), `T/__tests__/vault/session.test.ts` (create), `T/__tests__/vault/devMock.test.ts` (create)

**Interfaces:**
- Produces: `VaultDriver` per contract (no `ecdh`, `start(message?: string)`); `withKeySession<T>(driver, work, onWaiting?, opts?: { nfcMessage?: string; attachTimeoutMs?: number })` — the 4th parameter is an ADDITIVE optional extension (the contract asks for an injectable timeout without naming the seam; flagged in the summary); `MockYubiKey` with per-serial records and a test-visible `startMessage` getter; `setMockDriverEnabled(on: boolean)`, `setMockPresentKey(serial: MockPresentKey)`, `getMockPresentKey(): MockPresentKey`, `export type MockPresentKey = 'MOCK-DEV-1' | 'MOCK-DEV-2' | 'MOCK-DEV-3'`.
- Allowed tsc residuals after this commit: Task 3's list plus `ceremony.ts` (`driver.ecdh`, `seal`), which Task 6 rewrites.

- [ ] **Step 1: Edit `mockYubiKey.test.ts`**

(a) Delete line 11 (`import { sealVaultKey, unsealVaultKey } from '../../core/services/vault/sealing'`).
(b) Delete the whole `describe('ecdh', ...)` block (lines 209–250).
(c) Replace the `generateVaultKey policy` describe (lines 252–285) with:

```ts
// ── generateVaultKey policy + start(message) forwarding (R1C) ──
describe('native adapter', () => {
  const nativeFake = (calls: unknown[][]) => ({
    isSupported: () => true,
    startDiscovery: (message: string) => {
      calls.push(['startDiscovery', message])
    },
    stopDiscovery: () => {},
    setKeyListener: () => {},
    clearKeyListener: () => {},
    getKeyInfo: async () => '{}',
    verifyPin: async () => '{}',
    changePin: async () => '{}',
    generateVaultKey: async (...args: unknown[]) => {
      calls.push(['generateVaultKey', ...args])
      return JSON.stringify({ publicKey: '04' + '11'.repeat(64) })
    },
    readVaultPublicKey: async () => '{"publicKey":null}',
    signEcdsa: async () => '{}'
  })

  it('generates with touch policy cached and pin policy once (spec D6)', async () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')

    await getVaultDriver()!.generateVaultKey(0x82)

    // The card signs on-chain now, up to VAULT_INPUTS_PER_TAP digests per tap,
    // so ONE touch must cover a whole batch: 'cached' keeps the touch valid
    // for the card's 15 s window. 'always' would demand a touch per input.
    expect(calls[0]).toEqual(['generateVaultKey', 0x82, 'cached', 'once'])
  })

  it('forwards the NFC alert text to startDiscovery, and an empty string when none is given', () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')

    getVaultDriver()!.start('Hold your YubiKey here to sign')
    getVaultDriver()!.start()
    expect(calls).toEqual([
      ['startDiscovery', 'Hold your YubiKey here to sign'],
      ['startDiscovery', '']
    ])
  })

  it('exposes no ecdh on the driver', () => {
    const calls: unknown[][] = []
    jest.doMock('react-native-yubikey', () => ({ getYubiKeyPiv: () => nativeFake(calls) }))
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getVaultDriver } = require('../../core/services/vault/driver')
    expect((getVaultDriver() as unknown as Record<string, unknown>).ecdh).toBeUndefined()
  })
})
```

(d) Append a multi-serial suite at the end of the `describe('MockYubiKey', ...)` block (after the `attach/detach events` test, before its closing `})`):

```ts
  test('keeps one record per serial: insertKey switches keys, PINs and retries', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('A')
    const { publicKey: pubA } = await mock.generateVaultKey(0x82)
    mock.setPin('111111')

    mock.insertKey('B')
    expect(await mock.readVaultPublicKey(0x82)).toBeNull() // B has no key yet
    const { publicKey: pubB } = await mock.generateVaultKey(0x82)
    expect(pubB).not.toBe(pubA)
    // B still has the default PIN; A's change did not leak across serials.
    expect((await mock.verifyPin('123456')).ok).toBe(true)
    expect((await mock.verifyPin('111111')).ok).toBe(false)

    mock.insertKey('A')
    expect((await mock.readVaultPublicKey(0x82))!.publicKey).toBe(pubA)
    expect((await mock.verifyPin('111111')).ok).toBe(true)
  })

  test('re-inserting a serial does not reset its PIN verification or its lockout', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('A')
    await mock.generateVaultKey(0x82)
    await mock.verifyPin('123456')
    mock.insertKey('B')
    mock.insertKey('A')
    // pinPolicy=once is per session: a swap ends the session, so the PIN must
    // be presented again.
    await expect(mock.signEcdsa(0x82, '', 'ab'.repeat(32))).rejects.toMatchObject({ code: 'pin-required' })

    mock.insertKey('L')
    await mock.verifyPin('000000')
    await mock.verifyPin('000000')
    await mock.verifyPin('000000')
    mock.insertKey('A')
    mock.insertKey('L')
    expect((await mock.getKeyInfo()).pinRetries).toBe(0) // still locked after a re-tap
  })

  test('signEcdsa signs with the CURRENT serial key', async () => {
    const mock = new MockYubiKey()
    mock.insertKey('A')
    await mock.generateVaultKey(0x82)
    mock.insertKey('B')
    const { publicKey: pubB } = await mock.generateVaultKey(0x82)
    await mock.verifyPin('123456')
    const digest = 'cd'.repeat(32)
    const { signature } = await mock.signEcdsa(0x82, '123456', digest)
    const sig = p256.Signature.fromBytes(Uint8Array.from(Utils.toArray(signature, 'hex')), 'der')
    const compressedB = p256.Point.fromBytes(Uint8Array.from(Utils.toArray(pubB, 'hex'))).toBytes(true)
    expect(p256.verify(sig.toBytes(), Uint8Array.from(Utils.toArray(digest, 'hex')), compressedB, { prehash: false, lowS: false })).toBe(true)
  })

  test('start(message) records the alert text for tests to read', () => {
    const mock = new MockYubiKey()
    mock.start('Hold your YubiKey here')
    expect(mock.startMessage).toBe('Hold your YubiKey here')
  })
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts` → fails: the policy test with `Expected: [..., 'cached', 'once'] Received: [..., 'always', 'once']`, the forwarding test with `Received: [['startDiscovery', undefined], ...]`, the multi-serial test with `expect(received).toBeNull()` on B's slot (the single-slot mock keeps A's key), `mock.startMessage` undefined.

- [ ] **Step 3: Edit `driver.ts`**

Replace lines 27–50 (the `VaultDriver` interface) with:

```ts
export interface VaultDriver {
  isSupported(): boolean
  /** True when the transport is a modal per-ceremony session (iOS NFC: start()
   * shows the scan sheet, stop() dismisses it) rather than a persistent reader
   * (Android USB, mock). Session-based drivers are started only when a ceremony
   * begins — never at launch — and stopped when it arms or fails. */
  sessionBased: boolean
  /** Open discovery. `message` is the localised NFC alert text shown on the
   * iOS scan sheet for this session (spec §4.2 step 6); persistent readers and
   * Android ignore it. */
  start(message?: string): void
  stop(): void
  onKeyEvent(cb: (e: KeyEvent) => void): () => void
  getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }>
  verifyPin(pin: string): Promise<{ ok: boolean; retriesLeft: number }>
  changePin(oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }>
  /** Generate a fresh P-256 key in `slot`, replacing whatever was there. The
   * adapter passes touch policy 'cached' and PIN policy 'once' (spec D6). */
  generateVaultKey(slot: number): Promise<{ publicKey: string }>
  readVaultPublicKey(slot: number): Promise<{ publicKey: string } | null>
  /** Sign a pre-computed 32-byte digest (64 hex chars) with the slot's P-256
   * key. Returns a DER signature as hex. TOUCH-gated, PIN-gated. */
  signEcdsa(slot: number, pin: string, digest: string): Promise<{ signature: string }>
}
```

Replace lines 54–67 (`NativeYubiKeyPiv`) with:

```ts
interface NativeYubiKeyPiv {
  isSupported(): boolean
  startDiscovery(message: string): void
  stopDiscovery(): void
  setKeyListener(listener: (eventType: string, serial: string, transport: string) => void): void
  clearKeyListener(): void
  getKeyInfo(): Promise<string>
  verifyPin(pin: string): Promise<string>
  changePin(oldPin: string, newPin: string): Promise<string>
  generateVaultKey(slot: number, touchPolicy: string, pinPolicy: string): Promise<string>
  readVaultPublicKey(slot: number): Promise<string>
  signEcdsa(slot: number, pin: string, digest: string): Promise<string>
  // The native `ecdh` method may still exist; nothing in the TS layer calls it.
}
```

In `adaptNative`: change `start: () => {` (line 124) to `start: (message?: string) => {`, and `native.startDiscovery()` (line 133) to `native.startDiscovery(message ?? '')`. Replace lines 154–161 (the `'always'` comment + `generateVaultKey`) with:

```ts
    // 'cached' (spec D6): the card signs every vault input on-chain, up to
    // VAULT_INPUTS_PER_TAP digests per tap, so one touch must cover a batch —
    // the card keeps a touch valid for 15 s. 'always' would need a touch per
    // input. 'once' lets the PIN verified at session start cover the batch.
    generateVaultKey: slot => parse(native.generateVaultKey(slot, 'cached', 'once')),
```

Delete line 166 (`ecdh: (slot, pin, peer) => parse(native.ecdh(slot, pin, peer)),`).

- [ ] **Step 4: Rewrite `mockYubiKey.ts`**

```ts
/**
 * Software YubiKey for development and tests.
 *
 * Implements VaultDriver against in-memory P-256 keypairs — ONE RECORD PER
 * SERIAL, so a test (or the DEV present-key selector) can stand in for a
 * multi-key vault by switching serials with insertKey(). Emulates the
 * behaviours the real ceremony must survive: PIN retries and lockout per key,
 * touch timeouts, key removal mid-operation, and DER signatures exactly like
 * both real platforms (not low-S normalised).
 *
 * DEV/test only. Never bundled into a path a production user reaches.
 */
import { p256 } from '@noble/curves/nist.js'
import { Utils } from '@bsv/sdk'
import { VaultDriver, KeyEvent } from './driver'
import { VaultError } from './types'

type TouchBehavior = 'instant' | 'timeout'

const DEFAULT_PIN = '123456'

interface MockKeyRecord {
  priv: Uint8Array | null
  pub: string | null
  pin: string
  pinRetries: number
  pinVerified: boolean
}

const freshRecord = (): MockKeyRecord => ({ priv: null, pub: null, pin: DEFAULT_PIN, pinRetries: 3, pinVerified: false })

export class MockYubiKey implements VaultDriver {
  private listeners = new Set<(e: KeyEvent) => void>()
  private present = false
  private serial = 'MOCK-1'
  private keys = new Map<string, MockKeyRecord>()
  private touch: TouchBehavior = 'instant'
  private lastStartMessage: string | undefined

  /** The current serial's record, created on first use. */
  private record(): MockKeyRecord {
    let r = this.keys.get(this.serial)
    if (!r) {
      r = freshRecord()
      this.keys.set(this.serial, r)
    }
    return r
  }

  // ---- test controls ---------------------------------------------------
  /** Present the key with this serial (creating its record on first use). A
   * swap ends the previous session, so PIN verification resets; the record's
   * own PIN and lockout state persist like a real card's would. */
  insertKey(serial = 'MOCK-1'): void {
    if (this.present) this.record().pinVerified = false
    this.serial = serial
    this.present = true
    this.record().pinVerified = false
    this.emit({ type: 'attached', serial, transport: 'mock' })
  }

  removeKey(): void {
    if (!this.present) return
    const serial = this.serial
    this.present = false
    this.record().pinVerified = false
    this.emit({ type: 'detached', serial, transport: 'mock' })
  }

  setTouchBehavior(b: TouchBehavior): void {
    this.touch = b
  }

  /** Set the CURRENT serial's PIN. */
  setPin(pin: string): void {
    this.record().pin = pin
  }

  /** Simulate the NFC session dying before any key connected — the system
   * scan sheet being cancelled (user-cancelled) or timing out / failing to
   * present (no-key). Mirrors the real adapter's `failed:<code>` events from
   * the native didFailConnectingNFC handler. */
  failSession(code: 'user-cancelled' | 'no-key'): void {
    this.emit({ type: 'session-failed', code, transport: 'mock' })
  }

  /** Simulate a slot that already holds a key on the current serial (e.g. an
   * age-plugin-yubikey identity in retired slot 82). generateVaultKey replaces
   * it — spec D6 never adopts an existing key. */
  occupySlot(): void {
    const r = this.record()
    r.priv = p256.utils.randomSecretKey()
    r.pub = Utils.toHex(Array.from(p256.getPublicKey(r.priv, false)))
  }

  /** The last NFC alert text passed to start(), for tests. */
  get startMessage(): string | undefined {
    return this.lastStartMessage
  }

  // ---- VaultDriver -----------------------------------------------------
  isSupported(): boolean {
    return true
  }

  /** The mock behaves like a persistent reader (insert/remove under test). */
  sessionBased = false

  start(message?: string): void {
    this.lastStartMessage = message
    // Session-based flows (NFC) call start() to open a scan session and wait
    // for the tap to connect. Simulate that: if a key is "held", emit attached
    // now. Persistent flows never rely on this (they see the key via getKeyInfo).
    if (this.sessionBased && this.present) {
      this.emit({ type: 'attached', serial: this.serial, transport: 'mock' })
    }
  }

  stop(): void {
    // Matches the real adapter's contract (driver.ts adaptNative.stop): do NOT
    // clear listeners. App subscribers (WalletContext, and the ceremony's own
    // mid-flight NFC retry/batch loop) stay subscribed across a session-based
    // transport's stop/start cycles.
  }

  onKeyEvent(cb: (e: KeyEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async getKeyInfo(): Promise<{ serial: string; firmwareVersion: string; pinRetries: number }> {
    this.requirePresent()
    return { serial: this.serial, firmwareVersion: '5.7.1', pinRetries: this.record().pinRetries }
  }

  async verifyPin(pin: string): Promise<{ ok: boolean; retriesLeft: number }> {
    this.requirePresent()
    const r = this.record()
    if (r.pinRetries <= 0) throw new VaultError('pin-locked', 'PIN is blocked')
    if (pin === r.pin) {
      r.pinRetries = 3
      r.pinVerified = true
      return { ok: true, retriesLeft: 3 }
    }
    r.pinRetries -= 1
    r.pinVerified = false
    return { ok: false, retriesLeft: r.pinRetries }
  }

  async changePin(oldPin: string, newPin: string): Promise<{ ok: boolean; retriesLeft: number }> {
    this.requirePresent()
    const r = this.record()
    if (r.pinRetries <= 0) throw new VaultError('pin-locked', 'PIN is blocked')
    if (oldPin !== r.pin) {
      r.pinRetries -= 1
      throw new VaultError('pin-invalid', 'Wrong PIN', r.pinRetries)
    }
    r.pin = newPin
    r.pinRetries = 3
    return { ok: true, retriesLeft: 3 }
  }

  async generateVaultKey(_slot: number): Promise<{ publicKey: string }> {
    this.requirePresent()
    const r = this.record()
    r.priv = p256.utils.randomSecretKey()
    r.pub = Utils.toHex(Array.from(p256.getPublicKey(r.priv, false)))
    return { publicKey: r.pub }
  }

  async readVaultPublicKey(_slot: number): Promise<{ publicKey: string } | null> {
    this.requirePresent()
    const r = this.record()
    return r.pub ? { publicKey: r.pub } : null
  }

  /** Software stand-in for the card's GENERAL AUTHENTICATE.
   *
   * Emits DER, exactly like both real platforms, so a DER-parsing bug cannot
   * hide behind the mock. Enforces the same 32-byte digest rule the native
   * modules do — on iOS an unrecognised algorithm constant silently signs 32
   * ZERO bytes, and on Android an over-long payload is silently truncated.
   *
   * `lowS: false` is passed explicitly: real YubiKey PIV hardware does not
   * normalise — roughly half of real signatures are high-S — and the R1C
   * script accepts both (spec §2.5). A mock that only emitted low-S could not
   * catch downstream code that mishandles a non-canonical signature.
   */
  async signEcdsa(_slot: number, pin: string, digest: string): Promise<{ signature: string }> {
    this.requirePresent()
    const r = this.record()
    if (!r.pinVerified) {
      if (!pin) throw new VaultError('pin-required', 'PIN required before signing')
      const res = await this.verifyPin(pin)
      if (!res.ok) throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
    }
    if (!r.priv) throw new VaultError('no-key', 'No key in slot')

    const bytes = Utils.toArray(digest, 'hex')
    if (bytes.length !== 32) {
      throw new VaultError('template-invalid', `Digest must be 32 bytes, got ${bytes.length}`)
    }
    if (this.touch === 'timeout') throw new VaultError('touch-timeout', 'Touch not detected')

    const raw = p256.sign(Uint8Array.from(bytes), r.priv, { prehash: false, lowS: false })
    const der = p256.Signature.fromBytes(raw).toBytes('der')
    return { signature: Utils.toHex(Array.from(der)) }
  }

  // ---- internals -------------------------------------------------------
  private requirePresent(): void {
    if (!this.present) throw new VaultError('no-key', 'No YubiKey present')
  }

  private emit(e: KeyEvent): void {
    this.listeners.forEach(cb => cb(e))
  }
}
```

- [ ] **Step 5: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts` → all pass (`MockYubiKey` 7, `getVaultDriver` 2, `mapNativeKeyEvent` 7, `signEcdsa` 7, `native adapter` 3).

- [ ] **Step 6: Failing `session.test.ts`**

```ts
/**
 * withKeySession — the one-tap bracket enrollment runs inside. It used to wait
 * forever when the NFC sheet was cancelled or died; it now rejects (spec §3.3
 * step 2): session-failed → user-cancelled / no-key, detached before `work`
 * resolves → key-removed-mid-op, silence past the watchdog → no-key.
 */
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { withKeySession } from '../../core/services/vault/session'

const nfcMock = (): MockYubiKey => {
  const m = new MockYubiKey()
  ;(m as unknown as { sessionBased: boolean }).sessionBased = true
  return m
}
const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('withKeySession', () => {
  test('persistent reader: runs work immediately, no start/stop', async () => {
    const m = new MockYubiKey()
    const startSpy = jest.spyOn(m, 'start')
    const stopSpy = jest.spyOn(m, 'stop')
    expect(await withKeySession(m, async () => 42)).toBe(42)
    expect(startSpy).not.toHaveBeenCalled()
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('NFC: waits for attach, runs work, then stops; forwards the alert text', async () => {
    const m = nfcMock()
    const stopSpy = jest.spyOn(m, 'stop')
    const order: string[] = []
    const p = withKeySession(
      m,
      async () => {
        order.push('work')
        return 'ok'
      },
      () => order.push('waiting'),
      { nfcMessage: 'Hold your YubiKey here to set it up' }
    )
    await flush()
    expect(m.startMessage).toBe('Hold your YubiKey here to set it up')
    m.insertKey('MOCK-1')
    expect(await p).toBe('ok')
    expect(order).toEqual(['waiting', 'work'])
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('NFC: the user cancelling the system sheet rejects with user-cancelled and stops', async () => {
    const m = nfcMock()
    const stopSpy = jest.spyOn(m, 'stop')
    const p = withKeySession(m, async () => 'never')
    await flush()
    m.failSession('user-cancelled')
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('NFC: a session dying with no key rejects with no-key', async () => {
    const m = nfcMock()
    const p = withKeySession(m, async () => 'never')
    await flush()
    m.failSession('no-key')
    await expect(p).rejects.toMatchObject({ code: 'no-key' })
  })

  test('NFC: the key detaching while work is in flight rejects with key-removed-mid-op', async () => {
    const m = nfcMock()
    let finish!: () => void
    const p = withKeySession(m, () => new Promise<string>(resolve => {
      finish = () => resolve('late')
    }))
    await flush()
    m.insertKey('MOCK-1')
    await flush()
    m.removeKey()
    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    finish() // the abandoned work settling later changes nothing
  })

  test('NFC: silence past attachTimeoutMs rejects with no-key', async () => {
    const m = nfcMock()
    const p = withKeySession(m, async () => 'never', undefined, { attachTimeoutMs: 30 })
    await expect(p).rejects.toMatchObject({ code: 'no-key' })
  })

  test('NFC: a detach AFTER work resolved is ignored', async () => {
    const m = nfcMock()
    const p = withKeySession(m, async () => 'done')
    await flush()
    m.insertKey('MOCK-1')
    expect(await p).toBe('done')
    expect(() => m.removeKey()).not.toThrow()
  })
})
```

- [ ] **Step 7: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/session.test.ts` → the cancel / no-key / detach / watchdog cases time out (`Exceeded timeout of 5000 ms`) and `m.startMessage` is `undefined`.

- [ ] **Step 8: Rewrite `session.ts`**

```ts
/**
 * Run a block of token operations against a live key connection, hiding the
 * transport difference:
 *
 * - **session-based (iOS NFC):** the scan sheet is a system modal that covers
 *   the app, so you cannot collect a PIN while it is up. Callers MUST gather all
 *   user input (PIN, new PIN, nickname) BEFORE calling this; then this opens the
 *   NFC session, waits for the tap to connect, runs every token op in that one
 *   tap, and always closes the session afterwards (dismissing the sheet).
 * - **persistent (Android USB / mock):** the key is already on the reader, so
 *   `work` runs immediately; the reader's lifecycle is left untouched
 *   (WalletContext owns it for relock-on-unplug).
 *
 * `onWaiting` fires when we begin waiting for the tap, so the UI can prompt
 * "hold your key to the top of your phone". `opts.nfcMessage` is the localised
 * text the iOS scan sheet itself shows.
 *
 * This REJECTS instead of waiting forever (spec §3.3 step 2): the system sheet
 * being cancelled → user-cancelled; the session dying with no key → no-key; the
 * key leaving mid-`work` → key-removed-mid-op; and nothing at all arriving by
 * the watchdog deadline → no-key (CoreNFC caps a session at 60 s; YubiKit
 * swallows several failure paths, so no delegate fix makes this redundant).
 */
import { VaultDriver } from './driver'
import { VaultError } from './types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const DEFAULT_ATTACH_TIMEOUT_MS = 65_000

export async function withKeySession<T>(
  driver: VaultDriver,
  work: () => Promise<T>,
  onWaiting?: () => void,
  opts?: { nfcMessage?: string; attachTimeoutMs?: number }
): Promise<T> {
  if (!driver.sessionBased) {
    return work()
  }
  const connected = defer<void>()
  // Rejects when the key leaves before `work` has resolved; raced against it.
  const detached = defer<never>()
  detached.promise.catch(() => {}) // never unhandled — it only matters inside the race
  let connectedYet = false
  const off = driver.onKeyEvent(e => {
    if (e.type === 'attached') {
      connectedYet = true
      connected.resolve()
    } else if (e.type === 'session-failed') {
      connected.reject(new VaultError(e.code === 'user-cancelled' ? 'user-cancelled' : 'no-key'))
    } else if (e.type === 'detached') {
      const err = new VaultError('key-removed-mid-op', 'YubiKey removed during the operation')
      if (!connectedYet) connected.reject(err)
      detached.reject(err)
    }
  })
  const watchdog = setTimeout(
    () => connected.reject(new VaultError('no-key', 'No key connected before the NFC session deadline')),
    opts?.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
  )
  ;(watchdog as { unref?: () => void }).unref?.()
  onWaiting?.()
  driver.start(opts?.nfcMessage)
  try {
    await connected.promise
    clearTimeout(watchdog)
    return await Promise.race([work(), detached.promise])
  } finally {
    clearTimeout(watchdog)
    off()
    try {
      driver.stop()
    } catch {
      /* stop is best-effort — dismissing the sheet must never throw */
    }
  }
}
```

- [ ] **Step 9: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/session.test.ts` → `7 passed`.

- [ ] **Step 10: Failing `devMock.test.ts`**

```ts
/**
 * DEV mock wiring: one module-held MockYubiKey that survives toggles (so the
 * keys "generated" on MOCK-DEV-1/2/3 persist within the session) and a
 * present-key selector the wallet-config DEV row drives.
 */
import { getVaultDriver } from '../../core/services/vault/driver'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { getMockPresentKey, setMockDriverEnabled, setMockPresentKey } from '../../core/services/vault/devMock'

afterEach(() => setMockDriverEnabled(false))

test('enabling installs a MockYubiKey with MOCK-DEV-1 present by default', async () => {
  setMockDriverEnabled(true)
  const d = getVaultDriver()
  expect(d).toBeInstanceOf(MockYubiKey)
  expect((await d!.getKeyInfo()).serial).toBe('MOCK-DEV-1')
  expect(getMockPresentKey()).toBe('MOCK-DEV-1')
})

test('setMockPresentKey switches the present serial on the live mock', async () => {
  setMockDriverEnabled(true)
  setMockPresentKey('MOCK-DEV-2')
  expect((await getVaultDriver()!.getKeyInfo()).serial).toBe('MOCK-DEV-2')
  expect(getMockPresentKey()).toBe('MOCK-DEV-2')
})

test('keys generated on a serial survive a disable/enable cycle', async () => {
  setMockDriverEnabled(true)
  setMockPresentKey('MOCK-DEV-3')
  const { publicKey } = await getVaultDriver()!.generateVaultKey(0x82)
  setMockDriverEnabled(false)
  expect(getVaultDriver()).toBeNull()
  setMockDriverEnabled(true)
  expect((await getVaultDriver()!.readVaultPublicKey(0x82))!.publicKey).toBe(publicKey)
  expect(getMockPresentKey()).toBe('MOCK-DEV-3')
})

test('selecting a key while the mock is off only records the choice', () => {
  setMockPresentKey('MOCK-DEV-2')
  expect(getVaultDriver()).toBeNull()
  expect(getMockPresentKey()).toBe('MOCK-DEV-2')
})
```

- [ ] **Step 11: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/devMock.test.ts` → fails: `(0 , _devMock.setMockPresentKey) is not a function`.

- [ ] **Step 12: Rewrite `devMock.ts`**

```ts
/**
 * DEV-only convenience: run the whole vault stack against the software mock
 * YubiKey without hardware. Toggled from wallet-config (DEV builds only).
 *
 * ONE module-held MockYubiKey: its per-serial records (generated keys, PINs)
 * survive toggling the driver off and on within the session, so a vault
 * enrolled with MOCK-DEV-1 and MOCK-DEV-2 can be exercised by switching the
 * "present" key with setMockPresentKey — the DEV wallet-config row's selector.
 * Kept in its own module so driver.ts never imports the mock.
 */
import { setMockDriver } from './driver'
import { MockYubiKey } from './mockYubiKey'

export type MockPresentKey = 'MOCK-DEV-1' | 'MOCK-DEV-2' | 'MOCK-DEV-3'

let instance: MockYubiKey | null = null
let present: MockPresentKey = 'MOCK-DEV-1'

export function setMockDriverEnabled(on: boolean): void {
  if (on) {
    if (!instance) instance = new MockYubiKey()
    instance.insertKey(present)
    setMockDriver(instance)
  } else {
    setMockDriver(null)
  }
}

/** Which of the three dev keys is "held to the phone". Applies immediately
 * when the mock is installed; otherwise remembered for the next enable. */
export function setMockPresentKey(serial: MockPresentKey): void {
  present = serial
  instance?.insertKey(serial)
}

export function getMockPresentKey(): MockPresentKey {
  return present
}
```

- [ ] **Step 13: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/devMock.test.ts packages/expo-wallet-toolbox/__tests__/vault/session.test.ts packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts` → all pass.
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'VaultKeyService.ts\|ceremonyHost.ts\|transfers.ts\|ceremony.ts\|ui/screens/VaultScreen.tsx'` → empty.

- [ ] **Step 14: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/driver.ts packages/expo-wallet-toolbox/core/services/vault/session.ts packages/expo-wallet-toolbox/core/services/vault/mockYubiKey.ts packages/expo-wallet-toolbox/core/services/vault/devMock.ts packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts packages/expo-wallet-toolbox/__tests__/vault/session.test.ts packages/expo-wallet-toolbox/__tests__/vault/devMock.test.ts
git commit -m "feat(expo-wallet-toolbox)!: cached-touch driver, rejecting withKeySession, multi-serial mock" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Native NFC alert text — `startDiscovery(message)`

**Files:**
- Modify: `Y/src/specs/YubiKeyPiv.nitro.ts` line 5
- Modify: `Y/ios/HybridYubiKeyPiv.swift` lines 64–77 (`startDiscovery`) and lines 308–310 (stale `ALWAYS` comment in the ecdh path)
- Modify: `Y/android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt` line 79 (`startDiscovery`) and lines 296–298 (stale `ALWAYS` comment)
- Regenerate: `Y/nitrogen/generated/**`

**Interfaces:**
- Produces: nitro `startDiscovery(message: string): void`; Swift `func startDiscovery(message: String) throws`; Kotlin `override fun startDiscovery(message: String)`.

No jest covers native code; the checks are codegen + grep + a build.

- [ ] **Step 1: Spec**

In `Y/src/specs/YubiKeyPiv.nitro.ts` replace line 5 with:

```ts
  /** Open discovery. `message` is the localised text the iOS NFC scan sheet
   * shows for this session (set from JS per tap — spec §4.2 step 6); Android
   * ignores it (system NFC has no per-session prompt, USB has none). An empty
   * string selects the native default wording. */
  startDiscovery(message: string): void
```

- [ ] **Step 2: Regenerate and confirm the codegen picked it up**

```
cd /Users/personal/git/bsv-wallet/packages/react-native-yubikey && npx nitrogen
grep -n "startDiscovery" nitrogen/generated/ios/swift/HybridYubiKeyPivSpec.swift nitrogen/generated/android/kotlin/com/margelo/nitro/yubikeypiv/HybridYubiKeyPivSpec.kt nitrogen/generated/shared/c++/HybridYubiKeyPivSpec.hpp
```

Expected: `func startDiscovery(message: String) throws -> Void`, `abstract fun startDiscovery(message: String): Unit`, and a C++ declaration `virtual void startDiscovery(const std::string& message) = 0;`. The hand-written Swift/Kotlin classes no longer conform until Steps 3–4.

- [ ] **Step 3: Swift**

Replace lines 64–77 of `Y/ios/HybridYubiKeyPiv.swift` (`func startDiscovery() throws { ... }`) with:

```swift
  func startDiscovery(message: String) throws {
    if #available(iOS 13.0, *) {
      guard NFCReaderSession.readingAvailable else {
        throw Self.vaultError(
          "driver-unavailable",
          "NFC reading unavailable — NFC may be off, or the NFC service may need a device restart")
      }
    }
    YubiKitManager.shared.delegate = connDelegate
    // The alert text comes from JS, localised per tap (a withdrawal batch, an
    // enrollment step). YubiKit reads this static at session start, so it is
    // fixed for the life of one session; progress between batches is shown by
    // the app once the sheet dismisses. Empty = native default wording.
    YubiKitExternalLocalization.nfcScanAlertMessage =
      message.isEmpty ? "Hold your YubiKey to the top of your phone." : message
    if #available(iOS 13.0, *) {
      YubiKitManager.shared.startNFCConnection()
    }
  }
```

Replace lines 308–310 (the three comment lines beginning `// TOUCH-gated when the slot's key was generated with TouchPolicy.ALWAYS`) with:

```swift
        // TOUCH-gated by the slot's touch policy (generateVaultKey enrols with
        // CACHED, spec D6): blocks until the user taps unless a touch within
        // the card's 15 s window is still valid; an unmet touch surfaces as
        // touch-timeout via mapError. (ecdh itself is unused by the R1C vault.)
```

- [ ] **Step 4: Kotlin**

Replace line 79 of `HybridYubiKeyPiv.kt` (`override fun startDiscovery() {`) with:

```kotlin
  /** `message` is the iOS NFC alert text; Android's system NFC has no
   *  per-session prompt and USB has none, so it is accepted and ignored. */
  override fun startDiscovery(message: String) {
```

Replace lines 296–298 (the comment beginning `// TOUCH-gated by the slot's touch policy (generateVaultKey now enrolls with` through `// SW 0x6982/0x6985, which mapError folds into touch-timeout.`) with:

```kotlin
      // TOUCH-gated by the slot's touch policy (generateVaultKey enrols with
      // CACHED, spec D6): blocks until the user taps unless a touch within the
      // card's 15 s window is still valid; an unmet touch surfaces as
      // SW 0x6982/0x6985, which mapError folds into touch-timeout.
```

- [ ] **Step 5: Verify**

```
cd /Users/personal/git/bsv-wallet/packages/react-native-yubikey
grep -n "func startDiscovery(message: String)" ios/HybridYubiKeyPiv.swift
grep -n "override fun startDiscovery(message: String)" android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt
grep -rn "ALWAYS" ios/HybridYubiKeyPiv.swift android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt
```

Expected: one match each for the two signatures; the `ALWAYS` grep returns only the `"always" -> TouchPolicy.ALWAYS` / `PinPolicy.ALWAYS` mapping lines (Kotlin ~396/404), no prose. Then from the repo root run the TS side that consumes the spec: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep driver.ts` → empty (the `NativeYubiKeyPiv` shape in `driver.ts` already matches from Task 4). A device build (`npx expo run:ios` / `run:android` from the repo root) is the final proof and belongs to the §0 device run; it is not required for this commit.

- [ ] **Step 6: Commit**

```
cd /Users/personal/git/bsv-wallet
git add packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts packages/react-native-yubikey/ios/HybridYubiKeyPiv.swift packages/react-native-yubikey/android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt packages/react-native-yubikey/nitrogen/generated
git commit -m "feat(yubikey): startDiscovery(message) sets the NFC alert text from JS" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 6: ceremony.ts — `VaultSigner`, `requestSigner(reason, chosenSerial)`, resumable sign loop, batch reopen, `progress`

**Files:**
- Modify: `T/core/services/vault/ceremony.ts` (972 lines today; the regions listed in Step 3 are replaced, everything else stays byte-for-byte)
- Rewrite: `T/__tests__/vault/ceremony.test.ts`

**Interfaces:**
- Consumes: `VaultDriver` (Task 4 shape — `start(message?)`, `signEcdsa(slot, pin, digest)`, no `ecdh`), `VaultError`/`VaultErrorCode` from `./types`, `Utils` from `@bsv/sdk`. Tests use `compressPubkey` from `./r1comb` (Plan 1 — must exist) and `p256` from `@noble/curves/nist.js`.
- Produces (contract): `VaultProgress`, `CeremonyState.progress?`, `VaultSigner`, exported `CeremonyStoreView`, `CeremonyController` constructor `deps.inputsPerTap?`, `requestSigner(reason, chosenSerial)`, `noteProgress(p)`, `onArmed?: (s: VaultSigner) => void`. Removed: `VaultKeyHandle`, `requestKey`, `getSeal`, `unwrapVaultKey`, the `seal` parameter everywhere. `requireChosenSerial`'s `serial-mismatch` throw populates `VaultError.details = { tapped, chosen }` (Task 1's convention).
- Allowed tsc residuals after this commit: `ceremonyHost.ts` (`VaultKeyHandle`, `requestKey`, `getSeal`, `m.slot`/`m.yubiSerial` — Task 7), `transfers.ts` (`VaultKeyHandle`, `requestVaultKey`, `takeNextIndex`, the missing `./k1`/`./vaultDerivation` modules — Tasks 9–11), `VaultKeyService.ts` (Task 8), `ui/screens/VaultScreen.tsx` (Plan 3).

**What changes and what does not.** The arm flow (insert → serial → PIN) is untouched in shape; only its inputs change: the ceremony now reads the store's KEY LIST, resolves `chosenSerial` against it (`not-enrolled` before any hardware prompt if absent), and compares the tapped serial to the CHOSEN key (`serial-mismatch`, detail naming both). There is no touch at arm time any more — the old `unwrapVaultKey` (one ECDH) is gone and its `RETRYABLE_TAP_ERRORS` retry loop moves, generalised, into `VaultSigner.sign()`: every card signature runs inside it, retrying the SAME digest after a dropped tap (Retry prompt; on session-based transports close + reopen with serial and PIN re-checked). On session-based transports `sign()` also closes and reopens the session every `inputsPerTap` successful signatures. Generation fencing, retention (`startArmTimer`/`checkArmTimeout`/`enforceArmTimeout`/ceiling), `cancel()`, `notifyKeyDetached()`, `notifyKeyAttached()`, `notifySessionFailed()`, the `KeyEventSession` boxing, `run()`'s finally and `release()`'s identity check are byte-for-byte or semantically unchanged; only types and names inside them move from "handle" to "signer".

Three decisions this task makes that the contract does not spell out (flagged in the plan summary, not resolved by renaming anything):
1. **NFC alert text.** `VaultDriver.start(message?)` wants the localised sheet text, the ceremony must not import i18n, and `requestSigner` has no message parameter. The ceremony passes the caller's `reason` string to `driver.start(...)` on every session it opens (initial arm and each reopen). Plan 3 supplies a `reason` that reads correctly on the iOS sheet; "batch b of n" is shown by the in-app sheet from `state.progress` under `waiting-for-key`, since YubiKit fixes the alert text for the life of one session anyway (Task 5).
2. **A joiner naming a different serial.** Concurrent `requestSigner` calls still share one in-flight ceremony, but only when they name the SAME serial; a call naming a different serial while one is running is rejected at once with `serial-mismatch` and does not disturb the in-flight attempt. (transfers.ts never overlaps ceremonies; this is a guard, not a feature.)
3. **Detach vs. dropped tap.** A driver-EMITTED `detached` while a signer is live still relocks through `notifyKeyDetached()` exactly as today (WalletContext's USB listener and the session's own subscription both route there). Only a REJECTION of `driver.signEcdsa` with `touch-timeout` / `nfc-lost` / `key-removed-mid-op` is resumable. Whether an iOS field drop mid-command produces the rejection, the event, or both is decided by the native adapter and belongs to the §0 device run; the ceremony's behaviour for each is pinned by the tests below.

- [ ] **Step 1: Rewrite `ceremony.test.ts`**

Replace `T/__tests__/vault/ceremony.test.ts` with:

```ts
/**
 * Ceremony controller — the UI-free state machine that turns "sign these
 * digests with key X" into an insert → PIN → tap flow and back into a
 * VaultSigner: the chosen card's serial + compressed pubkey plus
 * sign(digest) → DER, held for the retention window and dropped on release.
 * Driven entirely by the multi-serial mock driver plus a fake store view that
 * vends a two-key meta, so every signature really is produced by the mock
 * card the caller chose — and is verified here against that card's public
 * key with @noble/curves, exactly the way the R1C lock will check it.
 *
 * Plan 1's r1comb.ts must exist: compressPubkey is the canonical form the
 * store records and the signer reports.
 */
import { Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { CeremonyController, CeremonyState, VaultSigner } from '../../core/services/vault/ceremony'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { compressPubkey } from '../../core/services/vault/r1comb'
import { VaultError } from '../../core/services/vault/types'

const VAULT_SLOT = 0x82
const RETENTION = 120_000
const SERIAL_A = 'MOCK-A'
const SERIAL_B = 'MOCK-B'
const PIN = '123456'
/** A fixed 32-byte digest. WHAT gets signed is transfers.ts's business
 * (preimage → signerDigest); this file owns the tap. */
const DIGEST = 'ab'.repeat(32)
/** Distinct digests for a batch, one byte repeated. */
const digestAt = (i: number): string => i.toString(16).padStart(2, '0').repeat(32)

interface CeremonyHarness {
  ceremony: CeremonyController
  mock: MockYubiKey
  /** The two-key list the store view vends — vaultStore's public shape. */
  meta: { keys: { serial: string; slot: number; pubkey: string }[] }
  pubA: string
  pubB: string
}

/**
 * Wire a CeremonyController to a fresh MockYubiKey holding TWO enrolled keys
 * (serials MOCK-A and MOCK-B, each with its own generated slot key) and a
 * store view vending the matching two-key meta. Both cards are "removed"
 * afterwards so every test starts from "no key seen yet" unless it calls
 * mock.insertKey() itself.
 */
async function makeCeremony(
  opts: { retentionMs?: number; sessionBased?: boolean; attachTimeoutMs?: number; inputsPerTap?: number } = {}
): Promise<CeremonyHarness> {
  const mock = new MockYubiKey()
  if (opts.sessionBased) (mock as unknown as { sessionBased: boolean }).sessionBased = true
  mock.insertKey(SERIAL_A)
  const { publicKey: rawA } = await mock.generateVaultKey(VAULT_SLOT)
  mock.insertKey(SERIAL_B)
  const { publicKey: rawB } = await mock.generateVaultKey(VAULT_SLOT)
  mock.removeKey()
  const pubA = compressPubkey(rawA)
  const pubB = compressPubkey(rawB)
  const meta = {
    keys: [
      { serial: SERIAL_A, slot: VAULT_SLOT, pubkey: pubA },
      { serial: SERIAL_B, slot: VAULT_SLOT, pubkey: pubB }
    ]
  }
  const ceremony = new CeremonyController({
    getDriver: () => mock,
    store: { getMeta: async () => meta },
    retentionMs: opts.retentionMs ?? RETENTION,
    attachTimeoutMs: opts.attachTimeoutMs,
    inputsPerTap: opts.inputsPerTap
  })
  return { ceremony, mock, meta, pubA, pubB }
}

/** True when `der` is a valid P-256 signature over `digestHex` by `pubkeyHex33`
 * (raw digest, no prehash; high-S accepted — the mock does not normalise). */
const verifies = (der: number[], digestHex: string, pubkeyHex33: string): boolean => {
  const sig = p256.Signature.fromBytes(Uint8Array.from(der), 'der')
  return p256.verify(
    sig.toBytes(),
    Uint8Array.from(Utils.toArray(digestHex, 'hex')),
    Uint8Array.from(Utils.toArray(pubkeyHex33, 'hex')),
    { prehash: false, lowS: false }
  )
}

// microtask flush helper — drains microtasks by hopping the macrotask queue
const flush = () => new Promise<void>(r => setTimeout(r, 0))

/** Arm MOCK-A on a harness: request, present the card, PIN, await. Works for
 * both transports (on NFC the queued PIN is applied when pin-entry is
 * reached, then start() finds the "held" card). */
async function armA(h: CeremonyHarness, reason = 'x'): Promise<VaultSigner> {
  const p = h.ceremony.requestSigner(reason, SERIAL_A)
  h.mock.insertKey(SERIAL_A)
  h.ceremony.submitPin(PIN)
  return p
}

describe('CeremonyController: arming', () => {
  test('driver unavailable rejects with driver-unavailable', async () => {
    const c = new CeremonyController({
      getDriver: () => null,
      store: { getMeta: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestSigner('x', SERIAL_A)).rejects.toMatchObject({ code: 'driver-unavailable' })
  })

  test('no meta (not enrolled) rejects with not-enrolled', async () => {
    const mock = new MockYubiKey()
    mock.insertKey(SERIAL_A)
    const c = new CeremonyController({
      getDriver: () => mock,
      store: { getMeta: async () => null },
      retentionMs: RETENTION
    })
    await expect(c.requestSigner('x', SERIAL_A)).rejects.toMatchObject({ code: 'not-enrolled' })
  })

  test('a chosen serial that is not in the key list rejects with not-enrolled BEFORE any hardware contact', async () => {
    // A removed key, or a stale chooser: nothing a tap could do, so no prompt
    // and no card round trip (spec §4.2 step 6).
    const { ceremony: c, mock } = await makeCeremony()
    mock.insertKey(SERIAL_A) // a key IS present — it must not even be asked its serial
    const startSpy = jest.spyOn(mock, 'start')
    const infoSpy = jest.spyOn(mock, 'getKeyInfo')
    const err = await c.requestSigner('x', 'MOCK-Z').catch(e => e)
    expect(err).toMatchObject({ code: 'not-enrolled' })
    expect(err.message).toContain('MOCK-Z')
    expect(startSpy).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(c.state.phase).toBe('error')
  })

  test('two concurrent requestSigner calls for the same serial share one ceremony and resolve to the SAME signer', async () => {
    const h = await makeCeremony()
    const p1 = h.ceremony.requestSigner('op A', SERIAL_A)
    const p2 = h.ceremony.requestSigner('op B', SERIAL_A)
    h.mock.insertKey(SERIAL_A)
    h.ceremony.submitPin(PIN)
    const [s1, s2] = await Promise.all([p1, p2])
    expect(s1).toBe(s2) // release() is idempotent by construction because of this
    s1.release()
  })

  test('a concurrent requestSigner for a DIFFERENT serial is refused at once and leaves the in-flight ceremony alone', async () => {
    const h = await makeCeremony()
    const p1 = h.ceremony.requestSigner('op A', SERIAL_A)
    const err = await h.ceremony.requestSigner('op B', SERIAL_B).catch(e => e)
    expect(err).toMatchObject({ code: 'serial-mismatch' })
    expect(err.message).toContain(SERIAL_A)
    expect(err.message).toContain(SERIAL_B)
    // Ceremony A is unaffected.
    h.mock.insertKey(SERIAL_A)
    h.ceremony.submitPin(PIN)
    const s1 = await p1
    expect(s1.serial).toBe(SERIAL_A)
    expect(h.ceremony.state.phase).toBe('armed')
    s1.release()
  })

  test('wrong key serial (persistent reader) → serial-mismatch naming both serials', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_B) // enrolled, but not the one chosen
    const err = await p.catch(e => e)
    expect(err).toMatchObject({ code: 'serial-mismatch' })
    expect(err.message).toContain(SERIAL_B) // what was tapped
    expect(err.message).toContain(SERIAL_A) // what was chosen
    expect(err.details).toEqual({ tapped: SERIAL_B, chosen: SERIAL_A })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('serial-mismatch')
  })

  test('wrong key serial (NFC tap) → serial-mismatch, and the finally still stops the session (nothing was armed)', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    nfc.insertKey('WRONG-SERIAL')
    c.submitPin(PIN)
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('a wrong serial is rejected before the PIN is verified and before any signature — a foreign card is never asked anything', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const signSpy = jest.spyOn(mock, 'signEcdsa')
    const verifyPinSpy = jest.spyOn(mock, 'verifyPin')
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_B)
    await expect(p).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(verifyPinSpy).not.toHaveBeenCalled()
    expect(signSpy).not.toHaveBeenCalled()
  })

  test('wrong PIN (persistent reader) returns to pin-entry with retriesLeft, then succeeds', async () => {
    const { ceremony: c, mock, pubA } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    c.submitPin('000000')
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    c.submitPin(PIN)
    const signer = await p
    expect(signer.serial).toBe(SERIAL_A)
    expect(signer.pubkey).toBe(pubA)
    expect(verifies(await signer.sign(DIGEST), DIGEST, pubA)).toBe(true)
    signer.release()
  })

  test('NFC: a wrong PIN aborts the whole ceremony (no in-place retry) with retriesLeft intact, and stops the session', async () => {
    // A wrong PIN cannot be corrected in place on NFC — the PIN is collected
    // before the system scan sheet ever opens, so there is nothing to
    // re-prompt mid-tap. The caller (a fresh withdraw attempt) collects the
    // PIN again.
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    nfc.insertKey(SERIAL_A)
    c.submitPin('000000') // wrong
    await expect(p).rejects.toMatchObject({ code: 'pin-invalid', retriesLeft: 2 })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('pin-invalid')
    expect(c.state.error?.retriesLeft).toBe(2)
    expect(stopSpy).toHaveBeenCalledTimes(1) // nothing armed → the finally closed it
  })

  test('detach while waiting for the PIN → key-removed-mid-op', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    mock.removeKey() // pulled before the PIN is ever submitted
    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(c.state.phase).toBe('error')
  })

  test('cancel rejects the pending request with user-cancelled', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
  })

  test('armed window expires back to idle, fires onRelock(timeout), and the signer refuses afterwards', async () => {
    const h = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')
    await new Promise<void>(r => setTimeout(r, 1050))
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])

    // The card is no longer ours to drive: sign() must refuse, not tap.
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('notifyKeyDetached during the armed window relocks immediately and the signer refuses afterwards', async () => {
    const h = await makeCeremony()
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')
    h.ceremony.notifyKeyDetached()
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('arming a session-based driver does NOT stop it — only release() does', async () => {
    const h = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')
    expect(stopSpy).not.toHaveBeenCalled()

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(1)
    signer.release() // idempotent
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('arming a persistent reader never stops it, matching before', async () => {
    const h = await makeCeremony()
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const signer = await armA(h)
    expect(stopSpy).not.toHaveBeenCalled()
    signer.release()
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('a session-based driver keeps notifying the ceremony after arm — an unprompted detach while armed still relocks', async () => {
    // WalletContext's own persistent-reader listener explicitly skips
    // sessionBased drivers (it exists only for Android USB unplug), so the
    // ceremony's OWN run()-level subscription is the only thing that can ever
    // learn an NFC session detached. If that subscription were torn down the
    // moment run() completes, a real driver-emitted 'detached' event would be
    // silently dropped for the rest of the signer's life, leaving a live
    // signer behind a card that is gone. This drives the event through the
    // MOCK's own emit, not through calling ceremony.notifyKeyDetached()
    // directly, so it exercises the subscription wiring.
    const h = await makeCeremony({ sessionBased: true })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')

    h.mock.removeKey() // a real driver-emitted detach, not a manual notify call
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['detached'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })
})

describe('CeremonyController: NFC session failure before a key connects', () => {
  // The production hang: the system NFC sheet was cancelled or timed out
  // BEFORE any key connected, YubiKit reported it via didFailConnectingNFC,
  // and nothing forwarded it — so the ceremony parked in waiting-for-key
  // forever. These drive the failure through the mock's own emit so the
  // subscription wiring is exercised, not just the notify method body.

  test('user cancelling the system NFC sheet rejects with user-cancelled, goes idle, and closes the session', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    c.submitPin(PIN) // NFC collects the PIN before the tap
    await flush() // reach waiting-for-key (driver.start() done, no key held)
    expect(c.state.phase).toBe('waiting-for-key')

    nfc.failSession('user-cancelled')
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')
    expect(stopSpy).toHaveBeenCalledTimes(1) // nothing armed → the finally closed it
  })

  test('the session dying without a key (timeout / failed to present) rejects with no-key and surfaces an error', async () => {
    const { ceremony: c, mock: nfc } = await makeCeremony({ sessionBased: true })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const p = c.requestSigner('x', SERIAL_A)
    c.submitPin(PIN)
    await flush()
    expect(c.state.phase).toBe('waiting-for-key')

    nfc.failSession('no-key')
    await expect(p).rejects.toMatchObject({ code: 'no-key' })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('no-key')
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('watchdog: no attach within attachTimeoutMs rejects with no-key even when the driver stays silent', async () => {
    // Covers the paths YubiKit swallows internally (readingAvailable false,
    // session invalidated before didBecomeActive) where NO event ever reaches
    // JS — the only layer that can catch those is a deadline of our own.
    const { ceremony: c } = await makeCeremony({ sessionBased: true, attachTimeoutMs: 40 })
    const p = c.requestSigner('x', SERIAL_A)
    c.submitPin(PIN)
    await flush()
    expect(c.state.phase).toBe('waiting-for-key')

    await expect(p).rejects.toMatchObject({ code: 'no-key' })
    expect(c.state.phase).toBe('error')
    expect(c.state.error?.code).toBe('no-key')
  })

  test('watchdog is disarmed by a successful attach — an armed session is not killed when the deadline passes', async () => {
    const h = await makeCeremony({ sessionBased: true, attachTimeoutMs: 40 })
    const signer = await armA(h) // key already held: start() emits attached immediately
    expect(h.ceremony.state.phase).toBe('armed')

    await new Promise<void>(r => setTimeout(r, 80)) // sail past the deadline
    expect(h.ceremony.state.phase).toBe('armed') // no spurious relock or error
    expect(verifies(await signer.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer.release()
  })

  test('watchdog does not apply to a persistent reader — waiting for a USB insert has no deadline', async () => {
    const { ceremony: c, mock, pubA } = await makeCeremony({ attachTimeoutMs: 40 })
    const p = c.requestSigner('x', SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('waiting-for-key')

    await new Promise<void>(r => setTimeout(r, 80)) // well past the (inapplicable) deadline
    expect(c.state.phase).toBe('waiting-for-key')

    mock.insertKey(SERIAL_A) // user finally plugs the key in
    c.submitPin(PIN)
    const signer = await p
    expect(signer.pubkey).toBe(pubA)
    expect(verifies(await signer.sign(DIGEST), DIGEST, pubA)).toBe(true)
    signer.release()
  })

  test('the NFC alert text is the caller\'s reason, on the first session and on every reopen', async () => {
    // Decision 1 in this task's preamble: the ceremony has no i18n and
    // requestSigner has no message parameter, so `reason` IS the sheet text.
    const h = await makeCeremony({ sessionBased: true, inputsPerTap: 1 })
    const startSpy = jest.spyOn(h.mock, 'start')
    const signer = await armA(h, 'Hold your YubiKey here to sign')
    await signer.sign(digestAt(0))
    await signer.sign(digestAt(1)) // inputsPerTap = 1 → a reopen before this one
    expect(startSpy.mock.calls.map(c => c[0])).toEqual([
      'Hold your YubiKey here to sign',
      'Hold your YubiKey here to sign'
    ])
    signer.release()
  })
})

describe('vault signer', () => {
  test('one tap yields a signer whose DER signature verifies against the chosen key\'s enrolled pubkey', async () => {
    const h = await makeCeremony()
    const signer = await armA(h, 'test withdrawal')
    expect(signer.serial).toBe(SERIAL_A)
    expect(signer.pubkey).toBe(h.pubA)
    const der = await signer.sign(DIGEST)
    // DER, like both real platforms: 0x30 <len> 0x02 <r> 0x02 <s>.
    expect(der[0]).toBe(0x30)
    expect(verifies(der, DIGEST, h.pubA)).toBe(true)
    expect(verifies(der, DIGEST, h.pubB)).toBe(false)
    signer.release()
  })

  test('choosing MOCK-B signs with B\'s slot key, not A\'s', async () => {
    const { ceremony: c, mock, pubA, pubB } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_B)
    mock.insertKey(SERIAL_B)
    c.submitPin(PIN)
    const signer = await p
    expect(signer.serial).toBe(SERIAL_B)
    expect(signer.pubkey).toBe(pubB)
    const der = await signer.sign(DIGEST)
    expect(verifies(der, DIGEST, pubB)).toBe(true)
    expect(verifies(der, DIGEST, pubA)).toBe(false)
    signer.release()
  })

  test('release drops the signer and relocks; sign() after release throws key-removed-mid-op; progress is cleared', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    await signer.sign(DIGEST, { index: 2, total: 5 })
    expect(h.ceremony.state.progress).toEqual({ signed: 2, total: 5 })
    expect(h.ceremony.state.phase).toBe('awaiting-touch')

    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
    expect(h.ceremony.state.progress).toBeUndefined()
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('no card contact until the first sign(): arming verifies the PIN once and signs nothing; each sign() is one signEcdsa call', async () => {
    const h = await makeCeremony()
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const startSpy = jest.spyOn(h.mock, 'start')
    const signer = await armA(h)
    expect(signSpy).not.toHaveBeenCalled()
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 3; i++) {
      expect(verifies(await signer.sign(digestAt(i)), digestAt(i), h.pubA)).toBe(true)
    }
    expect(signSpy).toHaveBeenCalledTimes(3)
    expect(signSpy).toHaveBeenNthCalledWith(1, VAULT_SLOT, PIN, digestAt(0))
    expect(signSpy).toHaveBeenNthCalledWith(3, VAULT_SLOT, PIN, digestAt(2))
    expect(verifyPinSpy).toHaveBeenCalledTimes(1) // 'once' PIN policy: verified at arm only
    expect(startSpy).not.toHaveBeenCalled() // persistent reader with the key present: no session to open
    signer.release()
  })

  test('nothing key-shaped reaches the React-visible ceremony state, and the key set is pinned', async () => {
    const h = await makeCeremony()
    const seen: string[] = []
    const unsubscribe = h.ceremony.subscribe(s => seen.push(JSON.stringify(s)))
    const signer = await armA(h)
    // Pinned: a new field cannot be added to CeremonyState without editing
    // this line — see the SECURITY note in ceremony.ts.
    expect(Object.keys(h.ceremony.state).sort()).toEqual(['armedUntil', 'error', 'phase', 'progress', 'reason'])
    const der = await signer.sign(DIGEST, { index: 0, total: 1 })
    unsubscribe()

    const derHex = Utils.toHex(der)
    for (const snapshot of seen) {
      expect(snapshot).not.toContain(PIN) // the PIN never lands in state
      expect(snapshot).not.toContain(derHex) // nor a signature
      expect(snapshot).not.toContain(h.pubA) // nor the pubkey — that rides on the signer
      expect(snapshot).not.toContain(SERIAL_A) // nor the serial (`reason` is 'x' here)
    }
    signer.release()
  })

  test('persistent reader: a touch timeout on the SECOND signature returns to error; retry() resumes that same digest without re-entering the PIN', async () => {
    const h = await makeCeremony()
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer = await armA(h, 'Withdraw from vault')
    expect(verifies(await signer.sign(digestAt(0)), digestAt(0), h.pubA)).toBe(true)

    h.mock.setTouchBehavior('timeout') // the touch is missed on input 1
    const p1 = signer.sign(digestAt(1), { index: 1, total: 3 })
    await flush()
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')
    expect(h.ceremony.state.progress).toEqual({ signed: 1, total: 3 }) // the sheet still knows where it is
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)

    h.mock.setTouchBehavior('instant')
    h.ceremony.retry()
    const d1 = await p1
    expect(verifies(d1, digestAt(1), h.pubA)).toBe(true)
    expect(verifyPinSpy).toHaveBeenCalledTimes(1) // no reopen on a persistent reader → no re-verify
    expect(h.ceremony.state.error).toBeUndefined()

    expect(verifies(await signer.sign(digestAt(2)), digestAt(2), h.pubA)).toBe(true)
    // 1 ok + 1 timed out + 1 retry of the SAME digest + 1 ok
    expect(signSpy.mock.calls.map(c => c[2])).toEqual([digestAt(0), digestAt(1), digestAt(1), digestAt(2)])
    signer.release()
  })

  test('NFC: a dropped tap mid-signature closes the dead session and reopens a fresh one — re-checking the serial and re-verifying the PIN — then signs the SAME digest', async () => {
    // Spec §4.2 step 6: the reservation and the signatures gathered so far are
    // the caller's; the ceremony's job is to get the card back and continue.
    const h = await makeCeremony({ sessionBased: true })
    const startSpy = jest.spyOn(h.mock, 'start')
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const getKeyInfoSpy = jest.spyOn(h.mock, 'getKeyInfo')
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer = await armA(h, 'Withdraw from vault')
    expect(startSpy).toHaveBeenCalledTimes(1)

    h.mock.setTouchBehavior('timeout') // the tap drops mid-signature
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')
    expect(startSpy).toHaveBeenCalledTimes(1) // no reopen yet — still waiting on Retry
    // The dead session is NOT torn down just for showing the error — only
    // once the user actually retries, so a touch-timeout that turns out to be
    // a false alarm (session still alive) never had to be closed at all.
    expect(stopSpy).not.toHaveBeenCalled()

    h.mock.setTouchBehavior('instant')
    h.ceremony.retry()
    await flush()
    expect(stopSpy).toHaveBeenCalledTimes(1) // retry closes the dead session before reopening

    const der = await p
    expect(verifies(der, DIGEST, h.pubA)).toBe(true)
    expect(startSpy).toHaveBeenCalledTimes(2) // retry reopened a fresh NFC session
    expect(verifyPinSpy).toHaveBeenCalledTimes(2) // PIN re-verified on the fresh session
    expect(getKeyInfoSpy).toHaveBeenCalledTimes(2) // serial RE-CHECKED on the fresh session
    expect(signSpy.mock.calls.map(c => c[2])).toEqual([DIGEST, DIGEST]) // one dropped, one landed — same digest

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(2) // release() closes the reopened session
  })

  test('NFC: a card swap between the dropped tap and the retry is caught by the re-check — the foreign card never signs', async () => {
    const h = await makeCeremony({ sessionBased: true })
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')
    expect(signSpy).toHaveBeenCalledTimes(1)

    h.mock.setTouchBehavior('instant')
    h.mock.insertKey(SERIAL_B) // the OTHER enrolled card lands on the retry tap
    h.ceremony.retry()
    const err = await p.catch(e => e)
    expect(err).toMatchObject({ code: 'serial-mismatch' })
    expect(err.message).toContain(SERIAL_B)
    expect(err.message).toContain(SERIAL_A)
    expect(signSpy).toHaveBeenCalledTimes(1) // B was never asked to sign A's digest
    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('NFC: a genuine detach while a retry is pending relocks and fails sign() with key-removed-mid-op', async () => {
    // A driver-emitted detach is the hardware leaving, not a dropped tap:
    // the signer is released, exactly as before this refactor.
    const h = await makeCeremony({ sessionBased: true })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')

    h.mock.removeKey() // reaches the ceremony through its own session subscription

    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(relocks).toEqual(['detached'])
    expect(h.ceremony.state.phase).toBe('idle')
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('persistent reader: WalletContext\'s notifyKeyDetached during a retry wait does the same', async () => {
    // After arming, a persistent reader's ceremony drops its own listener and
    // relies on WalletContext's always-on one, which calls notifyKeyDetached.
    const h = await makeCeremony()
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.error?.code).toBe('touch-timeout')

    h.mock.removeKey()
    h.ceremony.notifyKeyDetached()

    await expect(p).rejects.toMatchObject({ code: 'key-removed-mid-op' })
    expect(relocks).toEqual(['detached'])
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('cancelling during a retry wait rejects sign() with user-cancelled and relocks manually', async () => {
    const h = await makeCeremony()
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    h.mock.setTouchBehavior('timeout')
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.phase).toBe('error')

    h.ceremony.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['manual'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('a non-retryable signEcdsa error (pin-locked) propagates out of sign(), paints phase: error, and release() goes idle', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    // pin-locked is a real driver failure, not one of the RETRYABLE_TAP_ERRORS
    // (touch-timeout / nfc-lost / key-removed-mid-op) — it must not be
    // retried in place.
    jest.spyOn(h.mock, 'signEcdsa').mockRejectedValueOnce(new VaultError('pin-locked', 'PIN is blocked'))
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'pin-locked' })
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('pin-locked')
    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('an unrecognized (non-VaultError) signEcdsa failure is treated as a retryable field drop', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    jest.spyOn(h.mock, 'signEcdsa').mockRejectedValueOnce(new Error('tag connection lost'))
    const p = signer.sign(DIGEST)
    await flush()
    expect(h.ceremony.state.phase).toBe('error')
    expect(h.ceremony.state.error?.code).toBe('nfc-lost')

    h.ceremony.retry()
    expect(verifies(await p, DIGEST, h.pubA)).toBe(true)
    signer.release()
  })

  test('NFC batches: 20 signatures with inputsPerTap 8 open ceil(20/8) = 3 sessions, re-checking serial and PIN each time, and show waiting-for-key with the progress between batches', async () => {
    const h = await makeCeremony({ sessionBased: true, inputsPerTap: 8 })
    const startSpy = jest.spyOn(h.mock, 'start')
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const getKeyInfoSpy = jest.spyOn(h.mock, 'getKeyInfo')
    const signer = await armA(h)
    expect(startSpy).toHaveBeenCalledTimes(1)
    // Subscribe AFTER arming: the initial waiting-for-key (no progress yet) is
    // the arm's, not a batch boundary's.
    const snapshots: CeremonyState[] = []
    const unsubscribe = h.ceremony.subscribe(s => snapshots.push(s))

    const total = 20
    for (let i = 0; i < total; i++) {
      const der = await signer.sign(digestAt(i), { index: i, total })
      expect(verifies(der, digestAt(i), h.pubA)).toBe(true)
    }
    unsubscribe()

    expect(startSpy).toHaveBeenCalledTimes(3) // arm + reopen before #9 + reopen before #17
    expect(stopSpy).toHaveBeenCalledTimes(2) // each reopen closes the exhausted session first
    expect(verifyPinSpy).toHaveBeenCalledTimes(3)
    expect(getKeyInfoSpy).toHaveBeenCalledTimes(3)
    // Between batches the sheet sees waiting-for-key WITH the position, so it
    // can say "batch 2 of 3" while the iOS system sheet is down.
    const waits = snapshots.filter(s => s.phase === 'waiting-for-key').map(s => s.progress)
    expect(waits).toEqual([{ signed: 8, total: 20 }, { signed: 16, total: 20 }])

    signer.release()
    expect(stopSpy).toHaveBeenCalledTimes(3)
  })

  test('a persistent reader never reopens, whatever inputsPerTap says', async () => {
    const h = await makeCeremony({ inputsPerTap: 4 })
    const startSpy = jest.spyOn(h.mock, 'start')
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const verifyPinSpy = jest.spyOn(h.mock, 'verifyPin')
    const signer = await armA(h)
    for (let i = 0; i < 10; i++) await signer.sign(digestAt(i), { index: i, total: 10 })
    expect(startSpy).not.toHaveBeenCalled()
    expect(stopSpy).not.toHaveBeenCalled()
    expect(verifyPinSpy).toHaveBeenCalledTimes(1)
    signer.release()
  })

  test('the progress argument publishes state.progress and refreshes the retention deadline', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)
    const first = h.ceremony.state.armedUntil!
    await new Promise<void>(r => setTimeout(r, 20))
    await signer.sign(DIGEST, { index: 3, total: 10 })
    expect(h.ceremony.state.progress).toEqual({ signed: 3, total: 10 })
    expect(h.ceremony.state.armedUntil!).toBeGreaterThan(first) // the deadline moved
    signer.release()
  })
})

// The ceremonyHost singleton is ONE CeremonyController for the whole process
// lifetime — every fixture above builds a fresh controller per test, which
// cannot see anything that only becomes reachable on a SECOND ceremony
// against the same controller. These tests deliberately reuse one `c` across
// two (or more) full arm→use→release cycles, the way production actually runs.
describe('CeremonyController: one singleton, sequential ceremonies', () => {
  test("a signer released normally clears activeHandle, so a SECOND ceremony's error path still stops the session", async () => {
    const h = await makeCeremony({ sessionBased: true })
    const c = h.ceremony

    // Ceremony 1: arm normally and release, exactly as a caller finishing a
    // withdrawal would in its own finally.
    const signer1 = await armA(h, 'withdraw 1')
    expect(c.state.phase).toBe('armed')
    signer1.release()
    expect(c.state.phase).toBe('idle')

    // Ceremony 2: force a serial-mismatch by presenting the other enrolled key.
    const stopSpy = jest.spyOn(h.mock, 'stop')
    const p2 = c.requestSigner('withdraw 2', SERIAL_A)
    h.mock.insertKey(SERIAL_B)
    c.submitPin(PIN)
    await expect(p2).rejects.toMatchObject({ code: 'serial-mismatch' })

    // The bug this guards against: if release() never cleared activeHandle,
    // run()'s finally guard `if (!armed)` would be reasoning about a STALE
    // signer from ceremony 1 and skip closing ceremony 2's dead session
    // entirely — leaving the system NFC sheet open on exactly the error path
    // that guard exists to handle.
    expect(stopSpy).toHaveBeenCalledTimes(1)

    // And the controller is left clean enough for a third ceremony to arm.
    const signer3 = await armA(h, 'withdraw 3')
    expect(c.state.phase).toBe('armed')
    signer3.release()
  })

  test("a late release() from a stale signer must not steal a successor's PENDING attach-wait", async () => {
    const h = await makeCeremony({ sessionBased: true })
    const c = h.ceremony

    // Ceremony A arms normally.
    const signerA = await armA(h, 'withdraw A')
    expect(c.state.phase).toBe('armed')

    // Ceremony B starts — a SECOND, independent ceremony — before A's caller
    // has released: the realistic "slow finalize/broadcast" case the module
    // doc describes. The mock's start() would normally re-detect the
    // still-"present" key SYNCHRONOUSLY (see MockYubiKey.start), which
    // resolves B's own attach-wait before this test ever gets a chance to
    // interleave anything. Stubbing start() removes that synchronous shortcut
    // and opens the genuine window: B is now parked awaiting a fresh attach
    // event, same as a real NFC tap that has not landed yet.
    const startSpy = jest.spyOn(h.mock, 'start').mockImplementation(() => {})
    const p2 = c.requestSigner('withdraw B', SERIAL_A)
    c.submitPin(PIN)
    await flush()
    expect(c.state.phase).toBe('waiting-for-key') // B is genuinely pending, not yet armed

    // *** A's caller finally releases here — squarely inside B's pending
    // attach-wait. This is exactly the scenario the KeyEventSession box (a
    // per-attempt subscription, not one shared controller-wide field) exists
    // to protect: with a single shared field, A's release() unsubscribing it
    // would remove the listener B just registered for its own arm, and B's
    // `await waiter.promise` below would then hang forever. ***
    signerA.release()

    // The physical tap for B lands.
    startSpy.mockRestore()
    h.mock.insertKey(SERIAL_A)
    const signerB = await p2
    expect(signerB).not.toBe(signerA) // a genuinely new session, not shared
    expect(c.state.phase).toBe('armed')
    expect(verifies(await signerB.sign(DIGEST), DIGEST, h.pubA)).toBe(true)

    signerB.release()
  })

  test('an attempt cancelled while its verifyPin is in flight cannot arm behind the successor that replaced it', async () => {
    // The resurrection race. cancel() sets running=false while attempt #1 is
    // still parked inside driver.verifyPin — a native call cancel() cannot
    // interrupt — and the requestSigner() that follows both starts attempt #2
    // AND resets `cancelled` to false. When #1's PIN check finally answers,
    // every "am I still wanted?" flag reads clean. Without the generation
    // check, #1 then installs its own signer over #2's, arms a second timer,
    // and fires onArmed with a signer nobody asked for.
    const h = await makeCeremony()
    const c = h.ceremony
    const armedSigners: unknown[] = []
    c.onArmed = s => armedSigners.push(s)
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')

    // Park attempt #1 inside verifyPin until we say so.
    const realVerify = h.mock.verifyPin.bind(h.mock)
    let answerPin: (() => void) | undefined
    const verifySpy = jest.spyOn(h.mock, 'verifyPin').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerPin = () => resolve({ ok: true, retriesLeft: 3 })
        })
    )

    const p1 = c.requestSigner('op 1', SERIAL_A)
    h.mock.insertKey(SERIAL_A)
    c.submitPin(PIN)
    await flush()
    expect(answerPin).toBeDefined() // #1 is genuinely parked mid-verifyPin

    // The user gives up. #1 is still holding an open PIN check.
    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    // A second ceremony starts immediately — this one gets the real verifyPin.
    verifySpy.mockImplementation(realVerify)
    const p2 = c.requestSigner('op 2', SERIAL_A)
    c.submitPin(PIN)
    const signer2 = await p2
    expect(c.state.phase).toBe('armed')
    expect(armedSigners).toEqual([signer2])

    // *** #1's abandoned PIN check answers here, well after it was replaced. ***
    answerPin!()
    await flush()

    // Nothing changed hands: #2 is still the one and only armed session, and
    // #1 never reached a caller, a timer, or onArmed.
    expect(armedSigners).toEqual([signer2])
    expect(c.state.phase).toBe('armed')
    expect(signSpy).not.toHaveBeenCalled()
    // #1 also cleaned up after itself: no orphaned key-event listener. (A
    // persistent reader's ceremony drops its own listener once armed, so an
    // armed, tidy controller holds none at all.)
    expect((h.mock as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0)

    // And #2 still owns the controller's state: it signs, and its release relocks.
    expect(verifies(await signer2.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer2.release()
    expect(c.state.phase).toBe('idle')
    await expect(signer2.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('a superseded attempt that FAILS never rejects the successor waiting behind it', async () => {
    // Same race, error arm: #1's abandoned PIN check comes back as a hard
    // failure. Its rejection belongs to a ceremony nobody is waiting on any
    // more, so it must not reject #2's caller or repaint the phase out from
    // under an armed session.
    const h = await makeCeremony()
    const c = h.ceremony
    const realVerify = h.mock.verifyPin.bind(h.mock)
    let failPin: (() => void) | undefined
    const verifySpy = jest.spyOn(h.mock, 'verifyPin').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failPin = () => reject(new VaultError('pin-locked', 'PIN is blocked'))
        })
    )

    const p1 = c.requestSigner('op 1', SERIAL_A)
    h.mock.insertKey(SERIAL_A)
    c.submitPin(PIN)
    await flush()
    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    verifySpy.mockImplementation(realVerify)
    const p2 = c.requestSigner('op 2', SERIAL_A)
    c.submitPin(PIN)
    const signer2 = await p2
    expect(c.state.phase).toBe('armed')

    failPin!()
    await flush()

    // #2 is untouched: still armed, still usable, no error painted.
    expect(c.state.phase).toBe('armed')
    expect(c.state.error).toBeUndefined()
    expect(verifies(await signer2.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer2.release()
  })

  test('an attempt superseded while parked in getKeyInfo never repaints the successor or touches the card', async () => {
    // Same class, different park point: driver.getKeyInfo is a native call
    // cancel() cannot interrupt either. Resuming unguarded, attempt #1 would
    // walk into collectPin and set the phase back to 'pin-entry' over the
    // successor's armed session.
    const h = await makeCeremony()
    const c = h.ceremony
    const realInfo = h.mock.getKeyInfo.bind(h.mock)
    let answerInfo: (() => void) | undefined
    const infoSpy = jest.spyOn(h.mock, 'getKeyInfo').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answerInfo = () => resolve({ serial: SERIAL_A, firmwareVersion: '5.7.1', pinRetries: 3 })
        })
    )
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')

    const p1 = c.requestSigner('op 1', SERIAL_A)
    h.mock.insertKey(SERIAL_A)
    await flush()
    expect(answerInfo).toBeDefined() // #1 is parked inside getKeyInfo

    const rejected = expect(p1).rejects.toMatchObject({ code: 'user-cancelled' })
    c.cancel()
    await rejected

    infoSpy.mockImplementation(realInfo)
    const p2 = c.requestSigner('op 2', SERIAL_A)
    c.submitPin(PIN)
    const signer2 = await p2
    expect(c.state.phase).toBe('armed')

    const phasesAfterArm: string[] = []
    const unsubscribe = c.subscribe(s => phasesAfterArm.push(s.phase))
    answerInfo!() // #1's serial read finally answers
    await flush()
    unsubscribe()

    expect(phasesAfterArm.every(p => p === 'armed')).toBe(true) // no 'connecting' / 'pin-entry' repaint
    expect(c.state.phase).toBe('armed')
    expect(signSpy).not.toHaveBeenCalled()
    signer2.release()
  })

  test("a signer released by cancel() while its retry is pending leaves the successor's Retry button inert", async () => {
    // The retry branch lives inside sign() now. A cancel() during a retry wait
    // releases the signer and rejects its sign(); the retryWaiter it parked
    // on is gone with it, so a later retry() against a fresh ceremony must
    // not resume the dead signer's loop and spend a touch on the card.
    const h = await makeCeremony()
    const c = h.ceremony
    const signSpy = jest.spyOn(h.mock, 'signEcdsa')
    const signer1 = await armA(h, 'op 1')
    h.mock.setTouchBehavior('timeout')
    const p = signer1.sign(DIGEST)
    await flush()
    expect(c.state.error?.code).toBe('touch-timeout')
    expect(signSpy).toHaveBeenCalledTimes(1)

    c.cancel()
    await expect(p).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(c.state.phase).toBe('idle')

    h.mock.setTouchBehavior('instant')
    const signer2 = await armA(h, 'op 2')
    expect(c.state.phase).toBe('armed')

    c.retry() // nothing is parked — must be a no-op
    await flush()
    expect(c.state.phase).toBe('armed')
    expect(signSpy).toHaveBeenCalledTimes(1) // no touch spent on signer1's behalf
    expect(verifies(await signer2.sign(DIGEST), DIGEST, h.pubA)).toBe(true)
    signer2.release()
  })
})

describe('CeremonyController: post-arm progress', () => {
  test('progress from the spend path shows through, carries the position, and never leaks the key', async () => {
    const h = await makeCeremony()
    const signer = await armA(h)

    h.ceremony.noteProgress({ phase: 'preparing', signed: 3, total: 10 })
    expect(h.ceremony.state.phase).toBe('preparing')
    expect(h.ceremony.state.progress).toEqual({ signed: 3, total: 10 })
    h.ceremony.noteProgress({ phase: 'preparing' }) // no position → cleared, not stale
    expect(h.ceremony.state.progress).toBeUndefined()
    h.ceremony.noteProgress({ phase: 'broadcasting' })
    expect(h.ceremony.state.phase).toBe('broadcasting')
    expect(h.ceremony.state.progress).toBeUndefined()

    signer.release()
    expect(h.ceremony.state.phase).toBe('idle')
  })

  test('progress with nothing armed is ignored — a hardware-free deposit never raises a sheet', async () => {
    const { ceremony: c } = await makeCeremony()
    c.noteProgress({ phase: 'preparing', signed: 0, total: 1 })
    expect(c.state.phase).toBe('idle')
    expect(c.state.progress).toBeUndefined()
    c.noteProgress({ phase: 'broadcasting' })
    expect(c.state.phase).toBe('idle')
  })

  test('progress arriving mid-arm is ignored — the arming phases own the display', async () => {
    const { ceremony: c, mock } = await makeCeremony()
    const p = c.requestSigner('x', SERIAL_A)
    mock.insertKey(SERIAL_A)
    await flush()
    expect(c.state.phase).toBe('pin-entry')
    c.noteProgress({ phase: 'preparing' })
    expect(c.state.phase).toBe('pin-entry')
    c.submitPin(PIN)
    ;(await p).release()
  })
})

describe('CeremonyController: retention timeout robustness', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('the retention window elapsing while the spend path is still working relocks rather than staying armed forever', async () => {
    jest.useFakeTimers()
    const h = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')

    // A withdrawal that stalls in broadcast: phase is 'broadcasting', not
    // 'armed', for the whole rest of this test.
    h.ceremony.noteProgress({ phase: 'broadcasting' })
    expect(h.ceremony.state.phase).toBe('broadcasting')

    // Advance well past the point of no return. The busy-path fallback fires
    // the first check at t=1000, finds the phase is not 'armed', and schedules
    // a grace recheck — clamped to the 3x ceiling at t=3000, since with a 1s
    // window the ceiling lands inside the nominal 5s grace. Either way the
    // relock is due long before this advance ends.
    await jest.advanceTimersByTimeAsync(1000 + 5_000 + 10)

    // The bug this guards against: the ORIGINAL one-shot timer's callback was
    // guarded by `phase === 'armed'`, which is false here; without a
    // reschedule, the callback would return and NOTHING would ever check
    // again — a live signer that never leaves.
    expect(h.ceremony.state.phase).toBe('idle')
    expect(relocks).toEqual(['timeout'])
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('reported progress refreshes the retention window instead of letting the original deadline expire underneath an active withdrawal', async () => {
    jest.useFakeTimers()
    // 10s window → the 3x absolute ceiling sits at t=30_000, well clear of
    // everything this test exercises; the ceiling gets its own test below.
    const h = await makeCeremony({ retentionMs: 10_000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    const firstDeadline = h.ceremony.state.armedUntil!

    // Report progress well before the window elapses...
    await jest.advanceTimersByTimeAsync(6_000)
    h.ceremony.noteProgress({ phase: 'preparing', signed: 1, total: 4 })
    expect(h.ceremony.state.armedUntil!).toBeGreaterThan(firstDeadline) // the deadline moved

    // ...then advance past the ORIGINAL deadline (t=10_000) AND the grace
    // recheck that would have followed it (t=15_000) — i.e. the exact instant
    // an unrefreshed window would have relocked — without ever going idle.
    await jest.advanceTimersByTimeAsync(12_000) // t = 18_000
    expect(h.ceremony.state.phase).toBe('preparing')
    expect(relocks).toEqual([])
    expect(verifies(await signer.sign(DIGEST), DIGEST, h.pubA)).toBe(true) // still live

    signer.release()
  })

  test('the absolute ceiling relocks a session that keeps renewing itself with progress notes', async () => {
    // The refresh above must not become a lease a caller can renew forever:
    // that would make the retention window no boundary at all. Past armedAt +
    // 3x retention the relock fires regardless.
    jest.useFakeTimers()
    const h = await makeCeremony({ retentionMs: 1000 })
    const relocks: string[] = []
    h.ceremony.onRelock = why => relocks.push(why)
    const signer = await armA(h)
    expect(h.ceremony.state.phase).toBe('armed')

    // A note every 200ms — never letting a full window elapse — for well past
    // the 3x ceiling at t=3000.
    for (let t = 0; t < 6_000; t += 200) {
      await jest.advanceTimersByTimeAsync(200)
      h.ceremony.noteProgress({ phase: 'broadcasting' })
    }

    expect(relocks).toEqual(['timeout'])
    expect(h.ceremony.state.phase).toBe('idle')
    await expect(signer.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })

  test('the ceiling is anchored per ceremony, so a fresh arm gets a full new life', async () => {
    jest.useFakeTimers()
    const h = await makeCeremony({ retentionMs: 1000 })
    const s1 = await armA(h)
    await jest.advanceTimersByTimeAsync(4_000) // past ceremony 1's ceiling
    expect(h.ceremony.state.phase).toBe('idle')
    await expect(s1.sign(DIGEST)).rejects.toMatchObject({ code: 'key-removed-mid-op' })

    // Ceremony 2 on the same controller starts its own clock.
    const p2 = h.ceremony.requestSigner('y', SERIAL_A)
    h.ceremony.submitPin(PIN)
    const s2 = await p2
    expect(h.ceremony.state.phase).toBe('armed')
    await jest.advanceTimersByTimeAsync(900)
    expect(h.ceremony.state.phase).toBe('armed') // not inheriting ceremony 1's exhausted ceiling
    s2.release()
  })
})
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/ceremony.test.ts` → fails at load: `Cannot find module '../../core/services/vault/sealing'` is NOT the failure any more if Task 4 ran (mockYubiKey no longer imports it), but ceremony.ts itself still does (`import { unsealVaultKey } from './sealing'` — the file exists until Task 12, so this loads); the first failing assertions are `TypeError: c.requestSigner is not a function` across the suite, and the `compressPubkey` import resolves only if Plan 1 is merged.

- [ ] **Step 3: Edit `ceremony.ts` region by region**

Line numbers refer to the CURRENT file (972 lines). Apply the replacements bottom-up if editing by line number, or match the quoted anchors. Everything not listed stays byte-for-byte — in particular `CeremonyPhase` (67–76), `Deferred`/`defer`/`KeyEventSession` (144–172), `subscribe` (249–253), `submitPin`/`retry` (293–306), `cancel` (308–329), `notifyKeyDetached`/`notifyKeyAttached`/`notifySessionFailed` (331–365), `subscribeKeyEvents`/`unsubscribeKeyEvents` (367–388), `safeKeyInfo` (512–518), `collectPinValue`/`collectPin` (624–662), `armCeiling`/`startArmTimer`/`checkArmTimeout`/`enforceArmTimeout`/`clearArmTimer` (851–917), `throwIfCancelled` (919–921), `set` (961–964) and `now` (967–972). Their docblocks still say "handle"/"key live in memory" in places; those words are left alone on purpose — the semantics they describe are unchanged.

**(a) Lines 1–65 — module doc and imports** → replace with:

```ts
/**
 * Ceremony controller — UI-free state machine for the insert → PIN → tap flow
 * that turns one enrolled YubiKey into a VaultSigner. Consumed by a React
 * context that renders the ceremony sheet; kept free of React and native
 * imports so it is fully unit-testable against the mock driver.
 *
 * What a ceremony PRODUCES: a VaultSigner — the CHOSEN key's serial and
 * compressed P-256 public key, plus `sign(digest)`, which runs the card's
 * GENERAL AUTHENTICATE (driver.signEcdsa) for one 32-byte digest and returns
 * the DER signature. There is no seed, no seal, no ECDH and no key material in
 * JS memory at any point (spec D2): the card signs each vault input itself.
 * What lives in this module while a signer is armed is the PIN string and the
 * transport session — nothing else.
 *
 * The caller (transfers.ts) names the key BEFORE the tap (spec D14): the
 * ceremony reads `chosenSerial` against the store's key list, refuses a serial
 * that is not enrolled (`not-enrolled`) before any hardware prompt, and refuses
 * a tapped card whose serial is not the chosen one (`serial-mismatch`) on EVERY
 * session, including the reopened ones described below.
 *
 * Concurrency: one ceremony ARMING at a time — `requestSigner()` calls that
 * overlap a single in-flight arm attempt (two callers racing while `running`
 * is true) share that one attempt and all resolve to the SAME VaultSigner,
 * provided they name the same serial; a joiner naming a different serial is
 * rejected with `serial-mismatch` at once, without disturbing the in-flight
 * attempt. release() on the shared signer is idempotent by construction, so
 * whichever caller releases last simply no-ops. That guarantee does NOT extend
 * across separate ceremonies: once an attempt finishes arming, `running` goes
 * back to false, and the NEXT requestSigner() call starts an entirely new
 * ceremony with its own signer — even if the previous one has not been
 * released yet. Two live, independently-armed signers can therefore coexist
 * for a stretch (see ceremony.test.ts's "late release() from a stale signer"
 * case); what is guaranteed is that a signer released late can only affect its
 * OWN subscription, never a successor's — see makeHandle's `release()` doc for
 * the one exception (the shared native transport).
 *
 * Session lifetime: arming means "the chosen card answered with the right
 * serial and accepted the PIN", not "the operation is done." A session-based
 * transport's driver.stop() (which dismisses the iOS NFC sheet) is therefore
 * NOT called when the ceremony completes; it moves to VaultSigner.release(),
 * so the session's lifetime still brackets the caller's whole signing loop.
 * The one exception is the error path: if arming itself fails, no signer
 * exists to own the session, so run()'s finally closes it there.
 *
 * Signing is RESUMABLE (spec §4.2 step 6). `sign()` retries a dropped tap in
 * place — touch-timeout, nfc-lost, key-removed-mid-op REJECTED BY signEcdsa —
 * by parking on the Retry prompt and, on a session-based transport, closing the
 * dead session and opening a fresh one (serial and PIN re-checked) before
 * signing the SAME digest again; the caller's reservation and the signatures
 * already gathered are untouched. On a session-based transport it also closes
 * and reopens the session every `inputsPerTap` successful signatures (the
 * card's touch cache and CoreNFC's 60 s session both bound a batch), showing
 * 'waiting-for-key' with the caller's progress so the sheet can say "batch b of
 * n". A driver-EMITTED 'detached' while a signer is live is NOT a retry: it is
 * the hardware leaving, and notifyKeyDetached relocks exactly as before.
 *
 * The NFC alert text handed to driver.start() is the caller's `reason` — this
 * module has no i18n, and YubiKit fixes the text for the life of one session
 * anyway; per-batch progress is shown by the in-app sheet from
 * CeremonyState.progress.
 *
 * The retention window bounds how long a signer stays usable. A progress note
 * (noteProgress) or a `sign()` call carrying progress restarts it, so a long
 * batch is not cut off mid-flight; ARM_MAX_MULTIPLE caps a session's total
 * life at 3× the window measured from `armedAt`, after which the relock fires
 * however fresh the progress is.
 *
 * SECURITY: the PIN lives in the arm flow's closure until release(). Never log
 * the PIN, and never put it in CeremonyState, which is React-visible. Serials
 * and public keys are public data and travel on the signer, not in state.
 */
import { Utils } from '@bsv/sdk'
import { VaultDriver } from './driver'
import { VaultError, VaultErrorCode } from './types'
```

**(b) Lines 78–86 — `VaultProgress`** → replace with:

```ts
/**
 * Work happening AFTER the signer is armed, reported by the spend path so the
 * sheet can show activity instead of a frozen screen.
 *
 * 'preparing' carries the signing loop's position when it has one: `signed`
 * inputs done out of `total`. The sheet renders it between batches and after
 * the NFC sheet dismisses (it cannot draw under the iOS system sheet).
 */
export type VaultProgress = { phase: 'preparing'; signed?: number; total?: number } | { phase: 'broadcasting' }
```

**(c) Lines 88–102 — `CeremonyState`** → replace with:

```ts
/**
 * Everything the ceremony publishes to React (see context/VaultContext.tsx).
 *
 * Kept to exactly these five fields on purpose: a phase, a deadline, the
 * caller's own reason string, an error code, and the signing position. No PIN,
 * no serial, no pubkey, no signature — see this module's SECURITY note, and the
 * "nothing key-shaped reaches the React-visible ceremony state" case in
 * __tests__/vault/ceremony.test.ts, which pins the key set so a new field
 * cannot be added here without a deliberate decision.
 */
export interface CeremonyState {
  phase: CeremonyPhase
  reason?: string
  error?: { code: VaultErrorCode; retriesLeft?: number }
  armedUntil?: number
  /** Signing position while a batch runs (spec §4.2 step 8). Cleared on release. */
  progress?: { signed: number; total: number }
}
```

**(d) Lines 104–142 — `VaultKeyHandle`, `CeremonyMeta`, `CeremonyStoreView`** → replace with:

```ts
/**
 * An armed YubiKey: the chosen key's public identity plus the one operation
 * the card performs for the vault.
 *
 * Callers MUST call release() in a finally: on session-based transports that
 * is what dismisses the system NFC sheet, and on every transport it is what
 * ends the ceremony (phase back to 'idle') and drops the PIN.
 *
 * `sign()` after release (or after a timeout/detach relock) throws
 * `key-removed-mid-op` rather than talking to a card the ceremony has declared
 * dead. NEVER stash a signer in module state, React state, a closure that
 * outlives the operation, or any cache — obtain it from ceremonyHost for one
 * transfer and release it when that transfer ends.
 */
export interface VaultSigner {
  readonly serial: string
  /** 33-byte compressed P-256 public key, lowercase hex (as enrolled). */
  readonly pubkey: string
  /**
   * Sign one 32-byte digest (64 hex chars) on the card; returns DER bytes.
   * Retries in place on touch-timeout / nfc-lost / key-removed-mid-op REJECTED
   * BY the driver (re-opens the session on session-based transports,
   * re-checking serial + PIN); on session-based transports re-opens a fresh
   * session every `inputsPerTap` calls. `progress` publishes the loop position
   * to the sheet and refreshes the retention window. Throws
   * 'key-removed-mid-op' after release(), whatever released it (a cancel(),
   * a detach, the retention ceiling, or the caller).
   */
  sign(digestHex: string, progress?: { index: number; total: number }): Promise<number[]>
  /** Idempotent: safe to call more than once, and safe for concurrent callers
   * that were all handed the same signer to release independently. */
  release(): void
}

/** One enrolled key as the ceremony sees it — the public part of a
 * vaultStore VaultKeyRecord. */
interface CeremonyKey {
  serial: string
  slot: number
  pubkey: string
}

/** The store's key list, narrowed to what a tap needs. ceremonyHost maps
 * vaultStore's meta v5 onto it; tests hand in a literal. */
export interface CeremonyStoreView {
  getMeta(): Promise<{ keys: CeremonyKey[] } | null>
}
```

**(e) Lines 174–247 — class head through the constructor** → replace with:

```ts
export class CeremonyController {
  state: CeremonyState = { phase: 'idle' }

  onRelock?: (why: 'timeout' | 'detached' | 'manual') => void
  onArmed?: (signer: VaultSigner) => void

  private subscribers = new Set<(s: CeremonyState) => void>()
  private waiters: ((s: VaultSigner) => void)[] = []
  private rejecters: ((e: unknown) => void)[] = []
  private running = false
  private reason = ''
  /** The serial the in-flight (or most recent) ceremony was asked for. Read
   * by run() to pick the key out of the store, and by requestSigner() to
   * refuse a joiner naming a different key. */
  private chosenSerial = ''

  /** Monotonic id of the newest arm attempt. `running` alone cannot tell an
   * attempt that it has been replaced: cancel() sets running=false while the
   * cancelled attempt is still parked inside an await (a tap can still land
   * seconds later), and the requestSigner() that follows starts a fresh
   * attempt AND resets `cancelled`. Every run() captures its own generation
   * and re-checks it before touching any shared state, so a late-returning
   * attempt can only ever clean itself up. */
  private generation = 0

  /** The signer for the currently-armed session, if any. Set once arming
   * succeeds. Cleared by VaultSigner.release() itself (identity-checked
   * against this field — see makeHandle) rather than by whoever calls
   * release(), so this is accurate whether release() was invoked by the caller
   * finishing normally, or by cancel()/notifyKeyDetached()/the retention timer
   * relocking it. Its presence — not `state.phase` — is what the relock paths
   * key off of, because a signer can be "active" while the visible phase is
   * 'awaiting-touch', 'preparing' or 'broadcasting', not just 'armed'. (The
   * field keeps its historical name; every relock path reads it.) */
  private activeHandle?: VaultSigner

  private pinWaiter?: Deferred<string>
  private queuedPin?: string
  private retryWaiter?: Deferred<void>
  private attachWaiter?: Deferred<void>
  private cancelled = false
  private armTimer?: ReturnType<typeof setTimeout>
  /** When the current session armed. The anchor for the absolute ceiling — see
   * ARM_MAX_MULTIPLE — so a stream of progress notes cannot renew the retention
   * window forever. */
  private armedAt = 0

  /** Grace period given to an operation that is still reporting progress when
   * the retention window elapses, before the timeout is enforced regardless of
   * phase. See checkArmTimeout. */
  private static readonly ARM_GRACE_MS = 5_000

  /** Hard ceiling on a session's life, as a multiple of the retention window.
   * A progress note refreshes the window (see noteProgress), which on its own
   * would make the retention period a lease the caller can renew indefinitely.
   * Past `armedAt + this × retentionMs` the relock fires no matter how fresh
   * the progress is, and the grace window is clamped to it too, so the
   * signer's maximum lifetime is bounded by construction rather than by caller
   * good behaviour. */
  private static readonly ARM_MAX_MULTIPLE = 3

  /** Deadline for a session-based transport's waiting-for-key. CoreNFC caps a
   * tag-reader session at 60 s; if nothing (attach OR failure) has arrived in
   * 65 s the session is dead and its ending was swallowed somewhere below us —
   * YubiKit drops several such paths internally (readingAvailable false at
   * start, a session invalidated before it ever became active), so no delegate
   * fix can make this watchdog redundant. Persistent readers (Android USB)
   * are exempt: waiting for an insert legitimately has no deadline. */
  private static readonly DEFAULT_ATTACH_TIMEOUT_MS = 65_000

  /** Signatures one session-based tap covers before the ceremony closes the
   * session and asks for a fresh tap (spec §4.2 step 6). ceremonyHost passes
   * VAULT_INPUTS_PER_TAP; this is the fallback for a bare controller. */
  private static readonly DEFAULT_INPUTS_PER_TAP = 16

  constructor(
    private deps: {
      getDriver: () => VaultDriver | null
      store: CeremonyStoreView
      retentionMs: number
      /** Test seam for the waiting-for-key watchdog (session-based only). */
      attachTimeoutMs?: number
      /** Session-based transports only: how many sign() calls one tap covers. */
      inputsPerTap?: number
    }
  ) {}
```

**(f) Lines 255–267 — `requestKey`** → replace with:

```ts
  /** Ask for the chosen key as a signer. Concurrent calls naming the same
   * serial share one ceremony and all receive the SAME signer, so release() is
   * idempotent by construction; a concurrent call naming a DIFFERENT serial is
   * refused at once with serial-mismatch (one sheet can only run one tap). */
  requestSigner(reason: string, chosenSerial: string): Promise<VaultSigner> {
    return new Promise<VaultSigner>((resolve, reject) => {
      if (this.running && chosenSerial !== this.chosenSerial) {
        reject(
          new VaultError(
            'serial-mismatch',
            `A ceremony for key ${this.chosenSerial} is already in progress; asked for key ${chosenSerial}`
          )
        )
        return
      }
      this.waiters.push(resolve)
      this.rejecters.push(reject)
      if (this.running) return // join the in-flight ceremony
      this.reason = reason
      this.chosenSerial = chosenSerial
      this.cancelled = false
      this.running = true
      void this.run()
    })
  }
```

**(g) Lines 269–291 — `noteProgress`** → replace with:

```ts
  /**
   * Report post-arm progress from the spend path.
   *
   * Guarded on an armed session: a note with no signer armed (a deposit, which
   * is hardware-free, or a caller that has already released) must not raise a
   * sheet, and anything arriving mid-arm is ignored because the arming phases
   * own the display.
   *
   * A progress note also REFRESHES the retention window, bounded twice over
   * (see startArmTimer / ARM_MAX_MULTIPLE): progress must keep arriving, AND no
   * refresh may push the relock past `armedAt + ARM_MAX_MULTIPLE × retentionMs`.
   *
   * 'preparing' with both counters publishes them as `state.progress`; any
   * other note clears it, so a stale "3 of 10" never outlives its batch.
   */
  noteProgress(p: VaultProgress): void {
    if (!this.activeHandle || this.running) return
    const progress =
      p.phase === 'preparing' && p.signed != null && p.total != null ? { signed: p.signed, total: p.total } : undefined
    this.set({ phase: p.phase, progress, armedUntil: this.startArmTimer(), error: undefined })
  }
```

**(h) Lines 390–510 — `run()`** → replace with (only the meta/key resolution and the `handle`→`signer` names change; the fencing and the finally are verbatim):

```ts
  private async run(): Promise<void> {
    // This attempt's identity for the rest of its life — see `generation`.
    const gen = ++this.generation
    const driver = this.deps.getDriver()
    if (!driver) {
      this.failAll(new VaultError('driver-unavailable'))
      this.running = false
      return
    }
    // This attempt's own driver-event subscription box: a key connecting (an
    // NFC tap / a USB plug) resolves waiting-for-key; a key dropping mid-flow
    // aborts. Self-contained so it works whether or not WalletContext also
    // watches for persistent relock. Boxed per-attempt — see KeyEventSession.
    const session: KeyEventSession = {}
    this.subscribeKeyEvents(driver, session)
    // Attempt-local: whether THIS run() reached a successful arm. Deliberately
    // NOT this.activeHandle, which is controller-wide — see the finally guard
    // below for why that distinction is load-bearing.
    let armed = false
    // Set when this attempt discovers it has been superseded: it has already
    // torn its own session down, so the finally must not do it twice.
    let superseded = false
    try {
      // The key list, read before any hardware prompt: a serial that is not
      // enrolled (a removed key, a stale chooser) has nothing a tap could do,
      // so it must fail before the sheet ever opens (spec §4.2 step 6).
      const meta = await this.deps.store.getMeta()
      if (!meta) throw new VaultError('not-enrolled')
      const key = meta.keys.find(k => k.serial === this.chosenSerial)
      if (!key) {
        throw new VaultError('not-enrolled', `Key ${this.chosenSerial} is not one of this vault's keys`)
      }

      // NFC (session-based) collects the PIN BEFORE the tap and verifies it in
      // that one tap (the scan sheet covers the app, so no PIN entry mid-tap).
      // A persistent USB reader can interleave PIN entry and the serial/PIN
      // checks.
      const signer = driver.sessionBased
        ? await this.armViaTap(driver, key, session, gen)
        : await this.armViaReader(driver, key, session, gen)
      this.throwIfCancelled()

      // Have we been superseded while parked on the tap? `cancelled` cannot
      // answer this: cancel() sets it, but the very next requestSigner() resets
      // it to false for the NEW attempt, so by the time a cancelled-then-
      // replaced attempt's PIN check lands, the flag reads clean again. Only
      // the generation does. Without this check that attempt would install ITS
      // signer as activeHandle over the successor's, arm a second timer, and
      // hand its own signer to whoever is waiting on the successor — two
      // sessions live, one of them owned by nobody.
      if (gen !== this.generation) {
        superseded = true
        // Drop THIS attempt's listener box first (release() only unsubscribes
        // on a session-based transport, and the post-arm unsubscribe below is
        // never reached from here — without this a cancelled-and-replaced
        // attempt would leave a live listener behind on every persistent-reader
        // ceremony), then drop its session. The identity check inside
        // release() means none of the controller's shared state (the
        // successor's activeHandle, timer or phase) is touched.
        this.unsubscribeKeyEvents(session)
        signer.release()
        return
      }

      this.activeHandle = signer
      armed = true
      this.arm()
      this.resolveAll(signer)
      this.onArmed?.(signer)

      // Persistent readers hand relock-on-unplug to WalletContext's
      // longer-lived listener — drop ours now. Session-based transports keep
      // listening: see subscribeKeyEvents' doc above.
      if (!driver.sessionBased) this.unsubscribeKeyEvents(session)
    } catch (e) {
      // Anything that is not a VaultError gets relabelled 'driver-unavailable',
      // which renders as "YubiKey support is unavailable on this device" — so
      // the original message is carried across as the detail rather than being
      // dropped, otherwise an unrelated failure is indistinguishable from a
      // genuinely absent driver.
      const err = e instanceof VaultError ? e : new VaultError('driver-unavailable', String(e))
      // Same generation guard as the success path, for the same reason: a
      // superseded attempt's failure is not the CURRENT attempt's failure, and
      // must not reject the successor's waiters or paint its phase. Its own
      // waiters were already failed by the cancel() that superseded it, so
      // there is nobody left to tell. The finally still closes its session.
      if (gen !== this.generation) return
      if (err.code === 'user-cancelled') {
        this.set({ phase: 'idle' })
      } else {
        this.set({ phase: 'error', error: { code: err.code, retriesLeft: err.retriesLeft } })
      }
      this.failAll(err)
    } finally {
      // Only the CURRENT attempt owns `running`. A superseded attempt clearing
      // it would declare the successor's still-in-flight ceremony finished, so
      // the next requestSigner() would start a third attempt alongside it
      // instead of joining the second.
      if (gen === this.generation) this.running = false
      // `armed` (this attempt's own outcome), NOT this.activeHandle (whoever
      // the CONTROLLER currently considers active): an unreleased predecessor
      // ceremony leaves this.activeHandle truthy for the whole time this
      // attempt runs, which would otherwise make a FAILED successor's finally
      // wrongly conclude "some signer must already own this session/
      // subscription" and skip closing its own — the predecessor's activeHandle
      // has nothing to do with whether this attempt itself succeeded.
      if (!armed && !superseded) {
        // Arming never completed: no signer exists to own the subscription
        // or the session, so close both now — nothing else ever will.
        // (A superseded attempt DID build a signer and released it above,
        // which already did exactly this teardown — don't repeat it.)
        // Unsubscribe BEFORE any stop so a session-end detach echo cannot
        // relock a session that was already dead.
        this.unsubscribeKeyEvents(session)
        if (driver.sessionBased) {
          try {
            driver.stop()
          } catch {
            /* stop is best-effort */
          }
        }
      }
    }
  }
```

**(i) Lines 520–547 — `armViaReader`** → replace with (adds `requireChosenSerial`, used by both transports):

```ts
  /** Persistent reader (Android USB): key present, PIN entry and token ops
   * interleave, so a wrong PIN is retried in place. */
  private async armViaReader(
    driver: VaultDriver,
    key: CeremonyKey,
    session: KeyEventSession,
    gen: number
  ): Promise<VaultSigner> {
    this.throwIfStale(gen)
    this.set({ phase: 'connecting' })
    let info = await this.safeKeyInfo(driver)
    if (!info) {
      this.set({ phase: 'waiting-for-key' })
      const waiter = (this.attachWaiter = defer<void>())
      driver.start(this.reason)
      await waiter.promise
      this.throwIfStale(gen)
      this.set({ phase: 'connecting' })
      info = await this.safeKeyInfo(driver)
    }
    if (!info) throw new VaultError('no-key')
    this.requireChosenSerial(info.serial, key)
    const pin = await this.collectPin(driver, gen)
    return this.makeHandle(driver, key, pin, session, gen)
  }

  /** The serial check, run on EVERY session (initial arm, and each reopen on
   * a session-based transport): the tapped card must be THE chosen key. The
   * detail names both serials so the sheet can say "That's X — you chose Y"
   * (spec §4.2 step 6). A serial not enrolled at all lands here too: it is
   * not the chosen one either, and the sheet has the key list to say so. */
  private requireChosenSerial(tapped: string, key: CeremonyKey): void {
    if (tapped !== key.serial) {
      throw new VaultError('serial-mismatch', `Tapped key ${tapped}, chose key ${key.serial}`, undefined, {
        tapped,
        chosen: key.serial
      })
    }
  }
```

**(j) Lines 549–555 — the `RETRYABLE_TAP_ERRORS` docblock + field** → replace with:

```ts
  /** Errors from a single tap/touch attempt that are worth retrying without
   * throwing away the whole operation: a missed/short touch, or the field
   * dropping mid-command (phone shifted, key lifted a hair early). On a
   * session-based transport all three leave the dead NFC session behind, so a
   * retry must close it and open a fresh one — see the reopen inside
   * VaultSigner.sign() (makeHandle). Only REJECTIONS of driver.signEcdsa are
   * classified here; a driver-emitted 'detached' event is handled by
   * notifyKeyDetached and relocks. */
  private static readonly RETRYABLE_TAP_ERRORS = new Set(['touch-timeout', 'nfc-lost', 'key-removed-mid-op'])
```

**(k) Lines 557–571 — `armViaTap`** → replace with:

```ts
  /** NFC tap (iOS): PIN first in-app (the scan sheet is modal), then one tap
   * connects, checks the serial and verifies the PIN. A wrong PIN aborts the
   * ceremony — we cannot re-prompt beneath an open system NFC sheet. No
   * touch is spent here: the first signature is the first touch. */
  private async armViaTap(
    driver: VaultDriver,
    key: CeremonyKey,
    session: KeyEventSession,
    gen: number
  ): Promise<VaultSigner> {
    const pin = await this.collectPinValue(gen)
    await this.openTapSession(driver, key, pin, session, gen)
    return this.makeHandle(driver, key, pin, session, gen)
  }
```

**(l) Lines 573–622 — `openTapSession`** → replace with:

```ts
  /** Open (or reopen) an NFC session and get as far as a verified PIN. Used
   * for the initial arm and — on a session-based transport — by
   * VaultSigner.sign() to re-establish a fresh session after a dropped tap
   * and at every batch boundary. The serial check lives here as well as in
   * armViaReader deliberately: EVERY session, including a reopened one,
   * re-checks it, so a different card presented on the next tap is never
   * asked to sign for this key.
   * (Re)subscribes `session` every time: the very first call replaces run()'s
   * top-level subscription on the SAME box (harmless — nothing was pending on
   * it yet), and every reopen needs a fresh one since the caller unsubscribed
   * this same box around its matching driver.stop(). */
  private async openTapSession(
    driver: VaultDriver,
    key: CeremonyKey,
    pin: string,
    session: KeyEventSession,
    gen: number
  ): Promise<void> {
    this.throwIfStale(gen)
    this.subscribeKeyEvents(driver, session)
    this.set({ phase: 'waiting-for-key' })
    const waiter = (this.attachWaiter = defer<void>())
    driver.start(this.reason)
    // Watchdog: a session-based transport that reports NOTHING by the deadline
    // is dead, and its death was swallowed below us (see
    // DEFAULT_ATTACH_TIMEOUT_MS). Identity-checked against attachWaiter so a
    // late firing can never touch a successor ceremony's waiter.
    const attachDeadline = setTimeout(() => {
      if (this.attachWaiter === waiter) {
        this.attachWaiter = undefined
        waiter.reject(new VaultError('no-key', 'No key connected before the NFC session deadline'))
      }
    }, this.deps.attachTimeoutMs ?? CeremonyController.DEFAULT_ATTACH_TIMEOUT_MS)
    ;(attachDeadline as { unref?: () => void }).unref?.()
    try {
      await waiter.promise
    } finally {
      clearTimeout(attachDeadline)
    }
    this.throwIfStale(gen)
    this.set({ phase: 'connecting' })
    const info = await driver.getKeyInfo()
    // getKeyInfo is a native call cancel() cannot interrupt.
    this.throwIfStale(gen)
    this.requireChosenSerial(info.serial, key)
    const res = await driver.verifyPin(pin)
    this.throwIfStale(gen)
    if (!res.ok) throw new VaultError('pin-invalid', 'Wrong PIN', res.retriesLeft)
  }
```

**(m) Lines 664–750 — `unwrapVaultKey`** → DELETE entirely (its retry loop lives on inside `sign()` below).

**(n) Lines 752–842 — `makeHandle`** → replace with:

```ts
  /**
   * Wrap the verified card in the armed signer.
   *
   * `sign()` is where every touch is spent, so it carries the retry loop that
   * used to guard the single ECDH: a retryable rejection (RETRYABLE_TAP_ERRORS)
   * parks on the Retry prompt, then — on a session-based transport — closes
   * the dead session and opens a fresh one via openTapSession (serial re-
   * checked, PIN re-verified) before signing the SAME digest again. Nothing
   * about the caller's transaction changes: the digest is the same, so the
   * signatures already gathered stay valid and the loop resumes at input k.
   * A non-retryable rejection (pin-locked, an unexpected native error) paints
   * `error` and rethrows; the caller aborts its reservation and releases.
   *
   * Batches: on a session-based transport, after `inputsPerTap` successful
   * signatures the NEXT sign() first closes the session and reopens it —
   * publishing the caller's progress under 'waiting-for-key' so the sheet can
   * say "batch b of n" — because the card's 15 s touch cache and CoreNFC's
   * 60 s session both bound what one tap can cover. Persistent readers never
   * reopen.
   *
   * `released` is checked on every resumption point: whichever path ends the
   * session (the caller finishing normally, or the controller's own
   * cancel/detach/timeout relock) makes every later sign() throw
   * `key-removed-mid-op` instead of driving a card the ceremony considers
   * gone. A sign() already parked inside driver.signEcdsa when that happens
   * throws the same on return, whatever the card answered.
   *
   * release() is identity-checked against the controller's `activeHandle`:
   * whichever call reaches it first does the real cleanup — the transport
   * session AND, only if this is still the current signer, the shared arm
   * timer, activeHandle, phase and progress. That makes a signer released late
   * (after a successor has already armed) a no-op against the CONTROLLER's own
   * state and against the SUBSCRIPTION (each attempt owns its own
   * KeyEventSession box, so unsubscribing here can never touch a successor's
   * listener — see KeyEventSession).
   *
   * That scoping does NOT extend to the native transport itself:
   * `driver.stop()` (via the real adapter, `driver.ts`'s `adaptNative.stop`)
   * calls `native.stopDiscovery()` + `native.clearKeyListener()`, which are
   * process-wide — there is exactly one NFC/USB discovery session at the
   * native layer, not one per KeyEventSession box. A late release() on a
   * session-based transport therefore CAN silence a successor's still-open
   * native session even though it cannot touch the successor's JS-level
   * subscription or controller state. In practice this window is narrow (the
   * successor's own subsequent driver.start() reopens discovery), but it is
   * a real gap, not a theoretical one — do not read the subscription-safety
   * property above as a transport-safety one too.
   */
  private makeHandle(
    driver: VaultDriver,
    key: CeremonyKey,
    pin: string,
    session: KeyEventSession,
    gen: number
  ): VaultSigner {
    const inputsPerTap = this.deps.inputsPerTap ?? CeremonyController.DEFAULT_INPUTS_PER_TAP
    let released = false
    /** Successful signatures in the CURRENT transport session. Only consulted
     * on session-based transports. */
    let signedThisSession = 0
    const deadSigner = (): VaultError => new VaultError('key-removed-mid-op', 'Vault signer already released')

    /** Close the dead or exhausted session and open a fresh one on the same
     * box, re-checking serial and PIN. */
    const reopen = async (): Promise<void> => {
      // Unsubscribe BEFORE our own stop() so its session-end detach echo
      // cannot be mistaken for a real one and relock the signer we are about
      // to legitimately continue. openTapSession resubscribes this SAME box
      // fresh for the reopened session.
      this.unsubscribeKeyEvents(session)
      try {
        driver.stop()
      } catch {
        /* best-effort */
      }
      await this.openTapSession(driver, key, pin, session, gen)
      signedThisSession = 0
    }

    const signer: VaultSigner = {
      serial: key.serial,
      pubkey: key.pubkey,
      sign: async (digestHex, progress) => {
        if (released) throw deadSigner()
        if (progress) this.noteSigning(progress)
        // Batch boundary (spec §4.2 step 6). The progress published just above
        // is what the sheet shows under 'waiting-for-key' ("batch b of n").
        if (driver.sessionBased && signedThisSession >= inputsPerTap) {
          await reopen()
          if (released) throw deadSigner()
        }
        for (;;) {
          if (released) throw deadSigner()
          this.set({ phase: 'awaiting-touch', error: undefined })
          try {
            const { signature } = await driver.signEcdsa(key.slot, pin, digestHex)
            // signEcdsa is a native call cancel() cannot interrupt: if the
            // signer was released while we were parked, the answer is not ours
            // to hand out.
            if (released) throw deadSigner()
            signedThisSession++
            return Utils.toArray(signature, 'hex')
          } catch (e) {
            if (released) throw deadSigner()
            const err = e instanceof VaultError ? e : new VaultError('nfc-lost')
            if (!CeremonyController.RETRYABLE_TAP_ERRORS.has(err.code)) {
              // A hard failure is not retryable — paint it so the sheet can
              // explain, and rethrow so the caller aborts and releases;
              // release() then takes the phase back to idle.
              this.set({ phase: 'error', error: { code: err.code, retriesLeft: err.retriesLeft } })
              throw err
            }
            // Park on the Retry prompt. retryWaiter resolves on retry(); it
            // rejects on cancel() (user-cancelled), on notifyKeyDetached or the
            // retention ceiling (key-removed-mid-op) — each of which has
            // already released this signer by the time the rejection lands.
            this.set({ phase: 'error', error: { code: err.code } })
            this.retryWaiter = defer<void>()
            await this.retryWaiter.promise
            if (released) throw deadSigner()
            if (driver.sessionBased) await reopen()
            // loop: sign the SAME digest again
          }
        }
      },
      release: () => {
        if (released) return
        released = true
        // Session-based transports (iOS NFC) held the scan session open for the
        // caller's whole signing loop; this is what finally dismisses the sheet.
        // Unsubscribe first so our own stop() cannot echo back as a detach and
        // re-enter this relock path. Scoped to THIS signer's own session box —
        // see KeyEventSession — so a late release() here can never touch a
        // successor ceremony's subscription or session.
        if (driver.sessionBased) {
          this.unsubscribeKeyEvents(session)
          try {
            driver.stop()
          } catch {
            /* stop is best-effort */
          }
        }
        // Only touch controller-wide state if this is still THE active signer:
        // a stale/superseded signer's release() must not clobber a successor
        // ceremony's armed state, timer, phase or progress.
        if (this.activeHandle === signer) {
          this.clearArmTimer()
          this.activeHandle = undefined
          this.set({ phase: 'idle', progress: undefined })
        }
        // Bound the PIN's exposure now that the session is closed for good —
        // strings can't be wiped, but there is no reason to keep pinning the
        // value in the module singleton once release() has run.
        pin = ''
      }
    }
    return signer
  }

  /** Publish the signing loop's position and refresh the retention window —
   * the sign()-side twin of noteProgress, without a phase change (sign()
   * paints 'awaiting-touch' itself a moment later). */
  private noteSigning(p: { index: number; total: number }): void {
    this.set({ progress: { signed: p.index, total: p.total }, armedUntil: this.startArmTimer() })
  }
```

**(o) Lines 844–849 — `arm()`** → replace with:

```ts
  private arm(): void {
    // Anchor the absolute ceiling BEFORE the first startArmTimer, which clamps
    // against it. `progress: undefined` is deliberate: the key is present in
    // every armed state (the pinned key set), empty until the loop reports.
    this.armedAt = now()
    this.set({ phase: 'armed', armedUntil: this.startArmTimer(), error: undefined, progress: undefined })
  }
```

**(p) Lines 923–945 — the `throwIfStale` docblock** → the one sentence naming the native park points becomes `driver.signEcdsa`-free (there is no touch at arm time any more). Replace lines 928–931 (`   * resets it to false for the NEW attempt. An attempt parked in a native call` … `   * would carry on painting phases, installing waiters, and talking to the card`) with:

```ts
   * resets it to false for the NEW attempt. An attempt parked in a native call
   * that cancel() cannot interrupt — `driver.verifyPin`, `driver.getKeyInfo`
   * — therefore comes back to a flag that reads clean, and
   * would carry on painting phases, installing waiters, and talking to the card
```

**(q) Lines 947–952 — `resolveAll`** → replace with:

```ts
  private resolveAll(signer: VaultSigner): void {
    const ws = this.waiters
    this.waiters = []
    this.rejecters = []
    ws.forEach(w => w(signer))
  }
```

- [ ] **Step 4: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/ceremony.test.ts` → all pass: `arming` 17, `NFC session failure before a key connects` 6, `vault signer` 16, `one singleton, sequential ceremonies` 6, `post-arm progress` 3, `retention timeout robustness` 4 — **52 tests**.
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'VaultKeyService.ts\|ceremonyHost.ts\|transfers.ts\|ui/screens/VaultScreen.tsx'` → empty. (`ceremony.ts` itself must be clean: `grep ceremony.ts` on the raw output → nothing.)
`grep -n "ecdh\|unseal\|SealedBlob\|VaultKeyHandle\|HD\b" packages/expo-wallet-toolbox/core/services/vault/ceremony.ts` → nothing.

- [ ] **Step 5: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/ceremony.ts packages/expo-wallet-toolbox/__tests__/vault/ceremony.test.ts
git commit -m "feat(expo-wallet-toolbox)!: ceremony yields a VaultSigner — chosen serial, resumable on-card signing, NFC batches" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: ceremonyHost.ts — `requestVaultSigner`, `VAULT_INPUTS_PER_TAP`, v5 store view

**Files:**
- Modify: `T/core/services/vault/ceremonyHost.ts` (whole file, 46 lines → rewritten)
- Create: `T/__tests__/vault/ceremonyHost.test.ts`

**Interfaces:**
- Consumes: `CeremonyController`, `VaultProgress`, `VaultSigner` from `./ceremony` (Task 6); `getVaultDriver` from `./driver`; `vaultStore` (meta v5, Task 3).
- Produces (contract): `ceremony` (singleton), `VAULT_RETENTION_MS = 120_000`, `VAULT_INPUTS_PER_TAP = 16`, `requestVaultSigner(reason, chosenSerial): Promise<VaultSigner>`, `noteVaultProgress(p: VaultProgress): void`. Removed: `requestVaultKey`.
- Allowed tsc residuals after this commit: `transfers.ts` (`requestVaultKey`, `VaultKeyHandle`, `takeNextIndex`, missing `./k1`/`./vaultDerivation` — Tasks 9–11), `VaultKeyService.ts` (Task 8), `ui/screens/VaultScreen.tsx` (Plan 3). `WalletContext.tsx` keeps compiling: it imports only `VAULT_RETENTION_MS` and `ceremony` (`notifyKeyDetached`/`notifyKeyAttached`, unchanged).

- [ ] **Step 1: Failing wiring test**

`T/__tests__/vault/ceremonyHost.test.ts`:

```ts
/**
 * ceremonyHost — the process-wide CeremonyController singleton. Wiring only:
 * the controller's behaviour is ceremony.test.ts's business. This proves the
 * host constructs ONE controller with the release constants, a store view
 * that narrows vaultStore's meta v5 to the ceremony's key list, and thin
 * forwarders for requestVaultSigner / noteVaultProgress. The controller is
 * replaced by a recording fake so no driver or card is involved.
 */
// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts: the vault
// suites install a different one and a global mapper makes the resolver
// recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))
jest.mock('../../core/services/vault/ceremony', () => {
  class FakeCeremonyController {
    static instances: FakeCeremonyController[] = []
    deps: unknown
    requestSigner = jest.fn(async (_reason: string, serial: string) => ({
      serial,
      pubkey: '02' + '00'.repeat(32),
      sign: async () => [] as number[],
      release: () => {}
    }))
    noteProgress = jest.fn()
    constructor(deps: unknown) {
      this.deps = deps
      FakeCeremonyController.instances.push(this)
    }
  }
  return { CeremonyController: FakeCeremonyController }
})

import AsyncStorage from '@react-native-async-storage/async-storage'
import { CeremonyController } from '../../core/services/vault/ceremony'
import { getVaultDriver } from '../../core/services/vault/driver'
import { vaultStore } from '../../core/services/vault/vaultStore'
import {
  VAULT_INPUTS_PER_TAP,
  VAULT_RETENTION_MS,
  ceremony,
  noteVaultProgress,
  requestVaultSigner
} from '../../core/services/vault/ceremonyHost'

interface FakeDeps {
  getDriver: unknown
  store: { getMeta: () => Promise<unknown> }
  retentionMs: number
  inputsPerTap?: number
  attachTimeoutMs?: number
}
interface FakeInstance {
  deps: FakeDeps
  requestSigner: jest.Mock
  noteProgress: jest.Mock
}
const instances = (CeremonyController as unknown as { instances: FakeInstance[] }).instances

beforeEach(async () => {
  await AsyncStorage.clear()
})

test('constants: two-minute retention, sixteen inputs per tap', () => {
  expect(VAULT_RETENTION_MS).toBe(120_000)
  expect(VAULT_INPUTS_PER_TAP).toBe(16)
})

test('constructs exactly one controller, wired to the live driver getter and the release constants', () => {
  expect(instances).toHaveLength(1)
  expect(ceremony).toBe(instances[0])
  const deps = instances[0].deps
  expect(deps.getDriver).toBe(getVaultDriver)
  expect(deps.retentionMs).toBe(VAULT_RETENTION_MS)
  expect(deps.inputsPerTap).toBe(VAULT_INPUTS_PER_TAP)
  expect(deps.attachTimeoutMs).toBeUndefined() // the ceremony's own 65 s default applies
})

test('the store view narrows meta v5 to { keys: [{ serial, slot, pubkey }] } and nothing else', async () => {
  const view = instances[0].deps.store
  expect(await view.getMeta()).toBeNull()

  await vaultStore.setMeta({
    v: 5,
    createdAt: 1,
    lastUsedAt: 2,
    lastUsedSerial: '10000002',
    keys: [
      { serial: '10000001', slot: 0x82, pubkey: '02' + 'aa'.repeat(32), nickname: 'Desk', enrolledAt: 1 },
      { serial: '10000002', slot: 0x82, pubkey: '03' + 'bb'.repeat(32), nickname: 'Safe', enrolledAt: 2 }
    ]
  })
  // toEqual, not toMatchObject: nicknames and timestamps must NOT leak into
  // the ceremony's view — it needs serial, slot and pubkey only.
  expect(await view.getMeta()).toEqual({
    keys: [
      { serial: '10000001', slot: 0x82, pubkey: '02' + 'aa'.repeat(32) },
      { serial: '10000002', slot: 0x82, pubkey: '03' + 'bb'.repeat(32) }
    ]
  })
})

test("requestVaultSigner forwards (reason, chosenSerial) and returns the controller's signer", async () => {
  const signer = await requestVaultSigner('Withdraw from vault', '10000002')
  expect(instances[0].requestSigner).toHaveBeenCalledTimes(1)
  expect(instances[0].requestSigner).toHaveBeenCalledWith('Withdraw from vault', '10000002')
  expect(signer.serial).toBe('10000002')
})

test('noteVaultProgress forwards the note verbatim', () => {
  noteVaultProgress({ phase: 'preparing', signed: 3, total: 9 })
  expect(instances[0].noteProgress).toHaveBeenCalledWith({ phase: 'preparing', signed: 3, total: 9 })
  noteVaultProgress({ phase: 'broadcasting' })
  expect(instances[0].noteProgress).toHaveBeenLastCalledWith({ phase: 'broadcasting' })
})
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/ceremonyHost.test.ts` → fails at import: `TypeError: vaultStore.getSeal is not a function` is not reached (the fake controller never calls the view); the failures are `(0 , _ceremonyHost.requestVaultSigner) is not a function`, `expect(received).toBe(expected) … Expected: 16 Received: undefined` for `VAULT_INPUTS_PER_TAP`, and `deps.inputsPerTap` undefined.

- [ ] **Step 3: Rewrite `ceremonyHost.ts`**

```ts
/**
 * The process-wide ceremony singleton.
 *
 * Constructed once against the live driver + store so the vault transfer flow
 * and the React vault context drive the SAME ceremony. Kept out of any React
 * module so importing it never pulls in the component graph.
 */
import { CeremonyController, VaultProgress, VaultSigner } from './ceremony'
import { getVaultDriver } from './driver'
import { vaultStore } from './vaultStore'

/** How long an armed signer stays usable before it relocks — refreshed by
 * progress notes and sign() calls, capped at 3× (see ceremony.ts). */
export const VAULT_RETENTION_MS = 120_000

/** Digests one NFC tap covers before the ceremony closes the session and
 * asks for a fresh tap (spec §4.2 step 6). PROVISIONAL: pinned by the §0
 * device run (a 32-input withdrawal on iOS) against the card's 15 s touch
 * cache and CoreNFC's 60 s session. Persistent readers (Android USB) ignore it. */
export const VAULT_INPUTS_PER_TAP = 16

export const ceremony = new CeremonyController({
  getDriver: getVaultDriver,
  store: {
    // Only what the ceremony needs to run a tap: which serials may answer and
    // which slot / public key each carries. Nicknames and timestamps stay in
    // the store — the sheet reads them from vaultStore directly.
    getMeta: async () => {
      const m = await vaultStore.getMeta()
      return m ? { keys: m.keys.map(k => ({ serial: k.serial, slot: k.slot, pubkey: k.pubkey })) } : null
    }
  },
  retentionMs: VAULT_RETENTION_MS,
  inputsPerTap: VAULT_INPUTS_PER_TAP
})

/** Tap the CHOSEN YubiKey to obtain a signer for one operation. Callers MUST
 * release() in a finally — that is what dismisses the NFC sheet and drops the
 * PIN. `reason` is what the sheet shows, and (Task 6, decision 1) the iOS NFC
 * alert text. */
export function requestVaultSigner(reason: string, chosenSerial: string): Promise<VaultSigner> {
  return ceremony.requestSigner(reason, chosenSerial)
}

/** Report post-arm progress (preparing with signed/total, broadcasting) so
 * the ceremony sheet can show activity through the seconds-long stretches
 * where the JS thread or the network is busy, and so the retention window
 * tracks a live operation instead of expiring underneath it. A no-op when
 * nothing is armed — which is what keeps the hardware-free deposit sheet-free. */
export function noteVaultProgress(p: VaultProgress): void {
  ceremony.noteProgress(p)
}
```

- [ ] **Step 4: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/ceremonyHost.test.ts packages/expo-wallet-toolbox/__tests__/vault/ceremony.test.ts packages/expo-wallet-toolbox/__tests__/context/vaultProviderMigration.test.tsx packages/expo-wallet-toolbox/__tests__/context/walletBuildRestore.test.tsx` → all pass (`ceremonyHost` 5 new; the two context suites prove the singleton still mounts under `VaultProvider` and `WalletContextProvider`).
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'VaultKeyService.ts\|transfers.ts\|ui/screens/VaultScreen.tsx'` → empty.

- [ ] **Step 5: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/ceremonyHost.ts packages/expo-wallet-toolbox/__tests__/vault/ceremonyHost.test.ts
git commit -m "feat(expo-wallet-toolbox)!: ceremonyHost vends VaultSigner for a chosen serial; VAULT_INPUTS_PER_TAP" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: VaultKeyService.ts — `enrollKey`, `finalizeEnrollment(records)`, `addVaultKey`, `disableVault`

**Files:**
- Modify: `T/core/services/vault/VaultKeyService.ts` (whole file, 312 lines → rewritten)
- Rewrite: `T/__tests__/vault/vaultKeyService.test.ts`

**Interfaces:**
- Consumes: `getVaultDriver` (`./driver`), `withKeySession(driver, work, onWaiting?, opts?)` (Task 4's 4-parameter form), `compressPubkey` (`./r1comb`, Plan 1), `vaultStore`/`VaultKeyRecord`/`VaultMeta` (Task 3), `VaultError`.
- Produces (contract): `VAULT_SLOT = 0x82`, `VAULT_MIN_KEYS = 2`, `VAULT_MAX_KEYS = 5`, `EnrollPhase`, `enrollKey(args): Promise<VaultKeyRecord>`, `finalizeEnrollment(records): Promise<void>`, `addVaultKey(record): Promise<VaultMeta>`, `disableVault(): Promise<void>`. Removed: `enrollVault`, `recoverVaultHD`, `resealToNewKey`, `PendingEnrollment`, `adoptExisting`, the `'adopting'` phase, the passphrase check, every seed/seal line.
- Additive to the contract (flagged in the summary): `enrollKey` accepts an optional `nfcMessage?: string`, forwarded to `withKeySession`'s `opts.nfcMessage` so the iOS scan sheet can say "Hold your YubiKey here to set it up" (spec §4.2 step 6). Omitting it yields the native default wording.
- Both `key-already-enrolled` throws (`enrollKey`'s duplicate-tap check and `finalizeEnrollment`'s duplicate-in-batch check) populate `VaultError.details = { serial }` with the offending serial (Task 1's convention).
- Allowed tsc residuals after this commit: `transfers.ts` (Tasks 9–11), `ui/components/vault/EnrollWizard.tsx` (`enrollVault`, `finalizeEnrollment(pending)`), `ui/screens/VaultRecoverScreen.tsx` (`recoverVaultHD`, `sweepVaultWithHD`), `ui/screens/VaultScreen.tsx` — all Plan 3.

- [ ] **Step 1: Rewrite the service test**

Replace `T/__tests__/vault/vaultKeyService.test.ts` with:

```ts
/**
 * VaultKeyService — enrolling YubiKeys into the vault's key list. Driven
 * against the multi-serial mock YubiKey and the real (AsyncStorage-mocked)
 * vaultStore. The card is a SIGNER now: enrollment generates a fresh P-256
 * key on it and records the compressed public key, nothing else — so these
 * tests inspect the public record and the store, and prove nothing reaches
 * disk until finalizeEnrollment.
 *
 * Plan 1's r1comb.ts must exist: compressPubkey is the canonical form.
 */
// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts: the vault
// suites install a different one and a global mapper makes the resolver
// recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { setMockDriver } from '../../core/services/vault/driver'
import { compressPubkey } from '../../core/services/vault/r1comb'
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'
import {
  VAULT_MAX_KEYS,
  VAULT_MIN_KEYS,
  VAULT_SLOT,
  addVaultKey,
  disableVault,
  enrollKey,
  finalizeEnrollment
} from '../../core/services/vault/VaultKeyService'

let mock: MockYubiKey

beforeEach(async () => {
  await AsyncStorage.clear()
  mock = new MockYubiKey()
  mock.insertKey('MOCK-1')
  setMockDriver(mock)
})
afterEach(() => setMockDriver(null))

const PIN = '123456'

/** Enrollment args with the contract's required fields filled in. */
const args = (over: Record<string, unknown> = {}) => ({
  pendingSerials: [] as string[],
  onPhase: () => {},
  getPin: async () => PIN,
  ...over
})

const rec = (n: number): VaultKeyRecord => ({
  serial: `1000000${n}`,
  slot: VAULT_SLOT,
  pubkey: '02' + n.toString(16).padStart(2, '0').repeat(32),
  nickname: `Key ${n}`,
  enrolledAt: 1_700_000_000_000 + n
})

/** An NFC-shaped mock whose start() "connects the tap" at once. */
const nfcMock = (): MockYubiKey => {
  const nfc = new MockYubiKey()
  ;(nfc as unknown as { sessionBased: boolean }).sessionBased = true
  nfc.insertKey('MOCK-1')
  return nfc
}

describe('enrollKey', () => {
  test('one card session yields a key record with a compressed lowercase pubkey, and persists nothing', async () => {
    const phases: string[] = []
    const before = Date.now()
    const record = await enrollKey(args({ onPhase: (p: string) => phases.push(p) }))

    // Persistent reader: no 'connecting' — there is no tap to wait for.
    expect(phases).toEqual(['pin-check', 'generating', 'done'])
    expect(record.serial).toBe('MOCK-1')
    expect(record.slot).toBe(0x82)
    expect(record.nickname).toBe('Key 1')
    expect(record.enrolledAt).toBeGreaterThanOrEqual(before)
    expect(record.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
    // The compressed form of exactly the key now in the card's slot.
    const onCard = (await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey
    expect(record.pubkey).toBe(compressPubkey(onCard))

    // Nothing on disk yet — a user who backs out is simply not enrolled.
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('a caller-supplied nickname is kept (trimmed); the default counts from the pending list', async () => {
    expect((await enrollKey(args({ nickname: '  Desk ' }))).nickname).toBe('Desk')
    expect((await enrollKey(args({ pendingSerials: ['A', 'B'] }))).nickname).toBe('Key 3')
    expect((await enrollKey(args({ nickname: '   ' }))).nickname).toBe('Key 1')
  })

  test('two keys with different serials enrol through the same mock, each with its own pubkey', async () => {
    const a = await enrollKey(args())
    mock.insertKey('MOCK-2')
    const b = await enrollKey(args({ pendingSerials: [a.serial] }))
    expect(a.serial).toBe('MOCK-1')
    expect(b.serial).toBe('MOCK-2')
    expect(b.nickname).toBe('Key 2')
    expect(a.pubkey).not.toBe(b.pubkey)
    // A's slot key survived B's enrollment: records are per serial.
    mock.insertKey('MOCK-1')
    expect(compressPubkey((await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey)).toBe(a.pubkey)
  })

  test('a serial already enrolled or pending → key-already-enrolled, BEFORE the PIN is spent or the slot is touched', async () => {
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const verifySpy = jest.spyOn(mock, 'verifyPin')
    const err = await enrollKey(args({ pendingSerials: ['MOCK-9', 'MOCK-1'] })).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.message).toBe('MOCK-1') // the wizard names the key from this
    expect(err.details).toEqual({ serial: 'MOCK-1' })
    expect(genSpy).not.toHaveBeenCalled()
    expect(verifySpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey(VAULT_SLOT)).toBeNull() // slot untouched
  })

  test('pin-locked propagates, and the slot is untouched', async () => {
    await mock.verifyPin('000000')
    await mock.verifyPin('000000')
    await mock.verifyPin('000000') // retries now 0
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'pin-locked' })
    expect(genSpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey(VAULT_SLOT)).toBeNull()
  })

  test('a wrong PIN → pin-invalid with retriesLeft; the slot is untouched', async () => {
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    await expect(enrollKey(args({ getPin: async () => '000000' }))).rejects.toMatchObject({
      code: 'pin-invalid',
      retriesLeft: 2
    })
    expect(genSpy).not.toHaveBeenCalled()
    expect(await mock.readVaultPublicKey(VAULT_SLOT)).toBeNull()
  })

  test('a factory-PIN key (user enters 123456) forces a PIN change that reaches the card', async () => {
    let changeArgs: { oldPin: string; newPin: string } | null = null
    await enrollKey(
      args({
        getPin: async () => '123456', // factory
        requestPinChange: async () => {
          changeArgs = { oldPin: '123456', newPin: '654321' }
          return changeArgs
        }
      })
    )
    expect(changeArgs).toEqual({ oldPin: '123456', newPin: '654321' })
    expect((await mock.verifyPin('654321')).ok).toBe(true)
  })

  test('a non-factory PIN never triggers a change and never burns a retry', async () => {
    mock.setPin('999999') // key already has a custom PIN
    let changeCalled = false
    await enrollKey(
      args({
        getPin: async () => '999999',
        requestPinChange: async () => {
          changeCalled = true
          return { oldPin: '123456', newPin: 'x' }
        }
      })
    )
    expect(changeCalled).toBe(false)
    expect((await mock.getKeyInfo()).pinRetries).toBe(3)
  })

  test('always generates a fresh key, replacing whatever the slot held (spec D6) — no adoption', async () => {
    mock.occupySlot() // e.g. an age-plugin-yubikey identity in slot 82
    const existing = (await mock.readVaultPublicKey(VAULT_SLOT))!.publicKey
    const genSpy = jest.spyOn(mock, 'generateVaultKey')
    const phases: string[] = []
    const record = await enrollKey(args({ onPhase: (p: string) => phases.push(p) }))
    expect(genSpy).toHaveBeenCalledTimes(1)
    expect(genSpy).toHaveBeenCalledWith(VAULT_SLOT)
    expect(record.pubkey).not.toBe(compressPubkey(existing))
    expect(phases).not.toContain('adopting')
  })

  test('malformed card key material → template-invalid, without echoing the bytes', async () => {
    jest.spyOn(mock, 'generateVaultKey').mockResolvedValueOnce({ publicKey: '04aabb' })
    const err = await enrollKey(args()).catch(e => e)
    expect(err).toMatchObject({ code: 'template-invalid' })
    expect(err.message).not.toContain('aabb')
  })

  test('NFC: the PIN is collected BEFORE the tap, every op runs in one session, and the alert text is forwarded', async () => {
    const nfc = nfcMock()
    setMockDriver(nfc)
    const order: string[] = []
    const startSpy = jest.spyOn(nfc, 'start').mockImplementation(() => {
      order.push('session-start')
      // simulate the tap connecting
      ;(nfc as unknown as { emit: (e: unknown) => void }).emit({ type: 'attached', serial: 'MOCK-1', transport: 'mock' })
    })
    const stopSpy = jest.spyOn(nfc, 'stop')
    const phases: string[] = []

    const record = await enrollKey(
      args({
        onPhase: (p: string) => phases.push(p),
        getPin: async () => {
          order.push('pin-entered')
          return PIN
        },
        nfcMessage: 'Hold your YubiKey here to set it up'
      })
    )

    expect(record.serial).toBe('MOCK-1')
    expect(order).toEqual(['pin-entered', 'session-start'])
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledWith('Hold your YubiKey here to set it up')
    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(phases).toEqual(['pin-check', 'connecting', 'generating', 'done'])
  })

  test('NFC: the system sheet being cancelled rejects the step with user-cancelled and closes the session', async () => {
    const nfc = nfcMock()
    setMockDriver(nfc)
    jest.spyOn(nfc, 'start').mockImplementation(() => nfc.failSession('user-cancelled'))
    const stopSpy = jest.spyOn(nfc, 'stop')
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  test('NFC: the card leaving mid-session rejects the step with key-removed-mid-op', async () => {
    const nfc = nfcMock()
    setMockDriver(nfc)
    jest.spyOn(nfc, 'start').mockImplementation(() => {
      ;(nfc as unknown as { emit: (e: unknown) => void }).emit({ type: 'attached', serial: 'MOCK-1', transport: 'mock' })
    })
    // The card is pulled while the PIN verify is in flight; the verify never answers.
    jest.spyOn(nfc, 'verifyPin').mockImplementationOnce(() => {
      nfc.removeKey()
      return new Promise(() => {})
    })
    await expect(enrollKey(args())).rejects.toMatchObject({ code: 'key-removed-mid-op' })
  })
})

describe('finalizeEnrollment', () => {
  test('the bounds are 2 and 5', () => {
    expect(VAULT_MIN_KEYS).toBe(2)
    expect(VAULT_MAX_KEYS).toBe(5)
  })

  test('one record → not-enough-keys, nothing written', async () => {
    await expect(finalizeEnrollment([rec(1)])).rejects.toMatchObject({ code: 'not-enough-keys' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('six records → too-many-keys, nothing written', async () => {
    await expect(finalizeEnrollment([1, 2, 3, 4, 5, 6].map(rec))).rejects.toMatchObject({ code: 'too-many-keys' })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('duplicate serials → key-already-enrolled (defensive: the wizard already refuses them)', async () => {
    const err = await finalizeEnrollment([rec(1), { ...rec(2), serial: rec(1).serial }]).catch(e => e)
    expect(err).toMatchObject({ code: 'key-already-enrolled' })
    expect(err.details).toEqual({ serial: rec(1).serial })
    expect(await vaultStore.getMeta()).toBeNull()
  })

  test('two records → meta v5 persisted verbatim; five is the ceiling', async () => {
    const before = Date.now()
    await finalizeEnrollment([rec(1), rec(2)])
    expect(await vaultStore.isEnrolled()).toBe(true)
    const meta = (await vaultStore.getMeta())!
    expect(meta.v).toBe(5)
    expect(meta.createdAt).toBeGreaterThanOrEqual(before)
    expect(meta.keys).toEqual([rec(1), rec(2)])
    expect(meta.lastUsedSerial).toBeUndefined()

    await finalizeEnrollment([1, 2, 3, 4, 5].map(rec)) // a fresh Finish replaces the list
    expect((await vaultStore.getMeta())!.keys).toHaveLength(5)
  })

  test('two REAL enrollments round-trip with lowercase compressed pubkeys', async () => {
    const a = await enrollKey(args({ nickname: 'Desk' }))
    mock.insertKey('MOCK-2')
    const b = await enrollKey(args({ pendingSerials: [a.serial], nickname: 'Safe' }))
    await finalizeEnrollment([a, b])
    const meta = (await vaultStore.getMeta())!
    expect(meta.keys.map(k => k.serial)).toEqual(['MOCK-1', 'MOCK-2'])
    expect(meta.keys.map(k => k.nickname)).toEqual(['Desk', 'Safe'])
    for (const k of meta.keys) {
      expect(k.pubkey).toMatch(/^0[23][0-9a-f]{64}$/)
      expect(k.pubkey).toBe(k.pubkey.toLowerCase())
      expect(k.slot).toBe(0x82)
    }
  })
})

describe('addVaultKey / disableVault', () => {
  test('addVaultKey appends through vaultStore.addKey and returns the new meta', async () => {
    await finalizeEnrollment([rec(1), rec(2)])
    const meta = await addVaultKey(rec(3))
    expect(meta.keys.map(k => k.serial)).toEqual(['10000001', '10000002', '10000003'])
    expect((await vaultStore.getMeta())!.keys).toHaveLength(3)
  })

  test('addVaultKey refuses a duplicate serial, a sixth key, and an unenrolled vault', async () => {
    await expect(addVaultKey(rec(1))).rejects.toMatchObject({ code: 'not-enrolled' })
    await finalizeEnrollment([1, 2, 3, 4, 5].map(rec))
    await expect(addVaultKey(rec(6))).rejects.toMatchObject({ code: 'too-many-keys' })
    await finalizeEnrollment([rec(1), rec(2)])
    await expect(addVaultKey({ ...rec(1), nickname: 'again' })).rejects.toMatchObject({ code: 'key-already-enrolled' })
  })

  test('disableVault clears the key list', async () => {
    await finalizeEnrollment([rec(1), rec(2)])
    await disableVault()
    expect(await vaultStore.isEnrolled()).toBe(false)
    expect(await vaultStore.getMeta()).toBeNull()
  })
})
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts` → fails at load: the current `VaultKeyService.ts` imports `./vaultDerivation`, `./vaultPassphrase`, `./sealing` (files still present until Task 12, so they load) but then `TypeError: (0 , _VaultKeyService.enrollKey) is not a function` across the `enrollKey` suite and `finalizeEnrollment([rec(1)])` resolving instead of rejecting (the old one wrote whatever it was given).

- [ ] **Step 3: Rewrite `VaultKeyService.ts`**

```ts
/**
 * VaultKeyService — enrolling YubiKeys into the vault's key list, and tearing
 * the list down.
 *
 * Each YubiKey IS a vault key (spec D2/D3): PIV slot 0x82 holds a P-256 key
 * generated ON the card, whose compressed public key is all the phone ever
 * records. There is no seed, no seal, no passphrase and no recovery phrase
 * anywhere in this design — recovery is "any enrolled YubiKey + this wallet's
 * database" (spec §3.5). Nothing here derives, wraps or zeroizes anything.
 *
 * enrollKey runs ONE card session for ONE key and returns a public record
 * without persisting it; the wizard collects 2..5 such records and commits
 * them atomically with finalizeEnrollment (spec §3.3: nothing reaches disk
 * until Finish). addVaultKey appends one record to an enrolled vault (§3.4).
 *
 * The slot key is ALWAYS freshly generated (spec D6). There is no adoption:
 * iOS cannot read retired-slot occupancy, so "reuse the key already there"
 * is not something both platforms could offer — the key step's copy warns
 * that the slot's contents are replaced.
 *
 * SECURITY: never log the PIN. Public keys and serials are public data.
 */
import { getVaultDriver } from './driver'
import { compressPubkey } from './r1comb'
import { withKeySession } from './session'
import { VaultError } from './types'
import { vaultStore, VaultKeyRecord, VaultMeta } from './vaultStore'

export const VAULT_SLOT = 0x82

/** Spec D3: at least two keys, so one lost YubiKey does not lose the money;
 * at most five (R1C_MAX_KEYS — the lock carries one commitment per key). */
export const VAULT_MIN_KEYS = 2
export const VAULT_MAX_KEYS = 5

const DEFAULT_PIV_PIN = '123456'

export type EnrollPhase = 'connecting' | 'pin-check' | 'generating' | 'done'

/**
 * Enrol ONE YubiKey: one card session (one NFC tap), one fresh key, one
 * public record back. Persists nothing.
 *
 * `pendingSerials` are the serials that must be refused — already in
 * meta.keys, or already enrolled earlier in this wizard run. The check runs
 * FIRST inside the session, before the PIN is spent and, above all, before
 * generateVaultKey replaces whatever the slot holds: re-tapping an enrolled
 * card must cost nothing (spec §3.3 step 2).
 *
 * All user input (PIN, replacement PIN) is gathered BEFORE the tap: on NFC the
 * scan sheet is a system modal that covers the app.
 */
export async function enrollKey(args: {
  /** Serials already enrolled OR pending in this wizard run. */
  pendingSerials: string[]
  nickname?: string
  onPhase: (p: EnrollPhase) => void
  getPin: () => Promise<string>
  /** Called when the key still has the factory-default PIV PIN; must return a
   * new PIN the user chose. If omitted, enrollment proceeds on the default PIN
   * (dev/test convenience). */
  requestPinChange?: (retries: number) => Promise<{ oldPin: string; newPin: string }>
  /** Localised iOS NFC alert text for this tap (spec §4.2 step 6, enrollment
   * wording). Additive to the interface contract; Android ignores it and an
   * omitted value selects the native default wording. */
  nfcMessage?: string
}): Promise<VaultKeyRecord> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')

  // ── ALL user input up front, BEFORE any key contact ──
  args.onPhase('pin-check')
  const pin0 = await args.getPin()
  let pin = pin0
  let pinChange: { oldPin: string; newPin: string } | null = null
  if (pin0 === DEFAULT_PIV_PIN && args.requestPinChange) {
    // Factory-default detection is exactly "the PIN the user entered is the
    // default" — no side probe against '123456' that would burn a retry.
    pinChange = await args.requestPinChange(3)
    pin = pinChange.newPin
  }

  // ── Token phase: one session / one NFC tap ──
  const { serial, publicKey } = await withKeySession(
    driver,
    async () => {
      const info = await driver.getKeyInfo()
      if (args.pendingSerials.includes(info.serial)) {
        // The message IS the serial: the wizard resolves it to a nickname.
        throw new VaultError('key-already-enrolled', info.serial, undefined, { serial: info.serial })
      }
      // A blocked PIN can't be enrolled — surface it before burning anything.
      if (info.pinRetries === 0) throw new VaultError('pin-locked', 'PIN is blocked')
      if (pinChange) await driver.changePin(pinChange.oldPin, pinChange.newPin)
      const verified = await driver.verifyPin(pin)
      if (!verified.ok) throw new VaultError('pin-invalid', 'PIN not accepted', verified.retriesLeft)
      args.onPhase('generating')
      // Always fresh (spec D6): the adapter passes 'cached'/'once' (Task 4).
      const { publicKey } = await driver.generateVaultKey(VAULT_SLOT)
      return { serial: info.serial, publicKey }
    },
    () => args.onPhase('connecting'),
    { nfcMessage: args.nfcMessage }
  )

  // Canonical form (33-byte compressed, lowercase) before anything is compared
  // or stored. A point that is not on P-256 is a card bug; recode it without
  // echoing the bytes.
  let pubkey: string
  try {
    pubkey = compressPubkey(publicKey)
  } catch {
    throw new VaultError('template-invalid', 'YubiKey returned invalid key material')
  }

  const k = args.pendingSerials.length + 1
  const record: VaultKeyRecord = {
    serial,
    slot: VAULT_SLOT,
    pubkey,
    nickname: args.nickname?.trim() || `Key ${k}`,
    enrolledAt: Date.now()
  }
  args.onPhase('done')
  return record
}

/** Commit an enrollment: the wizard's 2..5 records become meta v5, atomically
 * (one AsyncStorage write). The bounds are defensive — the wizard cannot
 * reach Finish with fewer than two keys and disables Add at five. */
export async function finalizeEnrollment(records: VaultKeyRecord[]): Promise<void> {
  if (records.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${records.length} given`)
  }
  if (records.length > VAULT_MAX_KEYS) {
    throw new VaultError('too-many-keys', `A vault holds at most ${VAULT_MAX_KEYS} keys; ${records.length} given`)
  }
  const serials = records.map(r => r.serial)
  const dupeSerial = serials.find((s, i) => serials.indexOf(s) !== i)
  if (dupeSerial !== undefined) {
    throw new VaultError('key-already-enrolled', 'Duplicate serial in the enrollment', undefined, { serial: dupeSerial })
  }
  await vaultStore.setMeta({ v: 5, createdAt: Date.now(), keys: records })
}

/** Append one key to an enrolled vault (spec §3.4 "Add key"). vaultStore
 * enforces the duplicate-serial and five-key rules. */
export async function addVaultKey(record: VaultKeyRecord): Promise<VaultMeta> {
  return vaultStore.addKey(record)
}

/** Forget the key list. Only offered when the vault balance is zero (spec
 * §3.4); the keys themselves stay on the YubiKeys. */
export async function disableVault(): Promise<void> {
  await vaultStore.clear()
}
```

- [ ] **Step 4: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts` → all pass: `enrollKey` 13, `finalizeEnrollment` 6, `addVaultKey / disableVault` 3 — **22 tests**.
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'transfers.ts\|ui/components/vault/EnrollWizard.tsx\|ui/screens/VaultRecoverScreen.tsx\|ui/screens/VaultScreen.tsx'` → empty.
`grep -n "seed\|seal\|passphrase\|mnemonic\|HD" packages/expo-wallet-toolbox/core/services/vault/VaultKeyService.ts` → only the header sentences that say there is none.

- [ ] **Step 5: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/VaultKeyService.ts packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts
git commit -m "feat(expo-wallet-toolbox)!: multi-key enrollment — enrollKey, finalizeEnrollment(records), addVaultKey" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: transfers.ts — hardware-free deposit; legacy reclaim kept; K1 spend core removed

**Files:**
- Modify: `T/core/services/vault/transfers.ts` (1,151 lines today → ~560 after this task; Tasks 10–11 append the withdraw / re-lock / coverage sections)
- Rewrite: `T/__tests__/vault/transfers.test.ts` (deposit + legacy reclaim suites; Task 10 inserts the withdraw fixtures and suites, Task 11 appends re-lock / coverage / balance)

**Interfaces:**
- Consumes: `SALT_BYTES`, `buildLock`, `commitment`, `encodeVaultInstructions` from `./r1comb` (Plan 1); `isVaultEnabled` (`../../toolboxConfig`, Task 2); `isBackupPushEnabled` (`../../backup/preference`, existing: `core/backup/preference.ts:22`, `Promise<boolean>`, never throws); `randomBytes` (`./random`); `VAULT_MIN_KEYS` (`./VaultKeyService`, Task 8); `vaultStore`/`VaultKeyRecord` (Task 3).
- Produces (contract): `VAULT_BASKET`, `VAULT_DEPOSIT_MIN = 100_000`, `VAULT_MAX_INPUTS = 32`, `VAULT_HARD_MAX_INPUTS = 48`, `VaultTransferOptions` (+ `vaultEnabled?`, `backupEnabled?`), `VaultSpendResult` (new shape — type only here; Task 10 returns it), `VaultKeyCoverage` (type only here; Task 11 computes it), `VaultWallet` (see below), `depositToVault(w, adminOriginator, satoshis, opts?)`; unchanged legacy API: `reclaimStagingOutputs`, `ReclaimResult`, `VAULT_STAGING_BASKET`, `SpendingReferenceLookup`, `VaultActionRow`. `getVaultBalance` is kept byte-for-byte in this task (Task 11 makes it v4-only). Removed here: `depositToVault`'s `reason` parameter, `sweepVaultWithHD`, `spendVaultOutputs`, `prepareSpends`, `nextDepositTarget`, `VaultKeySource`, `PreparedSpend`, `VaultSpendResult.remainingInputs`, `withdrawFromVault` (re-added by Task 10 with the new signature), the `backup-required` gate, every `./k1` / `./vaultDerivation` / `./ceremony` import.
- **Why the whole K1 spend core goes in THIS task and not Task 12:** Plan 1 Task 7 deletes `k1.ts` (Plan 1 File Structure, "Delete (Task 7 only)"), and this plan's prerequisite is Plan 1 merged first. `transfers.ts` therefore cannot even LOAD under jest until its `./k1` and `./vaultDerivation` imports are gone, and everything that used them (`spendVaultOutputs`, `prepareSpends`, `nextDepositTarget`, `sweepVaultWithHD`) goes with the imports. Task 12's "remove sweepVaultWithHD" item is therefore already done here; Task 12 only greps to prove it.
- **`VaultWallet.getPublicKey` is KEPT** (contract deviation, flagged in the summary): the contract says only `createSignature` survives for the legacy reclaim, but `reclaimStagingOutputs` calls BOTH — `w.getPublicKey({ protocolID: STAGING_PROTOCOL, keyID, counterparty: 'self' })` at today's `transfers.ts:715` to obtain the staging P2PKH pubkey, then `w.createSignature` at `:735`. Both are documented as legacy-reclaim-only and both leave when the reclaim does (spec §5.2). Nothing in the R1C deposit / withdraw / re-lock paths calls either — the deposit tests pin that.
- Allowed tsc residuals after this commit: NONE in `transfers.ts` (this task makes it compile). Remaining: `ui/screens/VaultTransferScreen.tsx` (`depositToVault` 5-arg call, `withdrawFromVault` missing until Task 10, `remainingInputs`), `ui/screens/VaultRecoverScreen.tsx` (`sweepVaultWithHD`, `recoverVaultHD`), `ui/components/vault/EnrollWizard.tsx`, `ui/screens/VaultScreen.tsx` — the four Plan 3 files.

- [ ] **Step 1: Rewrite `transfers.test.ts` (deposit + legacy reclaim)**

Replace `T/__tests__/vault/transfers.test.ts` with:

```ts
/**
 * Vault transfers tests.
 *
 * The cryptographic arbiter for the R1C script itself lives in r1comb.test.ts
 * (goldens, Spend round trips, negatives). This file is orchestration: the
 * deposit's gates and output shape, coin selection, the commitment check
 * against the REAL lock, sequential on-card signing through a fake signer,
 * abort-on-failure, signer release, and double-spend heal — validated against
 * a fake VaultWallet whose signable transactions are real @bsv/sdk
 * Transactions, so every unlocking script the withdraw path produces is
 * checked by the real interpreter under the strict flags.
 *
 * Plan 1's r1comb.ts must exist.
 */
import { Beef, BigNumber, ECDSA, LockingScript, P2PKH, PrivateKey, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  R1C_LOCK_LEN,
  bakedCommitments,
  commitment,
  decodeVaultInstructions
} from '../../core/services/vault/r1comb'

// Own AsyncStorage mock, matching __tests__/backup/erase.test.ts: the vault
// suites install a different one and a global mapper makes the resolver
// recurse between the two.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {}
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store[k] ?? null,
      setItem: async (k: string, v: string) => { store[k] = v },
      removeItem: async (k: string) => { delete store[k] },
      getAllKeys: async () => Object.keys(store),
      multiRemove: async (keys: string[]) => { for (const k of keys) delete store[k] },
      clear: async () => { for (const k of Object.keys(store)) delete store[k] }
    }
  }
})
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afudo',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {})
}))

// The ceremony is a process singleton wired to the native driver; here it is a
// jest.fn the withdraw suites arm with a software P-256 key (see armWith).
jest.mock('../../core/services/vault/ceremonyHost', () => ({
  requestVaultSigner: jest.fn(),
  noteVaultProgress: jest.fn()
}))
// The two default gates. transfers.ts reads them only when opts omit the
// injected ones; both are asserted below, so they are mocked rather than left
// to configureToolbox / AsyncStorage state.
jest.mock('../../core/toolboxConfig', () => ({
  isVaultEnabled: jest.fn(() => true)
}))
jest.mock('../../core/backup/preference', () => ({
  isBackupPushEnabled: jest.fn(async () => true)
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { isBackupPushEnabled } from '../../core/backup/preference'
import { isVaultEnabled } from '../../core/toolboxConfig'
import { noteVaultProgress, requestVaultSigner } from '../../core/services/vault/ceremonyHost'
import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'
import {
  VAULT_BASKET,
  VAULT_DEPOSIT_MIN,
  VAULT_STAGING_BASKET,
  VaultWallet,
  depositToVault,
  reclaimStagingOutputs
} from '../../core/services/vault/transfers'

const ADMIN = 'admin.com'

// Two software P-256 keys standing in for two enrolled YubiKeys, generated
// once for the whole file. Their compressed pubkeys are what meta v5 records;
// the private halves let the withdraw suites' fake signer produce real
// signatures the R1C lock accepts.
const PRIV_A = p256.utils.randomSecretKey()
const PRIV_B = p256.utils.randomSecretKey()
const PUB_A = Utils.toHex(Array.from(p256.getPublicKey(PRIV_A, true)))
const PUB_B = Utils.toHex(Array.from(p256.getPublicKey(PRIV_B, true)))
const KEY_A: VaultKeyRecord = { serial: 'A-1', slot: 0x82, pubkey: PUB_A, nickname: 'Desk', enrolledAt: 1 }
const KEY_B: VaultKeyRecord = { serial: 'B-1', slot: 0x82, pubkey: PUB_B, nickname: 'Safe', enrolledAt: 2 }
/** A third enrolled key nobody signs with here. */
const KEY_C: VaultKeyRecord = {
  serial: 'C-1',
  slot: 0x82,
  pubkey: Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true))),
  nickname: 'Parents',
  enrolledAt: 3
}

async function seedMeta(keys: VaultKeyRecord[] = [KEY_A, KEY_B]): Promise<void> {
  await vaultStore.setMeta({ v: 5, createdAt: 1, keys })
}

/** A BEEF carrying every fixture's raw source transaction, as listOutputs
 * with `include: 'entire transactions'` returns. It is load-bearing twice
 * over: createAction's signer layer (buildSignableTransaction) resolves each
 * input's sourceTransaction ONLY from this BEEF, and the withdraw path reads
 * each vault output's REAL locking script out of it for the commitment check. */
const stitchBeef = (fx: { src: Transaction }[]): number[] => {
  const beef = new Beef()
  for (const { src } of fx) beef.mergeRawTx(src.toBinary())
  return beef.toBinary()
}

// ── fake wallet ───────────────────────────────────────────────────────────

let wallet: VaultWallet & {
  createAction: jest.Mock
  signAction: jest.Mock
  listOutputs: jest.Mock
  getPublicKey: jest.Mock
  createSignature: jest.Mock
  abortAction: jest.Mock
  listActions: jest.Mock
}

/** Staging outputs the fake wallet "holds" — legacy strands from the retired
 * two-transaction deposit, served to reclaimStagingOutputs' listOutputs call.
 * Nothing mints these any more; reclaim tests seed them directly. */
let fakeStagingUtxos: { outpoint: string; satoshis: number; customInstructions?: string }[]

beforeEach(async () => {
  await AsyncStorage.clear()
  fakeStagingUtxos = []
  wallet = {
    // Default: one call builds, signs and broadcasts — the single-transaction
    // deposit shape (no signableTransaction comes back when the caller
    // supplies no inputs of its own).
    createAction: jest.fn(async () => ({ txid: 'deadbeef'.repeat(8) })),
    signAction: jest.fn(async () => ({ txid: 'feedface'.repeat(8) })),
    listOutputs: jest.fn(async (args: any) =>
      args?.basket === VAULT_STAGING_BASKET ? { outputs: [...fakeStagingUtxos] } : { outputs: [] }
    ),
    // Legacy reclaim only. The staging derivation parses this as a curve
    // point, so it needs a real one (compressed secp256k1 G).
    getPublicKey: jest.fn(async () => ({
      publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    })),
    createSignature: jest.fn(async () => ({ signature: new Array(70).fill(1) })),
    abortAction: jest.fn(async () => ({})),
    listActions: jest.fn(async () => ({ actions: [] }))
  }
  ;(isVaultEnabled as jest.Mock).mockReturnValue(true)
  ;(isBackupPushEnabled as jest.Mock).mockResolvedValue(true)
  ;(noteVaultProgress as jest.Mock).mockClear()
  ;(requestVaultSigner as jest.Mock).mockReset()
})

// Spies on r1comb (Task 10 stubs verifyVaultInput / pushTxDerCheck in a few
// tests) must not leak between tests: a stubbed verifyVaultInput would let a
// later "the interpreter accepts it" test pass vacuously. Everything the
// beforeEach above creates or re-arms survives this.
afterEach(() => jest.restoreAllMocks())

// ── deposit ───────────────────────────────────────────────────────────────

describe('depositToVault', () => {
  const depositArgs = () => wallet.createAction.mock.calls[0][0] as any

  it('moves the deposit in ONE ordinary version-1 transaction: no inputs of ours, no signAction, no hardware', async () => {
    await seedMeta()
    const { txid } = await depositToVault(wallet, ADMIN, 250_000)
    expect(txid).toBe('deadbeef'.repeat(8))

    // Exactly one createAction — the two-transaction staging deposit is gone.
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    const args = depositArgs()
    expect(args.version).toBeUndefined() // deposits stay at the default version 1 (spec §2.6)
    expect(args.inputs).toBeUndefined() // funding is the toolbox's own coin selection
    expect(args.inputBEEF).toBeUndefined()
    expect(args.description).toBe('Move to vault')
    // The label is load-bearing: the patched toolbox suppresses UTXO-pool
    // growth for 'vault-deposit', keeping the deposit shape minimal.
    expect(args.labels).toEqual(['vault', 'vault-deposit'])
    expect(args.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false })
    expect(args.outputs).toHaveLength(1)
    expect(args.outputs[0]).toMatchObject({
      satoshis: 250_000,
      basket: VAULT_BASKET,
      outputDescription: 'Vault deposit',
      tags: ['vault']
    })

    // No hardware, no ceremony, no progress sheet, no identity lookup.
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(noteVaultProgress).not.toHaveBeenCalled()
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    expect(wallet.createSignature).not.toHaveBeenCalled()
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('locks to a fresh 32-byte salt committed to EVERY enrolled key, and records salt + keys as v4 customInstructions', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)
    const out = depositArgs().outputs[0]

    // The R1C lock for two keys, byte-exact in length.
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(2))

    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci).not.toBeNull()
    expect(ci.v).toBe(4)
    expect(ci.type).toBe('R1C')
    expect(ci.salt).toMatch(/^[0-9a-f]{64}$/)
    expect(ci.keys).toEqual([PUB_A, PUB_B]) // commitment order = meta order

    // The lock really bakes both commitments, in that order — not just the
    // record claiming so.
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toEqual([
      commitment(PUB_A, ci.salt),
      commitment(PUB_B, ci.salt)
    ])
  })

  it('uses a different salt (and so a different lock) for every deposit', async () => {
    await seedMeta()
    await depositToVault(wallet, ADMIN, 250_000)
    await depositToVault(wallet, ADMIN, 250_000)
    const outs = wallet.createAction.mock.calls.map(([a]: [any]) => a.outputs[0])
    const salts = outs.map((o: any) => decodeVaultInstructions(o.customInstructions)!.salt)
    expect(salts[0]).not.toBe(salts[1])
    expect(outs[0].lockingScript).not.toBe(outs[1].lockingScript)
  })

  it('commits to the CURRENT key list — three keys, three commitments, the three-key lock length', async () => {
    await seedMeta([KEY_A, KEY_B, KEY_C])
    await depositToVault(wallet, ADMIN, 250_000)
    const out = depositArgs().outputs[0]
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(3))
    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.keys).toEqual([PUB_A, PUB_B, KEY_C.pubkey])
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toHaveLength(3)
  })

  it('accepts exactly the floor', async () => {
    await seedMeta()
    expect(VAULT_DEPOSIT_MIN).toBe(100_000)
    await expect(depositToVault(wallet, ADMIN, VAULT_DEPOSIT_MIN)).resolves.toMatchObject({ txid: expect.any(String) })
  })

  describe('gates — every refusal before any money moves', () => {
    it('not-released when the injected flag is off, before anything else is consulted', async () => {
      await seedMeta()
      const isOnline = jest.fn(async () => true)
      const backupEnabled = jest.fn(async () => true)
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { vaultEnabled: () => false, isOnline, backupEnabled })
      ).rejects.toMatchObject({ code: 'not-released' })
      expect(isOnline).not.toHaveBeenCalled()
      expect(backupEnabled).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('reads isVaultEnabled() when opts omit the flag', async () => {
      await seedMeta()
      ;(isVaultEnabled as jest.Mock).mockReturnValueOnce(false)
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-released' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('below-dust under VAULT_DEPOSIT_MIN, and for a non-integer amount', async () => {
      await seedMeta()
      await expect(depositToVault(wallet, ADMIN, VAULT_DEPOSIT_MIN - 1)).rejects.toMatchObject({ code: 'below-dust' })
      await expect(depositToVault(wallet, ADMIN, 250_000.5)).rejects.toMatchObject({ code: 'below-dust' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('requires-online before the backup or key checks', async () => {
      await seedMeta()
      const backupEnabled = jest.fn(async () => true)
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { isOnline: async () => false, backupEnabled })
      ).rejects.toMatchObject({ code: 'requires-online' })
      expect(backupEnabled).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('backup-off when the injected backup gate is off (D13)', async () => {
      await seedMeta()
      await expect(
        depositToVault(wallet, ADMIN, 250_000, { backupEnabled: async () => false })
      ).rejects.toMatchObject({ code: 'backup-off' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('reads isBackupPushEnabled() when opts omit the gate', async () => {
      await seedMeta()
      ;(isBackupPushEnabled as jest.Mock).mockResolvedValueOnce(false)
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'backup-off' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('not-enrolled with no key list', async () => {
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-enrolled' })
    })

    it('not-enough-keys with a single enrolled key (defensive — the wizard cannot persist one)', async () => {
      await seedMeta([KEY_A])
      await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'not-enough-keys' })
      expect(wallet.createAction).not.toHaveBeenCalled()
    })
  })

  it('no-transaction when the wallet returns neither a txid nor a tx', async () => {
    await seedMeta()
    wallet.createAction.mockResolvedValueOnce({})
    await expect(depositToVault(wallet, ADMIN, 250_000)).rejects.toMatchObject({ code: 'no-transaction' })
  })
})

// ── legacy staging reclaim ────────────────────────────────────────────────

describe('reclaimStagingOutputs', () => {
  it('returns zero and touches nothing when the staging basket is empty', async () => {
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r).toEqual({ reclaimed: 0, satoshis: 0 })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
    // No ceremony either — staging keys are ordinary wallet keys.
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('runs the storage heal BEFORE listing, so spendable=0 strands become visible', async () => {
    const stranded = {
      outpoint: `${'cd'.repeat(32)}.0`,
      satoshis: 250_017,
      customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging cafebabe' })
    }
    // The heal makes the stranded output visible again (spendable=1), which
    // the fake models by inserting it into the listable set.
    const releaseStrandedStaging = jest.fn(async () => {
      fakeStagingUtxos.push(stranded)
      return 1
    })
    const r = await reclaimStagingOutputs(wallet, ADMIN, { releaseStrandedStaging })
    expect(releaseStrandedStaging).toHaveBeenCalledTimes(1)
    expect(releaseStrandedStaging.mock.invocationCallOrder[0]).toBeLessThan(
      wallet.listOutputs.mock.invocationCallOrder[0]
    )
    expect(r.reclaimed).toBe(1)
    expect(r.satoshis).toBe(250_017)
    // Direct-txid branch (no signableTransaction came back): the txid is
    // plumbed through and nothing needed our signature.
    expect(r.txid).toBe('deadbeef'.repeat(8))
    expect(wallet.signAction).not.toHaveBeenCalled()
    const [args] = wallet.createAction.mock.calls[0]
    expect(args.inputs).toHaveLength(1)
    expect(args.inputs[0].outpoint).toBe(stranded.outpoint)
  })

  it('sweeps every decodable staging output regardless of amount, skipping undecodable ones', async () => {
    fakeStagingUtxos.push(
      { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 250_017, customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging aaaa' }) },
      { outpoint: `${'cd'.repeat(32)}.1`, satoshis: 99_999, customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: 'staging bbbb' }) },
      { outpoint: `${'ef'.repeat(32)}.0`, satoshis: 12_345, customInstructions: 'not json at all' }
    )
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(2)
    expect(r.satoshis).toBe(250_017 + 99_999)
    const [args] = wallet.createAction.mock.calls[0]
    expect(args.inputs.map((i: any) => i.outpoint)).toEqual([`${'ab'.repeat(32)}.0`, `${'cd'.repeat(32)}.1`])
    // The reclaim keeps nothing: no outputs of its own, so the whole value
    // (minus fee) returns as toolbox change to the default basket.
    expect(args.outputs).toEqual([])
    // 'vault-deposit' is load-bearing: RELEASE_STRANDED_VAULT_STAGING_SQL's
    // predicate matches it, so a reclaim that itself fails at broadcast is
    // healed by the same release next time.
    expect(args.labels).toEqual(expect.arrayContaining(['vault', 'vault-deposit', 'vault-reclaim']))
  })

  /**
   * The production 2026-08-21 failure, migrated from the retired two-tx
   * deposit: generateChange's UTXO-pool growth added a funding input and
   * change outputs, and a staging signature built with `otherInputs: []`
   * committed to a one-input transaction. Every broadcaster rejected the
   * result with "false stack entry at end of script execution". Each staging
   * unlock must verify against the REAL interpreter for whatever transaction
   * shape the toolbox hands back.
   */
  const realReclaimWallet = (opts: { stagingFirst: boolean; coins?: number }) => {
    const coins = Array.from({ length: opts.coins ?? 1 }, (_, k) => {
      const priv = PrivateKey.fromRandom()
      const sats = 250_017 + k * 12_345
      const lock = new P2PKH().lock(priv.toPublicKey().toAddress())
      const src = new Transaction()
      src.addOutput({ satoshis: sats, lockingScript: lock })
      return {
        priv,
        pub: priv.toPublicKey().toString(),
        sats,
        lock,
        src,
        keyID: `staging c0ffee0${k}`,
        out: {
          outpoint: `${src.id('hex')}.0`,
          satoshis: sats,
          customInstructions: JSON.stringify({ v: 1, type: 'staging', keyID: `staging c0ffee0${k}` })
        }
      }
    })
    const fundPriv = PrivateKey.fromRandom()
    const fundSrc = new Transaction()
    fundSrc.addOutput({ satoshis: 12_730, lockingScript: new P2PKH().lock(fundPriv.toPublicKey().toAddress()) })

    wallet.listOutputs.mockImplementation(async (args: any) =>
      args?.basket === VAULT_STAGING_BASKET
        ? { outputs: coins.map(c => c.out), BEEF: stitchBeef(coins) }
        : { outputs: [] }
    )
    wallet.getPublicKey.mockImplementation(async (args: any) => ({
      publicKey: coins.find(c => c.keyID === args.keyID)!.pub
    }))
    // Sign the digest for real: the wallet signs hashToDirectlySign raw, and
    // the interpreter's OP_CHECKSIG later re-derives that digest itself.
    wallet.createSignature.mockImplementation(async (args: any) => {
      const c = coins.find(cc => cc.keyID === args.keyID)!
      const sig = ECDSA.sign(new BigNumber(args.hashToDirectlySign), c.priv, true)
      return { signature: sig.toDER() as number[] }
    })

    let signable: Transaction | undefined
    wallet.createAction.mockImplementation(async () => {
      const tx = new Transaction()
      // Non-default sequence and lockTime, deliberately: the preimage must
      // read BOTH from the transaction (transfers.ts formats with
      // input.sequence ?? 0xffffffff and tx.lockTime). A regression that
      // hardcodes the defaults would sign the wrong digest — the exact
      // "false stack entry" production failure class — and all-default
      // fixtures would never catch it.
      const addStaging = () => {
        for (const c of coins) {
          tx.addInput({ sourceTransaction: c.src, sourceOutputIndex: 0, sequence: 0xfffffffe, unlockingScript: new UnlockingScript([]) })
        }
      }
      const addFunding = () =>
        tx.addInput({ sourceTransaction: fundSrc, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
      if (opts.stagingFirst) {
        addStaging()
        addFunding()
      } else {
        addFunding()
        addStaging()
      }
      // The change outputs the toolbox generates (a reclaim has none of its own).
      tx.addOutput({ satoshis: 5000, lockingScript: new P2PKH().lock(Utils.toArray('22'.repeat(20), 'hex')) })
      tx.addOutput({ satoshis: 7000, lockingScript: new P2PKH().lock(Utils.toArray('33'.repeat(20), 'hex')) })
      tx.lockTime = 700_000
      signable = tx
      return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-rec' } }
    })
    return { coins, tx: () => signable! }
  }

  const validateReclaimSpends = (f: ReturnType<typeof realReclaimWallet>) => {
    const [signArgs] = wallet.signAction.mock.calls[0]
    expect(signArgs.reference).toBe('ref-rec')
    // Undelayed, pinned: a reclaim must not report success while its
    // transaction sits in the monitor queue with the broadcast still pending.
    expect(signArgs.options).toMatchObject({ acceptDelayedBroadcast: false })
    const tx = f.tx()
    for (const c of f.coins) {
      const idx = tx.inputs.findIndex(i => i.sourceTransaction?.id('hex') === c.src.id('hex'))
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(signArgs.spends[idx]).toBeDefined()
      const ok = new Spend({
        sourceTXID: c.src.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: c.sats,
        lockingScript: c.lock,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, i) => i !== idx),
        inputIndex: idx,
        unlockingScript: UnlockingScript.fromHex(signArgs.spends[idx].unlockingScript),
        outputs: tx.outputs,
        inputSequence: tx.inputs[idx].sequence ?? 0xffffffff,
        lockTime: tx.lockTime
      }).validate()
      expect(ok).toBe(true)
    }
    expect(Object.keys(signArgs.spends)).toHaveLength(f.coins.length)
  }

  it('signs a VALID reclaim when the toolbox adds a funding input and change outputs', async () => {
    const f = realReclaimWallet({ stagingFirst: true })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.txid).toBe('feedface'.repeat(8))
    expect(r.reclaimed).toBe(1)
    validateReclaimSpends(f)
  })

  it('finds each staging input by outpoint even when none of them is input 0', async () => {
    const f = realReclaimWallet({ stagingFirst: false, coins: 2 })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(2)
    validateReclaimSpends(f)
  })

  it('signs every staging coin with its OWN key, all valid under the real interpreter', async () => {
    const f = realReclaimWallet({ stagingFirst: true, coins: 3 })
    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(3)
    expect(r.satoshis).toBe(f.coins.reduce((s, c) => s + c.sats, 0))
    validateReclaimSpends(f)
  })

  it('aborts the reservation when signing fails, so the coins stay reclaimable', async () => {
    realReclaimWallet({ stagingFirst: true })
    wallet.createSignature.mockRejectedValueOnce(new Error('deriver down'))
    await expect(reclaimStagingOutputs(wallet, ADMIN)).rejects.toThrow('deriver down')
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-rec' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('forwards the listed BEEF as inputBEEF — the signer resolves sources only from it', async () => {
    realReclaimWallet({ stagingFirst: true })
    await reclaimStagingOutputs(wallet, ADMIN)
    // The listOutputs args are load-bearing: without includeCustomInstructions
    // every coin decodes as null and the reclaim silently recovers NOTHING;
    // without 'entire transactions' there is no BEEF and the signer throws.
    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs.basket).toBe(VAULT_STAGING_BASKET)
    expect(listArgs.include).toBe('entire transactions')
    expect(listArgs.includeCustomInstructions).toBe(true)
    const [args] = wallet.createAction.mock.calls[0]
    expect(Array.isArray(args.inputBEEF)).toBe(true)
    expect(args.inputBEEF.length).toBeGreaterThan(0)
    expect(args.options).toMatchObject({ acceptDelayedBroadcast: false, trustSelf: 'known' })
  })

  it('heals a stuck reservation (review-actions refusal) by aborting the orphan and retrying once', async () => {
    // A prior crashed reclaim/deposit left the coin's spentBy pointing at an
    // orphaned transaction; createAction refuses with WERR_REVIEW_ACTIONS.
    // The reclaim must free the orphan (same machinery as the withdraw path)
    // and retry once, not surface the refusal to a fire-and-forget caller.
    const f = realReclaimWallet({ stagingFirst: true })
    const orphanTxid = '9a'.repeat(32)
    const reviewErr = Object.assign(new Error('actions require review'), {
      reviewActionResults: [{ competingTxs: [orphanTxid] }]
    })
    const inner = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementationOnce(async () => {
      throw reviewErr
    })
    wallet.createAction.mockImplementation(inner)
    wallet.listActions.mockResolvedValue({
      actions: [{ txid: orphanTxid, status: 'unsigned', reference: 'ref-orphan' }]
    })

    const r = await reclaimStagingOutputs(wallet, ADMIN)
    expect(r.reclaimed).toBe(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    validateReclaimSpends(f)
  })
})
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts` → fails at load with `Cannot find module './k1' from 'core/services/vault/transfers.ts'` (Plan 1 Task 7 deleted it). If Plan 1 has for some reason NOT run yet, the failures are instead `depositToVault(...)` rejecting with `not-enrolled`-shaped surprises from the old 5-argument signature and `expect(requestVaultSigner).not.toHaveBeenCalled()` — either way red.

- [ ] **Step 3: Restructure `transfers.ts`**

Line numbers refer to the CURRENT 1,151-line file. The result is, in order: **[A]** below (replaces lines 1–220) · lines **222–223** verbatim (`// ── helpers ─…` + blank) · lines **247–445** verbatim (`isReviewActionsError` … `requireOnline`; lines 224–246, `nextDepositTarget`, are DELETED) · lines **447–452** verbatim (`// ── balance` + `getVaultBalance`, replaced in Task 11) · **[B]** below (replaces lines 454–571) · lines **573–765** verbatim (`ReclaimResult` … end of `reclaimStagingOutputs`) · end of file (lines 767–1151 — `VaultKeySource`, `PreparedSpend`, `prepareSpends`, `spendVaultOutputs`, `withdrawFromVault`, `sweepVaultWithHD` — are DELETED).

**[A] — header, imports, constants, types (replaces lines 1–220):**

```ts
/**
 * Vault transfers — internal movements between the `default` change basket
 * and the `admin vault` basket, over 1-of-N P-256 comb-verifier outputs
 * (r1comb.ts, spec §2).
 *
 * Deposit: NO hardware. A vault output is a fresh 32-byte salt committed to
 * every enrolled key's comb table (`commitment(pubkey, salt)` per meta.keys
 * entry), baked into one ~28 KB lock; the salt and the key list travel in
 * the output's customInstructions (v4). Funding and change stay with the
 * toolbox, out of the default basket. Because the salt lives only in the
 * wallet database, a deposit is refused while encrypted backup push is off
 * (D13) — and while the release flag is off (D15).
 *
 * Withdraw (Task 10): the user names a key BEFORE the tap. Only outputs
 * committed to that key are selected (filter → sort → cap), each one's REAL
 * lock out of the listed BEEF is checked for the key's commitment, and the
 * card then signs one 32-byte digest per input in batches of
 * VAULT_INPUTS_PER_TAP (ceremonyHost). Every unlock is validated locally with
 * strict Spend flags before signAction. The toolbox returns the withdrawn
 * value (minus fee, minus any re-vaulted remainder) as change into the default
 * basket — that change IS the internal transfer.
 *
 * Re-lock (Task 11): the same selection with amount 'all', but the ONLY
 * output is a new vault output committed to the CURRENT key set — how a key
 * added later gains access to old deposits, and how a removed key loses it
 * (spec §4.3).
 *
 * The deferred-broadcast finish on withdrawal (see the PAST THE POINT OF NO
 * ABORT comment) survives from the earlier designs on its own merits. What
 * remains of the two-transaction staging machinery exists only to recover
 * money the old flow stranded on real wallets (see reclaimStagingOutputs).
 *
 * The `admin vault` basket name is admin-reserved: WalletPermissionsManager
 * blocks any non-admin originator (web pages) from listing, inserting into, or
 * relinquishing it. All calls here use the admin originator.
 *
 * SECURITY: no key material passes through this module — ever. A VaultSigner
 * (serial, public key, sign()) arrives from ceremonyHost for the length of ONE
 * withdrawal or re-lock and is released in a finally. Salts are public once
 * spent and are never logged before that.
 */
import { Hash, P2PKH, PublicKey, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'
import { isBackupPushEnabled } from '../../backup/preference'
import { isVaultEnabled } from '../../toolboxConfig'
import { SALT_BYTES, buildLock, commitment, encodeVaultInstructions } from './r1comb'
import { randomBytes } from './random'
import { VaultError } from './types'
import { VAULT_MIN_KEYS } from './VaultKeyService'
import { vaultStore, VaultKeyRecord } from './vaultStore'

export const VAULT_BASKET = 'admin vault'

/**
 * LEGACY — the intermediate basket the retired two-transaction deposit split
 * its funding into (tx1 carved out deposit + tx2 fee here; tx2 spent it into
 * the vault). No new outputs are ever created in it. It survives only so that
 * reclaimStagingOutputs can find and recover coins the old flow stranded on
 * real wallets (tx1 landed, tx2 failed). Spec §5.2: kept until the user
 * confirms nothing is stranded; a follow-up then removes it.
 */
export const VAULT_STAGING_BASKET = 'vault staging'

/** LEGACY — BRC-42 protocol the staging output's P2PKH key was derived under.
 * Reclaim-only: the key lives in the ordinary wallet key deriver (counterparty
 * 'self'), so spending a staging coin needs no ceremony and no YubiKey. */
const STAGING_PROTOCOL: [number, string] = [2, 'vault deposit staging']

/** P2PKH unlock, worst case: push(73-byte DER+hashtype sig) + push(33-byte key). */
const STAGING_UNLOCK_LEN = 108

interface StagingInstructions {
  v: 1
  type: 'staging'
  keyID: string
}

function decodeStagingInstructions(s: string | undefined): StagingInstructions | null {
  if (!s) return null
  try {
    const o = JSON.parse(s)
    return o && o.v === 1 && o.type === 'staging' && typeof o.keyID === 'string' ? o : null
  } catch {
    return null
  }
}

/**
 * Storage-backed lookup of the transactions reserving a set of outpoints.
 *
 * Injected rather than imported so this module stays testable without a database
 * — and optional, so a caller that has no storage handle keeps the original
 * paged-scan heal. See findSpendingReferences in StorageExpoSQLite.
 */
export type SpendingReferenceLookup = (
  outpoints: string[]
) => Promise<{ reference: string; status: string }[]>

/**
 * Injected dependencies for a vault transfer.
 *
 * Injected rather than imported so the module stays testable without native
 * modules, a database or a configured host, and optional so a caller that has
 * none of them still works.
 */
export interface VaultTransferOptions {
  /** Storage-backed reservation heal. See SpendingReferenceLookup. */
  findSpendingReferences?: SpendingReferenceLookup
  /**
   * The app's single online signal.
   *
   * Vault transfers are refused while offline. The offline queue exists for
   * small casual default-basket payments: processOfflineActions holds every held
   * request's full rawTx and inputBEEF in one in-memory Beef, and a held row has
   * no attempt cap, no expiry and no local terminal state that releases its
   * reservation — so a vault transaction landing there would freeze real money
   * with no way out. Refusing up front is also what makes "no vault row ever
   * reaches the offline drain" a testable invariant.
   */
  isOnline?: () => Promise<boolean>
  /** Injected gates so the module stays config-free in tests. Defaults:
   * isVaultEnabled() (toolboxConfig) and isBackupPushEnabled() (backup/preference). */
  vaultEnabled?: () => boolean
  backupEnabled?: () => Promise<boolean>
}

export interface VaultSpendResult {
  txid: string
  /**
   * Vault outputs the chosen key COULD open but which were left untouched by
   * the input cap (VAULT_MAX_INPUTS). Non-zero means the withdrawal was
   * partial: repeating it with the same key moves them (each pass also
   * consolidates, so the next one needs fewer inputs).
   */
  cappedInputs: number
  /**
   * Outputs the chosen key is NOT committed to (spec §4.2 step 8): they need
   * one of `keys`. `serial` is present when the pubkey is still in meta —
   * absent for a key that has since been removed.
   */
  unreachable: { count: number; satoshis: number; keys: { serial?: string; pubkey: string }[] }
}

/** How the vault's outputs relate to the CURRENT key list (spec §3.4 badges). */
export interface VaultKeyCoverage {
  /** Decodable v4 outputs in the basket. */
  outputs: number
  /** Outputs whose key set differs from the current one, in either direction. */
  stale: number
  /** Current pubkeys absent from at least one output — "not yet open to X". */
  missingKeys: string[]
  /** Outputs committed to a pubkey no longer in meta — "still open to a removed key". */
  removedKeyOutputs: number
}

/**
 * Deposit floor AND withdrawal-remainder fold threshold (spec §4.1 step 1,
 * §4.2 step 4).
 *
 * An R1C output costs ~28 KB to create and ~2.5 KB of unlock plus its 28 KB
 * source transaction in the BEEF to spend, so at the wallet's fee rate one
 * output is a few thousand satoshis of fees over its life. 100,000 keeps that
 * under a few percent of the smallest deposit, and gives the re-lock (whose
 * fee comes out of the vault) room to run. The screen renders the floor
 * inline; `below-dust` is the defensive service-side refusal.
 */
export const VAULT_DEPOSIT_MIN = 100_000

/**
 * Vault inputs per withdrawal.
 *
 * What bounds this is size and createAction ergonomics. Each vault input
 * contributes its ~28 KB source transaction to the inputBEEF (32 inputs ≈
 * 900 KB — spec §6 residual 4, with listOutputs' missing response cap) plus a
 * 2.5 KB unlocking script; every input is one more coin to reserve atomically
 * and release if anything fails, one more sighash preimage over a transaction
 * that grows with each input, one more on-card signature inside the tap
 * batches, and one more chance for a stuck reservation to wedge the whole
 * withdrawal. 32 drains any realistic vault in one pass while staying well
 * inside all of that; the hard ceiling is the value no future tuning may
 * exceed without redoing that reasoning. (It is also the vault-side control
 * services/walletArgLimits.ts refers to — the vault bypasses the
 * wallet-argument caps structurally, so this IS its bound.)
 *
 * Consolidation is automatic: a capped withdrawal re-vaults its remainder as one
 * output, so repeated withdrawals converge on a single vault UTXO.
 */
export const VAULT_MAX_INPUTS = 32
export const VAULT_HARD_MAX_INPUTS = 48

/** The subset of the wallet interface transfers depends on (injected so the
 * whole module is testable without the toolbox). */
export interface VaultWallet {
  createAction(args: unknown, originator: string): Promise<CreateActionResult>
  signAction(args: unknown, originator: string): Promise<{ txid?: string; tx?: number[] }>
  listOutputs(args: unknown, originator: string): Promise<ListOutputsResult>
  abortAction(args: unknown, originator: string): Promise<unknown>
  listActions?(args: unknown, originator: string): Promise<{ actions: VaultActionRow[] }>
  /**
   * LEGACY — both used ONLY by reclaimStagingOutputs (spec §5.2): the staging
   * output's BRC-42 public key (to rebuild the P2PKH subscript it signs) and
   * its signature come from the wallet's own key deriver. Nothing in the R1C
   * deposit / withdraw / re-lock paths calls either — the deposit tests pin
   * that — and both leave when the staging reclaim does.
   */
  getPublicKey(args: unknown, originator: string): Promise<{ publicKey: string }>
  createSignature(args: unknown, originator: string): Promise<{ signature: number[] }>
}

/** The fields of a listActions row the reservation heal needs. `inputs` arrives
 * only when the call asked for `includeInputs`, and a transaction that never
 * reached signing has no `txid` — which is exactly the case the outpoint match
 * exists to cover. */
export interface VaultActionRow {
  txid?: string
  status: string
  reference?: string
  inputs?: { sourceOutpoint?: string }[]
}

interface CreateActionResult {
  txid?: string
  tx?: number[]
  signableTransaction?: { tx: number[]; reference: string }
}
interface ListOutputsResult {
  outputs: {
    outpoint: string
    satoshis: number
    customInstructions?: string
  }[]
  /** Present when `include: 'entire transactions'` was requested — the
   * multi-tx BEEF covering every listed output's source transaction. Forwarded
   * verbatim as createAction's inputBEEF and read for each output's REAL lock. */
  BEEF?: number[]
}
```

**[B] — vault outputs and the deposit (replaces lines 454–571):**

```ts
// ── vault outputs ────────────────────────────────────────────────────────

/**
 * One new vault output committed to `keys` (spec §4.1 step 3, §2.7).
 *
 * Fresh 32-byte salt per output, so outputs are unlinkable until spent and a
 * spend reveals only its own. The key list is written into the output's
 * customInstructions in commitment order — informational (the lock is the
 * truth; the withdraw path re-checks it), but it is what lets balance,
 * selection and coverage work without parsing a 28 KB script. Used by the
 * deposit, the withdraw path's re-vaulted remainder, and the re-lock.
 */
function newVaultOutput(
  keys: readonly Pick<VaultKeyRecord, 'pubkey'>[],
  satoshis: number,
  outputDescription: string
): {
  satoshis: number
  lockingScript: string
  outputDescription: string
  basket: string
  customInstructions: string
  tags: string[]
} {
  const salt = Utils.toHex(randomBytes(SALT_BYTES))
  const pubkeys = keys.map(k => k.pubkey)
  const lockingScript = buildLock({ commitments: pubkeys.map(pk => commitment(pk, salt)) })
  return {
    satoshis,
    lockingScript: lockingScript.toHex(),
    outputDescription,
    basket: VAULT_BASKET,
    customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt, keys: pubkeys }),
    tags: ['vault']
  }
}

/** The release gate (spec D15 / §5.5), injectable so tests stay config-free.
 * Gates every path that CREATES a vault output; never a withdrawal of
 * pre-existing outputs. */
function requireReleased(opts: VaultTransferOptions | undefined, what: string): void {
  const enabled = opts?.vaultEnabled ?? isVaultEnabled
  if (!enabled()) throw new VaultError('not-released', `${what} is switched off in this build`)
}

/** The enrolled key list, or the refusal an output-creating operation owes. */
async function requireKeys(): Promise<VaultKeyRecord[]> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  if (meta.keys.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${meta.keys.length} enrolled`)
  }
  return meta.keys
}

// ── deposit ─────────────────────────────────────────────────────────────

/**
 * Move `satoshis` from the default basket into the vault (spec §4.1).
 *
 * No hardware: a deposit needs the key LIST, not a key. Every refusal is
 * checked BEFORE the one createAction below, cheapest first, and nothing is
 * spent until it runs — so a refusal costs nothing, and there is no deposit
 * index to burn any more (each output is self-describing via its salt).
 *
 * D13, the one gate that is not about the request itself: the salt that opens
 * this output will live ONLY in the wallet database. With backup push off, a
 * lost phone loses the vault however many YubiKeys survive.
 */
export async function depositToVault(
  w: VaultWallet,
  adminOriginator: string,
  satoshis: number,
  opts?: VaultTransferOptions
): Promise<{ txid: string }> {
  requireReleased(opts, 'Vault deposit')
  if (!Number.isInteger(satoshis) || satoshis < VAULT_DEPOSIT_MIN) {
    throw new VaultError('below-dust', `Vault deposits must be at least ${VAULT_DEPOSIT_MIN} satoshis`)
  }
  await requireOnline(opts)
  const backupEnabled = opts?.backupEnabled ?? isBackupPushEnabled
  if (!(await backupEnabled())) {
    throw new VaultError('backup-off', 'Turn wallet backup on before depositing')
  }
  const keys = await requireKeys()

  // One call builds, signs AND broadcasts: with no caller-supplied inputs
  // there is no signableTransaction step — every funding input is toolbox
  // change the toolbox signs itself. Undelayed, so a failed broadcast surfaces
  // here rather than leaving the deposit looking sent while it sits in the
  // monitor's queue. Default version (1): only spends of vault outputs need
  // version 2 (spec §2.6). The 'vault-deposit' label is load-bearing: the
  // patched toolbox (see patches/) suppresses UTXO-pool growth for it, so the
  // deposit stays minimal — at most one change output — instead of splitting
  // change toward numberOfDesiredUTXOs.
  const created = await w.createAction(
    {
      description: 'Move to vault',
      outputs: [newVaultOutput(keys, satoshis, 'Vault deposit')],
      labels: ['vault', 'vault-deposit'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    },
    adminOriginator
  )
  const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Deposit produced no transaction')
  return { txid }
}
```

- [ ] **Step 4: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts` → all pass: `depositToVault` 14 (5 + 8 gates + 1), `reclaimStagingOutputs` 9 — **23 tests**.
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'ui/screens/VaultTransferScreen.tsx\|ui/screens/VaultRecoverScreen.tsx\|ui/components/vault/EnrollWizard.tsx\|ui/screens/VaultScreen.tsx'` → empty — `transfers.ts` is clean from here on.
`grep -n "k1'\|vaultDerivation'\|HD\b\|takeNextIndex\|backupAttestation\|requestVaultKey\|VaultKeyHandle\|sweepVaultWithHD" packages/expo-wallet-toolbox/core/services/vault/transfers.ts` → nothing.

- [ ] **Step 5: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/transfers.ts packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts
git commit -m "feat(expo-wallet-toolbox)!: hardware-free R1C vault deposit; K1 spend core and sweep removed" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: transfers.ts — `withdrawFromVault(w, adminOriginator, amount, reason, chosenSerial, opts)`

**Files:**
- Modify: `T/core/services/vault/transfers.ts` (extend two import lines; append the selection + spend core + `withdrawFromVault` after `reclaimStagingOutputs`)
- Modify: `T/__tests__/vault/transfers.test.ts` (extend imports; insert the withdraw fixtures after the top-level `beforeEach`; append the withdraw suites at the end)

**Interfaces:**
- Consumes (all from Plan 1's `./r1comb`): `R1C_UNLOCK_LEN`, `VaultInstructionsV4`, `bakedCommitments(lock)`, `buildUnlock({ preimage, derSig, pubkeyHex33, saltHex64 })`, `commitment`, `decodeVaultInstructions`, `pushTxDerCheck(preimage)`, `sighashPreimage(tx, inputIndex, sourceSatoshis)`, `signerDigest(preimage)`, `verifyVaultInput({ tx, inputIndex, sourceSatoshis, lockingScript, unlockingScript })`; `requestVaultSigner`, `noteVaultProgress` (`./ceremonyHost`, Task 7); `Beef`, `LockingScript` from `@bsv/sdk`; `freeReservedInputs`, `requireOnline`, `requireReleased`, `newVaultOutput`, `VAULT_DEPOSIT_MIN`, `VAULT_MAX_INPUTS`, `VAULT_HARD_MAX_INPUTS` (Task 9). SDK fields: `CreateActionArgs.version`, `CreateActionInput.sequenceNumber` (`node_modules/@bsv/sdk/dist/types/src/wallet/Wallet.interfaces.d.ts:212–218, 329–338`), `SignActionArgs { spends, reference, options }` (`:366`).
- Produces (contract): `withdrawFromVault(w, adminOriginator, amount: number | 'all', reason, chosenSerial, opts?): Promise<VaultSpendResult>`. Private helpers `selectVaultInputs`, `createSignableVaultTx`, `spendVaultOutputs` are shared with Task 11's `relockVault`.
- Structure kept from today's `spendVaultOutputs` (`transfers.ts:862–1083` before Task 9): the `setTimeout(0)` yield before listing and before every signature, the `freeReservedInputs` retry-once around `createAction`, SEQUENTIAL signing (never `tx.sign()`), abort-on-any-failure before `signAction`, and the deferred-broadcast finish OUTSIDE the abort try (`:1062–1082`).
- Decisions this task makes (flagged in the summary): (1) inputs are located in the signable transaction BY OUTPOINT (as `reclaimStagingOutputs` does at `:705–711`), never by position — the toolbox may prepend funding inputs; (2) a re-vaulted remainder with `vaultEnabled` off throws `not-released` rather than silently folding the remainder into the hot wallet (spec §5.5: re-vault is an output-creating path; `'all'` is never gated); (3) a "bumped" `sequenceNumber` DEcrements from the toolbox default `0xffffffff` (`0xfffffffe`, `0xfffffffd`, …) — the only direction that exists — and any value works because `lockTime` is 0; (4) a selected output whose real lock is not an R1C lock at all (`bakedCommitments` throws `template-invalid`) is reported as `key-not-committed` naming the outpoint, since customInstructions are never trusted over the lock.
- `key-cannot-cover` populates `VaultError.details = { reachable, total }` (satoshis; Task 1's convention). `too-many-inputs`, thrown right after it in the same guard, carries no `details` — unchanged.
- Allowed tsc residuals after this commit: the four Plan 3 `ui/` files only (`VaultTransferScreen.tsx` now fails on the 5→6-argument `withdrawFromVault` and `remainingInputs`).

- [ ] **Step 1: Extend the test file — imports and fixtures**

(a) Replace the r1comb import at the top of `transfers.test.ts` with:

```ts
import {
  R1C_LOCK_LEN,
  R1C_UNLOCK_LEN,
  bakedCommitments,
  buildLock,
  commitment,
  decodeVaultInstructions,
  encodeVaultInstructions,
  sighashPreimage,
  signerDigest,
  verifyVaultInput
} from '../../core/services/vault/r1comb'
// Namespace import so single functions can be spied (Babel's CJS interop
// reads exports at call time, so a spyOn here is seen by transfers.ts).
import * as r1comb from '../../core/services/vault/r1comb'
```

(b) After `import { vaultStore, VaultKeyRecord } from '../../core/services/vault/vaultStore'` add:

```ts
import type { VaultSigner } from '../../core/services/vault/ceremony'
import { VaultError } from '../../core/services/vault/types'
```

(c) Replace the transfers import with:

```ts
import {
  VAULT_BASKET,
  VAULT_DEPOSIT_MIN,
  VAULT_HARD_MAX_INPUTS,
  VAULT_MAX_INPUTS,
  VAULT_STAGING_BASKET,
  VaultWallet,
  depositToVault,
  reclaimStagingOutputs,
  withdrawFromVault
} from '../../core/services/vault/transfers'
```

(d) At the END of the top-level `beforeEach` callback (after `;(requestVaultSigner as jest.Mock).mockReset()`) add:

```ts
  lastSignable = undefined
  signerRelease = jest.fn()
  signCalls = []
  armWith(PRIV_A, PUB_A, 'A-1')
```

(e) Insert the fixture block after the top-level `afterEach(() => jest.restoreAllMocks())` line and before `// ── deposit ─…`:

```ts
// ── withdraw fixtures ─────────────────────────────────────────────────────

interface VaultFixture {
  outpoint: string
  satoshis: number
  salt: string
  keys: string[]
  lockingScript: LockingScript
  src: Transaction
  customInstructions: string
}

/**
 * A real R1C vault output: fresh salt, lock committed to `lockKeys`, and a v4
 * record claiming `keys`. The two agree unless a test says otherwise (the
 * key-not-committed case bakes a lock the record lies about).
 */
function vaultFixture(satoshis: number, keys: string[], lockKeys: string[] = keys): VaultFixture {
  const salt = Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(32))))
  const lockingScript = buildLock({ commitments: lockKeys.map(pk => commitment(pk, salt)) })
  const src = new Transaction()
  src.addOutput({ satoshis, lockingScript })
  return {
    outpoint: `${src.id('hex')}.0`,
    satoshis,
    salt,
    keys,
    lockingScript,
    src,
    customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt, keys })
  }
}

/** The signable transaction the fake wallet last fabricated — the object the
 * real interpreter checks each unlocking script against. */
let lastSignable: Transaction | undefined

/**
 * Serve `fx` from the fake wallet and fabricate a REAL signable transaction of
 * whatever version the caller asks for, honouring per-input sequenceNumber,
 * with the toolbox's own change output appended. `fundingFirst` prepends a
 * funding input, as the toolbox may — the code under test must locate its
 * inputs by outpoint, never by position.
 */
async function seedVault(
  fx: VaultFixture[],
  keys: VaultKeyRecord[] = [KEY_A, KEY_B],
  opts: { fundingFirst?: boolean } = {}
): Promise<void> {
  await seedMeta(keys)
  wallet.listOutputs.mockImplementation(async (args: any) =>
    args?.basket === VAULT_BASKET
      ? {
          outputs: fx.map(f => ({ outpoint: f.outpoint, satoshis: f.satoshis, customInstructions: f.customInstructions })),
          BEEF: stitchBeef(fx)
        }
      : args?.basket === VAULT_STAGING_BASKET
        ? { outputs: [...fakeStagingUtxos] }
        : { outputs: [] }
  )
  wallet.createAction.mockImplementation(async (args: any) => {
    const tx = new Transaction(args.version ?? 1)
    if (opts.fundingFirst) {
      const fund = new Transaction()
      fund.addOutput({ satoshis: 50_000, lockingScript: new P2PKH().lock(Utils.toArray('44'.repeat(20), 'hex')) })
      tx.addInput({ sourceTransaction: fund, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript([]) })
    }
    for (const inp of args.inputs ?? []) {
      const f = fx.find(x => x.outpoint === inp.outpoint)!
      tx.addInput({
        sourceTransaction: f.src,
        sourceOutputIndex: 0,
        sequence: inp.sequenceNumber ?? 0xffffffff,
        unlockingScript: new UnlockingScript([])
      })
    }
    for (const out of args.outputs ?? []) {
      tx.addOutput({ satoshis: out.satoshis, lockingScript: LockingScript.fromHex(out.lockingScript) })
    }
    // The toolbox's own default-basket change.
    tx.addOutput({ satoshis: 1234, lockingScript: new P2PKH().lock(Utils.toArray('11'.repeat(20), 'hex')) })
    lastSignable = tx
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'ref-1' } }
  })
}

let signerRelease: jest.Mock
let signCalls: { digest: string; progress?: { index: number; total: number } }[]

/**
 * Arm the mocked ceremonyHost with a software key standing in for a YubiKey.
 * Mirrors the real requestVaultSigner contract: refuses a chosenSerial that is
 * not this key (serial-mismatch), signs raw 32-byte digests as DER WITHOUT
 * low-S normalisation (real PIV hardware does not normalise; the lock accepts
 * both), and refuses to sign after release.
 */
const armWith = (priv: Uint8Array, pubkey: string, serial: string): void => {
  ;(requestVaultSigner as jest.Mock).mockImplementation(async (_reason: string, chosenSerial: string) => {
    if (chosenSerial !== serial) {
      throw new VaultError('serial-mismatch', `Tapped key ${serial}, chose key ${chosenSerial}`)
    }
    let released = false
    const signer: VaultSigner = {
      serial,
      pubkey,
      sign: async (digestHex, progress) => {
        if (released) throw new VaultError('key-removed-mid-op', 'Vault signer already released')
        signCalls.push({ digest: digestHex, progress })
        const raw = p256.sign(Uint8Array.from(Utils.toArray(digestHex, 'hex')), priv, { prehash: false, lowS: false })
        return Array.from(p256.Signature.fromBytes(raw).toBytes('der'))
      },
      release: () => {
        if (released) return
        released = true
        signerRelease()
      }
    }
    return signer
  })
}

/** Every produced unlock, checked by the real interpreter under the strict
 * flags against the fake's real v2 transaction. */
const validateSpends = (fx: VaultFixture[]): void => {
  const [caArgs] = wallet.createAction.mock.calls.at(-1)!
  const [saArgs] = wallet.signAction.mock.calls[0]
  const tx = lastSignable!
  expect(Object.keys(saArgs.spends)).toHaveLength(caArgs.inputs.length)
  for (const inp of caArgs.inputs as { outpoint: string }[]) {
    const f = fx.find(x => x.outpoint === inp.outpoint)!
    const idx = tx.inputs.findIndex(i => i.sourceTransaction?.id('hex') === f.src.id('hex'))
    expect(idx).toBeGreaterThanOrEqual(0)
    const unlockingScript = UnlockingScript.fromHex(saArgs.spends[idx].unlockingScript)
    expect(unlockingScript.toBinary().length).toBeLessThanOrEqual(R1C_UNLOCK_LEN)
    expect(
      verifyVaultInput({ tx, inputIndex: idx, sourceSatoshis: f.satoshis, lockingScript: f.lockingScript, unlockingScript })
    ).toBe(true)
  }
}

const withdrawAll = (opts?: Parameters<typeof withdrawFromVault>[5]) =>
  withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw all', 'A-1', opts)
```

- [ ] **Step 2: Append the withdraw suites**

Append at the END of `transfers.test.ts`:

```ts
// ── withdraw ──────────────────────────────────────────────────────────────

describe('withdrawFromVault', () => {
  it('lists with entire transactions + customInstructions, and creates a VERSION-2 action with the R1C unlock length, the BEEF, and undelayed strict options', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    await withdrawAll()

    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs).toEqual({
      basket: VAULT_BASKET,
      include: 'entire transactions',
      includeCustomInstructions: true,
      limit: 1000
    })

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.description).toBe('Withdraw all')
    expect(caArgs.version).toBe(2) // spec §2.6: every vault spend is version 2
    expect(caArgs.inputs).toHaveLength(2)
    for (const i of caArgs.inputs) {
      expect(i).toEqual({ outpoint: i.outpoint, unlockingScriptLength: R1C_UNLOCK_LEN, inputDescription: 'Vault withdrawal' })
      expect(i.unlockingScriptLength).toBe(2560)
    }
    // Largest first.
    expect(caArgs.inputs.map((i: any) => i.outpoint)).toEqual([fx[0].outpoint, fx[1].outpoint])
    expect(caArgs.labels).toEqual(['vault', 'vault-withdraw'])
    expect(caArgs.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' })
    // Sourced from the listOutputs result, not fabricated — and it decodes to
    // a BEEF containing every spent output's source transaction.
    const beef = Beef.fromBinary(caArgs.inputBEEF)
    for (const f of fx) expect(beef.findTxid(f.src.id('hex'))).toBeDefined()
  }, 60_000)

  it('produces unlocking scripts the strict interpreter accepts against the REAL version-2 signable transaction, keyed by input index', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    const r = await withdrawAll()
    expect(r.txid).toBe('feedface'.repeat(8))
    expect(lastSignable!.version).toBe(2)
    validateSpends(fx)
  }, 60_000)

  it('locates its inputs by outpoint when the toolbox prepends a funding input', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B], { fundingFirst: true })
    await withdrawAll()
    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(Object.keys(saArgs.spends).sort()).toEqual(['1', '2']) // input 0 is the toolbox's
    validateSpends(fx)
  }, 60_000)

  it('signs the digest of each input\'s REAL preimage, sequentially, with per-input progress, then reports broadcasting', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B]), vaultFixture(100_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw from vault', 'A-1')

    expect(requestVaultSigner).toHaveBeenCalledTimes(1)
    expect(requestVaultSigner).toHaveBeenCalledWith('Withdraw from vault', 'A-1')
    expect(signCalls).toHaveLength(3)
    signCalls.forEach((c, i) => {
      expect(c.progress).toEqual({ index: i, total: 3 })
      expect(c.digest).toBe(signerDigest(sighashPreimage(lastSignable!, i, fx[i].satoshis)))
    })
    const notes = (noteVaultProgress as jest.Mock).mock.calls.map(([p]) => p)
    expect(notes.slice(0, 3)).toEqual([
      { phase: 'preparing', signed: 0, total: 3 },
      { phase: 'preparing', signed: 1, total: 3 },
      { phase: 'preparing', signed: 2, total: 3 }
    ])
    expect(notes.at(-1)).toEqual({ phase: 'broadcasting' })
    expect(signerRelease).toHaveBeenCalledTimes(1)
  }, 90_000)

  it('hands the signed transaction to the monitor (acceptDelayedBroadcast: true) and stamps lastUsedSerial', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await withdrawAll()
    const [saArgs] = wallet.signAction.mock.calls[0]
    expect(saArgs.reference).toBe('ref-1')
    expect(saArgs.options).toEqual({ acceptDelayedBroadcast: true })
    expect((await vaultStore.getMeta())!.lastUsedSerial).toBe('A-1')
  }, 60_000)

  it('returns cappedInputs 0 and an empty unreachable set when every output is the chosen key\'s and fits', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const r = await withdrawAll()
    expect(r).toEqual({ txid: 'feedface'.repeat(8), cappedInputs: 0, unreachable: { count: 0, satoshis: 0, keys: [] } })
  }, 60_000)

  // ── selection (spec §4.2 steps 2–3) ───────────────────────────────────

  it('filters to the chosen key BEFORE capping: 35 outputs, the 3 largest committed only to B, chosen A → the 32 A outputs, 3 unreachable', async () => {
    // A cap-before-filter bug would pick the three B-only outputs (they are
    // the largest) and either fail on the commitment check or leave A with
    // fewer than 32 inputs.
    const aOutputs = Array.from({ length: 32 }, (_, i) => vaultFixture(300_000 + i, [PUB_A, PUB_B]))
    const bOnly = Array.from({ length: 3 }, (_, i) => vaultFixture(900_000 + i, [PUB_B]))
    await seedVault([...bOnly, ...aOutputs])
    jest.spyOn(r1comb, 'verifyVaultInput').mockReturnValue(true) // 32 real verifications are for the device run

    const r = await withdrawAll()
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs).toHaveLength(VAULT_MAX_INPUTS)
    expect(caArgs.inputs.length).toBeLessThanOrEqual(VAULT_HARD_MAX_INPUTS)
    const aOutpoints = new Set(aOutputs.map(f => f.outpoint))
    for (const i of caArgs.inputs) expect(aOutpoints.has(i.outpoint)).toBe(true)
    expect(r.cappedInputs).toBe(0)
    expect(r.unreachable).toEqual({
      count: 3,
      satoshis: 900_000 + 900_001 + 900_002,
      keys: [{ serial: 'B-1', pubkey: PUB_B }]
    })
    expect(signCalls).toHaveLength(32)
  }, 120_000)

  it('caps at VAULT_MAX_INPUTS and reports the untouched outputs as cappedInputs', async () => {
    const fx = Array.from({ length: VAULT_MAX_INPUTS + 2 }, () => vaultFixture(300_000, [PUB_A, PUB_B]))
    await seedVault(fx)
    jest.spyOn(r1comb, 'verifyVaultInput').mockReturnValue(true)
    const r = await withdrawAll()
    expect(r.cappedInputs).toBe(2)
    expect(r.unreachable.count).toBe(0)
    expect(wallet.createAction.mock.calls[0][0].inputs).toHaveLength(VAULT_MAX_INPUTS)
  }, 120_000)

  it('choosing B selects only B\'s outputs and reports A\'s as unreachable, naming A', async () => {
    armWith(PRIV_B, PUB_B, 'B-1')
    const shared = vaultFixture(300_000, [PUB_A, PUB_B])
    const bOnly = vaultFixture(400_000, [PUB_B])
    const aOnly = vaultFixture(500_000, [PUB_A])
    await seedVault([shared, bOnly, aOnly])
    const r = await withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', 'B-1')
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs.map((i: any) => i.outpoint)).toEqual([bOnly.outpoint, shared.outpoint]) // largest first
    expect(r.unreachable).toEqual({ count: 1, satoshis: 500_000, keys: [{ serial: 'A-1', pubkey: PUB_A }] })
    validateSpends([shared, bOnly])
  }, 60_000)

  it('an unreachable output committed to a key no longer in meta is reported without a serial', async () => {
    const removed = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true)))
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(700_000, [removed])])
    const r = await withdrawAll()
    expect(r.unreachable).toEqual({ count: 1, satoshis: 700_000, keys: [{ serial: undefined, pubkey: removed }] })
  }, 60_000)

  it('key-not-committed when the REAL lock lacks the chosen key\'s commitment although customInstructions claims it — before any reservation or tap', async () => {
    const liar = vaultFixture(300_000, [PUB_A, PUB_B], [PUB_B]) // record says A+B, lock says B
    await seedVault([liar])
    const err = await withdrawAll().catch(e => e)
    expect(err).toMatchObject({ code: 'key-not-committed' })
    expect(err.message).toContain(liar.outpoint)
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('key-not-committed when no output is committed to the chosen key at all', async () => {
    await seedVault([vaultFixture(300_000, [PUB_B]), vaultFixture(200_000, [PUB_B])])
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'key-not-committed' })
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  it('key-cannot-cover when the chosen key can open less than asked while other keys could open more', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_B])])
    const err = await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1').catch(e => e)
    expect(err).toMatchObject({ code: 'key-cannot-cover' })
    expect(err.message).toContain('500000')
    expect(err.message).toContain('1000000')
    expect(err.details).toEqual({ reachable: 500_000, total: 1_000_000 })
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('amount-exceeds-balance when the whole vault is too small', async () => {
    await seedVault([vaultFixture(250_000, [PUB_A, PUB_B])])
    await expect(withdrawFromVault(wallet, ADMIN, 300_000, 'Withdraw', 'A-1')).rejects.toMatchObject({
      code: 'amount-exceeds-balance'
    })
  })

  it('too-many-inputs when the amount cannot be funded within the cap although the key could open it', async () => {
    // 34 × 300,000 is plenty, but 32 inputs only reach 9,600,000 — an
    // input-count problem, not a balance or a key problem, and it must say so.
    await seedVault(Array.from({ length: VAULT_MAX_INPUTS + 2 }, () => vaultFixture(300_000, [PUB_A, PUB_B])))
    await expect(withdrawFromVault(wallet, ADMIN, 10_000_000, 'Withdraw', 'A-1')).rejects.toMatchObject({
      code: 'too-many-inputs'
    })
    expect(wallet.createAction).not.toHaveBeenCalled()
  }, 60_000)

  it('vault-empty when nothing decodes as v4 — a v3 K1 record is skipped, not spent', async () => {
    await seedMeta()
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: `${'aa'.repeat(32)}.0`, satoshis: 250_000, customInstructions: JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/0' }) },
        { outpoint: `${'bb'.repeat(32)}.0`, satoshis: 250_000, customInstructions: 'not json' }
      ]
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'vault-empty' })
  })

  it('not-enrolled for an unknown chosen serial, before listing anything', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await expect(withdrawFromVault(wallet, ADMIN, 'all', 'Withdraw', 'Z-9')).rejects.toMatchObject({ code: 'not-enrolled' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('requires-online before anything else — an offline user is never asked for a key', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    await expect(withdrawAll({ isOnline: async () => false })).rejects.toMatchObject({ code: 'requires-online' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  // ── remainder (spec §4.2 step 4) ───────────────────────────────────────

  it('re-vaults a remainder ≥ the floor as ONE output with a fresh salt committed to the CURRENT key set', async () => {
    const fx = [vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B, KEY_C]) // a key was added since these deposits
    await withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1')

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.outputs).toHaveLength(1)
    const out = caArgs.outputs[0]
    expect(out).toMatchObject({ satoshis: 400_000, basket: VAULT_BASKET, outputDescription: 'Vault change', tags: ['vault'] })
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(3))
    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.keys).toEqual([PUB_A, PUB_B, KEY_C.pubkey])
    expect(fx.map(f => f.salt)).not.toContain(ci.salt)
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toEqual(
      [PUB_A, PUB_B, KEY_C.pubkey].map(pk => commitment(pk, ci.salt))
    )
    validateSpends(fx)
  }, 60_000)

  it('folds a sub-floor remainder into the withdrawal (no vault output)', async () => {
    await seedVault([vaultFixture(150_000, [PUB_A, PUB_B])])
    await withdrawFromVault(wallet, ADMIN, 100_000, 'Withdraw', 'A-1')
    // 50,000 is below VAULT_DEPOSIT_MIN: it reaches the user as toolbox
    // change rather than becoming an output not worth what it costs to move.
    expect(wallet.createAction.mock.calls[0][0].outputs).toEqual([])
  }, 60_000)

  it('refuses to CREATE a re-vault output while vaultEnabled is off (not-released); withdrawing all is never gated', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(
      withdrawFromVault(wallet, ADMIN, 600_000, 'Withdraw', 'A-1', { vaultEnabled: () => false })
    ).rejects.toMatchObject({ code: 'not-released' })
    expect(wallet.createAction).not.toHaveBeenCalled()

    await expect(withdrawAll({ vaultEnabled: () => false })).resolves.toMatchObject({ txid: expect.any(String) })
  }, 60_000)

  // ── the version invariant and D4b (spec §2.6, §4.2 step 5) ─────────────

  it('bad-version: a signable transaction that is not version 2 is aborted before any signature', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const real = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementationOnce(async (args: any, o: string) => real({ ...args, version: 1 }, o))
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'bad-version' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('a pushTxDerCheck hit aborts the reservation and re-creates the action with that input\'s sequenceNumber bumped', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    const check = jest.spyOn(r1comb, 'pushTxDerCheck').mockReturnValueOnce({ ok: false, s: 0n })

    const r = await withdrawAll()
    expect(r.txid).toBeDefined()
    expect(check).toHaveBeenCalledTimes(2) // once per attempt
    expect(wallet.createAction).toHaveBeenCalledTimes(2)
    const [first] = wallet.createAction.mock.calls[0]
    const [second] = wallet.createAction.mock.calls[1]
    expect(first.inputs[0]).not.toHaveProperty('sequenceNumber')
    expect(second.inputs[0].sequenceNumber).toBe(0xfffffffe)
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    // The signatures are over the SECOND transaction (sequence 0xfffffffe).
    expect(lastSignable!.inputs[0].sequence).toBe(0xfffffffe)
    validateSpends(fx)
  }, 60_000)

  it('gives up after 8 attempts with no-transaction, never tapping', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    jest.spyOn(r1comb, 'pushTxDerCheck').mockReturnValue({ ok: false, s: 0n })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'no-transaction' })
    expect(wallet.createAction).toHaveBeenCalledTimes(8)
    expect(wallet.abortAction).toHaveBeenCalledTimes(8)
    const seqs = wallet.createAction.mock.calls.map(([a]: [any]) => a.inputs[0].sequenceNumber)
    expect(seqs).toEqual([undefined, 0xfffffffe, 0xfffffffd, 0xfffffffc, 0xfffffffb, 0xfffffffa, 0xfffffff9, 0xfffffff8])
    expect(requestVaultSigner).not.toHaveBeenCalled()
    expect(wallet.signAction).not.toHaveBeenCalled()
  }, 60_000)

  // ── abort discipline ───────────────────────────────────────────────────

  it('aborts the reservation and releases the signer when a signature fails (user cancel mid-batch)', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B]), vaultFixture(200_000, [PUB_A, PUB_B])])
    ;(requestVaultSigner as jest.Mock).mockImplementationOnce(async () => ({
      serial: 'A-1',
      pubkey: PUB_A,
      sign: async () => {
        throw new VaultError('user-cancelled')
      },
      release: signerRelease
    }))
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'user-cancelled' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(signerRelease).toHaveBeenCalledTimes(1)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('aborts the reservation when the tap itself fails (serial-mismatch from the ceremony)', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    ;(requestVaultSigner as jest.Mock).mockRejectedValueOnce(new VaultError('serial-mismatch', 'Tapped key B-1, chose key A-1'))
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'serial-mismatch' })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  })

  it('aborts when local verification rejects an unlock — the signer is already released', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    jest.spyOn(r1comb, 'verifyVaultInput').mockImplementationOnce(() => {
      throw new Error('SCRIPT_ERR_EVAL_FALSE')
    })
    await expect(withdrawAll()).rejects.toThrow('SCRIPT_ERR_EVAL_FALSE')
    expect(signerRelease).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-1' }, ADMIN)
    expect(wallet.signAction).not.toHaveBeenCalled()
  }, 60_000)

  it('still aborts when the signable bytes do not parse (after createAction reserved, before anything exists to sign)', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.createAction.mockResolvedValueOnce({ signableTransaction: { tx: [0, 0, 0, 0], reference: 'ref-corrupt' } })
    await expect(withdrawAll()).rejects.toThrow()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-corrupt' }, ADMIN)
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('does NOT abort when signAction itself fails — the transaction is signed and the network may have it', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.signAction.mockRejectedValueOnce(new Error('ETIMEDOUT posting to ARC'))
    await expect(withdrawAll()).rejects.toThrow('ETIMEDOUT')
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(signerRelease).toHaveBeenCalledTimes(1)
  }, 60_000)
})

// ── double-spend self-heal (unchanged behaviour, R1C fixtures) ────────────

describe('withdraw self-heals a double-spend from stuck reservations', () => {
  const reviewError = (competingTxs: string[]) =>
    Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
      code: 5,
      reviewActionResults: [{ txid: '', status: 'doubleSpend', competingTxs }]
    })

  /** One A+B output served, with the fake's createAction wrapped so the FIRST
   * call throws `err` and later calls run the real fabrication. */
  const oneOutputThrowingFirst = async (err: (outpoint: string) => unknown) => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    let createCalls = 0
    const real = wallet.createAction.getMockImplementation()!
    wallet.createAction.mockImplementation(async (...args: any[]) => {
      if (++createCalls === 1) throw err(fx[0].outpoint)
      return real(...(args as [unknown, string]))
    })
    return { fx, createCalls: () => createCalls }
  }

  test('aborts exactly the reserving txid (by txid match) then retries createAction', async () => {
    const RESERVING = 'ab'.repeat(32)
    const aborted: string[] = []
    const h = await oneOutputThrowingFirst(() => reviewError([RESERVING]))
    wallet.listActions.mockResolvedValue({
      actions: [
        { txid: RESERVING, status: 'nosend', reference: 'ref-reserving' }, // the culprit
        { txid: 'cd'.repeat(32), status: 'nosend', reference: 'ref-other' }, // unrelated txid
        { txid: RESERVING, status: 'completed', reference: 'ref-terminal' } // same txid, terminal
      ]
    })
    wallet.abortAction.mockImplementation(async (args: any) => {
      aborted.push(args.reference)
      return {}
    })

    const { txid } = await withdrawAll()
    expect(txid).toBeDefined()
    expect(h.createCalls()).toBe(2) // threw once, retried once
    expect(aborted).toEqual(['ref-reserving']) // only the matching txid + abortable status
  }, 60_000)

  // The shape a failed withdrawal ACTUALLY leaves behind: the orphan died
  // before signing, so it has no txid for the review path to blame and the
  // toolbox refuses the input with a plain WERR_INVALID_PARAMETER naming the
  // outpoint instead.
  const unspendableError = (outpoint: string) => {
    const [txid, vout] = outpoint.split('.')
    return Object.assign(
      new Error(
        `The inputs[0] parameter must be spendable output. output ${txid}:${vout} ` +
          'appears to have been spent (spendable=false).'
      ),
      { code: 'WERR_INVALID_PARAMETER' }
    )
  }

  test('aborts the orphan reserving the outpoint (matched on its inputs) then retries', async () => {
    const aborted: string[] = []
    const h = await oneOutputThrowingFirst(unspendableError)
    wallet.listActions.mockImplementation(async (args: any) => {
      expect(args.includeInputs).toBe(true) // cannot match on txid here, so it must ask for inputs
      if (args.offset > 0) return { actions: [] }
      return {
        actions: [
          { status: 'unsigned', reference: 'ref-orphan', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] },
          { status: 'unsigned', reference: 'ref-other', inputs: [{ sourceOutpoint: `${'ee'.repeat(32)}.0` }] },
          { txid: 'cd'.repeat(32), status: 'completed', reference: 'ref-done', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] }
        ]
      }
    })
    wallet.abortAction.mockImplementation(async (args: any) => {
      aborted.push(args.reference)
      return {}
    })

    const { txid } = await withdrawAll()
    expect(txid).toBeDefined()
    expect(h.createCalls()).toBe(2)
    expect(aborted).toEqual(['ref-orphan'])
  }, 60_000)

  test('with a storage lookup, heals from one query and never pages actions', async () => {
    const h = await oneOutputThrowingFirst(unspendableError)
    const asked: string[][] = []
    const findSpendingReferences = jest.fn(async (outpoints: string[]) => {
      asked.push(outpoints)
      return [
        { reference: 'ref-orphan', status: 'unsigned' },
        { reference: 'ref-done', status: 'completed' } // terminal → not abortable
      ]
    })

    const { txid } = await withdrawAll({ findSpendingReferences })
    expect(txid).toBeDefined()
    expect(h.createCalls()).toBe(2)
    expect(asked).toEqual([[h.fx[0].outpoint]])
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
    expect(wallet.abortAction).not.toHaveBeenCalledWith({ reference: 'ref-done' }, ADMIN)
    expect(wallet.listActions).not.toHaveBeenCalled()
  }, 60_000)

  test('falls back to the scan when the storage lookup throws', async () => {
    const h = await oneOutputThrowingFirst(unspendableError)
    const findSpendingReferences = jest.fn(async () => {
      throw new Error('database is locked')
    })
    wallet.listActions.mockResolvedValue({
      actions: [{ status: 'unsigned', reference: 'ref-orphan', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] }]
    })
    await expect(withdrawAll({ findSpendingReferences })).resolves.toMatchObject({ txid: expect.any(String) })
    expect(findSpendingReferences).toHaveBeenCalled()
    expect(wallet.listActions).toHaveBeenCalled()
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
  }, 60_000)

  test('matches the outpoint spelling the toolbox uses in error text (txid:vout)', async () => {
    const h = await oneOutputThrowingFirst(unspendableError)
    const [txid] = h.fx[0].outpoint.split('.')
    expect(h.fx[0].outpoint).toBe(`${txid}.0`)
    expect(unspendableError(h.fx[0].outpoint).message).toContain(`${txid}:0`)
    wallet.listActions.mockResolvedValue({
      actions: [{ status: 'nosend', reference: 'ref-orphan', inputs: [{ sourceOutpoint: h.fx[0].outpoint }] }]
    })
    await expect(withdrawAll()).resolves.toMatchObject({ txid: expect.any(String) })
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-orphan' }, ADMIN)
  }, 60_000)

  test('rethrows an unrelated WERR_INVALID_PARAMETER without aborting anything', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.createAction.mockImplementation(async () => {
      throw Object.assign(new Error('The outputs[0].satoshis parameter must be a positive integer.'), {
        code: 'WERR_INVALID_PARAMETER'
      })
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
    expect(wallet.listActions).not.toHaveBeenCalled()
    expect(wallet.abortAction).not.toHaveBeenCalled()
    expect(wallet.createAction).toHaveBeenCalledTimes(1) // no retry
  })

  test('rethrows when the wedged outpoint is not one this withdrawal is spending', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    wallet.createAction.mockImplementation(async () => {
      throw unspendableError(`${'ee'.repeat(32)}.0`)
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  test('rethrows when nothing reserving the outpoint can be aborted', async () => {
    const fx = [vaultFixture(300_000, [PUB_A, PUB_B])]
    await seedVault(fx)
    wallet.listActions.mockResolvedValue({
      actions: [{ txid: 'cd'.repeat(32), status: 'completed', reference: 'ref-done', inputs: [{ sourceOutpoint: fx[0].outpoint }] }]
    })
    wallet.createAction.mockImplementation(async () => {
      throw unspendableError(fx[0].outpoint)
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 'WERR_INVALID_PARAMETER' })
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  test('rethrows the review error when the reserving tx is not abortable/found', async () => {
    await seedVault([vaultFixture(300_000, [PUB_A, PUB_B])])
    const RESERVING = 'ab'.repeat(32)
    wallet.listActions.mockResolvedValue({
      actions: [{ txid: RESERVING, status: 'completed', reference: 'ref-terminal' }]
    })
    wallet.createAction.mockImplementation(async () => {
      throw reviewError([RESERVING])
    })
    await expect(withdrawAll()).rejects.toMatchObject({ code: 5 })
  })
})
```

- [ ] **Step 3: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts` → the two Task 9 suites still pass; every new test fails with `TypeError: (0 , _transfers.withdrawFromVault) is not a function`.

- [ ] **Step 4: Implement in `transfers.ts`**

(a) Replace the two import lines:

```ts
import { Beef, Hash, LockingScript, P2PKH, PublicKey, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'
```
and
```ts
import {
  R1C_UNLOCK_LEN,
  SALT_BYTES,
  VaultInstructionsV4,
  bakedCommitments,
  buildLock,
  buildUnlock,
  commitment,
  decodeVaultInstructions,
  encodeVaultInstructions,
  pushTxDerCheck,
  sighashPreimage,
  signerDigest,
  verifyVaultInput
} from './r1comb'
```
and add, after the `../../toolboxConfig` import:
```ts
import { noteVaultProgress, requestVaultSigner } from './ceremonyHost'
```

(b) Append after the last line of `reclaimStagingOutputs` (the end of the file after Task 9):

```ts

// ── withdraw / re-lock: selection (spec §4.2 steps 2–3) ───────────────────

/** How many times the signable transaction may be re-created to dodge a
 * pushTxDerCheck hit (spec D4b) before giving up. Each re-creation bumps the
 * offending input's sequence number, which changes every preimage. */
const PUSH_TX_RETRY_MAX = 8

/** One vault output the chosen key can open, with its real lock in hand. */
interface SelectedVaultOutput {
  outpoint: string
  satoshis: number
  ci: VaultInstructionsV4
  /** The output's REAL locking script, read from the listed BEEF. */
  lockingScript: LockingScript
}

interface VaultSelection {
  /** The CURRENT key list (meta.keys) — what a re-vault or re-lock commits to. */
  keys: VaultKeyRecord[]
  chosen: VaultKeyRecord
  /** Largest first, capped, every one proven committed to `chosen`. */
  selected: SelectedVaultOutput[]
  /** Sum of `selected`. */
  acc: number
  cappedInputs: number
  unreachable: VaultSpendResult['unreachable']
  beef?: number[]
}

/**
 * list → decode v4 → filter to the chosen key → sort largest first → cap →
 * prove each selected output's REAL lock commits to the chosen key → amount
 * checks. Nothing is reserved, tapped or signed here, so every refusal is free.
 *
 * `include: 'entire transactions'` IS required, twice over. Structurally:
 * every input carries unlockingScriptLength but no unlockingScript, so
 * @bsv/sdk's validateCreateActionArgs sets isSignAction=true and
 * buildSignableTransaction resolves each input's sourceTransaction ONLY from
 * args.inputBEEF (buildSignableTransaction.js:14,101) — omit it and
 * createAction.js's makeSignableTransactionBeef throws WERR_INTERNAL before
 * signing starts. And for the commitment check: the BEEF is where each
 * output's REAL lock comes from — customInstructions are never trusted over
 * it (a record can claim any key list; only the lock says who can spend).
 * `include` is one-of, so this call cannot also ask for 'locking scripts'.
 * includeCustomInstructions is required too: listOutputs omits the field
 * unless asked, and without it every output decodes as null.
 */
async function selectVaultInputs(
  w: VaultWallet,
  adminOriginator: string,
  chosenSerial: string,
  amount: number | 'all'
): Promise<VaultSelection> {
  const meta = await vaultStore.getMeta()
  if (!meta) throw new VaultError('not-enrolled', 'Vault is not set up')
  const chosen = meta.keys.find(k => k.serial === chosenSerial)
  if (!chosen) throw new VaultError('not-enrolled', `Key ${chosenSerial} is not one of this vault's keys`)

  // Hand the JS thread back once so React can paint before the bridge and
  // database work below; the listOutputs payload is up to ~900 KB of BEEF.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const list = await w.listOutputs(
    { basket: VAULT_BASKET, include: 'entire transactions', includeCustomInstructions: true, limit: 1000 },
    adminOriginator
  )
  const decodable = list.outputs
    .map(o => ({ outpoint: o.outpoint, satoshis: o.satoshis, ci: decodeVaultInstructions(o.customInstructions) }))
    .filter((o): o is typeof o & { ci: VaultInstructionsV4 } => o.ci != null)
  if (decodable.length === 0) throw new VaultError('vault-empty', 'Vault is empty')

  const total = decodable.reduce((s, o) => s + o.satoshis, 0)
  const mine = decodable.filter(o => o.ci.keys.includes(chosen.pubkey)).sort((a, b) => b.satoshis - a.satoshis)
  const others = decodable.filter(o => !o.ci.keys.includes(chosen.pubkey))
  const otherPubkeys = [...new Set(others.flatMap(o => o.ci.keys))]
  const unreachable: VaultSpendResult['unreachable'] = {
    count: others.length,
    satoshis: others.reduce((s, o) => s + o.satoshis, 0),
    keys: otherPubkeys.map(pubkey => ({ serial: meta.keys.find(k => k.pubkey === pubkey)?.serial, pubkey }))
  }
  if (mine.length === 0) {
    throw new VaultError('key-not-committed', `Key ${chosen.serial} is not committed to any vault output`)
  }
  const reachable = mine.reduce((s, o) => s + o.satoshis, 0)

  // Bounded input count — see VAULT_MAX_INPUTS. Largest first (already
  // sorted), so the fewest inputs cover the most value.
  const cap = Math.min(VAULT_MAX_INPUTS, VAULT_HARD_MAX_INPUTS)
  const capped = mine.slice(0, cap)
  const cappedInputs = mine.length - capped.length

  // THE COMMITMENT CHECK, against the script the output is ACTUALLY locked
  // with — never a lock rebuilt from the output's own record, which is
  // self-consistent by construction. Runs before anything is reserved, so a
  // lying record costs nothing to refuse.
  const sources = list.BEEF?.length ? Beef.fromBinary(list.BEEF) : undefined
  const selected: SelectedVaultOutput[] = capped.map(o => {
    const [txid, voutStr] = o.outpoint.split('.')
    // Beef indexes by exact txid string; storage writes lowercase, but so does
    // every other txid comparison in this file — match them rather than trust it.
    const lockingScript = sources?.findTxid(txid.toLowerCase())?.tx?.outputs[Number(voutStr)]?.lockingScript
    if (!lockingScript) {
      // Fail closed rather than sign blind — and createAction would refuse
      // this input moments later anyway (see the listOutputs comment).
      throw new VaultError('no-transaction', `No source transaction for vault output ${o.outpoint}`)
    }
    let baked: string[]
    try {
      baked = bakedCommitments(lockingScript)
    } catch (e) {
      if (e instanceof VaultError && e.code === 'template-invalid') {
        throw new VaultError('key-not-committed', `Vault output ${o.outpoint} is not an R1C lock`)
      }
      throw e
    }
    if (!baked.includes(commitment(chosen.pubkey, o.ci.salt))) {
      throw new VaultError('key-not-committed', `Vault output ${o.outpoint} is not committed to key ${chosen.serial}`)
    }
    return { outpoint: o.outpoint, satoshis: o.satoshis, ci: o.ci, lockingScript }
  })
  const acc = selected.reduce((s, o) => s + o.satoshis, 0)

  if (amount !== 'all') {
    if (amount > total) throw new VaultError('amount-exceeds-balance', 'Withdrawal exceeds vault balance')
    if (amount > reachable && reachable < total) {
      // Another key could open more: say which, rather than blaming the balance.
      throw new VaultError(
        'key-cannot-cover',
        `Key ${chosen.serial} can open ${reachable} of the ${total} satoshis in the vault`,
        undefined,
        { reachable, total }
      )
    }
    if (amount > acc) {
      // The key holds enough (checked above) but not within the input cap. The
      // remedy is a smaller withdrawal, which also consolidates.
      throw new VaultError(
        'too-many-inputs',
        `Withdrawing ${amount} satoshis would need more than ${cap} vault inputs; withdraw a smaller amount first`
      )
    }
  }
  return { keys: meta.keys, chosen, selected, acc, cappedInputs, unreachable, beef: list.BEEF }
}

// ── withdraw / re-lock: build, sign on the card, verify, finalise ─────────

/** What a spend adds to the transaction beyond its vault inputs. */
interface VaultSpendPlan {
  outputs: ReturnType<typeof newVaultOutput>[]
  labels: string[]
  inputDescription: string
}

interface PreparedInput {
  /** Position in the signable transaction — located by outpoint, never assumed. */
  inputIndex: number
  preimage: number[]
}

type SignableBuild =
  | { kind: 'done'; txid: string }
  | { kind: 'signable'; tx: Transaction; reference: string; prepared: PreparedInput[] }

/**
 * createAction with `version: 2` (spec §2.6), then the two checks that must
 * pass before the FIRST card signature: the parsed signable transaction is
 * version 2 (`bad-version`), and every input's preimage passes pushTxDerCheck
 * (D4b). A D4b hit aborts the reservation and re-creates the action with that
 * input's `sequenceNumber` bumped — the toolbox default is 0xffffffff, so
 * "bumped" means decremented; lockTime is 0, so any value is final — which
 * changes every preimage. Bounded by PUSH_TX_RETRY_MAX.
 *
 * The freeReservedInputs retry-once around createAction is unchanged: a prior
 * failed attempt can leave a vault UTXO reserved by an orphaned transaction,
 * in either of the two error shapes freeReservedInputs recognises.
 */
async function createSignableVaultTx(
  w: VaultWallet,
  adminOriginator: string,
  sel: VaultSelection,
  reason: string,
  plan: VaultSpendPlan,
  opts?: VaultTransferOptions
): Promise<SignableBuild> {
  const outpoints = sel.selected.map(o => o.outpoint)
  /** outpoint → sequenceNumber override, set by a pushTxDerCheck hit. */
  const sequences = new Map<string, number>()

  for (let attempt = 1; ; attempt++) {
    const caArgs = {
      description: reason,
      version: 2,
      inputs: sel.selected.map(o => ({
        outpoint: o.outpoint,
        unlockingScriptLength: R1C_UNLOCK_LEN,
        inputDescription: plan.inputDescription,
        ...(sequences.has(o.outpoint) ? { sequenceNumber: sequences.get(o.outpoint) } : {})
      })),
      outputs: plan.outputs,
      labels: plan.labels,
      // From the 'entire transactions' listOutputs call — required, not
      // optional (see selectVaultInputs). trustSelf: 'known' lets storage skip
      // re-walking each source transaction's own merkle-proof ancestry for a
      // basket this wallet already trusts; it does not replace inputBEEF.
      inputBEEF: sel.beef?.length ? sel.beef : undefined,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' }
    }

    let created: CreateActionResult
    try {
      created = await w.createAction(caArgs, adminOriginator)
    } catch (e) {
      const freed = await freeReservedInputs(w, adminOriginator, e, outpoints, opts?.findSpendingReferences)
      if (freed === 0) throw e
      created = await w.createAction(caArgs, adminOriginator)
    }

    if (!created.signableTransaction) {
      // Inputs carrying unlockingScriptLength always come back signable; kept
      // for symmetry with reclaimStagingOutputs' direct-txid branch.
      const txid = created.txid ?? (created.tx ? Transaction.fromAtomicBEEF(created.tx).id('hex') : undefined)
      if (!txid) throw new VaultError('no-transaction', 'Vault spend produced no transaction')
      return { kind: 'done', txid }
    }

    const { reference } = created.signableTransaction
    try {
      const tx = Transaction.fromAtomicBEEF(created.signableTransaction.tx)
      if (tx.version !== 2) {
        throw new VaultError('bad-version', `Signable transaction is version ${tx.version}; expected 2`)
      }
      const prepared: PreparedInput[] = sel.selected.map(o => {
        const [txid, voutStr] = o.outpoint.split('.')
        const vout = Number(voutStr)
        // The toolbox is free to add funding inputs of its own, so each vault
        // input is located by outpoint, never assumed by position.
        const inputIndex = tx.inputs.findIndex(
          i =>
            (i.sourceTXID ?? i.sourceTransaction?.id('hex'))?.toLowerCase() === txid.toLowerCase() &&
            i.sourceOutputIndex === vout
        )
        if (inputIndex < 0) {
          throw new VaultError('no-transaction', `Vault input ${o.outpoint} missing from the signable transaction`)
        }
        return { inputIndex, preimage: sighashPreimage(tx, inputIndex, o.satoshis) }
      })

      const badAt = prepared.findIndex(p => !pushTxDerCheck(p.preimage).ok)
      if (badAt < 0) return { kind: 'signable', tx, reference, prepared }
      if (attempt >= PUSH_TX_RETRY_MAX) {
        throw new VaultError(
          'no-transaction',
          `Could not build a signable vault transaction in ${PUSH_TX_RETRY_MAX} attempts`
        )
      }
      const bad = sel.selected[badAt]
      const current = sequences.get(bad.outpoint) ?? (tx.inputs[prepared[badAt].inputIndex].sequence ?? 0xffffffff)
      sequences.set(bad.outpoint, current - 1)
    } catch (e) {
      await w.abortAction({ reference }, adminOriginator).catch(() => {})
      throw e
    }
    // D4b hit: this reservation is worthless — release it and rebuild with the
    // bumped sequence.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
  }
}

/**
 * Spec §4.2 steps 5–8, shared by withdrawFromVault and relockVault.
 *
 * ORDER, and why: build + screen (no card) → tap (requestVaultSigner) → sign
 * every input SEQUENTIALLY → release the signer → verify every unlock locally
 * with the strict flags → signAction. Verification runs after release so the
 * NFC sheet is down while the interpreter works; anything failing before
 * signAction aborts the reservation; nothing after it does.
 *
 * SEQUENTIAL BY DESIGN — do not "simplify" this into an
 * unlockingScriptTemplate + tx.sign(). @bsv/sdk's Transaction.sign() fans
 * every template's sign() out through Promise.all and takes ownership of the
 * whole input set; this loop keeps each input's script ours to build, in a
 * known order, one card round trip at a time (the card signs one digest per
 * command). The yield before each signature keeps the JS thread responsive
 * for the sheet.
 */
async function spendVaultOutputs(
  w: VaultWallet,
  adminOriginator: string,
  sel: VaultSelection,
  reason: string,
  plan: VaultSpendPlan,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  const built = await createSignableVaultTx(w, adminOriginator, sel, reason, plan, opts)
  const result = (txid: string): VaultSpendResult => ({ txid, cappedInputs: sel.cappedInputs, unreachable: sel.unreachable })
  if (built.kind === 'done') return result(built.txid)
  const { tx, reference, prepared } = built
  const { chosen, selected } = sel
  const total = selected.length

  const unlocks: { inputIndex: number; unlockingScript: UnlockingScript }[] = []
  try {
    // ── the tap(s): one on-card signature per input ────────────────────
    const signer = await requestVaultSigner(reason, chosen.serial)
    try {
      for (let i = 0; i < total; i++) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        noteVaultProgress({ phase: 'preparing', signed: i, total })
        const { inputIndex, preimage } = prepared[i]
        const der = await signer.sign(signerDigest(preimage), { index: i, total })
        // buildUnlock throws template-invalid if fullR is the point at
        // infinity — a 2^-256 event; it unwinds through the abort below.
        unlocks.push({
          inputIndex,
          unlockingScript: buildUnlock({ preimage, derSig: der, pubkeyHex33: signer.pubkey, saltHex64: selected[i].ci.salt })
        })
      }
    } finally {
      // Dismisses the NFC sheet and drops the PIN whether or not every input
      // was signed; the local verification below needs no card.
      signer.release()
    }

    // ── strict local Spend per input (spec §4.2 step 7) ────────────────
    // Honest unlocks are minimal, so MINIMALDATA on is strictly stronger than
    // the node's version-2 rules: anything that passes here is accepted there.
    for (let i = 0; i < total; i++) {
      verifyVaultInput({
        tx,
        inputIndex: unlocks[i].inputIndex,
        sourceSatoshis: selected[i].satoshis,
        lockingScript: selected[i].lockingScript,
        unlockingScript: unlocks[i].unlockingScript
      })
    }
  } catch (e) {
    // Nothing reached signAction, so the reservation is worthless — release
    // it, or the vault UTXO stays spendable=false and the next attempt is
    // refused outright.
    await w.abortAction({ reference }, adminOriginator).catch(() => {})
    throw e
  }

  const spends: Record<number, { unlockingScript: string }> = {}
  for (const u of unlocks) spends[u.inputIndex] = { unlockingScript: u.unlockingScript.toHex() }

  // PAST THE POINT OF NO ABORT.
  //
  // acceptDelayedBroadcast: true hands the signed transaction to storage and
  // lets the monitor's SendWaiting task carry it to the network. A slow or
  // timing-out broadcaster therefore cannot cost the user a signed
  // transaction, and this call no longer waits on the network before the UI
  // can move on.
  //
  // Deliberately OUTSIDE the try above: once a transaction is signed, aborting
  // it is the dangerous move, not the safe one — the network may already have
  // accepted it, and abandoning it locally would leave the wallet blind to
  // funds that really moved. A failure here is reported as "we will try
  // again", never as a cancellation.
  //
  // The broadcasting note is inert once the signer is released (noteProgress
  // ignores notes with nothing armed); the transfer screen shows its own
  // spinner. Kept so the phase sequence reads complete.
  noteVaultProgress({ phase: 'broadcasting' })
  const signed = await w.signAction({ reference, spends, options: { acceptDelayedBroadcast: true } }, adminOriginator)
  const txid = signed.txid ?? (signed.tx ? Transaction.fromAtomicBEEF(signed.tx).id('hex') : undefined)
  if (!txid) throw new VaultError('no-transaction', 'Vault spend produced no transaction')
  await vaultStore.noteLastUsed(chosen.serial)
  return result(txid)
}

// ── withdraw ────────────────────────────────────────────────────────────

/**
 * Withdraw from the vault with the CHOSEN key (spec §4.2).
 *
 * `amount: 'all'` means "as much as one transaction can carry of what this
 * key can open": the untouched outputs stay in the vault and are reported as
 * `cappedInputs` (repeat to move them); outputs other keys own are reported as
 * `unreachable` (repeat with one of those keys). A remainder ≥ VAULT_DEPOSIT_MIN
 * is re-vaulted as one output committed to the CURRENT key set (so a partial
 * withdrawal also brings old deposits up to date with the key list); a smaller
 * one is folded into the withdrawal as toolbox change.
 */
export async function withdrawFromVault(
  w: VaultWallet,
  adminOriginator: string,
  amount: number | 'all',
  reason: string,
  chosenSerial: string,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  // Before anything else: an offline user is never asked to present a key for
  // a transfer that cannot proceed.
  await requireOnline(opts)
  const sel = await selectVaultInputs(w, adminOriginator, chosenSerial, amount)
  const want = amount === 'all' ? sel.acc : amount
  const remainder = sel.acc - want
  const outputs: VaultSpendPlan['outputs'] = []
  if (remainder >= VAULT_DEPOSIT_MIN) {
    // Re-vaulting CREATES a vault output, which the release flag gates (spec
    // §5.5). Withdrawing pre-existing outputs — 'all' — never is.
    requireReleased(opts, 'Re-vaulting a remainder')
    outputs.push(newVaultOutput(sel.keys, remainder, 'Vault change'))
  }
  return spendVaultOutputs(
    w,
    adminOriginator,
    sel,
    reason,
    { outputs, labels: ['vault', 'vault-withdraw'], inputDescription: 'Vault withdrawal' },
    opts
  )
}
```

- [ ] **Step 5: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts` → all pass: Task 9's 23 + `withdrawFromVault` 29 + `withdraw self-heals a double-spend from stuck reservations` 9 — **61 tests**. Wall time is dominated by the real strict `Spend` verifications (one comb-loop interpretation per verified input); the two 35-/34-output tests stub `verifyVaultInput` and should each finish well inside their 120 s budget.
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'ui/screens/VaultTransferScreen.tsx\|ui/screens/VaultRecoverScreen.tsx\|ui/components/vault/EnrollWizard.tsx\|ui/screens/VaultScreen.tsx'` → empty.

- [ ] **Step 6: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/transfers.ts packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts
git commit -m "feat(expo-wallet-toolbox)!: chosen-key vault withdrawal — v2 action, D4b screen, on-card batches, strict local Spend" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: transfers.ts — `relockVault`, `estimateRelockFee`, `getVaultKeyCoverage`, `orphanedIfRemoved`, v4-only `getVaultBalance`

**Files:**
- Modify: `T/core/services/vault/transfers.ts` (add `R1C_LOCK_LEN` to the r1comb import; replace `getVaultBalance`; append the re-lock and coverage sections)
- Modify: `T/__tests__/vault/transfers.test.ts` (extend the transfers import; append suites)

**Interfaces:**
- Consumes: everything Task 10 wired (`selectVaultInputs`, `spendVaultOutputs`, `newVaultOutput`, `requireReleased`, `requireOnline`), plus `R1C_LOCK_LEN(n)` and `decodeVaultInstructions` from `./r1comb`.
- Produces (contract): `relockVault(w, adminOriginator, reason, chosenSerial, opts?): Promise<VaultSpendResult>` (throws `too-small-to-relock` | `not-released`), `estimateRelockFee(inputCount, lockLen, satPerKb = 100): number`, `getVaultKeyCoverage(w, adminOriginator): Promise<VaultKeyCoverage>`, `orphanedIfRemoved(w, adminOriginator, pubkey): Promise<number>` (spec §3.4: the count of vault outputs that would lose every remaining committed key if `pubkey` were removed — Plan 3's Remove handler refuses with `relock-required` whenever this is > 0), `getVaultBalance` counting decodable v4 outputs only (and now passing `includeCustomInstructions: true`, which listOutputs needs to return the field at all).
- Fee arithmetic: the contract's `ceil(size/1000)·satPerKb·1.1` is computed in INTEGERS — `ceil(kb·satPerKb·11 / 10)` — because `11200 * 1.1` is `12320.000000000002` in IEEE doubles and a naive `Math.ceil` would charge one satoshi too many. Same value, no float.
- Labels: a re-lock carries `['vault', 'vault-relock']` and `inputDescription: 'Vault re-lock'` (the spec names no label; `'vault-withdraw'` would mislabel history and `'vault-deposit'` would drag the re-lock's inputs under `StorageExpoSQLite.releaseVaultStagingStrandedByInvalidTx`'s label predicate — flagged in the summary).
- Allowed tsc residuals after this commit: the four Plan 3 `ui/` files only.

- [ ] **Step 1: Extend the test imports and append the suites**

Replace the transfers import in `transfers.test.ts` with:

```ts
import {
  VAULT_BASKET,
  VAULT_DEPOSIT_MIN,
  VAULT_HARD_MAX_INPUTS,
  VAULT_MAX_INPUTS,
  VAULT_STAGING_BASKET,
  VaultWallet,
  depositToVault,
  estimateRelockFee,
  getVaultBalance,
  getVaultKeyCoverage,
  orphanedIfRemoved,
  reclaimStagingOutputs,
  relockVault,
  withdrawFromVault
} from '../../core/services/vault/transfers'
```

Append at the END of the file:

```ts
// ── re-lock (spec §4.3) ───────────────────────────────────────────────────

describe('estimateRelockFee', () => {
  it('is ceil(size/1000)·satPerKb·1.1 over the declared unlock length and the new lock, computed without float drift', () => {
    // 1 input, 2-key lock: size = 10 + 1·(41+3+2560) + (3 + 27881 + 8) = 30,506 → 31 kB → 3,100 → +10 % = 3,410
    expect(estimateRelockFee(1, R1C_LOCK_LEN(2))).toBe(3410)
    // 32 inputs, 3-key lock: size = 10 + 32·2604 + (3 + 27906 + 8) = 111,255 → 112 kB → 11,200 → 12,320
    // (11200 * 1.1 is 12320.000000000002 in doubles — a float ceil would say 12,321.)
    expect(estimateRelockFee(32, R1C_LOCK_LEN(3))).toBe(12320)
    // satPerKb is a parameter: 31 kB · 50 = 1,550 → 1,705
    expect(estimateRelockFee(1, R1C_LOCK_LEN(2), 50)).toBe(1705)
    // Zero inputs is not a re-lock, but the arithmetic is still well-defined:
    // size = 27,902 → 28 kB → 2,800 → 3,080 (2800 * 1.1 is 3080.0000000000005 in doubles).
    expect(estimateRelockFee(0, R1C_LOCK_LEN(2))).toBe(3080)
  })
})

describe('relockVault', () => {
  const relock = (opts?: Parameters<typeof relockVault>[4]) => relockVault(wallet, ADMIN, 'Re-lock vault', 'A-1', opts)

  it('spends everything the chosen key can open into ONE fresh vault output of acc − fee committed to the CURRENT key set, with no withdrawal output', async () => {
    const fx = [vaultFixture(500_000, [PUB_A, PUB_B]), vaultFixture(500_000, [PUB_A, PUB_B])]
    await seedVault(fx, [KEY_A, KEY_B, KEY_C]) // a key was ADDED since these deposits
    const r = await relock()
    expect(r).toEqual({ txid: 'feedface'.repeat(8), cappedInputs: 0, unreachable: { count: 0, satoshis: 0, keys: [] } })

    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.description).toBe('Re-lock vault')
    expect(caArgs.version).toBe(2)
    expect(caArgs.labels).toEqual(['vault', 'vault-relock'])
    expect(caArgs.inputs).toHaveLength(2)
    for (const i of caArgs.inputs) {
      expect(i.unlockingScriptLength).toBe(R1C_UNLOCK_LEN)
      expect(i.inputDescription).toBe('Vault re-lock')
    }
    expect(caArgs.options).toEqual({ randomizeOutputs: false, acceptDelayedBroadcast: false, trustSelf: 'known' })

    // ONE output: the whole accumulated value minus the fee reserve, back into
    // the vault under the current three keys. No second output — the fake
    // cannot observe the default-basket surplus, but it can observe that no
    // withdrawal output was asked for.
    expect(caArgs.outputs).toHaveLength(1)
    const out = caArgs.outputs[0]
    const fee = estimateRelockFee(2, R1C_LOCK_LEN(3))
    expect(out).toMatchObject({ satoshis: 1_000_000 - fee, basket: VAULT_BASKET, outputDescription: 'Vault re-lock', tags: ['vault'] })
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(3))
    const ci = decodeVaultInstructions(out.customInstructions)!
    expect(ci.keys).toEqual([PUB_A, PUB_B, KEY_C.pubkey])
    expect(fx.map(f => f.salt)).not.toContain(ci.salt) // fresh salt
    expect(bakedCommitments(LockingScript.fromHex(out.lockingScript))).toEqual(
      [PUB_A, PUB_B, KEY_C.pubkey].map(pk => commitment(pk, ci.salt))
    )
    validateSpends(fx)
    expect((await vaultStore.getMeta())!.lastUsedSerial).toBe('A-1')
  }, 60_000)

  it('after a key was REMOVED, the re-lock output is committed only to the remaining keys', async () => {
    const fx = [vaultFixture(500_000, [PUB_A, PUB_B, KEY_C.pubkey])]
    await seedVault(fx, [KEY_A, KEY_B]) // C removed
    await relock()
    const out = wallet.createAction.mock.calls[0][0].outputs[0]
    expect(decodeVaultInstructions(out.customInstructions)!.keys).toEqual([PUB_A, PUB_B])
    expect(Utils.toArray(out.lockingScript, 'hex')).toHaveLength(R1C_LOCK_LEN(2))
    expect(out.satoshis).toBe(500_000 - estimateRelockFee(1, R1C_LOCK_LEN(2)))
    validateSpends(fx)
  }, 60_000)

  it('too-small-to-relock when acc − fee would fall below the floor — nothing reserved, no tap; exactly the floor passes', async () => {
    await seedVault([vaultFixture(100_000, [PUB_A, PUB_B])]) // 100,000 − 3,410 < 100,000
    const err = await relock().catch(e => e)
    expect(err).toMatchObject({ code: 'too-small-to-relock' })
    expect(err.message).toContain('96590')
    expect(wallet.createAction).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()

    await seedVault([vaultFixture(100_000 + estimateRelockFee(1, R1C_LOCK_LEN(2)), [PUB_A, PUB_B])])
    await expect(relock()).resolves.toMatchObject({ txid: expect.any(String) })
    expect(wallet.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(VAULT_DEPOSIT_MIN)
  }, 60_000)

  it('not-released when the flag is off — before listing or tapping; reads isVaultEnabled() when opts omit it', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(relock({ vaultEnabled: () => false })).rejects.toMatchObject({ code: 'not-released' })
    ;(isVaultEnabled as jest.Mock).mockReturnValueOnce(false)
    await expect(relock()).rejects.toMatchObject({ code: 'not-released' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
    expect(requestVaultSigner).not.toHaveBeenCalled()
  })

  it('requires-online before listing', async () => {
    await seedVault([vaultFixture(500_000, [PUB_A, PUB_B])])
    await expect(relock({ isOnline: async () => false })).rejects.toMatchObject({ code: 'requires-online' })
    expect(wallet.listOutputs).not.toHaveBeenCalled()
  })

  it('selects like a withdrawal: outputs the chosen key cannot open are reported as unreachable, so the screen can ask for another key', async () => {
    const mine = vaultFixture(500_000, [PUB_A, PUB_B])
    const theirs = vaultFixture(400_000, [PUB_B])
    await seedVault([mine, theirs])
    const r = await relock()
    expect(r.unreachable).toEqual({ count: 1, satoshis: 400_000, keys: [{ serial: 'B-1', pubkey: PUB_B }] })
    expect(wallet.createAction.mock.calls[0][0].inputs.map((i: any) => i.outpoint)).toEqual([mine.outpoint])
    expect(wallet.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(500_000 - estimateRelockFee(1, R1C_LOCK_LEN(2)))
    validateSpends([mine])
  }, 60_000)

  it('caps like a withdrawal and reports cappedInputs so the screen can run another pass', async () => {
    await seedVault(Array.from({ length: VAULT_MAX_INPUTS + 1 }, () => vaultFixture(300_000, [PUB_A, PUB_B])))
    jest.spyOn(r1comb, 'verifyVaultInput').mockReturnValue(true)
    const r = await relock()
    expect(r.cappedInputs).toBe(1)
    const [caArgs] = wallet.createAction.mock.calls[0]
    expect(caArgs.inputs).toHaveLength(VAULT_MAX_INPUTS)
    expect(caArgs.outputs[0].satoshis).toBe(VAULT_MAX_INPUTS * 300_000 - estimateRelockFee(VAULT_MAX_INPUTS, R1C_LOCK_LEN(2)))
  }, 120_000)
})

// ── coverage (spec §3.4 badges) ───────────────────────────────────────────

describe('getVaultKeyCoverage', () => {
  let n = 0
  const rec = (keys: string[]) => ({
    outpoint: `${'ab'.repeat(32)}.${n++}`,
    satoshis: 1,
    customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys })
  })
  const removed = Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), true)))

  it('counts stale outputs in both directions, names the missing current keys, and counts outputs still open to a removed key', async () => {
    await seedMeta([KEY_A, KEY_B])
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        rec([PUB_A, PUB_B]), // current
        rec([PUB_A]), // stale: B was added after this deposit → "not yet open to Safe"
        rec([PUB_A, PUB_B, removed]), // stale: a removed key can still open it
        { outpoint: `${'ee'.repeat(32)}.0`, satoshis: 5, customInstructions: JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/0' }) }, // ignored
        { outpoint: `${'ff'.repeat(32)}.0`, satoshis: 5, customInstructions: '{' } // ignored
      ]
    })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({
      outputs: 3,
      stale: 2,
      missingKeys: [PUB_B],
      removedKeyOutputs: 1
    })
    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs).toMatchObject({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 })
  })

  it('is all-zero for an empty vault and for a vault whose every output matches the current set', async () => {
    await seedMeta([KEY_A, KEY_B])
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [] })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 0, stale: 0, missingKeys: [], removedKeyOutputs: 0 })

    wallet.listOutputs.mockResolvedValueOnce({ outputs: [rec([PUB_A, PUB_B]), rec([PUB_B, PUB_A])] }) // order is irrelevant
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 2, stale: 0, missingKeys: [], removedKeyOutputs: 0 })
  })

  it('with no key list every output is stale and open to a removed key, and nothing is missing', async () => {
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [rec([PUB_A, PUB_B]), rec([PUB_A])] })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 2, stale: 2, missingKeys: [], removedKeyOutputs: 2 })
  })

  it('missingKeys follows meta order and lists each key once however many outputs lack it', async () => {
    await seedMeta([KEY_A, KEY_B, KEY_C])
    wallet.listOutputs.mockResolvedValueOnce({ outputs: [rec([PUB_A]), rec([PUB_A]), rec([PUB_B])] })
    expect(await getVaultKeyCoverage(wallet, ADMIN)).toEqual({ outputs: 3, stale: 3, missingKeys: [PUB_A, PUB_B, KEY_C.pubkey], removedKeyOutputs: 0 })
  })
})

describe('orphanedIfRemoved', () => {
  it('counts vault outputs that would lose every remaining key if the given pubkey were removed', async () => {
    await seedMeta([KEY_A, KEY_B])
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys: [PUB_A, PUB_B] }) },
        { outpoint: `${'ab'.repeat(32)}.1`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'ce'.repeat(32), keys: [PUB_A] }) }
      ]
    })
    expect(await orphanedIfRemoved(wallet, ADMIN, PUB_A)).toBe(1)

    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        { outpoint: `${'ab'.repeat(32)}.0`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys: [PUB_A, PUB_B] }) },
        { outpoint: `${'ab'.repeat(32)}.1`, satoshis: 1, customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'ce'.repeat(32), keys: [PUB_A] }) }
      ]
    })
    expect(await orphanedIfRemoved(wallet, ADMIN, PUB_B)).toBe(0)
  })
})

// ── balance ───────────────────────────────────────────────────────────────

describe('getVaultBalance', () => {
  it('sums decodable v4 outputs only — a v3 K1 record, a malformed one and a missing one are ignored', async () => {
    const v4 = (sats: number) => ({
      outpoint: `${'ab'.repeat(32)}.${sats}`,
      satoshis: sats,
      customInstructions: encodeVaultInstructions({ v: 4, type: 'R1C', salt: 'cd'.repeat(32), keys: [PUB_A, PUB_B] })
    })
    wallet.listOutputs.mockResolvedValueOnce({
      outputs: [
        v4(3000),
        v4(4500),
        { outpoint: 'v3.0', satoshis: 1000, customInstructions: JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/0' }) },
        { outpoint: 'bad.0', satoshis: 2000, customInstructions: 'not json' },
        { outpoint: 'none.0', satoshis: 700 }
      ]
    })
    expect(await getVaultBalance(wallet, ADMIN)).toBe(7500)
    // Without this flag listOutputs omits customInstructions and EVERYTHING
    // would read as undecodable — a zero balance over a full vault.
    const [listArgs] = wallet.listOutputs.mock.calls[0]
    expect(listArgs).toEqual({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 })
  })

  it('is zero for an empty basket', async () => {
    expect(await getVaultBalance(wallet, ADMIN)).toBe(0)
  })
})
```

- [ ] **Step 2: Run**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts` → Tasks 9–10's 61 still pass; the new suites fail with `(0 , _transfers.estimateRelockFee) is not a function`, `(0 , _transfers.relockVault) is not a function`, `(0 , _transfers.getVaultKeyCoverage) is not a function`, `(0 , _transfers.orphanedIfRemoved) is not a function`, and `getVaultBalance` returning `11200` (it still sums everything) with `listArgs` lacking `includeCustomInstructions`.

- [ ] **Step 3: Implement**

(a) Add `R1C_LOCK_LEN,` as the first name in the `./r1comb` import list.

(b) Replace `getVaultBalance` (the `// ── balance` block kept verbatim from the old file in Task 9) with:

```ts
// ── balance ─────────────────────────────────────────────────────────────

/**
 * Sum of the DECODABLE v4 outputs in the basket (spec §2.7). An output whose
 * record is missing or malformed cannot be spent by this code and is ignored
 * here, in selection, in coverage and in the zero-balance check for Disable —
 * so the number on the screen is what a YubiKey can actually open.
 * includeCustomInstructions is required: listOutputs omits the field unless
 * asked, and without it everything would read as undecodable.
 */
export async function getVaultBalance(w: VaultWallet, adminOriginator: string): Promise<number> {
  const res = await w.listOutputs({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 }, adminOriginator)
  return res.outputs.reduce(
    (sum, o) => sum + (decodeVaultInstructions(o.customInstructions) ? (o.satoshis ?? 0) : 0),
    0
  )
}
```

(c) Append at the END of the file (after `withdrawFromVault`):

```ts

// ── re-lock (spec §4.3) ──────────────────────────────────────────────────

/**
 * Fee reserve for a re-lock, in the toolbox's own arithmetic (100 sat/kB,
 * rounded up per kB) plus 10 %.
 *
 *   size = 10 + inputCount·(41 + 3 + R1C_UNLOCK_LEN) + (3 + lockLen + 8)
 *
 * — version/locktime/counts (10); per input the outpoint + sequence (41), a
 * 3-byte script-length prefix and the DECLARED unlock length; one output: an
 * 8-byte value, a 3-byte prefix and the new lock. The +10 % is computed in
 * integers (`ceil(kb·satPerKb·11 / 10)`): `11200 * 1.1` is
 * `12320.000000000002` in doubles, and a float ceil would over-charge by one.
 *
 * The re-lock output is `acc − this`; the toolbox's real fee is at most this
 * and the surplus becomes ordinary default-basket change (folded into the fee
 * when below dust). ≈ 2,900 sat per pass plus ≈ 260 sat per input.
 */
export function estimateRelockFee(inputCount: number, lockLen: number, satPerKb = 100): number {
  const size = 10 + inputCount * (41 + 3 + R1C_UNLOCK_LEN) + (3 + lockLen + 8)
  const kb = Math.ceil(size / 1000)
  return Math.ceil((kb * satPerKb * 11) / 10)
}

/**
 * Re-lock the vault with the chosen key (spec §4.3): a distinct spend mode,
 * NOT withdrawFromVault('all') — whose remainder is zero and would sweep the
 * vault into the hot wallet. Selects exactly as a withdrawal of 'all' does
 * (filter → sort → cap → commitment check), then creates ONE output of
 * `acc − estimateRelockFee(...)` committed to the CURRENT key set, and no
 * withdrawal output. This is how a key added later gains access to old
 * deposits and how a removed key loses it — on-chain the removed key can still
 * spend the outputs it was committed to, so the re-lock IS the revocation.
 *
 * The screen runs one pass per tap while `cappedInputs > 0`, and asks for
 * another key when only `unreachable` outputs remain.
 */
export async function relockVault(
  w: VaultWallet,
  adminOriginator: string,
  reason: string,
  chosenSerial: string,
  opts?: VaultTransferOptions
): Promise<VaultSpendResult> {
  requireReleased(opts, 'Re-locking the vault')
  await requireOnline(opts)
  const sel = await selectVaultInputs(w, adminOriginator, chosenSerial, 'all')
  if (sel.keys.length < VAULT_MIN_KEYS) {
    throw new VaultError('not-enough-keys', `A vault needs at least ${VAULT_MIN_KEYS} keys; ${sel.keys.length} enrolled`)
  }
  const fee = estimateRelockFee(sel.selected.length, R1C_LOCK_LEN(sel.keys.length))
  const relocked = sel.acc - fee
  if (relocked < VAULT_DEPOSIT_MIN) {
    throw new VaultError(
      'too-small-to-relock',
      `Re-locking ${sel.acc} satoshis would leave ${relocked} after fees, below the ${VAULT_DEPOSIT_MIN} floor`
    )
  }
  return spendVaultOutputs(
    w,
    adminOriginator,
    sel,
    reason,
    {
      outputs: [newVaultOutput(sel.keys, relocked, 'Vault re-lock')],
      labels: ['vault', 'vault-relock'],
      inputDescription: 'Vault re-lock'
    },
    opts
  )
}

// ── coverage (spec §3.4 badges) ──────────────────────────────────────────

/**
 * How the vault's outputs relate to the CURRENT key list, from each output's
 * v4 record (the informational key list — good enough for a badge; the
 * withdraw path checks the real lock). `stale` counts outputs whose set
 * differs in EITHER direction; `missingKeys` are the current pubkeys some
 * output lacks ("{{count}} deposits not yet open to {{nickname}}");
 * `removedKeyOutputs` are outputs a pubkey no longer in meta can still open
 * ("still open to a removed key"). Undecodable outputs are ignored, as
 * everywhere.
 */
export async function getVaultKeyCoverage(w: VaultWallet, adminOriginator: string): Promise<VaultKeyCoverage> {
  const meta = await vaultStore.getMeta()
  const current = meta?.keys.map(k => k.pubkey) ?? []
  const currentSet = new Set(current)
  const res = await w.listOutputs({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 }, adminOriginator)
  const records = res.outputs
    .map(o => decodeVaultInstructions(o.customInstructions))
    .filter((ci): ci is VaultInstructionsV4 => ci != null)

  let stale = 0
  let removedKeyOutputs = 0
  const missing = new Set<string>()
  for (const ci of records) {
    const set = new Set(ci.keys)
    const same = set.size === currentSet.size && current.every(pk => set.has(pk))
    if (!same) stale++
    for (const pk of current) if (!set.has(pk)) missing.add(pk)
    if (ci.keys.some(pk => !currentSet.has(pk))) removedKeyOutputs++
  }
  return {
    outputs: records.length,
    stale,
    missingKeys: current.filter(pk => missing.has(pk)), // meta order, each once
    removedKeyOutputs
  }
}

/**
 * How many vault outputs would lose every remaining committed key if `pubkey`
 * were removed (spec §3.4) — the exact predicate Remove must satisfy: an
 * output stays spendable after removal only if its baked key set (the
 * informational v4 record — good enough here, as in getVaultKeyCoverage; the
 * withdraw path checks the real lock) intersects the CURRENT key list minus
 * the one being removed. Reads the same listOutputs as getVaultKeyCoverage;
 * undecodable outputs are ignored, as everywhere.
 */
export async function orphanedIfRemoved(w: VaultWallet, adminOriginator: string, pubkey: string): Promise<number> {
  const meta = await vaultStore.getMeta()
  const remaining = new Set((meta?.keys.map(k => k.pubkey) ?? []).filter(pk => pk !== pubkey))
  const res = await w.listOutputs({ basket: VAULT_BASKET, includeCustomInstructions: true, limit: 1000 }, adminOriginator)
  const records = res.outputs
    .map(o => decodeVaultInstructions(o.customInstructions))
    .filter((ci): ci is VaultInstructionsV4 => ci != null)
  return records.filter(ci => !ci.keys.some(pk => remaining.has(pk))).length
}
```

- [ ] **Step 4: Verify**

`npx jest packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts` → all pass: 61 + `estimateRelockFee` 1 + `relockVault` 7 + `getVaultKeyCoverage` 4 + `orphanedIfRemoved` 1 + `getVaultBalance` 2 — **76 tests**.
`npx jest packages/expo-wallet-toolbox/__tests__/ui/useVaultBalance.test.ts` → still passes (it mocks `getVaultBalance`; the hook's signature is unchanged).
`npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v 'ui/screens/VaultTransferScreen.tsx\|ui/screens/VaultRecoverScreen.tsx\|ui/components/vault/EnrollWizard.tsx\|ui/screens/VaultScreen.tsx'` → empty.

- [ ] **Step 5: Commit**

```
git add packages/expo-wallet-toolbox/core/services/vault/transfers.ts packages/expo-wallet-toolbox/__tests__/vault/transfers.test.ts
git commit -m "feat(expo-wallet-toolbox): relockVault with current keys, estimateRelockFee, key coverage, v4-only vault balance" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Deletions, error-code cleanup, barrel, guard prose, CHANGELOG 0.5.0

**Execution order (binding, see the "## Execution order" section above):** P1 Tasks 1–6 → P2 Tasks 1–11 → **P1 Task 7** → **this task** → Plan 3. By the time this task starts, P1 Task 7 has already run: `core/index.ts:269` already reads `export * from './services/vault/r1comb'` and `k1.ts` / `__tests__/vault/k1.test.ts` / `scripts/k1-spend-proof.ts` are already gone. This task never runs before P1 Task 7.

**Files:**
- Delete: `T/core/services/vault/sealing.ts`, `vaultDerivation.ts`, `vaultPassphrase.ts`; `T/__tests__/vault/sealing.test.ts`, `vaultDerivation.test.ts`, `vaultPassphrase.test.ts`
- Modify: `T/core/services/vault/types.ts` (lines 1–22 header + `SealedBlob`; the `'seal-corrupt'` entry with its comment; the four-code "REMOVED IN TASK 12" block Task 1 left)
- Modify: `T/core/index.ts` lines 254–256 (comment) and 268, 270, 271 (three `export *` lines)
- Modify: `T/core/services/vault/guard.ts` lines 1–33 (header prose)
- Modify: `T/CHANGELOG.md` (new `## 0.5.0` section at the top), `T/package.json` line 3 (`"version": "0.5.0"`)
- NOT touched: `k1.ts`, `__tests__/vault/k1.test.ts`, `scripts/k1-spend-proof.ts` and `core/index.ts:269` — owned by Plan 1 Task 7 exclusively (its File Structure: "Delete (Task 7 only)" / "Modify (Task 7 only) core/index.ts:269"). Rule for the barrel: Plan 1 Task 7 owns the `k1` → `r1comb` line; this task owns removing the other three, only.

**Interfaces:**
- Produces: `VaultErrorCode` without `'seal-corrupt' | 'bad-passphrase' | 'bad-mnemonic' | 'bad-derivation-index' | 'backup-required'`; no `SealedBlob`; the `core` barrel without `sealing`/`vaultDerivation`/`vaultPassphrase`; package `0.5.0`.
- Allowed tsc residuals after this commit — the four Plan 3 `ui/` files named in the Global Constraints PLUS ONE MORE (flagged in the summary): `ui/components/vault/PassphraseField.tsx` imports `normalizeVaultPassphrase` through the package barrel, which this task removes. Plan 3 deletes that file (contract: "Deleted: … PassphraseField.tsx"). Nothing else outside those five files may error.

- [ ] **Step 1: Prove what still imports the seed-era modules**

```
cd /Users/personal/git/bsv-wallet
grep -rn --include='*.ts' --include='*.tsx' -E "vault/(sealing|vaultDerivation|vaultPassphrase)['\"]|from '\./(sealing|vaultDerivation|vaultPassphrase)'" packages app
```

Expected after Tasks 4, 6, 8, 9: exactly three hits in `packages/expo-wallet-toolbox/core/index.ts` (lines 268, 270, 271), one in `core/services/vault/vaultDerivation.ts:34` (importing `./vaultPassphrase` — it goes with it), and the three test files that are deleted below. Any OTHER hit means an earlier task left an import behind — fix that task's file first.

- [ ] **Step 2: Delete**

```
cd /Users/personal/git/bsv-wallet
git rm packages/expo-wallet-toolbox/core/services/vault/sealing.ts packages/expo-wallet-toolbox/core/services/vault/vaultDerivation.ts packages/expo-wallet-toolbox/core/services/vault/vaultPassphrase.ts
git rm packages/expo-wallet-toolbox/__tests__/vault/sealing.test.ts packages/expo-wallet-toolbox/__tests__/vault/vaultDerivation.test.ts packages/expo-wallet-toolbox/__tests__/vault/vaultPassphrase.test.ts
```

- [ ] **Step 3: `types.ts` — final shape**

Replace the whole file with (only the header, `SealedBlob` and the five codes change; `VaultError`, `NFC_LOST_PATTERN` and `vaultErrorFromNative` are byte-for-byte):

```ts
/**
 * Vault domain types — shared by the store, the ceremony controller, the
 * transfers and the UI. No React, no I/O.
 *
 * There is no sealed blob and no seed anywhere in this design (spec D2): the
 * enrolled YubiKeys are the keys, and each output's salt lives in the wallet
 * database's customInstructions.
 */

export type VaultErrorCode =
  | 'unsupported-platform'
  | 'no-key'
  | 'wrong-key'
  | 'pin-required'
  | 'pin-invalid'
  | 'pin-locked'
  | 'touch-timeout'
  | 'key-removed-mid-op'
  | 'mgmt-key-custom'
  | 'slot-occupied'
  /** A vault key digest, DER signature, pubkey or script failed a structural
   * check (r1comb.ts throws it for malformed SEC1 points, DER, or a lock that
   * is not an R1C lock). Distinct from 'wrong-key', which vaultErrorFromNative
   * may reclassify to 'nfc-lost'. */
  | 'template-invalid'
  | 'serial-mismatch'
  | 'user-cancelled'
  | 'not-enrolled'
  | 'driver-unavailable'
  | 'vault-empty'
  | 'amount-exceeds-balance'
  | 'below-dust'
  | 'no-transaction'
  | 'nfc-lost'
  /** More vault inputs would be needed than one transaction may safely carry.
   *  See VAULT_MAX_INPUTS — the remedy is a smaller withdrawal, which also
   *  consolidates the vault. */
  | 'too-many-inputs'
  /** The device is offline. Vault transfers never enter the offline queue — see
   *  VaultTransferOptions.isOnline. */
  | 'requires-online'
  // ── R1C (1-of-N comb vault) ──────────────────────────────────────────────
  /** `vaultEnabled` is off in this build (spec §0 / D15): no enrollment,
   *  deposit, re-vault or re-lock may create a vault output. */
  | 'not-released'
  /** Encrypted wallet backup push is switched off (D13): a deposit's salt lives
   *  only in the wallet DB, so no YubiKey could open it after a phone loss. */
  | 'backup-off'
  /** Fewer than VAULT_MIN_KEYS keys — defensive; the wizard cannot persist it. */
  | 'not-enough-keys'
  /** The tapped serial is already in meta.keys or in the wizard's pending list.
   *  The message carries the serial. */
  | 'key-already-enrolled'
  /** VAULT_MAX_KEYS keys already enrolled. */
  | 'too-many-keys'
  /** Removing this key would leave fewer than VAULT_MIN_KEYS. */
  | 'last-keys'
  /** Removing this key would orphan an output only it can open — re-lock first. */
  | 'relock-required'
  /** The chosen key is not among the commitments baked into an output's real
   *  lock (or no reachable output exists). The message names the outpoint. */
  | 'key-not-committed'
  /** The chosen key can open less than the requested amount while other keys
   *  could open more. */
  | 'key-cannot-cover'
  /** acc − feeEstimate < VAULT_DEPOSIT_MIN: nothing worth re-locking. */
  | 'too-small-to-relock'
  /** The signable transaction is not version 2 — refused before any signature. */
  | 'bad-version'

export class VaultError extends Error {
  code: VaultErrorCode
  /** PIN attempts remaining, present on pin-invalid. */
  retriesLeft?: number
  /** Structured context for the specific failure — e.g. serial-mismatch's
   *  { tapped, chosen } or key-cannot-cover's { reachable, total } (see the
   *  Interfaces note above for the full convention). Additive: most codes
   *  leave it undefined, and no existing call site needs to change. */
  details?: Record<string, string | number>

  constructor(code: VaultErrorCode, message?: string, retriesLeft?: number, details?: Record<string, string | number>) {
    super(message ?? code)
    this.name = 'VaultError'
    this.code = code
    this.retriesLeft = retriesLeft
    this.details = details
  }
}

/** Native YubiKit description substrings for a dropped NFC field mid-command
 * (the phone moved a hair off the key, or the key was lifted). This is
 * transient and retryable — never a wrong key, but older/currently-installed
 * builds' Swift `mapError` falls through to its `wrong-key` default for any
 * description it doesn't specifically recognize, which includes this one. */
const NFC_LOST_PATTERN = /tag response error|no response|tag connection lost|session invalidated/i

/** Parse a native-module rejection (`VAULT_ERR:<code>:<detail>`) into a
 * VaultError; anything unrecognized becomes a generic driver failure. */
export function vaultErrorFromNative(e: unknown): VaultError {
  const msg = e instanceof Error ? e.message : String(e)
  const m = /^VAULT_ERR:([a-z-]+):?(.*)$/.exec(msg)
  if (m) {
    let code = m[1] as VaultErrorCode
    const detailMatch = /retries=(\d+)/.exec(m[2])
    // Reclassify a native `wrong-key` whose detail is really an NFC dropout —
    // see NFC_LOST_PATTERN. Safe to keep even after the native side is fixed
    // to classify this correctly at the source: this simply never matches then.
    if (code === 'wrong-key' && NFC_LOST_PATTERN.test(m[2])) {
      code = 'nfc-lost'
    }
    return new VaultError(code, m[2] || undefined, detailMatch ? Number(detailMatch[1]) : undefined)
  }
  return new VaultError('driver-unavailable', msg)
}
```

`__tests__/vault/types.test.ts` (Task 1) needs no change: it exercises only the R1C codes.

- [ ] **Step 4: `core/index.ts`**

Replace lines 254–256 (`// Hardware vault: YubiKey PIV custody, ceremony state machine, K1 script,` … `// reclaim), persistence, passphrase policy, access guard, backup attestation.`) with:

```ts
// Hardware vault: YubiKey PIV custody (1-of-N P-256 comb vault, spec
// docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md), ceremony state
// machine, the r1comb template module, session helper, transfers
// (deposit / withdraw / re-lock / legacy staging reclaim), persistence (meta
// v5), access guard, backup attestation.
```

Delete line 268 (`export * from './services/vault/sealing'`), line 270 (`export * from './services/vault/vaultDerivation'`) and line 271 (`export * from './services/vault/vaultPassphrase'`). Leave line 269 alone: after Plan 1 Task 7 it reads `export * from './services/vault/r1comb'`. The block then reads:

```ts
export * from './services/vault/types'
export * from './services/vault/driver'
export * from './services/vault/session'
export * from './services/vault/random'
export * from './services/vault/r1comb'
export * from './services/vault/vaultStore'
export * from './services/vault/mockYubiKey'
export * from './services/vault/devMock'
export * from './services/vault/guard'
export * from './services/vault/backupAttestation'
export * from './services/vault/ceremony'
export * from './services/vault/ceremonyHost'
export * from './services/vault/VaultKeyService'
export * from './services/vault/transfers'
```

- [ ] **Step 5: `guard.ts` header**

Replace lines 1–33 (the whole leading docblock, through ` */`) with:

```ts
/**
 * Vault access guard (fixes the privilege-escalation review finding).
 *
 * PrivilegedKeyManager's key universe is the wallet's master HD root key — a
 * strictly more sensitive key than the per-app `primaryKey` (m/0'/0') that
 * every ordinary, non-privileged operation signs with. That is true whether
 * or not a vault is enrolled: the vault does not route through this manager
 * at all — vault inputs are signed ON the enrolled YubiKeys (P-256, PIV slot
 * 0x82; services/vault/ceremony.ts) and no vault key material exists in the
 * wallet's key hierarchy or anywhere else on the phone. The toolbox routes
 * every BRC-100 `privileged: true` op through PrivilegedKeyManager
 * regardless, and this app runs with `seekProtocolPermissionsForSigning` /
 * public-key-revelation permissions OFF, so nothing else gates them. That let
 * any web origin, via the CWI bridge, use `getPublicKey({ privileged: true,
 * ... })`, `createSignature`, `encrypt`/`decrypt`, or HMAC ops to reveal or
 * sign with the root key — none of which are spend actions, so none of them
 * ever trip the spending-authorization sheet.
 *
 * Blocking privileged ops for external originators is what closes that
 * exposure: it is the only thing standing between a web page and the root
 * key, now that the keyGetter itself no longer discriminates by enrollment
 * or caller. (It is not what keeps the YubiKey ceremony admin-only — that
 * follows separately, because nothing outside `services/vault` ever calls
 * `requestVaultSigner`/`ceremony.requestSigner` in the first place; a page
 * cannot reach the ceremony through this guarded surface even in principle,
 * privileged or not.)
 *
 * Privileged operations have never been used by external origins in this app
 * (the keyGetter has only ever returned the root key with no ceremony and no
 * web caller — first because there was no vault, now because the vault does
 * not route through it either), so denying them breaks nothing real.
 */
```

`npx jest packages/expo-wallet-toolbox/__tests__/vault/guard.test.ts` → unchanged, passes (prose only).

- [ ] **Step 6: CHANGELOG and version**

Insert at the top of `T/CHANGELOG.md`, directly under `# Changelog`:

```markdown
## 0.5.0

### 1-of-N YubiKey vault (breaking)

The vault is rebuilt around the P-256 comb verifier: each enrolled YubiKey
signs vault inputs on the card, and the K1 sealed-seed design is gone. Spec:
`docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md`.

Removed exports (`core` barrel):

- `sealing` (`sealVaultKey`, `unsealVaultKey`, `softwareEcdh`, `SEAL_INFO`),
  `vaultDerivation` (`deriveVaultSeed`, `deriveVaultHD`, `bip32KeyID`,
  `indexFromKeyID`, `depositPrivKey`, `depositPubKeyHash`,
  `randomDepositStartIndex`), `vaultPassphrase` (`checkVaultPassphrase`,
  `normalizeVaultPassphrase`), `k1` (`K1_LOCK_LEN`, `K1_UNLOCK_LEN`,
  `buildVaultLockingScript`, the v3 `VaultInstructions` codec).
- `SealedBlob`; the error codes `seal-corrupt`, `bad-passphrase`,
  `bad-mnemonic`, `bad-derivation-index`, `backup-required`.
- `VaultKeyHandle`, `CeremonyController.requestKey`, `requestVaultKey`;
  `CeremonyStoreView.getSeal`.
- `enrollVault`, `recoverVaultHD`, `resealToNewKey`, `PendingEnrollment`.
- `sweepVaultWithHD`; `VaultSpendResult.remainingInputs`; the `reason`
  parameter of `depositToVault`; `VaultDriver.ecdh`; `vaultStore.getSeal` /
  `setSeal` / `takeNextIndex`; meta v4 (`VaultMetaV4`).

New:

- `r1comb`: `buildLock`, `bakedCommitments`, `commitment`, `buildUnlock`,
  `verifyVaultInput`, `sighashPreimage`, `signerDigest`, `pushTxDerCheck`,
  `compressPubkey`, the v4 `VaultInstructions` codec, `R1C_LOCK_LEN`,
  `R1C_UNLOCK_LEN` (see the 0.5.0 Plan 1 entry for the on-chain format).
- `vaultStore` meta v5: `VaultKeyRecord`, `VaultMetaV5`, `addKey`,
  `removeKey`, `renameKey`, `noteLastUsed`, `migrateLegacySeal`;
  `isEnrolled()` is meta-only.
- `VaultKeyService`: `enrollKey`, `finalizeEnrollment(records)`,
  `addVaultKey`, `VAULT_MIN_KEYS`, `VAULT_MAX_KEYS`, `EnrollPhase`.
- Ceremony: `VaultSigner { serial, pubkey, sign(digest, progress?), release() }`,
  `CeremonyController.requestSigner(reason, chosenSerial)`,
  `requestVaultSigner`, `VAULT_INPUTS_PER_TAP`, `CeremonyState.progress`,
  `VaultProgress.signed/total`.
- Transfers: `depositToVault(w, adminOriginator, satoshis, opts?)` needs no
  hardware; `withdrawFromVault(w, adminOriginator, amount, reason,
  chosenSerial, opts?)`; `relockVault`; `estimateRelockFee`;
  `getVaultKeyCoverage`; `VaultSpendResult { txid, cappedInputs, unreachable }`;
  `VaultTransferOptions.vaultEnabled` / `backupEnabled`; error codes
  `not-released`, `backup-off`, `not-enough-keys`, `key-already-enrolled`,
  `too-many-keys`, `last-keys`, `relock-required`, `key-not-committed`,
  `key-cannot-cover`, `too-small-to-relock`, `bad-version`.
- `configureToolbox({ vaultEnabled })` and `isVaultEnabled()` — the release
  gate (default off).
- `withKeySession(driver, work, onWaiting?, { nfcMessage?, attachTimeoutMs? })`
  rejects on `session-failed`, `detached` and the attach timeout instead of
  waiting forever.
- Native: `startDiscovery(message)` sets the iOS NFC alert text from JS.

Behaviour changes:

- Vault outputs are version-2 spends of a ~28 KB lock committed to every
  enrolled key; deposits stay version 1. `VAULT_DEPOSIT_MIN` is 100,000 sat.
- A deposit is refused while backup push is off (`backup-off`) or the
  release flag is off (`not-released`). Withdrawing pre-existing outputs is
  never gated; creating a re-vault output or a re-lock is.
- Withdrawals name a key before the tap; only outputs committed to that key
  are spent, each checked against its real lock; the card signs one digest
  per input in batches of 16 per NFC tap, resuming after a dropped tap.
- `generateVaultKey` enrols with touch policy `cached` (was `always`) and
  always generates a fresh key (no adoption).
- A device holding v4 meta reads as not enrolled; the legacy SecureStore seal
  is deleted on `VaultProvider` mount. Sweep any dev device holding K1 vault
  funds BEFORE installing this version — the K1 sweep tooling is gone.
- Kept as legacy pending confirmation that nothing is stranded:
  `reclaimStagingOutputs`, `VAULT_STAGING_BASKET`,
  `StorageExpoSQLite.releaseVaultStagingStrandedByInvalidTx`.
  `VaultWallet.getPublicKey` and `createSignature` survive only for that
  reclaim.

```

In `T/package.json` change line 3 to `  "version": "0.5.0",`.

- [ ] **Step 7: Verify — the whole package**

```
cd /Users/personal/git/bsv-wallet
npx jest packages/expo-wallet-toolbox
```
→ every suite passes, including the untouched `__tests__/i18n/translationParity.test.ts`, `__tests__/vault/guard.test.ts`, `__tests__/vault/backupAttestation.test.ts`, `__tests__/vault/types.test.ts` and the `__tests__/ui/*` suites (none imports a deleted module by path — `PassphraseField.tsx` reaches `normalizeVaultPassphrase` through the barrel, which under Babel is simply `undefined` until Plan 3 deletes the file). Expected new vault totals: `ceremony` 52, `ceremonyHost` 5, `vaultKeyService` 22, `transfers` 76, `vaultStore` 16, `session` 7, `devMock` 4, `mockYubiKey` 26, `types` 4.

Type-check gate: confirm which tsconfig applies before running it — `ls packages/expo-wallet-toolbox/tsconfig*.json` → `packages/expo-wallet-toolbox/tsconfig.json` exists, so every `tsc` call in this plan targets it with `-p` (there is also a root `tsconfig.json`, but it is not used here; if the package tsconfig ever stopped existing, fall back to `-p tsconfig.json` from the repo root). The gate itself: the ONLY remaining errors after this task may be inside `packages/expo-wallet-toolbox/ui/**`.

```
cd /Users/personal/git/bsv-wallet
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep -v '^packages/expo-wallet-toolbox/ui/' | grep -c 'error TS'
```
→ `0`. Then confirm the residual set inside `ui/` didn't grow silently:
```
npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json 2>&1 | grep '^packages/expo-wallet-toolbox/ui/' | cut -d'(' -f1 | sort -u
```
→ exactly the five Plan 3 files: `ui/components/vault/EnrollWizard.tsx`, `ui/screens/VaultTransferScreen.tsx`, `ui/screens/VaultRecoverScreen.tsx`, `ui/screens/VaultScreen.tsx`, `ui/components/vault/PassphraseField.tsx`.

```
grep -rn --include='*.ts' --include='*.tsx' -E "vault/(sealing|vaultDerivation|vaultPassphrase|k1)['\"]|from '\./(sealing|vaultDerivation|vaultPassphrase|k1)'" packages app
grep -rn --include='*.ts' --include='*.tsx' -E "sweepVaultWithHD|requestVaultKey|VaultKeyHandle|SealedBlob|seal-corrupt|bad-passphrase|bad-mnemonic|bad-derivation-index|backup-required|getSeal|setSeal|takeNextIndex" packages/expo-wallet-toolbox/core packages/expo-wallet-toolbox/__tests__ packages/expo-wallet-toolbox/ui app
```
→ the first grep prints nothing. The second prints ONLY Plan 3's residuals — `ui/components/vault/EnrollWizard.tsx` (`bad-mnemonic`), `ui/screens/VaultRecoverScreen.tsx` (`bad-mnemonic`, `sweepVaultWithHD`), `ui/screens/VaultTransferScreen.tsx` (`backup-required`), `core/context/VaultContext.tsx` if Plan 3 has not yet rewritten its comment (Task 3 already replaced the `VaultKeyHandle` sentence there, so normally no hit) — and one prose line outside the vault, `core/services/secrets/types.ts:16` ("Mirrors the vault's SealedBlob conventions"), which this plan leaves alone (not in the File Structure; a comment, not code).

`ls packages/expo-wallet-toolbox/core/services/vault/` → `VaultKeyService.ts backupAttestation.ts ceremony.ts ceremonyHost.ts devMock.ts driver.ts guard.ts mockYubiKey.ts r1comb.ts random.ts session.ts transfers.ts types.ts vaultStore.ts` — fourteen files, no `k1.ts`, no seed-era module.

- [ ] **Step 8: Commit**

```
cd /Users/personal/git/bsv-wallet
git add -A packages/expo-wallet-toolbox/core/services/vault packages/expo-wallet-toolbox/__tests__/vault packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/CHANGELOG.md packages/expo-wallet-toolbox/package.json
git commit -m "feat(expo-wallet-toolbox)!: remove the K1 sealed-seed vault (sealing, derivation, passphrase); 0.5.0" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(`git add -A` on those two directories stages the `git rm` deletions and the `types.ts`/`guard.ts` edits together; nothing else in the tree is touched by this task.)

---

### Task 13: Vault salts survive backup and database import (spec §7 "Restore")

**Files:**
- Test: create `T/__tests__/vault/restoreSalt.test.ts`
- No source changes. `encodeVaultInstructions`/`decodeVaultInstructions` (Plan 1, `r1comb.ts`), `encodeChunk`/`decodeChunk`/`emptyChunk` (`core/backup/codec.ts`), `deriveBackupWallet` (`core/backup/derive.ts`), `createTables` (`core/storage/schema/createTables.ts`) and `StorageExpoSQLite` are all already exported for this test to import directly by relative path (this task does not touch the package barrel).

**Interfaces:**
- Consumes: `encodeVaultInstructions`, `decodeVaultInstructions`, `type VaultInstructionsV4` (Plan 1, `./r1comb`); `encodeChunk`, `decodeChunk`, `emptyChunk` (`../../core/backup/codec`); `deriveBackupWallet` (`../../core/backup/derive`); `createTables` (`../../core/storage/schema/createTables`); `StorageExpoSQLite` (`../../core/storage/StorageExpoSQLite`).
- Produces: nothing new — a regression test pinning spec §7 Restore's jest-testable half: a vault deposit's salt and key list live ONLY in an output's `customInstructions` (spec §3.5), so restore correctness reduces to two independent claims — (1) the encrypted backup chunk codec round-trips that string byte-for-byte, and (2) a database import (a whole-file restore) preserves it in the `outputs` table.
- **What this task does NOT cover.** `ui/importDatabases.ts` / `ui/exportDatabases.ts` call native expo-sqlite APIs (`serializeAsync`, `deserializeDatabaseAsync`, `backupDatabaseAsync`) that jest cannot load (`__tests__/__mocks__/expo-sqlite.js` throws on any call, per its own comment) — those two files have no jest-testable path at all, so this task exercises the underlying file-copy invariant they both rely on instead of calling them directly. The end-to-end check — back up a real vault, wipe the device, restore from the real backup (or import a real exported `.db` file) on hardware, and SPEND from the recovered output with an enrolled YubiKey — needs a physical YubiKey and a second device; it is a §0 manual checklist item, not a jest task.

- [ ] **Step 1: Write the test file**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/vault/restoreSalt.test.ts`:

```ts
/**
 * Vault salts across backup and database import (spec §7 "Restore").
 *
 * A vault deposit's salt and key list live in exactly one place: the output's
 * customInstructions (spec §3.5) — nothing else on the phone can reconstruct
 * them. Restore correctness therefore reduces to two independent claims:
 *
 *  1. The encrypted backup chunk codec (encodeChunk/decodeChunk,
 *     core/backup/codec.ts) round-trips that string byte-for-byte.
 *  2. A database import — a whole-file restore, see ui/importDatabases.ts —
 *     preserves it in the outputs table.
 *
 * ui/importDatabases.ts and ui/exportDatabases.ts themselves call native
 * expo-sqlite APIs (serializeAsync, deserializeDatabaseAsync,
 * backupDatabaseAsync) that jest cannot load — __tests__/__mocks__/expo-sqlite.js
 * throws on every call by design — so there is no jest-testable path through
 * those two files directly. The second test below exercises the invariant
 * they both depend on: a raw copy of the SQLite file, reopened as a brand-new
 * StorageExpoSQLite instance, must return the same customInstructions.
 *
 * NOT covered here, by design: the end-to-end device check — back up a real
 * vault, wipe the device, restore from the real backup (or import a real
 * exported .db file) on hardware, and SPEND from the recovered output with an
 * enrolled YubiKey. That needs a physical YubiKey and a second device; it is
 * a spec §0 manual checklist item, not a jest task.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PrivateKey } from '@bsv/sdk'
import type { SyncChunk } from '@bsv/wallet-toolbox-mobile/out/src/sdk/WalletStorage.interfaces'
import { decodeChunk, emptyChunk, encodeChunk } from '../../core/backup/codec'
import { deriveBackupWallet } from '../../core/backup/derive'
import { createTables } from '../../core/storage/schema/createTables'
import { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { decodeVaultInstructions, encodeVaultInstructions, type VaultInstructionsV4 } from '../../core/services/vault/r1comb'

const KEY = new PrivateKey(7).toArray('be', 32)
const NOW = '2026-09-10T00:00:00.000Z'

const VAULT: VaultInstructionsV4 = {
  v: 4,
  type: 'R1C',
  salt: 'ab'.repeat(32),
  keys: ['02' + 'c'.repeat(64), '02' + 'd'.repeat(64)]
}

/** expo-sqlite's async surface over node:sqlite's sync one — the same adapter
 * __tests__/storage/walletBalanceSql.test.ts uses to run StorageExpoSQLite
 * against the real engine under jest (no reusable helper exists to import). */
function adapt(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql)
    },
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    getFirstAsync: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...(params as never[])) ?? null,
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[]))
  }
}

describe('vault salts survive backup encode/decode', () => {
  it('decodeVaultInstructions(customInstructions) deep-equals the original after an encrypted round trip', async () => {
    const w = deriveBackupWallet(KEY, 'main')
    const base = emptyChunk('from', 'to', 'user') as unknown as Record<string, unknown>
    base.outputs = [
      {
        outputId: 1,
        userId: 1,
        transactionId: 1,
        spendable: true,
        change: false,
        vout: 0,
        satoshis: 500_000,
        providedBy: 'you',
        customInstructions: encodeVaultInstructions(VAULT)
      }
    ]
    const chunk = base as unknown as SyncChunk

    const decoded = await decodeChunk(w, await encodeChunk(w, chunk, 'main'), 'main')

    expect(decodeVaultInstructions(decoded.outputs?.[0].customInstructions)).toEqual(VAULT)
  })
})

describe('vault salts survive a database file copy and reopen (import)', () => {
  let dir = ''

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('findOutputs on a FRESH StorageExpoSQLite over a COPY of the file returns the same customInstructions', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'vault-restore-'))
    const sourcePath = path.join(dir, 'wallet.db')

    // ── write one vault output, then close the source (flushes to disk) ──
    let raw = new DatabaseSync(sourcePath)
    let db = adapt(raw)
    await createTables(db as never)

    await db.runAsync('INSERT INTO users (created_at, updated_at, identityKey) VALUES (?, ?, ?)', [
      NOW,
      NOW,
      '02' + 'a'.repeat(62)
    ])
    await db.runAsync(
      `INSERT INTO transactions (created_at, updated_at, userId, status, reference, isOutgoing, satoshis, txid)
       VALUES (?, ?, ?, 'completed', ?, 0, ?, ?)`,
      [NOW, NOW, 1, 'ref-1', 500_000, 'a'.repeat(64)]
    )
    await db.runAsync(
      `INSERT INTO outputs (created_at, updated_at, userId, transactionId, spendable, change,
         vout, satoshis, providedBy, txid, lockingScript, customInstructions)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, 'you', ?, ?, ?)`,
      [NOW, NOW, 1, 1, 0, 500_000, 'b'.repeat(64), new Uint8Array(25), encodeVaultInstructions(VAULT)]
    )
    raw.close()

    // ── "import": copy the whole file, open the COPY as a NEW instance ──
    const importedPath = path.join(dir, 'wallet-imported.db')
    copyFileSync(sourcePath, importedPath)
    raw = new DatabaseSync(importedPath)
    db = adapt(raw)
    const storage = new StorageExpoSQLite({ chain: 'test' } as never)
    ;(storage as unknown as { db: unknown }).db = db

    const results = await storage.findOutputs({ partial: { userId: 1 } } as never)
    expect(results).toHaveLength(1)
    expect(decodeVaultInstructions(results[0].customInstructions)).toEqual(VAULT)

    raw.close()
  })
})
```

- [ ] **Step 2: Run**

```
npx jest packages/expo-wallet-toolbox/__tests__/vault/restoreSalt.test.ts
```
→ `2 passed`. Neither test needs a source change: both exercise existing exports directly (`encodeChunk`/`decodeChunk`/`emptyChunk`, `deriveBackupWallet`, `createTables`, `StorageExpoSQLite`, `encodeVaultInstructions`/`decodeVaultInstructions`), so there is no red step here — this task pins an invariant that already holds, the way `__tests__/backup/codec.test.ts` pins the binary-field round trip.

- [ ] **Step 3: Commit**

```
git add packages/expo-wallet-toolbox/__tests__/vault/restoreSalt.test.ts
git commit -m "test(expo-wallet-toolbox): pin vault salts surviving backup encode/decode and a database file copy" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec §3–§6 → task map (this plan).**

| Spec item | Where |
|---|---|
| §3.1 fresh key, `'cached'/'once'`, compressed pubkey recorded | Task 4 (adapter), Task 8 (`enrollKey` → `compressPubkey`); `compressPubkey` itself is Plan 1 |
| §3.2 meta v5, `isEnrolled` meta-only, `migrateLegacySeal` on mount, `getSeal` gone from the ceremony view | Task 3; Tasks 6–7 |
| §3.3 step 2 (duplicate refusal before the slot is touched, `pin-locked`, PIN before tap, `generateVaultKey`, compress → pending record) and the rejecting `withKeySession` | Task 8; Task 4. Steps 1, 3–6 (copy, sub-states, leave-confirm, PUK copy) are Plan 3 |
| §3.4 add / remove / rename / lastUsed persistence; `addVaultKey`; coverage badges data; re-lock; disable; per-key orphan check for removal | Task 3 (`addKey`/`removeKey`/`renameKey`/`noteLastUsed`), Task 8 (`addVaultKey`, `disableVault`), Task 11 (`getVaultKeyCoverage`, `relockVault`, `orphanedIfRemoved`) |
| §3.5 recovery = any key + wallet DB; Export wallet data row | Design outcome of Tasks 3/9 (salts in customInstructions, nothing else); the row and `useExportWalletData` are Plan 3 |
| §4.1 deposit gates (`not-released`, `backup-off`, `not-enough-keys`, `below-dust`, online), salt + commitments + one createAction with the labels/options | Task 9. Steps 2 (first-deposit confirm) and 5 (`ensureWalletExists`) are Plan 3 |
| §4.2 step 1 chooser | Plan 3 (`KeyChooser`); the service takes `chosenSerial` (Task 10) |
| §4.2 steps 2–3 list → decode → filter → sort → cap → BEEF commitment check → `key-not-committed` / `key-cannot-cover` / `too-many-inputs` / `amount-exceeds-balance` | Task 10 (`selectVaultInputs`) |
| §4.2 step 4 remainder rule | Task 10 (fold below `VAULT_DEPOSIT_MIN`; re-vault to current keys with a fresh salt); the confirm copy is Plan 3 |
| §4.2 step 5 `version: 2`, `unlockingScriptLength`, `inputBEEF`, `trustSelf`, version assertion (`bad-version`), `pushTxDerCheck` re-create with `sequenceNumber` bumped (bound 8) | Task 10 (`createSignableVaultTx`) |
| §4.2 step 6 chosen-serial check, `verifyPin`, batches of `VAULT_INPUTS_PER_TAP`, per-tap alert text, resume at input k after a dropped tap, cancel/non-retryable aborts | Tasks 6–7 (ceremony/host), Task 5 (alert text plumbing), Task 10 (abort). Alert text = `reason` (decision flagged) |
| §4.2 step 7 DER → `fullR` → 71-push unlock → strict local `Spend` → `signAction` delayed | Task 10 (`buildUnlock`/`verifyVaultInput` are Plan 1) |
| §4.2 step 8 `VaultSpendResult { txid, cappedInputs, unreachable }`, `VaultProgress.signed/total`, pinned `CeremonyState` keys extended | Task 10; Task 6. The two post-transfer alerts are Plan 3 |
| §4.3 re-lock as its own spend mode, one output `acc − fee`, `estimateRelockFee`, `too-small-to-relock`, "one pass per tap while `cappedInputs > 0`" | Task 11 (the pass loop is the screen's — Plan 3) |
| §4.4 new codes / removed codes | Task 1 / Task 12. `vaultErrorCopy` is Plan 3 |
| §5.1 `r1comb.ts`, `scripts/r1c-spend-proof.ts` | Plan 1 |
| §5.2 `types`, `vaultStore`, `VaultKeyService`, `session`, `ceremony`/`ceremonyHost`, `driver`, `mockYubiKey`/`devMock`, `transfers`, `toolboxConfig`, `core` barrel, 0.5.0 changelog | Tasks 1/12, 3, 8, 4, 6/7, 4/5, 4, 9–11, 2, 12, 12 |
| §5.2 `WalletHomeScreen` / `SettingsScreen` gate, `ui` barrel | Plan 3 |
| §5.3 delete `sealing`/`vaultDerivation`/`vaultPassphrase` (+ tests), the `backup-required` gate, `guard.ts` prose, Swift/Kotlin `ALWAYS` prose | Task 12, Task 9, Task 12, Task 5. `k1.ts`/`k1.test.ts`/`scripts/k1-spend-proof.ts` are Plan 1 Task 7; the `ui/` deletions, `app/vault-recover.tsx`, `EnrollWizard`'s attestation imports and `WalletContext.tsx`'s vault comments are Plan 3 |
| §5.4 UI | Plan 3 |
| §5.5 `vaultEnabled` gates deposit / re-vault / re-lock; never a plain withdrawal | Task 2 (flag), Tasks 9–11 (`requireReleased`). Home button, Settings row, route hero, `app/_layout.tsx`, `eas.json` are Plan 3 |
| §6 no key material on the phone (signer, not handle); D13 refusal; residual (1) flag + D4b; (2) sequence bump; (3) local validation | Task 6; Task 9; Tasks 2 + 10; Task 10; Task 10. Residual (4) listOutputs cap stays deferred; D5 malleability is accepted with no code |
| §7 codec/store, enrollment-with-mock, transfers-with-mock, batch resume; salts surviving backup encode/decode and a database file copy | Tasks 3, 8, 9–11, 6, 13. Goldens/round trips/negatives are Plan 1; the end-to-end device restore-then-spend (real backup or real exported `.db`, on hardware, followed by a spend) is a §0 manual checklist item, not a jest task — flagged |

**Contract conformance.** Every name and signature in the Interface Contract for Plan 2 is produced verbatim by Tasks 1–12; nothing is renamed or re-typed. Additive only: `withKeySession`'s 4th `opts` parameter (Task 4), `enrollKey.nfcMessage?` (Task 8), `CeremonyController`'s `requireChosenSerial`/`noteSigning` private helpers (Task 6), transfers' private `selectVaultInputs`/`createSignableVaultTx`/`spendVaultOutputs`/`newVaultOutput`/`requireReleased`/`requireKeys` (Tasks 9–11), and `VaultWallet.getPublicKey` KEPT (Task 9 — needed by the legacy reclaim the contract itself keeps).

**Open items the orchestrator must settle (none resolved here by renaming):**

1. `VaultWallet.getPublicKey` is kept (contract says removed) because `reclaimStagingOutputs` needs it (`transfers.ts:715` today). Either amend the contract or delete the reclaim.
2. The iOS NFC alert text per tap has no contract seam; Task 6 passes the caller's `reason` to `driver.start(...)`. Plan 3's `reason` strings must read well on the system sheet, or a `nfcMessage` seam must be added to `requestSigner`.
3. `enrollKey.nfcMessage?` is additive to the contract (Task 8), for the same reason.
4. A concurrent `requestSigner` naming a different serial is refused with `serial-mismatch` (Task 6) — the contract is silent.
5. Detach vs. dropped tap: a driver-EMITTED `detached` while a signer is live relocks; only `signEcdsa` REJECTIONS resume (Task 6). Whether an iOS field drop produces the event, the rejection, or both is a §0 device-run question for the native adapter.
6. After Task 12 a FIFTH `ui/` file has tsc errors: `ui/components/vault/PassphraseField.tsx` (`normalizeVaultPassphrase` via the barrel). Plan 3 deletes it; the Global Constraints list only four files.
7. RESOLVED: Task 11 now exports `orphanedIfRemoved(w, adminOriginator, pubkey)`, an additive follow-up helper the contract itself doesn't name — the `relock-required` refusal on key removal (spec §3.4) is computed from it directly rather than approximated from `VaultKeyCoverage`. Plan 3's remove handler (Task 8) calls it.
8. Re-lock labels `['vault', 'vault-relock']` and `inputDescription: 'Vault re-lock'` are this plan's choice (Task 11); the spec names none.
9. `core/services/secrets/types.ts:16` still says "Mirrors the vault's SealedBlob conventions" (prose, outside this plan's files).
10. §7's jest-testable half — a backup chunk round trip and a database-file-copy round trip preserving an output's customInstructions — is covered by Task 13. The end-to-end half (restore a real backup, or import a real exported `.db`, on a physical device, then SPEND from the recovered vault with an enrolled YubiKey) is still not in any plan's task list — it needs hardware and is flagged as a §0 manual checklist item.

