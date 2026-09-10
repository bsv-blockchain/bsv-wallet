# R1C Vault Template Module (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the pure, fully tested `r1comb.ts` template module (lock/unlock/preimage/codec for the 1-of-N P-256 comb-verifier vault) plus the software-key spend-proof CLI, and retire the K1 module it replaces.

**Architecture:** `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` is a dependency-free (only `@bsv/sdk` + `@noble/curves`) port of the spike generators `docs/example-txs/spike/gen.mjs`, `gen2.mjs`, `unlock.mjs`, `unlock2.mjs`: a mini-assembler emits a ~28 KB locking script whose G-table/comb-loop/tail region is byte-identical to the mined testnet fixture, and a 71-push unlocking script carries the signer's Q comb table, salt, signature scalars and the whole 158-byte sighash preimage. `scripts/r1c-spend-proof.ts` drives the same module against a real network through ARC. Plan 2 (services) and Plan 3 (UI) consume only the names in the Interface Contract below.

**Tech Stack:** TypeScript (strict), `@bsv/sdk` 2.4.1 (`Script`, `Spend`, `TransactionSignature`, `Hash`, `Utils`, `ARC`), `@noble/curves` 2.3.0 (`p256` from `@noble/curves/nist.js`), Jest 29 via `jest-expo`, `tsx` for the CLI.

**Spec:** `/Users/personal/git/bsv-wallet/docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md` (§0, §2, §5.1, §7). Interface contract copied verbatim below from `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad/plan-contract.md`.

**Evidence base (read before starting, in this order):** `docs/example-txs/spike/ANALYSIS.md` §2–§9 (algorithm, region map, sizes, digest convention); `docs/example-txs/spike/gen.mjs` (asm, encNum/scriptNum, combTable, DOUBLE/MADD, shiftFor, emitAdd, emitCombLoop, emitTail); `gen2.mjs` (emitHeader2, le33, canonicalTableBytes, commitmentFor, buildLock2, bakedCommitments, emitSharedSuffix); `unlock2.mjs` (encodeUnlock2, buildUnlock2FromSigner); `unlock.mjs` (sighashPreimage, signerDigest, pushTxDerCheck, peelLoopNonMinimalAt, fullR).

---

## Interface Contract

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

---

## Global Constraints

- Curve P-256: `p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff`, `n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551`, `a = p − 3`; secp256k1 (OP_PUSH_TX leg only): `n_k1 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141`, `Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798`.
- Comb geometry: 6 rows × 43 columns; `TABLE_SIZE = 32`; recode constant `2^258 − 1`; `T_j = 2^215 + Σ_{k<5} (bit_k(j) ? +1 : −1)·2^(43k)`; `shiftFor(c, k) = 257 − c − 43k`.
- Sizes (exact, asserted): lock 27,855 B (N = 1), 27,831 + 25N B (N = 2..5) → 27,881 / 27,906 / 27,931 / 27,956; chunk counts 23,310 (N = 1), 23,306 + 5N (N ≥ 2); shared suffix (G table → end) 27,160 B; canonical table 2,112 B; preimage 158 B; `R1C_UNLOCK_LEN = 2560` (hard max 2,539); `COORD_WIDTH = 33`; `SALT_BYTES = 32`; `R1C_MAX_KEYS = 5`.
- `VAULT_DEPOSIT_MIN = 100_000` sat (Plan 2 constant; the spend-proof script uses 5,000-sat token outputs because it proves acceptance, not the deposit floor).
- Withdrawals are **version-2** transactions; `buildUnlock` refuses a preimage whose version field is not 2 (Plan 1 error code `'template-invalid'`; Plan 2 adds `'bad-version'` at the transfers layer).
- Sighash `0x41` (ALL | FORKID) only; subscript `ac`.
- Strict verification flags (contract): `['MINIMALDATA', 'UTXO_AFTER_CHRONICLE', 'SIGHASH_FORKID', 'STRICTENC']` — exact `@bsv/sdk` 2.4.1 flag strings (`Spend.js` `hasFlag`).
- Twelve locales: **not touched by Plan 1** (no UI, no i18n).
- Jest: run from the REPO root, e.g. `npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` (root `package.json` `jest` config, `jest-expo` preset).
- TypeScript strict (`packages/expo-wallet-toolbox/tsconfig.json` extends `expo/tsconfig.base`, `strict: true`, target ESNext → `bigint` literals allowed). Typecheck: `npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json` from the repo root.
- No `process.env` anywhere inside `packages/expo-wallet-toolbox` (0.4.0 host-config seam). `scripts/r1c-spend-proof.ts` lives at the repo root and takes everything from argv.
- Do not modify `docs/example-txs/**` (fixtures are already tracked: `51c5…579a_0.hex` = 29,584-byte lock, `4766…4b80.hex` = 231-byte fixture spend).
- Commit after every task with a conventional-commit message whose LAST line is exactly: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Existing conventions to follow: `VaultError(code, message)` from `core/services/vault/types.ts` with code `'template-invalid'`; tests import modules by relative path (`../../core/services/vault/…`) as `__tests__/vault/k1.test.ts` does; no lazy `require` is needed here because the module has no React/expo dependencies.

## Execution order

Binding sequencing across all three plans: **P1 Tasks 1–6 → P2 Tasks 1–11 → P1 Task 7 → P2 Task 12 → Plan 3.** P1 Tasks 1–6 ship the pure `r1comb.ts` module Plan 2 imports from. P2 Tasks 1–11 (prerequisite: Plan 1 merged, i.e. Tasks 1–6) build every service on top of it while `core/services/vault/k1.ts` and `core/index.ts:269`'s `k1` export still exist — nothing in this plan or Plan 2 Tasks 1–11 deletes them. Only once ALL of P2 Tasks 1–11 have landed does **P1 Task 7** run: it deletes `k1.ts`, `k1.test.ts`, `scripts/k1-spend-proof.ts` and flips `core/index.ts:269` from `export * from './services/vault/k1'` to `export * from './services/vault/r1comb'`. **P2 Task 12** runs directly after that — it deletes `sealing.ts`/`vaultDerivation.ts`/`vaultPassphrase.ts` and their exports/tests, and must not touch the `k1` line or the k1 files (Plan 1 Task 7 owns them exclusively — see that task's preamble and this plan's Task 12 preamble). Plan 3 starts only after P2 Task 12 lands.

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` | Pure template module: constants, script-number encoders, `asm`, comb tables, commitments, `buildLock`/`bakedCommitments`, preimage/digest/`pushTxDerCheck`/DER, `fullR`/`buildUnlock`/`verifyVaultInput`, v4 codec. |
| Create | `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` | Goldens against the fixture, round trips through `Spend`, negatives, codec fail-closed. Grown task by task. |
| Create | `scripts/r1c-spend-proof.ts` | §0 spend proof with software P-256 keys through ARC: deposit → per-key spends → 3-input → mixed P2PKH+vault → constructed `pushTxDerCheck`-failing v2 spend. |
| Modify (Task 7 only) | `packages/expo-wallet-toolbox/core/index.ts:269` | `export * from './services/vault/k1'` → `export * from './services/vault/r1comb'`. |
| Delete (Task 7 only) | `packages/expo-wallet-toolbox/core/services/vault/k1.ts` | Replaced by `r1comb.ts`. |
| Delete (Task 7 only) | `packages/expo-wallet-toolbox/__tests__/vault/k1.test.ts` | Tests of the deleted module. |
| Delete (Task 7 only) | `scripts/k1-spend-proof.ts` | Replaced by `scripts/r1c-spend-proof.ts`. |
| Read only | `docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex`, `docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex` | Golden fixtures (testnet lock + its spend). |

Additive exports beyond the contract (allowed as "private helpers", exported so the tests can pin them): `P256_P`, `P256_N`, `SECP_N`, `SECP_GX`, `RECODE_CONST`, `R1C_PREIMAGE_LEN`, `R1C_SIGHASH`, `R1C_VERIFY_FLAGS`, `pushData`, `scriptNum`, `encNum`, `asm`, `combTableScalar`, `gTable`, `le33`, `recode`, `shiftFor`, `sharedSuffix`, `pushTxSignatureS`, `peelLoopNonMinimalAt`. Nothing in the contract is renamed or re-typed.

---

### Task 1: Scaffold `r1comb.ts` — constants, script-number encoders, `asm`

**Files:**
- Create: `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts`

**Interfaces:**
- Consumes: `VaultError` from `core/services/vault/types.ts` (`constructor(code: VaultErrorCode, message?: string, retriesLeft?: number)`, `code: 'template-invalid'`); `OP`, `Utils` from `@bsv/sdk`; `p256` from `@noble/curves/nist.js`.
- Produces: `COMB_ROWS`, `COMB_COLS`, `TABLE_SIZE`, `COORD_WIDTH`, `SALT_BYTES`, `R1C_UNLOCK_LEN`, `R1C_MAX_KEYS`, `R1C_LOCK_LEN(n: number): number`, `R1C_PREIMAGE_LEN`, `R1C_SIGHASH`, `P256_P: bigint`, `P256_N: bigint`, `SECP_N: bigint`, `SECP_GX: bigint`, `RECODE_CONST: bigint`, `pushData(data: number[]): number[]`, `scriptNum(v: bigint): number[]`, `encNum(v: bigint | number): number[]`, `asm(text: string, params?: Record<string, bigint | number | number[]>): number[]`.

- [ ] **Step 1.1: Write the failing test file**

Create `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts`:

```ts
/**
 * R1C template module tests — the cryptographic arbiter for the vault script.
 *
 * Goldens come from the mined testnet fixture (docs/example-txs/51c5…579a_0.hex
 * + its spend 4766…4b80.hex) and from the spike generators that reproduce it
 * byte-for-byte (docs/example-txs/spike/gen.mjs, gen2.mjs). Round trips run the
 * real @bsv/sdk Spend interpreter with explicit strict flags.
 */
import fs from 'fs'
import path from 'path'
import { BigNumber, Curve, Utils } from '@bsv/sdk'
import {
  COMB_COLS, COMB_ROWS, COORD_WIDTH, SALT_BYTES, TABLE_SIZE, R1C_LOCK_LEN, R1C_MAX_KEYS, R1C_UNLOCK_LEN,
  P256_N, P256_P, SECP_GX, SECP_N, RECODE_CONST,
  asm, encNum, pushData, scriptNum
} from '../../core/services/vault/r1comb'
import { VaultError } from '../../core/services/vault/types'

jest.setTimeout(180_000)

const REPO = path.resolve(__dirname, '../../../../')
export const FIXTURE_LOCK_HEX = fs
  .readFileSync(path.join(REPO, 'docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex'), 'utf8')
  .trim()
export const FIXTURE_TX_HEX = fs
  .readFileSync(path.join(REPO, 'docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex'), 'utf8')
  .trim()

const hex = (a: number[]): string => Utils.toHex(a)

describe('r1comb constants', () => {
  it('pins the comb geometry and size constants from spec §2', () => {
    expect(COMB_ROWS).toBe(6)
    expect(COMB_COLS).toBe(43)
    expect(TABLE_SIZE).toBe(32)
    expect(COORD_WIDTH).toBe(33)
    expect(SALT_BYTES).toBe(32)
    expect(R1C_UNLOCK_LEN).toBe(2560)
    expect(R1C_MAX_KEYS).toBe(5)
    expect(RECODE_CONST).toBe((1n << 258n) - 1n)
  })

  it('R1C_LOCK_LEN is 27855 for N=1 and 27831 + 25N for N=2..5, throws otherwise', () => {
    expect(R1C_LOCK_LEN(1)).toBe(27855)
    expect(R1C_LOCK_LEN(2)).toBe(27881)
    expect(R1C_LOCK_LEN(3)).toBe(27906)
    expect(R1C_LOCK_LEN(4)).toBe(27931)
    expect(R1C_LOCK_LEN(5)).toBe(27956)
    for (const bad of [0, 6, -1, 1.5, NaN]) {
      expect(() => R1C_LOCK_LEN(bad)).toThrow(VaultError)
      try { R1C_LOCK_LEN(bad) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
    }
  })

  it('curve constants match ANALYSIS.md §2 and the SDK secp256k1 curve', () => {
    expect(P256_P.toString(16)).toBe('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff')
    expect(P256_N.toString(16)).toBe('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
    const secp = new Curve()
    expect(SECP_N.toString(16)).toBe(secp.n.toHex())
    expect(SECP_GX.toString(16)).toBe((secp.g.x as BigNumber).toHex())
  })
})

describe('script-number encoding', () => {
  // (value, scriptNum hex, encNum hex) — from gen.mjs run against the SDK's BigNumber.toSm('little')
  const vectors: Array<[bigint, string, string]> = [
    [0n, '', '00'],
    [1n, '01', '51'],
    [16n, '10', '60'],
    [17n, '11', '0111'],
    [127n, '7f', '017f'],
    [128n, '8000', '028000'],
    [255n, 'ff00', '02ff00'],
    [256n, '0001', '020001'],
    [-1n, '81', '4f'],
    [-127n, 'ff', '01ff'],
    [-128n, '8080', '028080'],
    [32767n, 'ff7f', '02ff7f'],
    [32768n, '008000', '03008000'],
    [(1n << 247n) - 1n, 'ff'.repeat(30) + '7f', '1f' + 'ff'.repeat(30) + '7f'],
    [1n << 247n, '00'.repeat(30) + '8000', '20' + '00'.repeat(30) + '8000'],
    [(1n << 255n) - 1n, 'ff'.repeat(31) + '7f', '20' + 'ff'.repeat(31) + '7f'],
    [1n << 255n, '00'.repeat(31) + '8000', '21' + '00'.repeat(31) + '8000'],
    [P256_N, '512563fcc2cab9f3849e17a7adfae6bcffffffffffffffff00000000ffffffff00', '21512563fcc2cab9f3849e17a7adfae6bcffffffffffffffff00000000ffffffff00'],
    [P256_P, 'ffffffffffffffffffffffff00000000000000000000000001000000ffffffff00', '21ffffffffffffffffffffffff00000000000000000000000001000000ffffffff00'],
    [RECODE_CONST, 'ff'.repeat(32) + '03', '21' + 'ff'.repeat(32) + '03']
  ]

  it.each(vectors)('scriptNum / encNum of %s', (v, sm, enc) => {
    expect(hex(scriptNum(v))).toBe(sm)
    expect(hex(encNum(v))).toBe(enc)
  })

  it('scriptNum equals BigNumber.toSm("little") for every vector', () => {
    for (const [v] of vectors) {
      const neg = v < 0n
      const bn = new BigNumber((neg ? -v : v).toString(16), 16)
      const sdk = (neg ? bn.neg() : bn).toSm('little')
      expect(hex(scriptNum(v))).toBe(hex(sdk))
    }
  })

  it('pushData picks the minimal push opcode', () => {
    expect(hex(pushData([]))).toBe('00')
    expect(hex(pushData([7]))).toBe('0107')
    expect(hex(pushData(new Array(75).fill(1)))).toBe('4b' + '01'.repeat(75))
    expect(hex(pushData(new Array(76).fill(1)))).toBe('4c4c' + '01'.repeat(76))
    expect(hex(pushData(new Array(158).fill(2)))).toBe('4c9e' + '02'.repeat(158))
    expect(hex(pushData(new Array(256).fill(3)))).toBe('4d0001' + '03'.repeat(256))
  })
})

describe('asm mini-assembler', () => {
  it('assembles region H0 of the lock', () => {
    expect(hex(asm('OP_DUP OP_HASH256 <00> OP_CAT OP_BIN2NUM OP_SWAP OP_TOALTSTACK'))).toBe('76aa01007e817c6b')
  })

  it('expands the MODP and NORM macros', () => {
    expect(hex(asm('MODP'))).toBe('6c766b97')
    expect(hex(asm('NORM'))).toBe('76009f636c766b9368')
  })

  it('encodes numeric tokens and bigint / number / byte-array params', () => {
    expect(hex(asm('0 1 16 17 -1 257'))).toBe('005160011' + '14f020101')
    expect(hex(asm('{N} OP_TOALTSTACK', { N: P256_N }))).toBe('21512563fcc2cab9f3849e17a7adfae6bcffffffffffffffff00000000ffffffff006b')
    expect(hex(asm('{D} OP_PICK', { D: 70 }))).toBe('014679')
    expect(hex(asm('{S} OP_CAT', { S: [0x41] }))).toBe('01417e')
  })

  it('rejects unknown opcodes and missing params with template-invalid', () => {
    expect(() => asm('OP_NOPE')).toThrow(VaultError)
    expect(() => asm('{MISSING}')).toThrow(VaultError)
  })
})
```

- [ ] **Step 1.2: Run the test — expect module-not-found**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts
```
Expected: `Cannot find module '../../core/services/vault/r1comb' from '__tests__/vault/r1comb.test.ts'`.

- [ ] **Step 1.3: Create `r1comb.ts` with constants, encoders and `asm`**

Create `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts`:

```ts
/**
 * R1C — the 1-of-N P-256 comb-verifier vault template (spec §2).
 *
 * Pure: no I/O, no React, no process.env; imports only @bsv/sdk and
 * @noble/curves. Ported from docs/example-txs/spike/gen.mjs, gen2.mjs,
 * unlock.mjs and unlock2.mjs. The G-table / comb-loop / tail region of every
 * lock is byte-identical to the mined testnet fixture
 * docs/example-txs/51c5…579a_0.hex (asserted in __tests__/vault/r1comb.test.ts).
 *
 * Script numbers are BSV little-endian sign-magnitude; "minimal scriptnum" is
 * what BigNumber.toSm('little') produces. Every constant is emitted minimally.
 *
 * SECURITY: nothing secret passes through this module — public keys, per-output
 * salts, signatures the card already produced, and script bytes.
 */
import { OP, Utils } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import { VaultError } from './types'

// ───────────────────────── comb geometry and sizes (spec §2) ─────────────────────────
export const COMB_ROWS = 6
export const COMB_COLS = 43
/** Entries per base point = 2^(COMB_ROWS − 1). */
export const TABLE_SIZE = 32
/** OP_NUM2BIN width per coordinate in the canonical (hashed) serialisation. */
export const COORD_WIDTH = 33
export const SALT_BYTES = 32
/** Declared unlockingScriptLength; the measured hard maximum is 2,539 B. */
export const R1C_UNLOCK_LEN = 2560
export const R1C_MAX_KEYS = 5
/** BIP143 preimage length with subscript `ac` (2 B) and scope 0x41. */
export const R1C_PREIMAGE_LEN = 158
/** SIGHASH_ALL | SIGHASH_FORKID — the only scope the template supports. */
export const R1C_SIGHASH = 0x41

/** Exact lock size: 27,855 B at N = 1; 27,831 + 25N B for N = 2..5 (ANALYSIS.md §9.2). */
export function R1C_LOCK_LEN(n: number): number {
  if (n === 1) return 27855
  if (Number.isInteger(n) && n >= 2 && n <= R1C_MAX_KEYS) return 27831 + 25 * n
  throw new VaultError('template-invalid', `R1C_LOCK_LEN: N must be 1..${R1C_MAX_KEYS}, got ${String(n)}`)
}

// ───────────────────────── curve constants ─────────────────────────
const P256_CURVE = p256.Point.CURVE()
export const P256_P: bigint = P256_CURVE.p
export const P256_N: bigint = P256_CURVE.n
/** secp256k1 group order — the OP_PUSH_TX leg only. */
export const SECP_N: bigint = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
/** secp256k1 generator x — the OP_PUSH_TX signature's r (nonce k = 1). */
export const SECP_GX: bigint = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const RECODE_BITS = COMB_ROWS * COMB_COLS // 258 signed digits
/** 2^258 − 1: the recode constant at H2 (ANALYSIS.md §5.2). */
export const RECODE_CONST: bigint = (1n << BigInt(RECODE_BITS)) - 1n

// ───────────────────────── bigint / byte helpers ─────────────────────────
const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m
function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n
  let b = mod(base, m)
  let e = exp
  while (e > 0n) {
    if ((e & 1n) === 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}
/** Inverse modulo a prime. */
const modinv = (a: bigint, m: bigint): bigint => modpow(a, m - 2n, m)
const bytesOf = (h: string): number[] => Utils.toArray(h, 'hex') as number[]
const beToBig = (b: number[]): bigint => BigInt('0x' + (b.length > 0 ? Utils.toHex(b) : '0'))
const leToBig = (b: number[]): bigint => beToBig([...b].reverse())
const invalid = (message: string): VaultError => new VaultError('template-invalid', message)
// Keep the helpers referenced until later tasks use them (TypeScript strict does not
// flag unused module-level consts, but this documents intent).
void modinv
void leToBig

// ───────────────────────── script-number encoding ─────────────────────────
/** Raw data push with the minimal push opcode (direct length, PUSHDATA1/2/4). */
export function pushData(data: number[]): number[] {
  const d = [...data]
  if (d.length === 0) return [OP.OP_0]
  if (d.length <= 75) return [d.length, ...d]
  if (d.length <= 0xff) return [OP.OP_PUSHDATA1, d.length, ...d]
  if (d.length <= 0xffff) return [OP.OP_PUSHDATA2, d.length & 0xff, d.length >>> 8, ...d]
  return [OP.OP_PUSHDATA4, d.length & 0xff, (d.length >>> 8) & 0xff, (d.length >>> 16) & 0xff, (d.length >>> 24) & 0xff, ...d]
}

/** Minimal script-number encoding (sign-magnitude little-endian) == BigNumber.toSm('little'). */
export function scriptNum(v: bigint): number[] {
  if (v === 0n) return []
  const neg = v < 0n
  let m = neg ? -v : v
  const b: number[] = []
  while (m > 0n) {
    b.push(Number(m & 0xffn))
    m >>= 8n
  }
  if ((b[b.length - 1] & 0x80) !== 0) b.push(neg ? 0x80 : 0x00)
  else if (neg) b[b.length - 1] |= 0x80
  return b
}

/** Push a number as a minimally-encoded script number (OP_0, OP_1..OP_16, OP_1NEGATE, or a data push). */
export function encNum(v: bigint | number): number[] {
  const n = BigInt(v)
  if (n === 0n) return [OP.OP_0]
  if (n >= 1n && n <= 16n) return [OP.OP_1 + Number(n) - 1]
  if (n === -1n) return [OP.OP_1NEGATE]
  return pushData(scriptNum(n))
}

// ───────────────────────── tiny assembler ─────────────────────────
// Tokens: OP_NAME | decimal integer (encNum) | <hex> (raw push) | {PARAM} | macro name.
const MACROS: Record<string, string> = {
  // reduce top mod p; p lives on the altstack and is never consumed
  MODP: 'OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_MOD',
  // BSV OP_MOD keeps the dividend's sign: normalise a negative remainder into [0, p)
  NORM: 'OP_DUP 0 OP_LESSTHAN OP_IF OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_ADD OP_ENDIF'
}
export type AsmParam = bigint | number | number[]
const OPCODES = OP as unknown as Record<string, number | undefined>

export function asm(text: string, params: Record<string, AsmParam> = {}): number[] {
  const out: number[] = []
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === '') continue
    const macro = MACROS[tok]
    if (macro !== undefined) {
      out.push(...asm(macro, params))
      continue
    }
    if (tok.startsWith('{') && tok.endsWith('}')) {
      const v = params[tok.slice(1, -1)]
      if (v === undefined) throw invalid(`asm: missing param ${tok}`)
      out.push(...(typeof v === 'bigint' || typeof v === 'number' ? encNum(v) : pushData(v)))
      continue
    }
    if (tok.startsWith('<') && tok.endsWith('>')) {
      out.push(...pushData(bytesOf(tok.slice(1, -1))))
      continue
    }
    if (/^-?\d+$/.test(tok)) {
      out.push(...encNum(BigInt(tok)))
      continue
    }
    const op = OPCODES[tok]
    if (op === undefined) throw invalid(`asm: unknown opcode ${tok}`)
    out.push(op)
  }
  return out
}
```

- [ ] **Step 1.4: Run the test — expect PASS**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts
```
Expected: `Tests: 30 passed` (3 constants + 20 vectors + 2 encoding + 4 asm ... all green, 0 failed). Then typecheck:

```bash
cd /Users/personal/git/bsv-wallet && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json
```
Expected: no output (exit 0).

- [ ] **Step 1.5: Commit**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/core/services/vault/r1comb.ts packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && git commit -m "feat(expo-wallet-toolbox): r1comb scaffold — constants, scriptnum encoders, asm

Port of the spike's encNum/scriptNum/pushData and the mini-assembler with the
MODP/NORM macros; pins the P-256 / secp256k1 constants and R1C_LOCK_LEN.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Comb tables, `compressPubkey`, `canonicalTableBytes`, `commitment`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` (append after `asm`; extend the `@bsv/sdk` import to `import { Hash, OP, Utils } from '@bsv/sdk'`)
- Test: `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` (append)

**Interfaces:**
- Consumes: `p256.Point.fromHex(hex)`, `.assertValidity()`, `.toHex(true)`, `.multiply(k)`, `.toAffine()`, `p256.Point.BASE`; `Hash.hash160(number[]): number[]`.
- Produces: `compressPubkey(sec1Hex: string): string`; `combTableScalar(j: number): bigint`; `gTable(): { x: bigint; y: bigint }[]`; `combTable(pubkeyHex33: string): { x: bigint; y: bigint }[]`; `le33(v: bigint): number[]`; `canonicalTableBytes(pubkeyHex33: string): number[]`; `commitment(pubkeyHex33: string, saltHex64: string): string`.

- [ ] **Step 2.1: Append the failing tests**

Add to the import list of `r1comb.test.ts`: `compressPubkey, combTable, combTableScalar, gTable, le33, canonicalTableBytes, commitment` and add `import { LockingScript } from '@bsv/sdk'` to the SDK import line (`import { BigNumber, Curve, LockingScript, Utils } from '@bsv/sdk'`). Add `import { p256 } from '@noble/curves/nist.js'`. Append:

```ts
/** The fixture's signer key, recovered from its Q comb table (ANALYSIS.md §2). */
export const FIXTURE_Q = '03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d'

describe('compressPubkey', () => {
  it('compresses a 65-byte SEC1 point and lowercases a compressed one', () => {
    const priv = p256.utils.randomSecretKey()
    const uncompressed = Utils.toHex(p256.getPublicKey(priv, false))
    const compressed = Utils.toHex(p256.getPublicKey(priv, true))
    expect(uncompressed).toHaveLength(130)
    expect(compressPubkey(uncompressed)).toBe(compressed)
    expect(compressPubkey(compressed.toUpperCase())).toBe(compressed)
    expect(compressPubkey(FIXTURE_Q)).toBe(FIXTURE_Q)
  })

  it.each([
    '', 'zz', '02' + 'ff'.repeat(32) /* x >= p */, '05' + '00'.repeat(32), '04' + '00'.repeat(64) /* off curve */,
    FIXTURE_Q.slice(0, 64), FIXTURE_Q + '00'
  ])('throws template-invalid on %s', bad => {
    expect(() => compressPubkey(bad)).toThrow(VaultError)
    try { compressPubkey(bad) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})

describe('comb tables', () => {
  const fixtureLock = LockingScript.fromHex(FIXTURE_LOCK_HEX)

  it('combTableScalar: T_j = 2^215 + Σ (bit_k(j) ? +1 : -1)·2^(43k)', () => {
    expect(combTableScalar(0)).toBe((1n << 215n) - (1n << 172n) - (1n << 129n) - (1n << 86n) - (1n << 43n) - 1n)
    expect(combTableScalar(31)).toBe((1n << 215n) + (1n << 172n) + (1n << 129n) + (1n << 86n) + (1n << 43n) + 1n)
    expect(combTableScalar(1)).toBe(combTableScalar(0) + 2n)
  })

  it('combTable(fixture Q) equals fixture chunks 151..214 as minimal scriptnums', () => {
    const table = combTable(FIXTURE_Q)
    expect(table).toHaveLength(32)
    for (let j = 0; j < 32; j++) {
      expect(hex(fixtureLock.chunks[151 + 2 * j].data!)).toBe(hex(scriptNum(table[j].x)))
      expect(hex(fixtureLock.chunks[152 + 2 * j].data!)).toBe(hex(scriptNum(table[j].y)))
    }
    expect(table[0].x.toString(16)).toBe('954767a2ef708eeab0476600b7a681af687f511f6a92b4f365ba6fedf9be3ad')
    expect(table[31].y.toString(16)).toBe('5a5330b7f93e4fafddac56b822bbcdbfad880239d990a9623018422aff4e9083')
  })

  it('gTable() equals fixture chunks 87..150', () => {
    const g = gTable()
    for (let j = 0; j < 32; j++) {
      expect(hex(fixtureLock.chunks[87 + 2 * j].data!)).toBe(hex(scriptNum(g[j].x)))
      expect(hex(fixtureLock.chunks[88 + 2 * j].data!)).toBe(hex(scriptNum(g[j].y)))
    }
    expect(g[0].x.toString(16)).toBe('16e4abe60c4b18a476fdab0db59c1ac3767855b4118be0113bd04bb679f1952d')
  })

  it('memoises per pubkey (same array back) and normalises the key case', () => {
    const a = combTable(FIXTURE_Q)
    expect(combTable(FIXTURE_Q)).toBe(a)
    expect(combTable(FIXTURE_Q.toUpperCase())).toBe(a)
  })

  it('evicts the oldest entry once more than 8 keys are cached', () => {
    const first = combTable(FIXTURE_Q)
    for (let i = 0; i < 8; i++) combTable(Utils.toHex(p256.getPublicKey(p256.utils.randomSecretKey(), true)))
    expect(combTable(FIXTURE_Q)).not.toBe(first)
  })
})

describe('canonical table bytes and commitment', () => {
  it('le33 is OP_NUM2BIN(v, 33): minimal LE magnitude zero-padded to 33 bytes', () => {
    expect(hex(le33(0n))).toBe('00'.repeat(33))
    expect(hex(le33(1n))).toBe('01' + '00'.repeat(32))
    expect(hex(le33(1n << 255n))).toBe('00'.repeat(31) + '8000')
    expect(() => le33(-1n)).toThrow(VaultError)
    expect(() => le33(1n << 263n)).toThrow(VaultError)
  })

  it('canonicalTableBytes(fixture Q) is 2,112 bytes with the pinned sha256', () => {
    const c = canonicalTableBytes(FIXTURE_Q)
    expect(c).toHaveLength(64 * 33)
    expect(hex(Hash.sha256(c))).toBe('014d1dc4d05be751e798dc280bdd824dda0880d70f1615275ef62c66d680bf77')
  })

  it('commitment = hash160(salt ‖ canonical) — pinned for two salts', () => {
    expect(commitment(FIXTURE_Q, '01'.repeat(32))).toBe('d45e539304c629b5ef67f7d38e654e5ed2138152')
    expect(commitment(FIXTURE_Q, '00'.repeat(32))).toBe('1efb4cd1b3edc12a6772215d5f112aad53541246')
    expect(commitment(FIXTURE_Q, '01'.repeat(32))).toBe(
      hex(Hash.hash160([...(Utils.toArray('01'.repeat(32), 'hex') as number[]), ...canonicalTableBytes(FIXTURE_Q)]))
    )
  })

  it.each(['', '01'.repeat(31), '01'.repeat(33), 'zz'.repeat(32)])('commitment rejects salt %s', bad => {
    expect(() => commitment(FIXTURE_Q, bad)).toThrow(VaultError)
  })
})
```
Also add `Hash` to the SDK import: `import { BigNumber, Curve, Hash, LockingScript, Utils } from '@bsv/sdk'`.

- [ ] **Step 2.2: Run — expect failures on the new exports**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts
```
Expected: the new suites fail with `TypeError: (0 , _r1comb.compressPubkey) is not a function` (and similar for `combTable` etc.).

- [ ] **Step 2.3: Implement in `r1comb.ts`**

Change the SDK import to `import { Hash, OP, Utils } from '@bsv/sdk'` and append after `asm`:

```ts
// ───────────────────────── public keys ─────────────────────────
/**
 * 65-byte SEC1 (04‖X‖Y) or 33-byte compressed hex in → 33-byte compressed lowercase hex out.
 * The card returns the 65-byte form; every comparison in the app uses the compressed form.
 */
export function compressPubkey(sec1Hex: string): string {
  if (typeof sec1Hex !== 'string' || !/^([0-9a-fA-F]{66}|[0-9a-fA-F]{130})$/.test(sec1Hex)) {
    throw invalid('compressPubkey: expected 33- or 65-byte SEC1 hex')
  }
  const lower = sec1Hex.toLowerCase()
  const prefix = lower.slice(0, 2)
  if (lower.length === 66 && prefix !== '02' && prefix !== '03') throw invalid('compressPubkey: bad compressed prefix')
  if (lower.length === 130 && prefix !== '04') throw invalid('compressPubkey: bad uncompressed prefix')
  try {
    const P = p256.Point.fromHex(lower)
    P.assertValidity()
    return P.toHex(true)
  } catch {
    throw invalid('compressPubkey: not a valid P-256 point')
  }
}

// ───────────────────────── comb tables (spec §2.1) ─────────────────────────
export interface AffinePoint { x: bigint; y: bigint }
type P256Point = ReturnType<typeof p256.Point.fromHex>

/**
 * Comb table scalar for entry j (0 <= j < 32):
 *   T_j = 2^(43·5) + Σ_{k<5} (bit_k(j) ? +1 : −1) · 2^(43k)
 * The top digit is fixed +1 (the sign digit is applied in-script by negating y).
 */
export function combTableScalar(j: number): bigint {
  let s = 1n << BigInt(COMB_COLS * (COMB_ROWS - 1))
  for (let k = 0; k < COMB_ROWS - 1; k++) s += (((j >> k) & 1) !== 0 ? 1n : -1n) << BigInt(COMB_COLS * k)
  return s
}

function tableOf(base: P256Point): AffinePoint[] {
  const pts: AffinePoint[] = []
  for (let j = 0; j < TABLE_SIZE; j++) {
    const a = base.multiply(mod(combTableScalar(j), P256_N)).toAffine()
    pts.push({ x: a.x, y: a.y })
  }
  return pts
}

let gTableCache: AffinePoint[] | null = null
/** table(G) — computed once on first use (32 scalar multiplications), then constant. */
export function gTable(): AffinePoint[] {
  if (gTableCache === null) gTableCache = tableOf(p256.Point.BASE)
  return gTableCache
}

const TABLE_CACHE_MAX = 8
const qTableCache = new Map<string, AffinePoint[]>()
/** table(Q): 32 affine points T_j·Q. Memoised per compressed pubkey (Map, FIFO, max 8). Never persisted. */
export function combTable(pubkeyHex33: string): AffinePoint[] {
  const key = compressPubkey(pubkeyHex33)
  const hit = qTableCache.get(key)
  if (hit !== undefined) return hit
  const table = tableOf(p256.Point.fromHex(key))
  if (qTableCache.size >= TABLE_CACHE_MAX) {
    const oldest = qTableCache.keys().next().value
    if (oldest !== undefined) qTableCache.delete(oldest)
  }
  qTableCache.set(key, table)
  return table
}

// ───────────────────────── commitment (spec §2.2) ─────────────────────────
/** OP_NUM2BIN(v, 33) for a non-negative v: minimal LE scriptnum zero-padded to 33 bytes. */
export function le33(v: bigint): number[] {
  if (v < 0n) throw invalid('le33: negative coordinate')
  const b = scriptNum(v)
  if (b.length > COORD_WIDTH) throw invalid('le33: value does not fit in 33 bytes')
  while (b.length < COORD_WIDTH) b.push(0)
  return b
}

/** le33(x_0) ‖ le33(y_0) ‖ … ‖ le33(y_31) — 2,112 bytes; injective over integer values. */
export function canonicalTableBytes(pubkeyHex33: string): number[] {
  const out: number[] = []
  for (const { x, y } of combTable(pubkeyHex33)) out.push(...le33(x), ...le33(y))
  return out
}

function saltBytes(saltHex64: string): number[] {
  if (typeof saltHex64 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(saltHex64)) {
    throw invalid(`salt must be ${SALT_BYTES} bytes as 64 hex chars`)
  }
  return bytesOf(saltHex64)
}

/** hash160(salt ‖ canonicalTableBytes(Q)) as 40 lowercase hex chars — the value baked into the lock. */
export function commitment(pubkeyHex33: string, saltHex64: string): string {
  return Utils.toHex(Hash.hash160([...saltBytes(saltHex64), ...canonicalTableBytes(pubkeyHex33)]))
}
```

- [ ] **Step 2.4: Run — expect PASS**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json
```
Expected: all tests pass (the fixture-table comparisons are the proof that `combTable`, `scriptNum` and the T_j definition agree with the mined script); tsc silent.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/core/services/vault/r1comb.ts packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && git commit -m "feat(expo-wallet-toolbox): r1comb comb tables, compressPubkey, canonical bytes, commitment

combTable(Q) is asserted equal to the fixture's Q table (chunks 151..214) and
gTable() to chunks 87..150; commitment goldens pinned for the fixture key.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 3: `buildLock`, the DOUBLE/MADD/comb-loop/tail emitters, `sharedSuffix`, `bakedCommitments`, `recode`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` (append after `commitment`; extend the SDK import to `import { Hash, LockingScript, OP, PrivateKey, Script, Utils } from '@bsv/sdk'`)
- Test: `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` (append)

**Interfaces:**
- Consumes: `asm`, `encNum`, `pushData`, `gTable`, `bytesOf`, `mod`, `modinv`, `invalid`, `R1C_LOCK_LEN`, `P256_N`, `P256_P`, `SECP_N`, `SECP_GX`, `RECODE_CONST`, `COORD_WIDTH`, `TABLE_SIZE`, `COMB_ROWS`, `COMB_COLS`, `R1C_SIGHASH`, `R1C_MAX_KEYS`; `new LockingScript(chunks)`, `Script.fromBinary(bytes).chunks` (`LockingScript` does not override the static, which is typed `Script`); `new PrivateKey(hex, 16).toPublicKey().encode(true)`.
- Produces: `recode(u: bigint): bigint`; `shiftFor(c: number, k: number): number`; `sharedSuffix(): number[]` (27,160 B, cached); `buildLock(a: { commitments: string[] }): LockingScript`; `bakedCommitments(lock: Script): string[]`.

The comb loop, DOUBLE, MADD, DIGITS_AND_LOOKUP, GUARD_PREFIX/SUFFIX and the tail are ported **verbatim** from `docs/example-txs/spike/gen2.mjs` (which copied them from `gen.mjs`); the header H0–H5 is `gen2.mjs` `emitHeader2`. The proof that the port is right is the byte-identity test against the fixture, not reading.

- [ ] **Step 3.1: Append the failing tests**

Add to the r1comb import list: `buildLock, bakedCommitments, recode, sharedSuffix, shiftFor` and add `Script` to the SDK import (`import { BigNumber, Curve, Hash, LockingScript, Script, Utils } from '@bsv/sdk'`). Append:

```ts
/** hash160 of a small deterministic byte string — a syntactically valid commitment for structural tests. */
const fakeCommitment = (i: number): string => Utils.toHex(Hash.hash160([0xc0, i]))

/** Golden commitment set: FIXTURE_Q under the two salts pinned in Task 2. */
const GOLDEN_C2 = ['d45e539304c629b5ef67f7d38e654e5ed2138152', '1efb4cd1b3edc12a6772215d5f112aad53541246']
/** sha256 of buildLock({ commitments: GOLDEN_C2 }) — computed from docs/example-txs/spike/gen2.mjs
 *  (`buildLock2({ commitments: GOLDEN_C2 })`), the reference this module ports. If this ever differs
 *  the PORT is wrong; never re-pin to the new value. Re-derive with:
 *  cd docs/example-txs/spike && node --input-type=module -e "import { buildLock2 } from './gen2.mjs'; import { Hash, Utils } from '@bsv/sdk'; console.log(Utils.toHex(Hash.sha256(buildLock2({ commitments: ['d45e539304c629b5ef67f7d38e654e5ed2138152', '1efb4cd1b3edc12a6772215d5f112aad53541246'] }).toBinary())))" */
const GOLDEN_SHA256_N2 = '1b94d0b8453d459116694334b67f7f2c32ec77c2e0e6588805e5d0d4cd2ed472'
/** Same for N = 1 with GOLDEN_C2[0] only. */
const GOLDEN_SHA256_N1 = '680a378d65640bea8b31e70b884809a9b6aaf6cbcf011fdefa7202c3db0930a4'
/** OP_PUSH_TX dummy key d·G, d = 2^248·Gx⁻¹ mod n_k1 (ANALYSIS.md §6.1, fixture chunk 23064). */
const PUSH_TX_PUBKEY = '02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0'

describe('recode and shiftFor', () => {
  it("recode(u) = ((u odd ? u : u + n) + 2^258 − 1) / 2 and inverts to u mod n", () => {
    expect(recode(1n)).toBe(1n << 257n)
    expect(recode(P256_N - 1n)).toBe(P256_N + (1n << 257n) - 1n)
    // fixture u1 (ANALYSIS.md §2, even → +n branch)
    const u1 = 0x051fd0dba16ab0f7a8ba9127e52a45c1316ab230f807d243ec88788eb1d8d2e6n
    expect(recode(u1)).toBe((u1 + P256_N + RECODE_CONST) / 2n)
    for (let i = 0; i < 50; i++) {
      const u = BigInt('0x' + Utils.toHex(Array.from(p256.utils.randomSecretKey()))) % P256_N
      const up = recode(u)
      expect(up < (1n << 258n)).toBe(true)
      expect((up >> 257n) & 1n).toBe(1n)
      expect((((2n * up - RECODE_CONST) % P256_N) + P256_N) % P256_N).toBe(u)
    }
  })

  it('shiftFor(c, k) = 257 − c − 43k', () => {
    expect(shiftFor(0, 0)).toBe(257)
    expect(shiftFor(42, 5)).toBe(0)
    expect(shiftFor(0, 5)).toBe(42)
    expect(shiftFor(42, 0)).toBe(215)
    for (let c = 0; c < 43; c++) for (let k = 0; k < 6; k++) expect(shiftFor(c, k)).toBe(257 - c - 43 * k)
  })
})

describe('buildLock goldens', () => {
  const fixtureLock = LockingScript.fromHex(FIXTURE_LOCK_HEX)

  it('sharedSuffix() equals fixture chunks [87..150] ++ [215..end] byte-for-byte (27,160 B)', () => {
    const fixtureSuffix = new LockingScript([...fixtureLock.chunks.slice(87, 151), ...fixtureLock.chunks.slice(215)])
    const mine = sharedSuffix()
    expect(mine).toHaveLength(27160)
    expect(hex(mine)).toBe(fixtureSuffix.toHex())
    expect(sharedSuffix()).toEqual(mine) // cached and stable
  })

  it.each([1, 2, 3, 4, 5])('N=%i: exact byte length R1C_LOCK_LEN(N) and chunk count', N => {
    const commitments = [...Array(N)].map((_, i) => fakeCommitment(i))
    const lock = buildLock({ commitments })
    expect(lock.toBinary()).toHaveLength(R1C_LOCK_LEN(N))
    expect(lock.chunks).toHaveLength(N === 1 ? 23310 : 23306 + 5 * N)
    // the lock ends with the shared suffix
    const bin = lock.toBinary()
    expect(hex(bin.slice(bin.length - 27160))).toBe(hex(sharedSuffix()))
  })

  it('pins sha256 for the golden commitment sets (N = 1 and N = 2)', () => {
    expect(hex(Hash.sha256(buildLock({ commitments: [GOLDEN_C2[0]] }).toBinary()))).toBe(GOLDEN_SHA256_N1)
    expect(hex(Hash.sha256(buildLock({ commitments: GOLDEN_C2 }).toBinary()))).toBe(GOLDEN_SHA256_N2)
    // uppercase commitments produce the same bytes
    expect(hex(buildLock({ commitments: GOLDEN_C2.map(c => c.toUpperCase()) }).toBinary())).toBe(hex(buildLock({ commitments: GOLDEN_C2 }).toBinary()))
  })

  it('tail ends with <dummy pubkey> OP_CODESEPARATOR OP_CHECKSIG', () => {
    const c = buildLock({ commitments: [fakeCommitment(0)] }).chunks
    expect(hex(c[c.length - 3].data!)).toBe(PUSH_TX_PUBKEY)
    expect(c[c.length - 2].op).toBe(0xab)
    expect(c[c.length - 1].op).toBe(0xac)
    expect(hex(fixtureLock.chunks[23064].data!)).toBe(PUSH_TX_PUBKEY)
  })

  it('H5 layout: N=1 is <C0> EQUALVERIFY; N>=2 is (DUP <Ci> EQUAL SWAP)×(N−1) <C_last> EQUAL BOOLOR×(N−1) VERIFY', () => {
    const one = buildLock({ commitments: [fakeCommitment(0)] }).chunks
    expect(one[391].op).toBe(0xa9) // OP_HASH160
    expect(hex(one[392].data!)).toBe(fakeCommitment(0))
    expect(one[393].op).toBe(0x88) // OP_EQUALVERIFY
    const three = buildLock({ commitments: [0, 1, 2].map(fakeCommitment) }).chunks
    expect(three[391].op).toBe(0xa9)
    expect(three.slice(392, 392 + 4 * 2 + 2 + 2 + 1).map(k => (k.data !== undefined ? hex(k.data) : k.op))).toEqual([
      0x76, fakeCommitment(0), 0x87, 0x7c,
      0x76, fakeCommitment(1), 0x87, 0x7c,
      fakeCommitment(2), 0x87,
      0x9b, 0x9b, 0x69
    ])
  })

  it.each([
    [[]],
    [[0, 1, 2, 3, 4, 5].map(fakeCommitment)],
    [['zz'.repeat(20)]],
    [[fakeCommitment(0).slice(0, 38)]],
    [[fakeCommitment(0) + '00']],
    [[fakeCommitment(0), fakeCommitment(0)]],
    [[fakeCommitment(0), fakeCommitment(0).toUpperCase()]]
  ])('buildLock rejects %j with template-invalid', bad => {
    expect(() => buildLock({ commitments: bad })).toThrow(VaultError)
    try { buildLock({ commitments: bad }) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})

describe('bakedCommitments', () => {
  it.each([1, 2, 3, 4, 5])('round-trips N=%i commitments in order', N => {
    const commitments = [...Array(N)].map(() => Utils.toHex(Hash.hash160(Array.from(p256.utils.randomSecretKey()))))
    const lock = buildLock({ commitments })
    expect(bakedCommitments(lock)).toEqual(commitments)
    // also from a re-parsed copy (what a BEEF gives Plan 2)
    expect(bakedCommitments(Script.fromHex(lock.toHex()))).toEqual(commitments)
  })

  it('returns lowercase even when built from uppercase input', () => {
    expect(bakedCommitments(buildLock({ commitments: GOLDEN_C2.map(c => c.toUpperCase()) }))).toEqual(GOLDEN_C2)
  })

  it.each<[string, () => Script]>([
    ['empty script', () => Script.fromHex('')],
    ['P2PKH', () => Script.fromASM('OP_DUP OP_HASH160 ' + 'ab'.repeat(20) + ' OP_EQUALVERIFY OP_CHECKSIG')],
    ['the original fixture lock (Q table baked, no H5)', () => LockingScript.fromHex(FIXTURE_LOCK_HEX)],
    ['R1C lock with its last byte dropped', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); return Script.fromBinary(b.slice(0, -1)) }],
    ['R1C lock with one suffix byte flipped', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); b[10_000] ^= 0x01; return Script.fromBinary(b) }],
    ['R1C lock with one header byte flipped', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); b[3] ^= 0x01; return Script.fromBinary(b) }],
    ['R1C lock whose H5 BOOLOR was replaced by OP_BOOLAND', () => { const b = buildLock({ commitments: GOLDEN_C2 }).toBinary(); const i = b.length - 27160 - 2; expect(b[i]).toBe(0x9b); b[i] = 0x9a; return Script.fromBinary(b) }]
  ])('throws template-invalid on %s', (_name, mk) => {
    expect(() => bakedCommitments(mk())).toThrow(VaultError)
    try { bakedCommitments(mk()) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})
```

- [ ] **Step 3.2: Run — expect failures on the new exports**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts
```
Expected: the four new suites fail with `TypeError: (0 , _r1comb.buildLock) is not a function` (and `recode`, `shiftFor`, `sharedSuffix`, `bakedCommitments`); Tasks 1–2 suites still pass.

- [ ] **Step 3.3: Implement in `r1comb.ts`**

Change the SDK import to `import { Hash, LockingScript, OP, PrivateKey, Script, Utils } from '@bsv/sdk'` and append after `commitment`:

```ts
// ───────────────────────── scalar recoding (spec §2.4, ANALYSIS.md §5.2) ─────────────────────────
/** u' = ((u odd ? u : u + n) + 2^258 − 1) / 2 — exactly the H2 arithmetic. u' < 2^258 and bit 257 is always set. */
export function recode(u: bigint): bigint {
  let v = mod(u, P256_N)
  if (v % 2n === 0n) v += P256_N
  return (v + RECODE_CONST) / 2n
}

// ───────────────────────── header H0–H5 (spec §2.3, gen2.mjs emitHeader2) ─────────────────────────
/** 64 Q coordinates pushed by the unlocker. */
const K_Q = 2 * TABLE_SIZE

/**
 * H0–H4 (+ OP_HASH160): identical for every lock. Stack in (unlock): [r u2' u1' Q0..Q63 salt s sInv preimage]
 * alt []; stack out: [r u2' u1' Q0..Q63 H] alt [preimage n], where H = hash160(salt ‖ canonical table).
 */
let headerPrefixCache: number[] | null = null
function emitHeaderPrefix(): number[] {
  if (headerPrefixCache !== null) return headerPrefixCache
  const out: number[] = []
  // H0: e = unsigned-LE(hash256(preimage)); preimage -> alt
  out.push(...asm('OP_DUP OP_HASH256 <00> OP_CAT OP_BIN2NUM OP_SWAP OP_TOALTSTACK'))
  // H1: n -> alt; s*sInv == 1; u1 = e*sInv; u2 = r*sInv (r sits under salt + 64 coords + u1' + u2'); drop s, sInv
  //     [.. salt s sInv u1]: u1(0) sInv(1) s(2) salt(3) Q63(4) .. Q0(3+K) u1'(4+K) u2'(5+K) r(6+K)
  out.push(...asm(`
    {N} OP_TOALTSTACK
    2 OP_PICK 2 OP_PICK OP_MUL MODP 1 OP_NUMEQUALVERIFY
    OP_OVER OP_MUL MODP
    {RDEPTH} OP_PICK 2 OP_PICK OP_MUL MODP
    2 OP_ROLL OP_DROP 2 OP_ROLL OP_DROP
  `, { N: P256_N, RDEPTH: K_Q + 6 }))
  // H2: recode u2 then u1 -> [.. salt u1' u2']
  const one = 'OP_DUP 2 OP_MOD OP_NOTIF {N} OP_ADD OP_ENDIF {C} OP_ADD 2 OP_DIV OP_SWAP'
  out.push(...asm(`${one} ${one}`, { N: P256_N, C: RECODE_CONST }))
  // H3: computed u2' == pushed u2' (depth K+4), then computed u1' == pushed u1' (depth K+2) -> [r u2' u1' Q.. salt]
  out.push(...asm('{DU2} OP_PICK OP_NUMEQUALVERIFY {DU1} OP_PICK OP_NUMEQUALVERIFY', { DU2: K_Q + 4, DU1: K_Q + 2 }))
  // H4: acc = salt; acc ||= NUM2BIN33(Q_m) for m = 0..63 (Q_m at depth K − m); H = hash160(acc)
  for (let m = 0; m < K_Q; m++) out.push(...asm('{D} OP_PICK {W} OP_NUM2BIN OP_CAT', { D: K_Q - m, W: COORD_WIDTH }))
  out.push(OP.OP_HASH160)
  headerPrefixCache = out
  return out
}

/** H5: H must equal one of the N baked 20-byte commitments. 22 B (N = 1) or 25N − 2 B (N >= 2). */
function emitH5(commitments: number[][]): number[] {
  const out: number[] = []
  if (commitments.length === 1) {
    out.push(...asm('{C} OP_EQUALVERIFY', { C: commitments[0] }))
    return out
  }
  for (let i = 0; i < commitments.length - 1; i++) out.push(...asm('OP_DUP {C} OP_EQUAL OP_SWAP', { C: commitments[i] }))
  out.push(...asm('{C} OP_EQUAL', { C: commitments[commitments.length - 1] }))
  for (let i = 0; i < commitments.length - 1; i++) out.push(OP.OP_BOOLOR)
  out.push(OP.OP_VERIFY)
  return out
}

// ───────────────────────── shared suffix: G table, pre-loop, comb loop, tail (verbatim from gen.mjs) ─────────────────────────
function emitGTable(): number[] {
  const out: number[] = []
  for (const { x, y } of gTable()) out.push(...encNum(x), ...encNum(y))
  return out
}

/** Push p; swap altstack top n -> p; accumulator := Jacobian infinity (1, 1, 0). */
function emitPreloop(): number[] {
  return asm('{P} OP_FROMALTSTACK OP_DROP OP_TOALTSTACK 1 1 0', { P: P256_P })
}

// Jacobian doubling, a = -3 (dbl-2001-b): M = 3(X-Z^2)(X+Z^2), S = 4XY^2,
// X3 = M^2 - 2S, Y3 = M(S - X3) - 8Y^4, Z3 = 2YZ. Only X3, Y3, Z3 are reduced.
// The `1 OP_ROLL 1 OP_ROLL` pairs and the trailing 3x `2 OP_ROLL` are no-ops kept for byte-exactness.
const DOUBLE = `
  OP_DUP OP_DUP OP_MUL
  3 OP_PICK OP_OVER OP_SUB
  4 OP_PICK 2 OP_ROLL OP_ADD
  1 OP_ROLL 1 OP_ROLL
  OP_MUL 3 OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  4 OP_ROLL OP_OVER OP_MUL 4 OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  OP_OVER OP_2MUL
  1 OP_ROLL 1 OP_ROLL
  OP_SUB MODP NORM
  1 OP_ROLL OP_OVER OP_SUB
  3 OP_ROLL 1 OP_ROLL OP_MUL
  2 OP_ROLL OP_DUP OP_MUL 8 OP_MUL
  1 OP_ROLL 1 OP_ROLL OP_SUB MODP NORM
  3 OP_ROLL 3 OP_ROLL OP_MUL OP_2MUL MODP NORM
  2 OP_ROLL 2 OP_ROLL 2 OP_ROLL
`

// Digit extraction + table lookup + conditional negation. Stack in: [.. X Y Z]; out: [.. X Y Z x y].
// Row 0 bit = sign digit; rows 1..4 are XNOR'd against it to form the 5-bit table index j.
const DIGITS_AND_LOOKUP = `
  {DEPTH0} OP_PICK {SHIFT0} OP_RSHIFTNUM 2 OP_MOD
  {DEPTH1} OP_PICK {SHIFT1} OP_RSHIFTNUM 2 OP_MOD OP_OVER OP_NUMEQUAL OP_2MUL
  {DEPTH2} OP_PICK {SHIFT2} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT3} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT4} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD OP_2MUL
  {DEPTH2} OP_PICK {SHIFT5} OP_RSHIFTNUM 2 OP_MOD 2 OP_PICK OP_NUMEQUAL OP_ADD
  OP_DUP OP_2MUL {BASE} OP_SWAP OP_SUB OP_PICK
  OP_OVER OP_2MUL {BASE} OP_SWAP OP_SUB OP_PICK
  2 OP_ROLL OP_DROP 2 OP_ROLL
  OP_NOTIF OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_SWAP OP_SUB OP_ENDIF
`

// Identity guard (column 0, first add only): if Z == 0 replace the accumulator by (x, y, 1).
const GUARD_PREFIX = '2 OP_PICK 0 OP_NUMEQUAL OP_IF OP_TOALTSTACK OP_TOALTSTACK OP_DROP OP_DROP OP_DROP OP_FROMALTSTACK OP_FROMALTSTACK 1 OP_ELSE'
const GUARD_SUFFIX = 'OP_ENDIF'

// Mixed Jacobian + affine addition: U2 = xZ^2, S2 = yZ^3, H = U2 - X, R = S2 - Y,
// X3 = R^2 - H^3 - 2XH^2, Y3 = R(XH^2 - X3) - YH^3, Z3 = ZH. Only X3, Y3, Z3 are reduced.
const MADD = `
  2 OP_PICK OP_DUP OP_MUL
  2 OP_ROLL OP_OVER OP_MUL
  3 OP_PICK 2 OP_ROLL OP_MUL
  2 OP_ROLL 1 OP_ROLL OP_MUL
  1 OP_ROLL 4 OP_PICK OP_SUB
  1 OP_ROLL 3 OP_PICK OP_SUB
  OP_OVER OP_DUP OP_MUL
  2 OP_PICK OP_OVER OP_MUL
  6 OP_ROLL 2 OP_ROLL OP_MUL
  2 OP_PICK OP_DUP OP_MUL
  OP_OVER OP_2MUL
  1 OP_ROLL 3 OP_PICK OP_SUB
  1 OP_ROLL OP_SUB MODP NORM
  1 OP_ROLL OP_OVER OP_SUB
  3 OP_ROLL 1 OP_ROLL OP_MUL
  5 OP_ROLL 3 OP_ROLL OP_MUL
  1 OP_ROLL 1 OP_ROLL OP_SUB MODP NORM
  3 OP_ROLL 3 OP_ROLL OP_MUL MODP NORM
  2 OP_ROLL 2 OP_ROLL 2 OP_ROLL
`

/** Stack layout beneath the accumulator: [r u2' u1' C[0..K-1]] with K = 128 table coordinates (Q[0..63] then G[0..63]). */
const K_CONSTS = 2 * 2 * TABLE_SIZE            // 128
const BELOW = 3 + K_CONSTS                     // 131 items under the accumulator (X Y Z)
// With [.. X Y Z] on top (BELOW + 3 items): stack index 1 (= u2') is at depth 132, index 2 (= u1') at 131.
const scalarDepth = (half: 0 | 1): number => BELOW + 1 - half
// C[m] sits at depth 132 − m once [.. X Y Z sign j] is on top; half 0 -> C[0..63] (= Q), half 1 -> C[64..127] (= G).
const tableBase = (half: 0 | 1): number => BELOW + 1 - 2 * TABLE_SIZE * half
/** Shift for column c, row k: bit position 43k + 42 − c of the recoded scalar = 257 − c − 43k. */
export const shiftFor = (c: number, k: number): number => COMB_COLS * (COMB_ROWS - 1 - k) + (COMB_COLS - 1 - c)

function emitAdd(half: 0 | 1, c: number, guarded: boolean): number[] {
  const params: Record<string, AsmParam> = {
    DEPTH0: scalarDepth(half), DEPTH1: scalarDepth(half) + 1, DEPTH2: scalarDepth(half) + 2, BASE: tableBase(half)
  }
  for (let k = 0; k < COMB_ROWS; k++) params[`SHIFT${k}`] = shiftFor(c, k)
  return asm(`${DIGITS_AND_LOOKUP} ${guarded ? GUARD_PREFIX : ''} ${MADD} ${guarded ? GUARD_SUFFIX : ''}`, params)
}

/** 43 columns, Horner: acc = 2·acc + d2(c)·TQ[j2] + d1(c)·TG[j1]; only column 0's first add is identity-guarded. */
function emitCombLoop(): number[] {
  const out: number[] = []
  for (let c = 0; c < COMB_COLS; c++) {
    out.push(...asm(DOUBLE))
    out.push(...emitAdd(0, c, c === 0))     // index-1 scalar (u2') with C[0..63] (Q)
    out.push(...emitAdd(1, c, false))       // index-2 scalar (u1') with C[64..127] (G)
  }
  return out
}

/** DER INTEGER for a non-negative bigint: minimal big-endian with a 0x00 pad if the top bit is set. */
function derIntBytes(v: bigint): number[] {
  let h = v.toString(16)
  if (h.length % 2 === 1) h = '0' + h
  const b = bytesOf(h)
  if ((b[0] & 0x80) !== 0) b.unshift(0)
  return [0x02, b.length, ...b]
}

/** The OP_PUSH_TX dummy key d·G on secp256k1, d = 2^248·Gx⁻¹ mod n_k1 (public by construction). */
let pushTxPubKeyCache: number[] | null = null
function pushTxPubKey(): number[] {
  if (pushTxPubKeyCache === null) {
    const d = mod((1n << 248n) * modinv(SECP_GX, SECP_N), SECP_N)
    pushTxPubKeyCache = new PrivateKey(d.toString(16).padStart(64, '0'), 16).toPublicKey().encode(true) as number[]
  }
  return pushTxPubKeyCache
}

/** Tail: Z != 0 and X == r·Z² (mod p); clear the stack; OP_PUSH_TX with k = 1 on secp256k1 (ANALYSIS.md §6). */
function emitTail(): number[] {
  // r (item index 0) with [.. X Y Z Z^2] on top (BELOW + 4 items) is at depth BELOW + 3 = 134
  const rCheck = asm(`
    OP_DUP 0 OP_NUMEQUAL OP_NOTIF
      OP_DUP OP_DUP OP_MUL MODP
      {RDEPTH} OP_PICK OP_OVER OP_MUL MODP
      4 OP_PICK OP_NUMEQUAL
    OP_ELSE 0 OP_ENDIF OP_VERIFY
    OP_FROMALTSTACK OP_DROP
  `, { RDEPTH: BELOW + 3 })
  // stack now holds BELOW + 4 items (r u2' u1' C[] X Y Z Z^2): drop them all
  const leftover = BELOW + 4
  const clear: number[] = [
    ...new Array<number>(Math.floor(leftover / 2)).fill(OP.OP_2DROP),
    ...(leftover % 2 === 1 ? [OP.OP_DROP] : [])
  ]
  // e_k1 = BE(hash256(preimage)); s = lowS((e_k1 + 2^248) mod n_k1); r = Gx (k = 1)
  const rev31 = new Array<string>(31).fill('OP_SWAP OP_CAT').join(' ')
  const pushTx = asm(`
    OP_FROMALTSTACK {SIGHASH} OP_TOALTSTACK OP_HASH256
    ${new Array<string>(31).fill('1 OP_SPLIT').join(' ')}
    ${rev31}
    <00> OP_CAT OP_BIN2NUM
    0 31 OP_NUM2BIN 1 OP_CAT OP_ADD
    {NK} OP_TUCK 2 OP_DIV OP_OVER OP_LESSTHAN
    OP_IF OP_OVER OP_MOD OP_OVER 2 OP_DIV OP_OVER OP_LESSTHAN OP_IF OP_SUB OP_ELSE OP_NIP OP_ENDIF
    OP_ELSE OP_NIP OP_ENDIF
    ${new Array<string>(31).fill('OP_DUP OP_0NOTEQUAL OP_SPLIT').join(' ')}
    ${rev31}
    OP_SIZE OP_SWAP OP_CAT
    {DERPREFIX} OP_SWAP OP_CAT
    OP_SIZE OP_SWAP OP_CAT
    <30> OP_SWAP OP_CAT
    OP_FROMALTSTACK OP_CAT
    {PUBKEY} OP_CODESEPARATOR OP_CHECKSIG
  `, {
    SIGHASH: [R1C_SIGHASH], NK: SECP_N,
    DERPREFIX: [...derIntBytes(SECP_GX), 0x02],   // 02 20 <Gx> 02  (s INTEGER tag appended)
    PUBKEY: pushTxPubKey()
  })
  return [...rCheck, ...clear, ...pushTx]
}

let sharedSuffixCache: number[] | null = null
/** G table + pre-loop + comb loop + tail: 27,160 B, byte-identical to fixture chunks [87..150] ++ [215..end]. Computed once. */
export function sharedSuffix(): number[] {
  if (sharedSuffixCache === null) sharedSuffixCache = [...emitGTable(), ...emitPreloop(), ...emitCombLoop(), ...emitTail()]
  return sharedSuffixCache.slice()
}

// ───────────────────────── public: buildLock / bakedCommitments (spec §2.3) ─────────────────────────
function parseCommitments(commitments: unknown): number[][] {
  if (!Array.isArray(commitments) || commitments.length < 1 || commitments.length > R1C_MAX_KEYS) {
    throw invalid(`buildLock: commitments must be 1..${R1C_MAX_KEYS} hash160 hex strings`)
  }
  const lower: string[] = commitments.map(c => {
    if (typeof c !== 'string' || !/^[0-9a-fA-F]{40}$/.test(c)) throw invalid('buildLock: commitment must be 40 hex chars')
    return c.toLowerCase()
  })
  if (new Set(lower).size !== lower.length) throw invalid('buildLock: duplicate commitment')
  return lower.map(bytesOf)
}

/** N in 1..5 commitments (40-hex each), in the order given. Byte-exact per spec §2.3; length asserted against R1C_LOCK_LEN. */
export function buildLock(a: { commitments: string[] }): LockingScript {
  const cs = parseCommitments(a.commitments)
  const bytes = [...emitHeaderPrefix(), ...emitH5(cs), ...sharedSuffix()]
  const expected = R1C_LOCK_LEN(cs.length)
  if (bytes.length !== expected) throw invalid(`buildLock: emitted ${bytes.length} bytes, expected ${expected}`)
  return new LockingScript(Script.fromBinary(bytes).chunks)
}

/**
 * Parse region H5 of a lock built by buildLock → the commitments in order (lowercase hex).
 * Fail-closed: the header prefix, the H5 skeleton AND the whole shared suffix must be byte-identical
 * to what buildLock emits for the extracted commitments; anything else is 'template-invalid'.
 */
export function bakedCommitments(lock: Script): string[] {
  const bin = lock.toBinary()
  let n = -1
  for (let k = 1; k <= R1C_MAX_KEYS; k++) if (bin.length === R1C_LOCK_LEN(k)) n = k
  if (n < 0) throw invalid(`bakedCommitments: ${bin.length} bytes is not an R1C lock length`)
  const prefix = emitHeaderPrefix()
  const suffix = sharedSuffix()
  const h5 = bin.slice(prefix.length, bin.length - suffix.length)
  const cs: number[][] = []
  if (n === 1) {
    cs.push(h5.slice(1, 21))
  } else {
    for (let i = 0; i < n - 1; i++) cs.push(h5.slice(24 * i + 2, 24 * i + 22))
    cs.push(h5.slice(24 * (n - 1) + 1, 24 * (n - 1) + 21))
  }
  const rebuilt = [...prefix, ...emitH5(cs), ...suffix]
  if (rebuilt.length !== bin.length || rebuilt.some((b, i) => b !== bin[i])) {
    throw invalid('bakedCommitments: not an R1C lock')
  }
  return cs.map(c => Utils.toHex(c))
}
```

- [ ] **Step 3.4: Run — expect PASS**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json
```
Expected: all suites green. The two decisive assertions are `sharedSuffix()` == fixture chunks `[87..150] ++ [215..end]` (the mined script is the oracle for every emitter) and the two pinned sha256s (the gen2 reference is the oracle for the header). If the suffix test fails, diff the first differing byte against `docs/example-txs/spike/gen2.mjs emitSharedSuffix()` — the templates above must be character-identical to it. tsc silent.

- [ ] **Step 3.5: Commit**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/core/services/vault/r1comb.ts packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && git commit -m "feat(expo-wallet-toolbox): r1comb buildLock, comb-loop/tail emitters, bakedCommitments

Header H0-H5 ported from gen2.mjs, loop and OP_PUSH_TX tail from gen.mjs.
Goldens: exact lengths for N=1..5, shared suffix byte-identical to the mined
fixture, pinned sha256 for the golden commitment sets, H5 round trip.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `sighashPreimage`, `signerDigest`, `pushTxSignatureS`, `peelLoopNonMinimalAt`, `pushTxDerCheck`, `decodeDerSignature`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` (append after `bakedCommitments`; extend the SDK import to `import { Hash, LockingScript, OP, PrivateKey, Script, Transaction, TransactionSignature, Utils } from '@bsv/sdk'`)
- Test: `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` (append)

**Interfaces:**
- Consumes: `TransactionSignature.format({ sourceTXID, sourceOutputIndex, sourceSatoshis, transactionVersion, otherInputs, outputs, inputIndex, subscript, inputSequence, lockTime, scope }): number[]` (param names from `node_modules/@bsv/sdk/dist/types/src/primitives/TransactionSignature.d.ts`); `Transaction.inputs[i].sourceTXID / sourceTransaction / sourceOutputIndex / sequence`; `Hash.hash256`; `scriptNum`, `beToBig`, `mod`, `SECP_N`, `P256_N`, `R1C_PREIMAGE_LEN`, `R1C_SIGHASH`, `invalid`.
- Produces: `sighashPreimage(tx: Transaction, inputIndex: number, sourceSatoshis: number): number[]`; `signerDigest(preimage: number[]): string`; `pushTxSignatureS(preimage: number[]): bigint`; `peelLoopNonMinimalAt(sLE: number[]): number`; `pushTxDerCheck(preimage: number[]): { ok: boolean; s: bigint }`; `decodeDerSignature(der: number[]): { r: bigint; s: bigint }`.

Preimage byte map (158 B, ANALYSIS.md §2/§9): version `[0,4)` · hashPrevouts `[4,36)` · hashSequence `[36,68)` · outpoint `[68,104)` · scriptCode `01ac` `[104,106)` · amount LE64 `[106,114)` · sequence `[114,118)` · hashOutputs `[118,150)` · lockTime `[150,154)` · sighash LE32 `[154,158)`.

- [ ] **Step 4.1: Append the failing tests**

Add to the r1comb import list: `sighashPreimage, signerDigest, pushTxSignatureS, peelLoopNonMinimalAt, pushTxDerCheck, decodeDerSignature, R1C_PREIMAGE_LEN, R1C_SIGHASH` and add `Transaction` to the SDK import (`import { BigNumber, Curve, Hash, LockingScript, Script, Transaction, Utils } from '@bsv/sdk'`). Append:

```ts
/** Minimal LE sign-magnitude scriptnum bytes → bigint (inverse of scriptNum; test-side only). */
export const fromScriptNum = (b: number[]): bigint => {
  if (b.length === 0) return 0n
  const m = [...b]
  const neg = (m[m.length - 1] & 0x80) !== 0
  m[m.length - 1] &= 0x7f
  const v = BigInt('0x' + hex([...m].reverse()))
  return neg ? -v : v
}
export const beBig = (b: number[]): bigint => BigInt('0x' + (b.length > 0 ? hex(b) : '0'))

/** Fixture facts (ANALYSIS.md §2). */
export const FIXTURE_SATS = 4600
export const FIXTURE_HASH256 = '0bd94d7d0883ed0e47d4bbc903845542857cb072a85b45c7a6484f7ff532620e'
export const FIXTURE_DIGEST = '0e6232f57f4f48a6c7455ba872b07c8542558403c9bbd4470eed83087d4dd90b'
export const FIXTURE_R = 0xe3c4329684a494d2db1c99234f136d9b941c4274f40befe976b546c130f9f7c7n
export const FIXTURE_S = 0x401a6223caf9c7b57188e354044d52687ed2c69f975bc4c075369d44199d67e9n
export const FIXTURE_DER = '3045022100e3c4329684a494d2db1c99234f136d9b941c4274f40befe976b546c130f9f7c70220401a6223caf9c7b57188e354044d52687ed2c69f975bc4c075369d44199d67e9'

describe('sighashPreimage and signerDigest (fixture spend)', () => {
  const tx = Transaction.fromHex(FIXTURE_TX_HEX)
  const unlock = tx.inputs[0].unlockingScript!
  const hashOutputs = unlock.chunks[3].data!   // push #3
  const outpoint = unlock.chunks[4].data!      // push #4

  it('reconstructs the 158-byte preimage field by field', () => {
    expect(hashOutputs).toHaveLength(32)
    expect(outpoint).toHaveLength(36)
    const expected = [
      ...(Utils.toArray('01000000', 'hex') as number[]),           // version 1
      ...Hash.hash256(outpoint),                                    // hashPrevouts (single input)
      ...Hash.hash256(Utils.toArray('ffffffff', 'hex') as number[]),// hashSequence
      ...outpoint,
      ...(Utils.toArray('01ac', 'hex') as number[]),               // scriptCode = OP_CHECKSIG
      ...(Utils.toArray('f811000000000000', 'hex') as number[]),   // 4600 sat LE64
      ...(Utils.toArray('ffffffff', 'hex') as number[]),           // sequence
      ...hashOutputs,
      ...(Utils.toArray('00000000', 'hex') as number[]),           // lockTime
      ...(Utils.toArray('41000000', 'hex') as number[])            // sighash ALL|FORKID
    ]
    expect(expected).toHaveLength(R1C_PREIMAGE_LEN)
    const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)
    expect(hex(preimage)).toBe(hex(expected))
    expect(hex(preimage.slice(118, 150))).toBe(hex(hashOutputs))
    expect(hex(preimage.slice(68, 104))).toBe(hex(outpoint))
    expect(hex(Hash.hash256(preimage))).toBe(FIXTURE_HASH256)
    expect(R1C_SIGHASH).toBe(0x41)
  })

  it('signerDigest is reverse(hash256(preimage)) as 64 lowercase hex', () => {
    const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)
    expect(signerDigest(preimage)).toBe(FIXTURE_DIGEST)
    expect(signerDigest(preimage)).toBe(hex([...Hash.hash256(preimage)].reverse()))
    // the script's e is the LE view of hash256 == the BE view of the digest
    expect(beBig(Utils.toArray(FIXTURE_DIGEST, 'hex') as number[])).toBe(beBig([...Hash.hash256(preimage)].reverse()))
  })

  it('a different sourceSatoshis changes only the amount field', () => {
    const a = sighashPreimage(tx, 0, FIXTURE_SATS)
    const b = sighashPreimage(tx, 0, FIXTURE_SATS + 1)
    expect(hex(a.slice(0, 106))).toBe(hex(b.slice(0, 106)))
    expect(hex(a.slice(114))).toBe(hex(b.slice(114)))
    expect(hex(b.slice(106, 114))).toBe('f911000000000000')
  })

  it('rejects a missing input, an input without a source reference, and bad satoshis', () => {
    expect(() => sighashPreimage(tx, 1, FIXTURE_SATS)).toThrow(VaultError)
    const bare = new Transaction(2, [{ sourceOutputIndex: 0, sequence: 0xffffffff }], [], 0)
    expect(() => sighashPreimage(bare, 0, 1000)).toThrow(VaultError)
    expect(() => sighashPreimage(tx, 0, -1)).toThrow(VaultError)
    expect(() => sighashPreimage(tx, 0, 1.5)).toThrow(VaultError)
    expect(() => signerDigest(new Array(157).fill(0))).toThrow(VaultError)
  })
})

describe('OP_PUSH_TX model: pushTxSignatureS / peelLoopNonMinimalAt / pushTxDerCheck', () => {
  const tx = Transaction.fromHex(FIXTURE_TX_HEX)
  const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)

  it('fixture: ok, and s = e_k1 + 2^248 (no wrap, below n/2)', () => {
    const eK1 = beBig(Hash.hash256(preimage))
    expect(eK1).toBe(BigInt('0x' + FIXTURE_HASH256))
    const chk = pushTxDerCheck(preimage)
    expect(chk.ok).toBe(true)
    expect(chk.s).toBe(eK1 + (1n << 248n))
    expect(pushTxSignatureS(preimage)).toBe(chk.s)
    expect(chk.s < (SECP_N - 1n) / 2n).toBe(true)
  })

  it('pushTxSignatureS applies mod n_k1 and the low-S flip', () => {
    // synthetic preimages are fine here: the function only hashes its input
    for (let i = 0; i < 200; i++) {
      const p = Array.from(p256.utils.randomSecretKey())
      const e = beBig(Hash.hash256(p))
      const t = ((e + (1n << 248n)) % SECP_N + SECP_N) % SECP_N
      const expected = t > (SECP_N - 1n) / 2n ? SECP_N - t : t
      expect(pushTxSignatureS(p)).toBe(expected)
      expect(pushTxSignatureS(p) <= (SECP_N - 1n) / 2n).toBe(true)
    }
  })

  // ANALYSIS.md §6.2 boundary table of the peel loop (k = index of the first non-minimal remainder, −1 = ok)
  it.each<[string, bigint, number, number]>([
    ['2^248 − 1', (1n << 248n) - 1n, 32, -1],
    ['2^247',     1n << 247n,        32, -1],
    ['2^247 − 1', (1n << 247n) - 1n, 31, -1],
    ['2^240',     1n << 240n,        31, -1],
    ['2^240 − 1', (1n << 240n) - 1n, 31, 30],
    ['2^239',     1n << 239n,        31, 30],
    ['2^239 − 1', (1n << 239n) - 1n, 30, -1],
    ['2^231',     1n << 231n,        30, 29],
    ['255',       255n,               2,  1],
    ['128',       128n,               2,  1],
    ['127',       127n,               1, -1],
    ['1',         1n,                 1, -1]
  ])('peelLoopNonMinimalAt(scriptNum(%s)) — %i-byte scriptnum → %i', (_n, s, len, k) => {
    const b = scriptNum(s)
    expect(b).toHaveLength(len)
    expect(peelLoopNonMinimalAt(b)).toBe(k)
  })

  it('peelLoopNonMinimalAt: empty remainder is fine; a lone 0x00 or 0x80 is not', () => {
    expect(peelLoopNonMinimalAt([])).toBe(-1)
    expect(peelLoopNonMinimalAt([0x00])).toBe(0)
    expect(peelLoopNonMinimalAt([0x80])).toBe(0)
    expect(peelLoopNonMinimalAt([0x01, 0x00])).toBe(0)   // 1 with a redundant 00: non-minimal as a whole (k = 0)
    expect(peelLoopNonMinimalAt([0xff, 0x00])).toBe(1)   // 255: minimal as a whole; the lone 00 left after one peel is not
    expect(peelLoopNonMinimalAt([0x00, 0x80])).toBe(0)   // −0 with a padded magnitude: non-minimal at k = 0
    expect(peelLoopNonMinimalAt([0x80, 0x00])).toBe(1)   // 128: minimal as a whole; lone 00 at k = 1 (the 2^(8m−1) class)
  })

  it('pushTxDerCheck agrees with the predicate on the boundary classes (ok ⇔ s ≠ 0 ∧ peel = −1)', () => {
    // Pick 4,000 synthetic preimages; every verdict must equal the closed form.
    for (let i = 0; i < 4000; i++) {
      const p = Array.from(p256.utils.randomSecretKey())
      const { ok, s } = pushTxDerCheck(p)
      expect(ok).toBe(s !== 0n && peelLoopNonMinimalAt(scriptNum(s)) === -1)
    }
  })
})

describe('decodeDerSignature', () => {
  it('decodes the fixture signature', () => {
    expect(decodeDerSignature(Utils.toArray(FIXTURE_DER, 'hex') as number[])).toEqual({ r: FIXTURE_R, s: FIXTURE_S })
    expect(hex(Array.from(new p256.Signature(FIXTURE_R, FIXTURE_S).toBytes('der')))).toBe(FIXTURE_DER)
  })

  it("round-trips noble's DER for 200 fresh signatures (low-S and high-S)", () => {
    for (let i = 0; i < 200; i++) {
      const priv = p256.utils.randomSecretKey()
      const digest = p256.utils.randomSecretKey()
      const sig = p256.Signature.fromBytes(p256.sign(digest, priv, { prehash: false, lowS: false }))
      const der = Array.from(sig.toBytes('der'))
      expect(decodeDerSignature(der)).toEqual({ r: sig.r, s: sig.s })
      const flipped = new p256.Signature(sig.r, P256_N - sig.s)
      expect(decodeDerSignature(Array.from(flipped.toBytes('der')))).toEqual({ r: sig.r, s: P256_N - sig.s })
    }
  })

  it.each<[string, number[]]>([
    ['empty', []],
    ['just a SEQUENCE tag', [0x30]],
    ['compact r‖s', Array.from(new p256.Signature(FIXTURE_R, FIXTURE_S).toBytes('compact'))],
    ['trailing byte', [...(Utils.toArray(FIXTURE_DER, 'hex') as number[]), 0x00]],
    ['SEQUENCE length off by one', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d[1] -= 1; return d })()],
    ['negative r (missing 00 pad)', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d.splice(4, 1); d[1] -= 1; d[3] -= 1; return d })()],
    ['non-minimal s (extra 00 pad)', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d.splice(d.length - 32, 0, 0x00); d[1] += 1; d[d.length - 34] += 1; return d })()],
    ['r = 0', Array.from(new p256.Signature(0n, FIXTURE_S).toBytes('der'))],
    ['s = n', (() => { const rInt = Array.from(new p256.Signature(FIXTURE_R, 1n).toBytes('der')).slice(2, 2 + 35); const nBytes = Utils.toArray(P256_N.toString(16), 'hex') as number[]; return [0x30, 70, ...rInt, 0x02, 33, 0x00, ...nBytes] })()],
    ['INTEGER tag replaced', (() => { const d = Utils.toArray(FIXTURE_DER, 'hex') as number[]; d[2] = 0x04; return d })()]
  ])('rejects %s with template-invalid', (_name, der) => {
    expect(() => decodeDerSignature(der)).toThrow(VaultError)
    try { decodeDerSignature(der) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
  })
})
```

- [ ] **Step 4.2: Run — expect failures on the new exports**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts
```
Expected: `TypeError: (0 , _r1comb.sighashPreimage) is not a function` (and the other five); earlier suites pass.

- [ ] **Step 4.3: Implement in `r1comb.ts`**

Change the SDK import to `import { Hash, LockingScript, OP, PrivateKey, Script, Transaction, TransactionSignature, Utils } from '@bsv/sdk'`. Delete the two placeholder lines `void modinv` / `void leToBig` (both helpers are now used). Append after `bakedCommitments`:

```ts
// ───────────────────────── sighash preimage and signer digest (spec §2.5) ─────────────────────────
/** OP_CODESEPARATOR OP_CHECKSIG ⇒ the scriptCode the lock's CHECKSIG hashes is the single byte `ac`. */
const SUBSCRIPT = Script.fromHex('ac')

function requirePreimage(preimage: number[], where: string): void {
  if (!Array.isArray(preimage) || preimage.length !== R1C_PREIMAGE_LEN) {
    throw invalid(`${where}: preimage must be ${R1C_PREIMAGE_LEN} bytes`)
  }
}

/** BIP143 preimage, subscript `ac`, scope 0x41, for input `inputIndex` of `tx` whose source output carried `sourceSatoshis`. 158 bytes. */
export function sighashPreimage(tx: Transaction, inputIndex: number, sourceSatoshis: number): number[] {
  const input = tx.inputs[inputIndex]
  if (input === undefined) throw invalid(`sighashPreimage: input ${inputIndex} does not exist`)
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTXID === undefined) throw invalid('sighashPreimage: input needs sourceTXID or sourceTransaction')
  if (!Number.isSafeInteger(sourceSatoshis) || sourceSatoshis < 0) throw invalid('sighashPreimage: sourceSatoshis must be a non-negative integer')
  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    subscript: SUBSCRIPT,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope: R1C_SIGHASH
  })
  if (preimage.length !== R1C_PREIMAGE_LEN) throw invalid(`sighashPreimage: expected ${R1C_PREIMAGE_LEN} bytes, got ${preimage.length}`)
  return preimage
}

/** reverse(hash256(preimage)) as 64 lowercase hex — the raw digest the P-256 signer signs (the script reads e little-endian). */
export function signerDigest(preimage: number[]): string {
  requirePreimage(preimage, 'signerDigest')
  return Utils.toHex([...Hash.hash256(preimage)].reverse())
}

// ───────────────────────── OP_PUSH_TX model (ANALYSIS.md §6) ─────────────────────────
/** The s the tail assembles: lowS((BE(hash256(preimage)) + 2^248) mod n_k1). r is fixed at Gx (k = 1). */
export function pushTxSignatureS(preimage: number[]): bigint {
  const e = beToBig(Hash.hash256(preimage))
  const t = mod(e + (1n << 248n), SECP_N)
  return t > (SECP_N - 1n) / 2n ? SECP_N - t : t
}

/**
 * Model of the byte-peel loop `(DUP 0NOTEQUAL SPLIT)×31`: it reads the not-yet-peeled remainder of the s scriptnum
 * as a NUMBER at k = 0..30. Returns the first k whose remainder is a non-minimal script number (a trailing 0x00/0x80
 * with no high bit beneath it), or −1 when every remainder is minimal. An empty remainder is fine (== 0).
 */
export function peelLoopNonMinimalAt(sLE: number[]): number {
  for (let k = 0; k <= 30; k++) {
    const rem = sLE.slice(k)
    if (rem.length === 0) continue
    const last = rem[rem.length - 1]
    if ((last & 0x7f) === 0 && (rem.length === 1 || (rem[rem.length - 2] & 0x80) === 0)) return k
  }
  return -1
}

/**
 * D4b screen — evaluate BEFORE asking the card to sign. ok = false when the OP_PUSH_TX s the lock will assemble
 * is zero (2^-256) or peel-nonminimal (2^-16: scriptnum(s) <= 31 bytes ending in a sign byte). Under strict
 * MINIMALDATA such a spend aborts at the peel loop; the remedy is to perturb the transaction (Plan 2 bumps the
 * input's sequence) and re-screen. Pure function of the preimage; independent of the P-256 signature.
 */
export function pushTxDerCheck(preimage: number[]): { ok: boolean; s: bigint } {
  requirePreimage(preimage, 'pushTxDerCheck')
  const s = pushTxSignatureS(preimage)
  if (s === 0n) return { ok: false, s }
  return { ok: peelLoopNonMinimalAt(scriptNum(s)) === -1, s }
}

// ───────────────────────── DER ─────────────────────────
/** Strict DER `SEQUENCE { INTEGER r, INTEGER s }` → (r, s), both in [1, n−1]. Short-form lengths only (max 72 B). */
export function decodeDerSignature(der: number[]): { r: bigint; s: bigint } {
  const fail = (why: string): never => { throw invalid(`decodeDerSignature: ${why}`) }
  if (!Array.isArray(der) || der.length < 8 || der.length > 72) fail('length')
  if (der[0] !== 0x30) fail('not a SEQUENCE')
  if (der[1] !== der.length - 2) fail('bad SEQUENCE length')
  let pos = 2
  const readInt = (): bigint => {
    if (der[pos] !== 0x02) fail('expected INTEGER')
    const len = der[pos + 1]
    if (len === undefined || len === 0 || len > 33 || pos + 2 + len > der.length) fail('bad INTEGER length')
    const body = der.slice(pos + 2, pos + 2 + len)
    if ((body[0] & 0x80) !== 0) fail('negative INTEGER')
    if (len > 1 && body[0] === 0x00 && (body[1] & 0x80) === 0) fail('non-minimal INTEGER')
    pos += 2 + len
    return beToBig(body)
  }
  const r = readInt()
  const s = readInt()
  if (pos !== der.length) fail('trailing bytes')
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) fail('scalar out of range')
  return { r, s }
}
```

- [ ] **Step 4.4: Run — expect PASS**

```bash
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json
```
Expected: all green; the fixture preimage reconstruction, `FIXTURE_HASH256`, `FIXTURE_DIGEST` and the boundary table are the anchors. tsc silent (if tsc reports `'leToBig' is declared but its value is never read`, it is not an error under this tsconfig — `noUnusedLocals` is off — but Task 5 uses it anyway).

- [ ] **Step 4.5: Commit**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/core/services/vault/r1comb.ts packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && git commit -m "feat(expo-wallet-toolbox): r1comb preimage, signer digest, OP_PUSH_TX screen, DER decoder

sighashPreimage reproduces the fixture's 158-byte preimage field by field;
pushTxDerCheck models the peel loop on the ANALYSIS §6.2 boundary table;
decodeDerSignature is strict DER with scalars in [1, n-1].

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `fullR`, `buildUnlock`, `verifyVaultInput`, `R1C_VERIFY_FLAGS`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` (append after `decodeDerSignature`; extend the SDK import to `import { Hash, LockingScript, OP, PrivateKey, Script, Spend, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'`)
- Test: `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` (append)

**Interfaces:**
- Consumes: `new Spend({ sourceTXID, sourceOutputIndex, sourceSatoshis, lockingScript, transactionVersion, otherInputs, outputs, inputIndex, unlockingScript, inputSequence, lockTime, verifyFlags })` and `spend.validate(): boolean` (throws `Error('Script evaluation error: …')` on any failure, including a false top-of-stack — `requireTruthyTopStack`); `p256.Point.fromHex / .BASE / .ZERO / .multiply / .add / .is0 / .toAffine`; `decodeDerSignature`, `compressPubkey`, `combTable`, `recode`, `saltBytes`, `encNum`, `pushData`, `leToBig`, `modinv`, `mod`, `Utils.Reader`.
- Produces: `R1C_VERIFY_FLAGS: readonly string[]`; `fullR(a: { preimage: number[]; rSig: bigint; s: bigint; pubkeyHex33: string }): bigint | null`; `buildUnlock(a: { preimage: number[]; derSig: number[]; pubkeyHex33: string; saltHex64: string }): UnlockingScript`; `verifyVaultInput(a: { tx: Transaction; inputIndex: number; sourceSatoshis: number; lockingScript: LockingScript; unlockingScript: UnlockingScript }): true`.

**Flag set (read from `node_modules/@bsv/sdk/dist/esm/src/script/Spend.js`).** With `verifyFlags` given, `hasExplicitFlags()` is true and every rule becomes flag-driven, independent of `transactionVersion`: `shouldEnforceMinimalData()` ⇔ `MINIMALDATA`; `isAfterGenesis()` ⇔ `GENESIS | UTXO_AFTER_GENESIS | UTXO_AFTER_CHRONICLE` (unbounded script numbers and pushes); `isAfterChronicle()` ⇔ `UTXO_AFTER_CHRONICLE` (`OP_RSHIFTNUM`/`OP_2MUL` execute instead of being skipped — `skipUnavailablePreChronicleOpcode`); `shouldEnforceDerSignatures()`/`shouldEnforceStrictEncoding()` ⇔ `STRICTENC | SIGHASH_FORKID`; `enforceSignatureForkId` requires the FORKID bit when `SIGHASH_FORKID` is set. So the contract's four flags `['MINIMALDATA', 'UTXO_AFTER_CHRONICLE', 'SIGHASH_FORKID', 'STRICTENC']` are exactly what a version-2 R1C spend needs to be judged as strictly as the version-1 fixture was. `CLEANSTACK`, `SIGPUSHONLY`, `LOW_S`, `NULLDUMMY` are NOT set (the contract pins the set; an R1C spend satisfies all four anyway: push-only unlock, one item left, the PUSH_TX s is low-S by construction). Verified on 2026-09-10 with the SDK interpreter: the mined fixture validates under this set; a gen2 version-2 spend validates; a peel-nonminimal version-2 preimage is rejected under this set (`non-minimally encoded script number`) and accepted with no flags — which is the version-2 relaxation the spec-§0 spend proof exists to confirm on a real node.

**Design note — buildUnlock does not pre-verify the signature.** It refuses malformed inputs (preimage length, version ≠ 2, salt, key, DER) and `R = O`, then emits the pushes; the interpreter is the arbiter. Plan 2 runs `verifyVaultInput` on every input before `signAction`, and this keeps the "signature from another key" negative reachable in the interpreter test below.

- [ ] **Step 5.1: Append the failing tests**

Add to the r1comb import list: `fullR, buildUnlock, verifyVaultInput, R1C_VERIFY_FLAGS` and extend the SDK import to `import { BigNumber, Curve, Hash, LockingScript, P2PKH, PrivateKey, Script, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk'`. Append:

```ts
interface Member { priv: Uint8Array; pub: string }
const newMember = (): Member => {
  const priv = p256.utils.randomSecretKey()
  return { priv, pub: Utils.toHex(Array.from(p256.getPublicKey(priv, true))) }
}
const randSalt = (): string => Utils.toHex(Array.from(p256.utils.randomSecretKey()))
const digestBytes = (digestHex: string): Uint8Array => Uint8Array.from(Utils.toArray(digestHex, 'hex') as number[])
/** DER signature over a 64-hex digest, RFC6979, lowS NOT enforced (the card does not normalise either). */
const signDer = (priv: Uint8Array, digestHex: string): number[] =>
  Array.from(p256.Signature.fromBytes(p256.sign(digestBytes(digestHex), priv, { prehash: false, lowS: false })).toBytes('der'))
const p2pkhOut = (): LockingScript => new P2PKH().lock(PrivateKey.fromRandom().toAddress())
const NONCE_OUT = (): LockingScript => new LockingScript(Script.fromASM('OP_RETURN 6e6f6e6365').chunks)

/** Funding stub: `lock` at output `vout` of a zero-input transaction; the other outputs are P2PKH dust. */
function fundingStub(lock: LockingScript, sats: number, vout: number): Transaction {
  const src = new Transaction(1, [], [], 0)
  for (let k = 0; k < vout; k++) src.addOutput({ satoshis: 1, lockingScript: p2pkhOut() })
  src.addOutput({ satoshis: sats, lockingScript: lock })
  return src
}

/** Re-encode one push of an unlocking script (tamper helper); every other chunk is re-emitted minimally. */
function withPush(unlock: UnlockingScript, index: number, data: number[]): UnlockingScript {
  const bytes: number[] = []
  unlock.chunks.forEach((c, i) => {
    if (i === index) bytes.push(...pushData(data))
    else if (c.data !== undefined) bytes.push(...pushData(c.data))
    else bytes.push(c.op)
  })
  return new UnlockingScript(Script.fromBinary(bytes).chunks)
}

/** Preimages of the given vault inputs after the D4b screen: on a failing check, decrement that input's sequence and retry (≤ 16). */
function screenedPreimages(tx: Transaction, vaultInputs: { index: number; sats: number }[]): number[][] {
  for (let attempt = 0; attempt < 16; attempt++) {
    const pres = vaultInputs.map(v => sighashPreimage(tx, v.index, v.sats))
    const bad = pres.findIndex(p => !pushTxDerCheck(p).ok)
    if (bad < 0) return pres
    const inp = tx.inputs[vaultInputs[bad].index]
    inp.sequence = ((inp.sequence ?? 0xffffffff) - 1) >>> 0
  }
  throw new Error('pushTxDerCheck failed 16 times in a row (probability ≈ 2^-256)')
}

const modpowT = (base: bigint, exp: bigint, m: bigint): bigint => {
  let r = 1n
  let b = ((base % m) + m) % m
  let e = exp
  while (e > 0n) { if ((e & 1n) === 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n }
  return r
}
const modinvT = (a: bigint, m: bigint): bigint => modpowT(a, m - 2n, m)

describe('verifyVaultInput flags and the fixture spend', () => {
  it('R1C_VERIFY_FLAGS is exactly the contract set', () => {
    expect([...R1C_VERIFY_FLAGS]).toEqual(['MINIMALDATA', 'UTXO_AFTER_CHRONICLE', 'SIGHASH_FORKID', 'STRICTENC'])
  })

  it('the mined fixture spend (version 1) validates under the strict flags; sourceSatoshis + 1 throws', () => {
    const tx = Transaction.fromHex(FIXTURE_TX_HEX)
    const lock = LockingScript.fromHex(FIXTURE_LOCK_HEX)
    const unlock = tx.inputs[0].unlockingScript!
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: FIXTURE_SATS, lockingScript: lock, unlockingScript: unlock })).toBe(true)
    expect(() => verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: FIXTURE_SATS + 1, lockingScript: lock, unlockingScript: unlock })).toThrow(/Script evaluation error/)
  })

  it('fullR reproduces the fixture r (r < n) and differs for a foreign Q', () => {
    const tx = Transaction.fromHex(FIXTURE_TX_HEX)
    const unlock = tx.inputs[0].unlockingScript!
    const r = fromScriptNum(unlock.chunks[0].data!)
    const s = fromScriptNum(unlock.chunks[1].data!)
    expect(r).toBe(FIXTURE_R)
    expect(s).toBe(FIXTURE_S)
    const preimage = sighashPreimage(tx, 0, FIXTURE_SATS)
    expect(fullR({ preimage, rSig: r, s, pubkeyHex33: FIXTURE_Q })).toBe(r)
    expect(r < P256_N).toBe(true)
    expect(fullR({ preimage, rSig: r, s, pubkeyHex33: newMember().pub })).not.toBe(r)
    expect(() => fullR({ preimage, rSig: r, s: 0n, pubkeyHex33: FIXTURE_Q })).toThrow(VaultError)
    expect(() => fullR({ preimage: preimage.slice(1), rSig: r, s, pubkeyHex33: FIXTURE_Q })).toThrow(VaultError)
  })
})

describe('round trips through Spend (version 2, strict flags)', () => {
  it('25 rounds: random N in 1..5, signer index, salt, sats <= 2^40, vout, 1-3 outputs, sequence, lockTime', () => {
    for (let round = 0; round < 25; round++) {
      const N = 1 + Math.floor(Math.random() * 5)
      const members = [...Array(N)].map(newMember)
      const salt = randSalt()                                    // one salt per output (spec §2.7)
      const lock = buildLock({ commitments: members.map(m => commitment(m.pub, salt)) })
      const signer = members[Math.floor(Math.random() * N)]
      const sats = Number(1n + (BigInt('0x' + randSalt()) & ((1n << 40n) - 1n)))
      const vout = Math.floor(Math.random() * 3)
      const src = fundingStub(lock, sats, vout)
      const final = Math.random() < 0.5
      const sequence = final ? 0xffffffff : (Math.random() < 0.5 ? 0xfffffffe : Math.floor(Math.random() * 0xfffffffe))
      const lockTime = final ? 0 : Math.floor(Math.random() * 800_000)
      const nOut = 1 + Math.floor(Math.random() * 3)
      const tx = new Transaction(2, [], [], lockTime)
      tx.addInput({ sourceTransaction: src, sourceOutputIndex: vout, sequence })
      tx.addOutput({ satoshis: Math.max(1, sats - 500), lockingScript: p2pkhOut() })
      if (nOut >= 2) tx.addOutput({ satoshis: 100, lockingScript: NONCE_OUT() })
      if (nOut >= 3) tx.addOutput({ satoshis: 200, lockingScript: p2pkhOut() })
      const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
      expect(hex(preimage.slice(0, 4))).toBe('02000000')
      const unlock = buildUnlock({ preimage, derSig: signDer(signer.priv, signerDigest(preimage)), pubkeyHex33: signer.pub, saltHex64: salt })
      expect(unlock.chunks).toHaveLength(71)
      expect(unlock.toBinary().length).toBeLessThanOrEqual(2539)
      expect(unlock.toBinary().length).toBeLessThanOrEqual(R1C_UNLOCK_LEN)
      expect(hex(unlock.chunks[67].data!)).toBe(salt)
      expect(hex(unlock.chunks[70].data!)).toBe(hex(preimage))
      // pushes #1/#2 are the recoded scalars for the pushed r and e
      const r = fromScriptNum(unlock.chunks[0].data!)
      const s = fromScriptNum(unlock.chunks[68].data!)
      const sInv = fromScriptNum(unlock.chunks[69].data!)
      expect((s * sInv) % P256_N).toBe(1n)
      const e = beBig(Utils.toArray(signerDigest(preimage), 'hex') as number[])
      expect(fromScriptNum(unlock.chunks[1].data!)).toBe(recode((r * sInv) % P256_N))
      expect(fromScriptNum(unlock.chunks[2].data!)).toBe(recode((e * sInv) % P256_N))
      tx.inputs[0].unlockingScript = unlock
      expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
    }
  })

  it('2 vault inputs (different keys, salts, locks) + 1 P2PKH input signed by tx.sign()', async () => {
    const a = newMember(), b = newMember(), c = newMember()
    const saltA = randSalt(), saltB = randSalt()
    const lockA = buildLock({ commitments: [commitment(a.pub, saltA), commitment(b.pub, saltA)] })   // N = 2, signer b
    const lockB = buildLock({ commitments: [commitment(c.pub, saltB)] })                             // N = 1, signer c
    const satsA = 40_000, satsB = 25_000, satsP = 7_000
    const srcA = fundingStub(lockA, satsA, 0)
    const srcB = fundingStub(lockB, satsB, 2)
    const p2pkhPriv = PrivateKey.fromRandom()
    const p2pkhLock = new P2PKH().lock(p2pkhPriv.toAddress())
    const srcP = fundingStub(p2pkhLock, satsP, 1)
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: srcA, sourceOutputIndex: 0, sequence: 0xffffffff })
    tx.addInput({ sourceTransaction: srcP, sourceOutputIndex: 1, sequence: 0xffffffff, unlockingScriptTemplate: new P2PKH().unlock(p2pkhPriv, 'all', false, satsP, p2pkhLock) })
    tx.addInput({ sourceTransaction: srcB, sourceOutputIndex: 2, sequence: 0xffffffff })
    tx.addOutput({ satoshis: satsA + satsB + satsP - 1000, lockingScript: p2pkhOut() })
    tx.addOutput({ satoshis: 100, lockingScript: NONCE_OUT() })
    const [preA, preB] = screenedPreimages(tx, [{ index: 0, sats: satsA }, { index: 2, sats: satsB }])
    tx.inputs[0].unlockingScript = buildUnlock({ preimage: preA, derSig: signDer(b.priv, signerDigest(preA)), pubkeyHex33: b.pub, saltHex64: saltA })
    tx.inputs[2].unlockingScript = buildUnlock({ preimage: preB, derSig: signDer(c.priv, signerDigest(preB)), pubkeyHex33: c.pub, saltHex64: saltB })
    await tx.sign()   // signs only the templated input; inputs without a template are left as set
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: satsA, lockingScript: lockA, unlockingScript: tx.inputs[0].unlockingScript! })).toBe(true)
    expect(verifyVaultInput({ tx, inputIndex: 2, sourceSatoshis: satsB, lockingScript: lockB, unlockingScript: tx.inputs[2].unlockingScript! })).toBe(true)
    // the P2PKH input validates under the same strict flags
    const p2pkhSpend = new Spend({
      sourceTXID: srcP.id('hex'), sourceOutputIndex: 1, sourceSatoshis: satsP, lockingScript: p2pkhLock,
      transactionVersion: 2, otherInputs: [tx.inputs[0], tx.inputs[2]], outputs: tx.outputs, inputIndex: 1,
      unlockingScript: tx.inputs[1].unlockingScript!, inputSequence: 0xffffffff, lockTime: 0, verifyFlags: [...R1C_VERIFY_FLAGS]
    })
    expect(p2pkhSpend.validate()).toBe(true)
    // the two vault preimages share everything but outpoint (68..104) and amount (106..114)
    expect(hex(preA.slice(0, 68))).toBe(hex(preB.slice(0, 68)))
    expect(hex(preA.slice(114))).toBe(hex(preB.slice(114)))
    expect(hex(preA.slice(68, 104))).not.toBe(hex(preB.slice(68, 104)))
  })

  it('accepts both the low-S and the high-S form of one signature', () => {
    const m = newMember()
    const salt = randSalt()
    const lock = buildLock({ commitments: [commitment(m.pub, salt)] })
    const sats = 12_345
    const src = fundingStub(lock, sats, 0)
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 12_000, lockingScript: p2pkhOut() })
    const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    const { r, s } = decodeDerSignature(signDer(m.priv, signerDigest(preimage)))
    const low = s <= (P256_N - 1n) / 2n ? s : P256_N - s
    const high = P256_N - low
    expect(high > (P256_N - 1n) / 2n).toBe(true)
    for (const sv of [low, high]) {
      const unlock = buildUnlock({ preimage, derSig: Array.from(new p256.Signature(r, sv).toBytes('der')), pubkeyHex33: m.pub, saltHex64: salt })
      expect(fromScriptNum(unlock.chunks[68].data!)).toBe(sv)
      expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
    }
  })

  it('a key whose comb table has a sub-2^248 coordinate (31-byte push) spends', () => {
    let found: Member | null = null
    for (let tries = 0; tries < 200 && found === null; tries++) {
      const m = newMember()
      if (combTable(m.pub).some(pt => pt.x < (1n << 248n) || pt.y < (1n << 248n))) found = m
    }
    if (found === null) {
      // ≈ 22 % of keys have a short coordinate, so 200 misses has probability ≈ 0.78^200 ≈ 2^-71.
      console.warn('r1comb.test: no 31-byte coordinate in 200 random keys — skipping the short-coordinate round trip')
      return
    }
    const salt = randSalt()
    const lock = buildLock({ commitments: [commitment(found.pub, salt)] })
    const sats = 22_222
    const src = fundingStub(lock, sats, 1)
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 22_000, lockingScript: p2pkhOut() })
    const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    const unlock = buildUnlock({ preimage, derSig: signDer(found.priv, signerDigest(preimage)), pubkeyHex33: found.pub, saltHex64: salt })
    expect(unlock.chunks.slice(3, 67).some(ch => ch.data!.length <= 31)).toBe(true)
    expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
  })

  it('constructed R.x >= n (review4-rgen port): the full x is required and accepted, x mod n is rejected', () => {
    const p = P256_P, n = P256_N, b = p256.Point.CURVE().b
    const sats = 31_337
    const tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTXID: randSalt(), sourceOutputIndex: 2, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 31_000, lockingScript: p2pkhOut() })
    const [preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    const digest = signerDigest(preimage)
    const e = beBig(Utils.toArray(digest, 'hex') as number[])
    for (let round = 0; round < 2; round++) {
      // R with x in [n, n + 2^120) ⊂ [n, p): y = sqrt(x³ − 3x + b) via the p ≡ 3 (mod 4) exponent
      let x = 0n, y = 0n
      for (;;) {
        x = n + BigInt('0x' + Utils.toHex(Array.from(p256.utils.randomSecretKey()).slice(0, 15)))
        const rhs = (((x * x * x - 3n * x + b) % p) + p) % p
        y = modpowT(rhs, (p + 1n) / 4n, p)
        if ((y * y) % p === rhs) break
      }
      const R = p256.Point.fromAffine({ x, y })
      R.assertValidity()
      const rSig = x % n
      expect(rSig).toBe(x - n)
      const s = BigInt('0x' + randSalt()) % n
      const sInv = modinvT(s, n)
      const u1 = (e * sInv) % n
      const u2 = (rSig * sInv) % n
      const Q = R.subtract(p256.Point.BASE.multiply(u1)).multiply(modinvT(u2, n))   // Q = (R − u1·G)·u2⁻¹
      Q.assertValidity()
      const qHex = Q.toHex(true)
      const sig = new p256.Signature(rSig, s)
      expect(p256.verify(sig.toBytes('compact'), digestBytes(digest), Q.toBytes(true), { prehash: false, lowS: false })).toBe(true)
      expect(fullR({ preimage, rSig, s, pubkeyHex33: qHex })).toBe(x)
      const salt = randSalt()
      const lock = buildLock({ commitments: [commitment(qHex, salt)] })
      const unlock = buildUnlock({ preimage, derSig: Array.from(sig.toBytes('der')), pubkeyHex33: qHex, saltHex64: salt })
      expect(hex(unlock.chunks[0].data!)).toBe(hex(scriptNum(x)))
      expect(fromScriptNum(unlock.chunks[0].data!) >= n).toBe(true)
      expect(verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })).toBe(true)
      const modN = withPush(unlock, 0, scriptNum(rSig))
      expect(() => verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: modN })).toThrow(/Script evaluation error/)
    }
  })
})

describe('negatives — each must throw from verifyVaultInput (or buildUnlock where stated)', () => {
  const a = newMember(), b = newMember(), outsider = newMember()
  const salt = randSalt()
  const lock = buildLock({ commitments: [commitment(a.pub, salt), commitment(b.pub, salt)] })
  const sats = 50_000
  const src = fundingStub(lock, sats, 1)
  const verify = (tx: Transaction, unlock: UnlockingScript): true =>
    verifyVaultInput({ tx, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: unlock })
  let tx: Transaction
  let preimage: number[]
  let good: UnlockingScript

  beforeAll(() => {
    tx = new Transaction(2, [], [], 0)
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    tx.addOutput({ satoshis: 49_000, lockingScript: p2pkhOut() })
    tx.addOutput({ satoshis: 100, lockingScript: NONCE_OUT() })
    ;[preimage] = screenedPreimages(tx, [{ index: 0, sats }])
    good = buildUnlock({ preimage, derSig: signDer(b.priv, signerDigest(preimage)), pubkeyHex33: b.pub, saltHex64: salt })
    expect(verify(tx, good)).toBe(true)   // positive control
  })

  it('wrong salt (fails at H5)', () => {
    const u = buildUnlock({ preimage, derSig: signDer(b.priv, signerDigest(preimage)), pubkeyHex33: b.pub, saltHex64: randSalt() })
    expect(() => verify(tx, u)).toThrow(/Script evaluation error/)
  })

  it('key not committed: outsider signs with its own table and the right salt (H5)', () => {
    const u = buildUnlock({ preimage, derSig: signDer(outsider.priv, signerDigest(preimage)), pubkeyHex33: outsider.pub, saltHex64: salt })
    expect(() => verify(tx, u)).toThrow(/Script evaluation error/)
  })

  it('one table coordinate + 1 (H5)', () => {
    const x0 = fromScriptNum(good.chunks[3].data!)
    expect(() => verify(tx, withPush(good, 3, scriptNum(x0 + 1n)))).toThrow(/Script evaluation error/)
  })

  it("signature from another key, presented as b's (tail r-check)", () => {
    const u = buildUnlock({ preimage, derSig: signDer(outsider.priv, signerDigest(preimage)), pubkeyHex33: b.pub, saltHex64: salt })
    expect(() => verify(tx, u)).toThrow(/Script evaluation error/)
  })

  it('r + 1 (H3: pushed u2\' no longer matches)', () => {
    const r = fromScriptNum(good.chunks[0].data!)
    expect(() => verify(tx, withPush(good, 0, scriptNum(r + 1n)))).toThrow(/Script evaluation error/)
  })

  it('s + 1 with a stale sInv (H1)', () => {
    const s = fromScriptNum(good.chunks[68].data!)
    expect(() => verify(tx, withPush(good, 68, scriptNum(s + 1n)))).toThrow(/Script evaluation error/)
  })

  it('a flipped preimage byte (final CHECKSIG)', () => {
    const p = [...preimage]
    p[120] ^= 1
    expect(() => verify(tx, withPush(good, 70, p))).toThrow(/Script evaluation error/)
  })

  it('preimage of another input: same lock, same key, same salt on both inputs — only OP_PUSH_TX can reject', () => {
    const src2 = fundingStub(lock, sats + 7, 0)
    const tx2 = new Transaction(2, [], [], 0)
    tx2.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    tx2.addInput({ sourceTransaction: src2, sourceOutputIndex: 0, sequence: 0xffffffff })
    tx2.addOutput({ satoshis: 2 * sats - 1000, lockingScript: p2pkhOut() })
    const [p0, p1] = screenedPreimages(tx2, [{ index: 0, sats }, { index: 1, sats: sats + 7 }])
    const u0 = buildUnlock({ preimage: p0, derSig: signDer(a.priv, signerDigest(p0)), pubkeyHex33: a.pub, saltHex64: salt })
    const u1 = buildUnlock({ preimage: p1, derSig: signDer(a.priv, signerDigest(p1)), pubkeyHex33: a.pub, saltHex64: salt })
    expect(verifyVaultInput({ tx: tx2, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: u0 })).toBe(true)
    expect(verifyVaultInput({ tx: tx2, inputIndex: 1, sourceSatoshis: sats + 7, lockingScript: lock, unlockingScript: u1 })).toBe(true)
    expect(() => verifyVaultInput({ tx: tx2, inputIndex: 0, sourceSatoshis: sats, lockingScript: lock, unlockingScript: u1 })).toThrow(/Script evaluation error/)
    expect(() => verifyVaultInput({ tx: tx2, inputIndex: 1, sourceSatoshis: sats + 7, lockingScript: lock, unlockingScript: u0 })).toThrow(/Script evaluation error/)
  })

  it('version-1 transaction: buildUnlock refuses with template-invalid and a message naming the version', () => {
    const v1 = new Transaction(1, [], [], 0)
    v1.addInput({ sourceTransaction: src, sourceOutputIndex: 1, sequence: 0xffffffff })
    v1.addOutput({ satoshis: 49_000, lockingScript: p2pkhOut() })
    const p = sighashPreimage(v1, 0, sats)
    expect(hex(p.slice(0, 4))).toBe('01000000')
    let err: unknown
    try { buildUnlock({ preimage: p, derSig: signDer(b.priv, signerDigest(p)), pubkeyHex33: b.pub, saltHex64: salt }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(VaultError)
    expect((err as VaultError).code).toBe('template-invalid')
    expect((err as VaultError).message).toMatch(/version/)
  })

  it('buildUnlock rejects a short preimage, a bad salt, a bad key and garbage DER with template-invalid', () => {
    const der = signDer(b.priv, signerDigest(preimage))
    for (const bad of [
      () => buildUnlock({ preimage: preimage.slice(1), derSig: der, pubkeyHex33: b.pub, saltHex64: salt }),
      () => buildUnlock({ preimage, derSig: der, pubkeyHex33: b.pub, saltHex64: salt.slice(2) }),
      () => buildUnlock({ preimage, derSig: der, pubkeyHex33: '02' + 'ff'.repeat(32), saltHex64: salt }),
      () => buildUnlock({ preimage, derSig: der.slice(1), pubkeyHex33: b.pub, saltHex64: salt })
    ]) {
      expect(bad).toThrow(VaultError)
      try { bad() } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
    }
  })

  it('verifyVaultInput rejects a missing input with template-invalid', () => {
    expect(() => verifyVaultInput({ tx, inputIndex: 3, sourceSatoshis: sats, lockingScript: lock, unlockingScript: good })).toThrow(VaultError)
  })
})
```

- [ ] **Step 5.2: Run — expect failures on the new exports**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts
```
Expected: `TypeError: (0 , _r1comb.verifyVaultInput) is not a function` / `buildUnlock` / `fullR`, and `R1C_VERIFY_FLAGS` undefined; Tasks 1–4 suites pass.

- [ ] **Step 5.3: Implement in `r1comb.ts`**

Change the SDK import to `import { Hash, LockingScript, OP, PrivateKey, Script, Spend, Transaction, TransactionSignature, UnlockingScript, Utils } from '@bsv/sdk'` and append after `decodeDerSignature`:

```ts
// ───────────────────────── strict verification flags ─────────────────────────
/**
 * Explicit @bsv/sdk Spend flags. With flags given, every rule is flag-driven and ignores the transaction
 * version: MINIMALDATA (minimal pushes and script numbers — the rule the OP_PUSH_TX peel loop can trip),
 * UTXO_AFTER_CHRONICLE (post-Genesis limits off, OP_RSHIFTNUM/OP_2MUL live), SIGHASH_FORKID + STRICTENC
 * (strict DER, defined hash type, FORKID required). A version-2 vault spend is judged exactly as strictly as
 * the version-1 mined fixture.
 */
export const R1C_VERIFY_FLAGS: readonly string[] = ['MINIMALDATA', 'UTXO_AFTER_CHRONICLE', 'SIGHASH_FORKID', 'STRICTENC']

// ───────────────────────── fullR / buildUnlock (spec §2.4) ─────────────────────────
/**
 * R = u1·G + u2·Q for e = LE(hash256(preimage)), u1 = e·s⁻¹, u2 = rSig·s⁻¹ (mod n).
 * Returns the FULL affine x (in [0, p)), or null if R is the point at infinity. Throws on s ≡ 0.
 */
export function fullR(a: { preimage: number[]; rSig: bigint; s: bigint; pubkeyHex33: string }): bigint | null {
  requirePreimage(a.preimage, 'fullR')
  const Q = p256.Point.fromHex(compressPubkey(a.pubkeyHex33))
  const s = mod(a.s, P256_N)
  if (s === 0n) throw invalid('fullR: s ≡ 0 (mod n)')
  const e = leToBig(Hash.hash256(a.preimage))
  const sInv = modinv(s, P256_N)
  const u1 = mod(e * sInv, P256_N)
  const u2 = mod(a.rSig * sInv, P256_N)
  const R = (u1 === 0n ? p256.Point.ZERO : p256.Point.BASE.multiply(u1)).add(u2 === 0n ? p256.Point.ZERO : Q.multiply(u2))
  if (R.is0()) return null
  return R.toAffine().x
}

/**
 * The 71-push unlocking script: r, u2', u1', 64 coords of table(Q), salt, s, s⁻¹, preimage (spec §2.4).
 * Refuses: wrong preimage length, preimage version ≠ 2 (spec §2.6 — Plan 2 maps this to 'bad-version' upstream),
 * bad salt / key / DER, R = O. It does NOT verify the signature against Q: the interpreter is the arbiter
 * (Plan 2 runs verifyVaultInput on every input before signAction).
 */
export function buildUnlock(a: { preimage: number[]; derSig: number[]; pubkeyHex33: string; saltHex64: string }): UnlockingScript {
  const { preimage } = a
  requirePreimage(preimage, 'buildUnlock')
  const version = new Utils.Reader(preimage.slice(0, 4)).readUInt32LE()
  if (version !== 2) throw invalid(`buildUnlock: withdrawals are version-2 transactions; this preimage carries version ${version}`)
  const salt = saltBytes(a.saltHex64)
  const key = compressPubkey(a.pubkeyHex33)
  const { r: rSig, s } = decodeDerSignature(a.derSig)
  const Rx = fullR({ preimage, rSig, s, pubkeyHex33: key })
  if (Rx === null) throw invalid('buildUnlock: R is the point at infinity')
  const e = leToBig(Hash.hash256(preimage))
  const sInv = modinv(s, P256_N)
  const u1 = mod(e * sInv, P256_N)
  const u2 = mod(Rx * sInv, P256_N)   // the lock derives u2 from the PUSHED r (≡ rSig mod n), so recode that
  const bytes: number[] = [...encNum(Rx), ...encNum(recode(u2)), ...encNum(recode(u1))]
  for (const { x, y } of combTable(key)) bytes.push(...encNum(x), ...encNum(y))
  bytes.push(...pushData(salt), ...encNum(s), ...encNum(sInv), ...pushData(preimage))
  if (bytes.length > R1C_UNLOCK_LEN) throw invalid(`buildUnlock: ${bytes.length} bytes exceeds R1C_UNLOCK_LEN`)
  return new UnlockingScript(Script.fromBinary(bytes).chunks)
}

// ───────────────────────── strict local verification ─────────────────────────
/** Run @bsv/sdk Spend with R1C_VERIFY_FLAGS for one input. Returns true or throws the interpreter's error. */
export function verifyVaultInput(a: {
  tx: Transaction
  inputIndex: number
  sourceSatoshis: number
  lockingScript: LockingScript
  unlockingScript: UnlockingScript
}): true {
  const { tx, inputIndex } = a
  const input = tx.inputs[inputIndex]
  if (input === undefined) throw invalid(`verifyVaultInput: input ${inputIndex} does not exist`)
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTXID === undefined) throw invalid('verifyVaultInput: input needs sourceTXID or sourceTransaction')
  const spend = new Spend({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: a.sourceSatoshis,
    lockingScript: a.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    unlockingScript: a.unlockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    verifyFlags: [...R1C_VERIFY_FLAGS]
  })
  if (spend.validate() !== true) throw invalid('verifyVaultInput: script evaluated to false')
  return true
}
```

- [ ] **Step 5.4: Run — expect PASS (this file now takes ~40–60 s)**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json
```
Expected: all green. Every `verifyVaultInput(...)` positive is a full 23k-step run of the SDK interpreter under strict flags (~40 ms each); the negatives throw `Script evaluation error: …` from inside the interpreter. tsc silent.

- [ ] **Step 5.5: Commit**

```bash
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/core/services/vault/r1comb.ts packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && git commit -m "feat(expo-wallet-toolbox): r1comb fullR, buildUnlock, verifyVaultInput with strict flags

71-push unlock per spec 2.4; version-2 only; Spend run with MINIMALDATA,
UTXO_AFTER_CHRONICLE, SIGHASH_FORKID, STRICTENC. Round trips: fixture, 25
random rounds, 2 vault + P2PKH inputs, high-S/low-S, 31-byte coordinate,
constructed R.x >= n; negatives for salt, key, table, foreign sig, cross-input.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `VaultInstructionsV4` codec — `encodeVaultInstructions` / `decodeVaultInstructions`

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts` (append after `verifyVaultInput`)
- Test: `packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` (append)

**Interfaces:**
- Consumes: `compressPubkey`, `R1C_MAX_KEYS`, `invalid`, `JSON`.
- Produces: `interface VaultInstructionsV4 { v: 4; type: 'R1C'; salt: string; keys: string[] }`; `type VaultInstructions = VaultInstructionsV4`; `encodeVaultInstructions(i: VaultInstructionsV4): string`; `decodeVaultInstructions(ci?: string): VaultInstructionsV4 | null`.

**Decisions (fail closed, spec §2.7):** `decode` returns `null` unless the record is a JSON object with exactly `v === 4`, `type === 'R1C'`, `salt` = 64 **lowercase** hex, `keys` = 1..5 distinct **lowercase** 33-byte compressed P-256 points that decompress (`compressPubkey(k) === k`), and the string is ≤ 4096 chars. Uppercase is **rejected, not normalised** — `encode` only ever writes lowercase (its inputs are `compressPubkey` outputs and `Utils.toHex` salts), so an uppercase record is corruption, not a legitimate alias. `encode` is equally strict: it throws `VaultError('template-invalid')` rather than write a record `decode` would refuse. Extra JSON fields are ignored by `decode` and never written by `encode`. Key order is preserved (commitment order, informational).

- [ ] **Step 6.1: Append the failing tests**

Add to the r1comb import list: `encodeVaultInstructions, decodeVaultInstructions` and `type VaultInstructionsV4`. Append:

```ts
describe('customInstructions v4 codec', () => {
  const keys5 = [...Array(5)].map(() => newMember().pub)
  const salt = randSalt()

  it.each([1, 2, 3, 4, 5])('round-trips %i keys in order and writes the canonical field order', n => {
    const rec: VaultInstructionsV4 = { v: 4, type: 'R1C', salt, keys: keys5.slice(0, n) }
    const s = encodeVaultInstructions(rec)
    expect(s).toBe(JSON.stringify({ v: 4, type: 'R1C', salt, keys: keys5.slice(0, n) }))
    expect(s.length).toBeLessThan(4096)
    expect(decodeVaultInstructions(s)).toEqual(rec)
  })

  it('ignores extra fields and accepts a re-ordered object', () => {
    const s = JSON.stringify({ keys: [keys5[0]], extra: 1, type: 'R1C', salt, v: 4 })
    expect(decodeVaultInstructions(s)).toEqual({ v: 4, type: 'R1C', salt, keys: [keys5[0]] })
  })

  it.each<[string, string | undefined]>([
    ['undefined', undefined],
    ['empty', ''],
    ['not JSON', 'not json'],
    ['{}', '{}'],
    ['[]', '[]'],
    ['null', 'null'],
    ['a string', JSON.stringify('R1C')],
    ['v3 K1 record', JSON.stringify({ v: 3, type: 'K1', keyID: 'bip32/7' })],
    ['v2 R1K1 record', JSON.stringify({ v: 2, type: 'R1K1', keyID: 'bip32/7', salt: 'aa', r1PublicKey: 'bb', slot: 130 })],
    ['v4 with type K1', JSON.stringify({ v: 4, type: 'K1', salt, keys: [keys5[0]] })],
    ['v 5', JSON.stringify({ v: 5, type: 'R1C', salt, keys: [keys5[0]] })],
    ['v as string', JSON.stringify({ v: '4', type: 'R1C', salt, keys: [keys5[0]] })],
    ['missing salt', JSON.stringify({ v: 4, type: 'R1C', keys: [keys5[0]] })],
    ['salt 62 hex', JSON.stringify({ v: 4, type: 'R1C', salt: salt.slice(2), keys: [keys5[0]] })],
    ['salt 66 hex', JSON.stringify({ v: 4, type: 'R1C', salt: salt + '00', keys: [keys5[0]] })],
    ['salt not hex', JSON.stringify({ v: 4, type: 'R1C', salt: 'zz'.repeat(32), keys: [keys5[0]] })],
    ['salt uppercase', JSON.stringify({ v: 4, type: 'R1C', salt: salt.toUpperCase(), keys: [keys5[0]] })],
    ['0 keys', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [] })],
    ['6 keys', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [...keys5, newMember().pub] })],
    ['keys not an array', JSON.stringify({ v: 4, type: 'R1C', salt, keys: keys5[0] })],
    ['key uppercase', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0].toUpperCase()] })],
    ['key uncompressed (65 B)', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [Utils.toHex(Array.from(p256.getPublicKey(p256.utils.randomSecretKey(), false)))] })],
    ['key off-curve', JSON.stringify({ v: 4, type: 'R1C', salt, keys: ['02' + 'ff'.repeat(32)] })],
    ['key wrong prefix', JSON.stringify({ v: 4, type: 'R1C', salt, keys: ['05' + keys5[0].slice(2)] })],
    ['key too short', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0].slice(0, 64)] })],
    ['duplicate keys', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0], keys5[0]] })],
    ['non-string key', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [1] })],
    ['over 4096 chars', JSON.stringify({ v: 4, type: 'R1C', salt, keys: [keys5[0]], pad: 'x'.repeat(4100) })]
  ])('fails closed on %s', (_name, ci) => {
    expect(decodeVaultInstructions(ci)).toBeNull()
  })

  it('encode refuses what decode would refuse', () => {
    for (const bad of [
      { v: 4, type: 'R1C', salt, keys: [] },
      { v: 4, type: 'R1C', salt, keys: [...keys5, newMember().pub] },
      { v: 4, type: 'R1C', salt: salt.toUpperCase(), keys: [keys5[0]] },
      { v: 4, type: 'R1C', salt, keys: [keys5[0].toUpperCase()] },
      { v: 4, type: 'R1C', salt: 'ab', keys: [keys5[0]] },
      { v: 4, type: 'R1C', salt, keys: [keys5[0], keys5[0]] }
    ] as VaultInstructionsV4[]) {
      expect(() => encodeVaultInstructions(bad)).toThrow(VaultError)
      try { encodeVaultInstructions(bad) } catch (e) { expect((e as VaultError).code).toBe('template-invalid') }
    }
  })
})
```

- [ ] **Step 6.2: Run — expect failures on the new exports**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts -t 'customInstructions v4 codec'
```
Expected: `TypeError: (0 , _r1comb.encodeVaultInstructions) is not a function` and `decodeVaultInstructions is not a function`.

- [ ] **Step 6.3: Implement in `r1comb.ts`**

Append after `verifyVaultInput`:

```ts
// ───────────────────────── customInstructions v4 (spec §2.7) ─────────────────────────
/** What a vault output records about itself. `keys` are the pubkeys whose commitments the lock bakes, in commitment order. */
export interface VaultInstructionsV4 {
  v: 4
  type: 'R1C'
  /** 32-byte salt shared by every commitment in this output, 64 lowercase hex. */
  salt: string
  /** 1..5 compressed P-256 pubkeys, 66 lowercase hex each, commitment order. */
  keys: string[]
}
export type VaultInstructions = VaultInstructionsV4

const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4096

/**
 * Parse an output's customInstructions, or null for anything that is not exactly a v4 R1C record with a valid
 * lowercase salt and 1..5 distinct, valid, lowercase compressed keys. Fails closed on purpose: an undecodable
 * record is an output the app cannot construct a spend for, and ignoring it beats building a doomed transaction.
 * v3 `K1` and v2 `R1K1` records are rejected here.
 */
export function decodeVaultInstructions(ci?: string): VaultInstructionsV4 | null {
  if (typeof ci !== 'string' || ci.length === 0 || ci.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(ci)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const p = parsed as Record<string, unknown>
  if (p.v !== 4 || p.type !== 'R1C') return null
  if (typeof p.salt !== 'string' || !/^[0-9a-f]{64}$/.test(p.salt)) return null
  if (!Array.isArray(p.keys) || p.keys.length < 1 || p.keys.length > R1C_MAX_KEYS) return null
  const keys: string[] = []
  for (const k of p.keys) {
    if (typeof k !== 'string' || !/^0[23][0-9a-f]{64}$/.test(k)) return null
    try {
      if (compressPubkey(k) !== k) return null
    } catch {
      return null
    }
    keys.push(k)
  }
  if (new Set(keys).size !== keys.length) return null
  return { v: 4, type: 'R1C', salt: p.salt, keys }
}

/** Serialise a v4 record. Throws VaultError('template-invalid') rather than write anything decodeVaultInstructions would refuse. */
export function encodeVaultInstructions(i: VaultInstructionsV4): string {
  const s = JSON.stringify({ v: 4, type: 'R1C', salt: i.salt, keys: i.keys })
  if (decodeVaultInstructions(s) === null) throw invalid('encodeVaultInstructions: record would not decode (salt/keys must be valid lowercase hex, 1..5 distinct keys)')
  return s
}
```

- [ ] **Step 6.4: Run — expect PASS**

```bash
npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json
```
Expected: all green, tsc silent. (`encodeVaultInstructions`/`decodeVaultInstructions`/`VaultInstructions` are also exported by `k1.ts`; there is no clash yet because `core/index.ts` still re-exports `k1`, not `r1comb` — Task 7 swaps that.)

- [ ] **Step 6.5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/services/vault/r1comb.ts packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts && git commit -m "feat(expo-wallet-toolbox): r1comb customInstructions v4 codec, fail-closed

{ v: 4, type: 'R1C', salt, keys[1..5] }; lowercase-only, on-curve keys, no
duplicates, <= 4096 chars; v3 K1 and v2 R1K1 records decode to null; encode
refuses anything decode would.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `scripts/r1c-spend-proof.ts`, then retire K1 (`k1.ts`, `k1.test.ts`, `k1-spend-proof.ts`, `core/index.ts:269`)

**DEPENDENCY — read before starting. Execution order (binding, see the "## Execution order" section above): P1 Tasks 1–6 → P2 Tasks 1–11 → P1 Task 7 (this task) → P2 Task 12 → Plan 3.** Steps 7.1–7.3 (the spend-proof script) depend only on Tasks 1–6 and can run immediately. Steps 7.4–7.7 (the deletions and the `core/index.ts` switch) run **ONLY after ALL of Plan 2's Tasks 1–11 have landed** — not merely the transfers rewrite — because `docs/superpowers/plans/2026-09-09-r1-comb-vault-plan-2-services.md`'s Task 12 runs strictly after this task, never before, and (per its own File Structure and Task 12 preamble) does not touch `k1.ts` or `core/index.ts:269`. Today both files import `./k1` (`K1_UNLOCK_LEN`, `buildVaultLockingScript`, `decodeVaultInstructions`, `encodeVaultInstructions`, `VaultInstructions` at `transfers.ts:50–56`; `transfers.test.ts:19`); deleting `k1.ts` before Plan 2's transfers rewrite (its Tasks 9–11) breaks `tsc` and the transfers tests. Step 7.4 is a hard gate that checks this. Plan 2's File Structure no longer lists `k1.ts`/`k1.test.ts` under "Delete" — this task owns that deletion, and the `core/index.ts` r1comb export switch, exclusively.

**Files:**
- Create: `scripts/r1c-spend-proof.ts`
- Modify: `packages/expo-wallet-toolbox/core/index.ts` line 269: `export * from './services/vault/k1'` → `export * from './services/vault/r1comb'`
- Delete: `packages/expo-wallet-toolbox/core/services/vault/k1.ts`, `packages/expo-wallet-toolbox/__tests__/vault/k1.test.ts`, `scripts/k1-spend-proof.ts`

**Interfaces:**
- Consumes (from `r1comb.ts`, by relative path so the script does not depend on the `core/index.ts` switch): `R1C_LOCK_LEN`, `R1C_UNLOCK_LEN`, `buildLock`, `bakedCommitments`, `commitment`, `compressPubkey`, `sighashPreimage`, `signerDigest`, `pushTxDerCheck`, `buildUnlock`, `verifyVaultInput`, `encodeVaultInstructions`. From `@bsv/sdk`: `ARC(url, { apiKey }?)`, `tx.broadcast(arc): Promise<BroadcastResponse | BroadcastFailure>` (`status: 'success' | 'error'`), `SatoshisPerKilobyte`, `P2PKH().lock/unlock`, `PrivateKey.fromWif`, `Transaction`. From `@noble/curves/nist.js`: `p256`.
- Produces: the CLI. Usage `FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]`. `tsx` is not a devDependency of this repo (`package.json` has no `tsx`; the existing `pdf` script also relies on `npx tsx`) — `npx` fetches it.

No jest test for the script: its building blocks are the module tested in Tasks 1–6, its output is network acceptance, and the only local gate is the typecheck in Step 7.2.

- [ ] **Step 7.1: Create `scripts/r1c-spend-proof.ts`**

```ts
/**
 * R1C spend proof — spec §0 step 1, software-key half. Proves the EXACT shipped template
 * (packages/expo-wallet-toolbox/core/services/vault/r1comb.ts) is accepted by a real network before the vault
 * feature flag is turned on. Two software P-256 keys stand in for the YubiKeys: what is under test is the
 * script's acceptance by the network, not the hardware. Replaces scripts/k1-spend-proof.ts.
 *
 * Usage:
 *   FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]
 *
 * FUNDING_UTXO is a P2PKH output the WIF controls, discovered out of band (block explorer), the same convention
 * the deleted r1k1-spend-proof.ts used. Everything else comes from argv. Run once without FUNDING_UTXO to print
 * the address to fund.
 *
 * Funds: 100,000 sat per deposit; every spend returns to the funding address, so the balance only shrinks by
 * fees. Peak lock = 3 deposits alive at once (300,000 sat) + ~25,000 sat of fees at 100 sat/kB over 7 deposits
 * (~28 KB each, the 28 KB lock is in the OUTPUT) and 5 spends (2.7–8 KB) → fund >= 400,000 sat.
 *
 * Sequence (every txid printed; summary at the end for the spec changelog):
 *   D1 deposit (N = 2: keys A, B)  → S1 spend by A (1-in / 1-out, version 2)
 *   D2 deposit                     → S2 spend by B
 *   D3, D4, D5 deposits            → S3 3-input spend by A
 *   D6 deposit                     → S4 mixed spend: D6 + a wallet P2PKH input, signer B (output > vault input)
 *   D7 deposit                     → S5 spend by A whose vault input's sequence was GROUND until
 *                                    pushTxDerCheck(preimage).ok === false. The strict local interpreter MUST
 *                                    reject it (MINIMALDATA) and the network MUST accept it — that is the
 *                                    version-2 relaxation the design relies on (spec §1 D4).
 * Every other spend must pass verifyVaultInput locally; the script aborts on the first local or ARC rejection.
 * Spends chain on unconfirmed parents — fine for ARC (mempool chains).
 */
import { ARC, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, Utils } from '@bsv/sdk'
import type { LockingScript } from '@bsv/sdk'
import { p256 } from '@noble/curves/nist.js'
import {
  R1C_LOCK_LEN,
  R1C_UNLOCK_LEN,
  buildLock,
  bakedCommitments,
  commitment,
  compressPubkey,
  sighashPreimage,
  signerDigest,
  pushTxDerCheck,
  buildUnlock,
  verifyVaultInput,
  encodeVaultInstructions
} from '../packages/expo-wallet-toolbox/core/services/vault/r1comb'

const [, , wif, arcUrl, arcApiKey] = process.argv
if (!wif || !arcUrl) {
  console.error('usage: FUNDING_UTXO=<txid>:<vout>:<satoshis> npx tsx scripts/r1c-spend-proof.ts <fundingWIF> <arcUrl> [arcApiKey]')
  process.exit(1)
}

const VAULT_SATS = 100_000
/** Spec §2.6: fee model unchanged (100 sat/kB). */
const FEE_SAT_PER_KB = 100
/** Measured P2PKH unlock: push(<=72-byte DER) + push(33-byte pubkey). */
const P2PKH_UNLOCK_LEN = 107
/** Expected ≈ 65,536 tries at 2^-16 each; 2^21 leaves a 2^-46 chance of missing. */
const GRIND_MAX = 1 << 21

interface Coin {
  tx: Transaction
  vout: number
  satoshis: number
  /** Real chain txid when `tx` is only a stand-in (the initial FUNDING_UTXO). */
  txid?: string
}
interface VaultCoin extends Coin {
  lock: LockingScript
  salt: string
}
interface SoftKey {
  name: 'A' | 'B'
  priv: Uint8Array
  pub: string
}

const funding = PrivateKey.fromWif(wif)
const fundingLock = new P2PKH().lock(funding.toAddress())
const broadcaster = arcApiKey ? new ARC(arcUrl, { apiKey: arcApiKey }) : new ARC(arcUrl)

function softKey(name: 'A' | 'B'): SoftKey {
  const priv = p256.utils.randomSecretKey()
  // 65-byte SEC1 in → compressed out: the same path the card's public key takes in the app
  return { name, priv, pub: compressPubkey(Utils.toHex(Array.from(p256.getPublicKey(priv, false)))) }
}
const keyA = softKey('A')
const keyB = softKey('B')

/** P2PKH outputs the funding key controls: change outputs and returned spends. */
const wallet: Coin[] = []
const txids: string[] = []

function fundingInput(c: Coin) {
  return {
    sourceTXID: c.txid,
    sourceTransaction: c.tx,
    sourceOutputIndex: c.vout,
    sequence: 0xffffffff,
    unlockingScriptTemplate: new P2PKH().unlock(funding, 'all', false, c.satoshis, fundingLock)
  }
}

function takeLargestWalletCoin(): Coin {
  if (wallet.length === 0) throw new Error('no wallet coins left')
  wallet.sort((a, b) => b.satoshis - a.satoshis)
  return wallet.splice(0, 1)[0]
}

async function broadcast(label: string, tx: Transaction): Promise<void> {
  const res = await tx.broadcast(broadcaster)
  if (res.status !== 'success') throw new Error(`${label}: ARC rejected the transaction: ${JSON.stringify(res)}`)
  const id = tx.id('hex')
  txids.push(`${label}: ${id}`)
  console.log(`${label}: broadcast OK txid ${id} (${tx.toBinary().length} B)`)
}

/** Consolidate every wallet coin into one N = 2 vault output (version 1, spec §2.6) + change. */
async function deposit(label: string): Promise<VaultCoin> {
  const salt = Utils.toHex(Array.from(p256.utils.randomSecretKey())) // fresh 32-byte salt per output (spec §2.2, §2.7)
  const commitments = [keyA, keyB].map(k => commitment(k.pub, salt))
  const lock = buildLock({ commitments })
  const lockLen = lock.toBinary().length
  if (lockLen !== R1C_LOCK_LEN(2)) throw new Error(`template drift: lock is ${lockLen} B, expected ${R1C_LOCK_LEN(2)} — aborting before any funds move`)
  const baked = bakedCommitments(lock)
  if (baked.join(',') !== commitments.join(',')) throw new Error('bakedCommitments does not round-trip the commitments')
  console.log(`\n${label}: lock ${lockLen} B; customInstructions ${encodeVaultInstructions({ v: 4, type: 'R1C', salt, keys: [keyA.pub, keyB.pub] })}`)

  const coins = wallet.splice(0)
  if (coins.length === 0) throw new Error(`${label}: no wallet coins to fund the deposit`)
  const tx = new Transaction(1, [], [], 0)
  for (const c of coins) tx.addInput(fundingInput(c))
  tx.addOutput({ satoshis: VAULT_SATS, lockingScript: lock })
  tx.addOutput({ lockingScript: fundingLock, change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_SAT_PER_KB))
  await tx.sign()
  const change = tx.outputs[1].satoshis
  if (change === undefined) throw new Error(`${label}: fee() left the change amount unset`)
  await broadcast(label, tx)
  wallet.push({ tx, vout: 1, satoshis: change })
  return { tx, vout: 0, satoshis: VAULT_SATS, lock, salt }
}

interface SpendOptions {
  signer: SoftKey
  /** Add one wallet P2PKH input; the single output then exceeds the vault inputs (spec §0: "withdraw slightly more"). */
  extraP2PKH?: boolean
  /** Grind input 0's sequence until pushTxDerCheck FAILS, then broadcast anyway (single vault input only). */
  grindPeelFail?: boolean
}

/** Version-2 spend of `vaults` to the funding address; local strict verification, then broadcast. */
async function spend(label: string, vaults: VaultCoin[], o: SpendOptions): Promise<void> {
  if (o.grindPeelFail === true && vaults.length !== 1) throw new Error('grind mode is single-input')
  const tx = new Transaction(2, [], [], 0) // withdrawals are version 2 (spec §2.6)
  for (const v of vaults) tx.addInput({ sourceTransaction: v.tx, sourceOutputIndex: v.vout, sequence: 0xffffffff })
  let p2pkhSats = 0
  if (o.extraP2PKH === true) {
    const c = takeLargestWalletCoin()
    tx.addInput(fundingInput(c))
    p2pkhSats = c.satoshis
  }
  const vaultTotal = vaults.reduce((s, v) => s + v.satoshis, 0)
  const size = 10 + vaults.length * (41 + 3 + R1C_UNLOCK_LEN) + (o.extraP2PKH === true ? 41 + 1 + P2PKH_UNLOCK_LEN : 0) + (8 + 1 + 25)
  const fee = Math.ceil((size * FEE_SAT_PER_KB) / 1000)
  const outSats = vaultTotal + p2pkhSats - fee
  if (o.extraP2PKH === true && outSats <= vaultTotal) throw new Error(`${label}: mixed spend must withdraw more than the vault inputs cover`)
  tx.addOutput({ satoshis: outSats, lockingScript: fundingLock })

  // D4b screen (spec §4.2): every vault preimage must pass pushTxDerCheck — bump the failing input's sequence
  // (each bump changes hashSequence, so all preimages are recomputed). Grind mode inverts the goal.
  const vaultIdx = vaults.map((_, i) => i)
  let preimages: number[][] = []
  if (o.grindPeelFail === true) {
    let found = false
    for (let k = 0; k < GRIND_MAX; k++) {
      tx.inputs[0].sequence = (0xfffffffe - k) >>> 0
      const p = sighashPreimage(tx, 0, vaults[0].satoshis)
      const chk = pushTxDerCheck(p)
      if (!chk.ok) {
        preimages = [p]
        found = true
        console.log(`${label}: sequence 0x${(tx.inputs[0].sequence ?? 0).toString(16)} makes the OP_PUSH_TX s peel-nonminimal after ${k + 1} tries (s = 0x${chk.s.toString(16)})`)
        break
      }
    }
    if (!found) throw new Error(`${label}: no failing sequence in ${GRIND_MAX} tries`)
  } else {
    for (let attempt = 0; ; attempt++) {
      preimages = vaultIdx.map(i => sighashPreimage(tx, i, vaults[i].satoshis))
      const bad = preimages.findIndex(p => !pushTxDerCheck(p).ok)
      if (bad < 0) break
      if (attempt >= 16) throw new Error(`${label}: pushTxDerCheck failed 16 times in a row`)
      console.log(`${label}: input ${bad} failed the OP_PUSH_TX screen (2^-16 event); bumping its sequence`)
      tx.inputs[bad].sequence = ((tx.inputs[bad].sequence ?? 0xffffffff) - 1) >>> 0
    }
  }

  // Sign each vault input with the software key — the card would receive exactly signerDigest(preimage).
  for (const i of vaultIdx) {
    const digest = signerDigest(preimages[i])
    const compact = p256.sign(Uint8Array.from(Utils.toArray(digest, 'hex') as number[]), o.signer.priv, { prehash: false, lowS: false })
    const der = Array.from(p256.Signature.fromBytes(compact).toBytes('der'))
    const unlock = buildUnlock({ preimage: preimages[i], derSig: der, pubkeyHex33: o.signer.pub, saltHex64: vaults[i].salt })
    const len = unlock.toBinary().length
    if (len > R1C_UNLOCK_LEN) throw new Error(`${label}: unlock is ${len} B > R1C_UNLOCK_LEN`)
    tx.inputs[i].unlockingScript = unlock
    console.log(`${label}: input ${i} signed by key ${o.signer.name}; unlock ${len} B`)
  }
  if (o.extraP2PKH === true) await tx.sign() // signs the templated P2PKH input only; vault inputs are left as set

  // Strict local verification (the same flags the app uses before signAction).
  for (const i of vaultIdx) {
    let ok = false
    let err = ''
    try {
      ok = verifyVaultInput({ tx, inputIndex: i, sourceSatoshis: vaults[i].satoshis, lockingScript: vaults[i].lock, unlockingScript: tx.inputs[i].unlockingScript! })
    } catch (e) {
      err = (e as Error).message.split('\n')[0]
    }
    if (o.grindPeelFail === true) {
      if (ok) throw new Error(`${label}: expected the strict interpreter to REJECT the constructed spend; it passed — nothing was proven`)
      console.log(`${label}: strict local Spend rejects as designed: ${err}`)
    } else if (!ok) {
      throw new Error(`${label}: input ${i} failed local strict verification: ${err}`)
    }
  }
  console.log(`${label}: tx ${tx.toBinary().length} B, ${tx.inputs.length} inputs, output ${outSats} sat${o.extraP2PKH === true ? ` (> ${vaultTotal} vault sat)` : ''}`)
  await broadcast(label, tx)
  wallet.push({ tx, vout: 0, satoshis: outSats })
}

async function main(): Promise<void> {
  console.log('funding address:', funding.toAddress())
  const FUNDING_UTXO = process.env.FUNDING_UTXO
  if (!FUNDING_UTXO) {
    console.error('\nFund the address above (>= 400,000 sat), then set FUNDING_UTXO=<txid>:<vout>:<satoshis> and re-run.')
    process.exit(1)
  }
  const [fTxid, fVout, fSats] = FUNDING_UTXO.split(':')
  if (!/^[0-9a-f]{64}$/i.test(fTxid ?? '') || !/^\d+$/.test(fVout ?? '') || !/^\d+$/.test(fSats ?? '')) {
    throw new Error('FUNDING_UTXO must be <64-hex txid>:<vout>:<satoshis>')
  }
  // fee()/sign()/EF serialisation read sourceTransaction.outputs[vout]; build a stand-in holding the one real output.
  const stub = new Transaction(1, [], [], 0)
  for (let i = 0; i < Number(fVout); i++) stub.addOutput({ satoshis: 0, lockingScript: fundingLock })
  stub.addOutput({ satoshis: Number(fSats), lockingScript: fundingLock })
  wallet.push({ tx: stub, vout: Number(fVout), satoshis: Number(fSats), txid: fTxid.toLowerCase() })
  console.log(`funding UTXO ${fTxid}:${fVout} ${fSats} sat`)
  console.log(`key A ${keyA.pub}\nkey B ${keyB.pub}`)

  const d1 = await deposit('D1')
  await spend('S1 (A, 1-in/1-out)', [d1], { signer: keyA })
  const d2 = await deposit('D2')
  await spend('S2 (B, 1-in/1-out)', [d2], { signer: keyB })
  const d3 = await deposit('D3')
  const d4 = await deposit('D4')
  const d5 = await deposit('D5')
  await spend('S3 (A, 3 vault inputs)', [d3, d4, d5], { signer: keyA })
  const d6 = await deposit('D6')
  await spend('S4 (B, vault + P2PKH input)', [d6], { signer: keyB, extraP2PKH: true })
  const d7 = await deposit('D7')
  await spend('S5 (A, constructed peel-nonminimal, version 2)', [d7], { signer: keyA, grindPeelFail: true })

  console.log('\n--- summary (record in docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md changelog) ---')
  for (const t of txids) console.log(t)
  console.log('\nPASS: all seven deposits and five version-2 spends accepted, including the peel-nonminimal one.')
}

main().catch(e => {
  console.error('\nspend proof FAILED:', e instanceof Error ? e.message : e)
  if (txids.length > 0) {
    console.error('txids broadcast before the failure:')
    for (const t of txids) console.error('  ' + t)
  }
  process.exit(1)
})
```

- [ ] **Step 7.2: Typecheck the script and dry-run the usage error**

```bash
cd /Users/personal/git/bsv-wallet && npx tsc --noEmit --strict --skipLibCheck --target es2022 --module preserve --moduleResolution bundler --types node scripts/r1c-spend-proof.ts
```
Expected: no output (exit 0). (Equivalent, slower: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'scripts/r1c-spend-proof'` → empty; the root tsconfig includes `scripts/**`.) Then:

```bash
cd /Users/personal/git/bsv-wallet && npx tsx scripts/r1c-spend-proof.ts; echo "exit $?"
```
Expected: the usage line on stderr and `exit 1` (no network, no funds touched). Running it for real is the spec §0 gate, done by the operator on testnet then mainnet; the txids go into the spec changelog.

- [ ] **Step 7.3: Commit the script**

```bash
cd /Users/personal/git/bsv-wallet && git add scripts/r1c-spend-proof.ts && git commit -m "feat(scripts): r1c-spend-proof — spec §0 software-key network proof

Seven N=2 deposits and five version-2 spends through ARC: per-key spends, a
3-input spend, a vault+P2PKH mixed spend, and a sequence-ground spend whose
OP_PUSH_TX s is peel-nonminimal (rejected by the strict local interpreter,
must be accepted by the network). Prints every txid.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7.4: GATE — confirm nothing but `core/index.ts` and `k1.test.ts` still imports `k1`**

```bash
cd /Users/personal/git/bsv-wallet && grep -rn "from './k1'\|from \"./k1\"\|vault/k1'" packages/expo-wallet-toolbox/core packages/expo-wallet-toolbox/ui packages/expo-wallet-toolbox/__tests__ scripts app
```
Expected EXACTLY (line numbers may drift):
```
packages/expo-wallet-toolbox/core/index.ts:269:export * from './services/vault/k1'
packages/expo-wallet-toolbox/__tests__/vault/k1.test.ts:5:} from '../../core/services/vault/k1'
```
If `core/services/vault/transfers.ts` or `__tests__/vault/transfers.test.ts` appear: **STOP here** — Plan 2's Tasks 1–11 have not all landed yet (per the Execution order, this task never runs until they have); leave Steps 7.5–7.7 unchecked and finish the plan at Step 7.3.

- [ ] **Step 7.5: Delete the K1 module, its test and its spend proof**

```bash
cd /Users/personal/git/bsv-wallet && git rm packages/expo-wallet-toolbox/core/services/vault/k1.ts packages/expo-wallet-toolbox/__tests__/vault/k1.test.ts scripts/k1-spend-proof.ts
```

- [ ] **Step 7.6: Switch the package export**

In `packages/expo-wallet-toolbox/core/index.ts` replace the single line

```ts
export * from './services/vault/k1'
```
with
```ts
export * from './services/vault/r1comb'
```
(Per the Execution order, Plan 2's Task 12 always runs AFTER this task, so it never races this switch.) The re-exported names now include `encodeVaultInstructions`, `decodeVaultInstructions`, `VaultInstructions` from `r1comb` — the same names `k1` exported, with the v4 types — plus every other `r1comb` export; no other module in `core/index.ts` exports those names (`grep -n "VaultInstructions" packages/expo-wallet-toolbox/core/index.ts` shows only the one `export *`).

- [ ] **Step 7.7: Prove nothing else references K1, then run the gates**

```bash
cd /Users/personal/git/bsv-wallet && grep -rn "vault/k1\|from './k1'\|K1_LOCK_LEN\|K1_UNLOCK_LEN\|buildVaultLockingScript\|k1-spend-proof" packages/expo-wallet-toolbox/core packages/expo-wallet-toolbox/ui packages/expo-wallet-toolbox/__tests__ scripts app; echo "grep exit $?"
```
Expected: no matching lines, `grep exit 1`.

```bash
cd /Users/personal/git/bsv-wallet && npx tsc --noEmit -p packages/expo-wallet-toolbox/tsconfig.json && npx jest packages/expo-wallet-toolbox/__tests__/vault
```
Expected: tsc silent (this is the compile-time proof that no remaining `core/` or `ui/` file imports `k1`); every test under `__tests__/vault` green (including Plan 2's rewritten `transfers.test.ts`).

```bash
cd /Users/personal/git/bsv-wallet && git add -A packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/core/services/vault/k1.ts packages/expo-wallet-toolbox/__tests__/vault/k1.test.ts scripts/k1-spend-proof.ts && git commit -m "refactor(expo-wallet-toolbox)!: retire the K1 vault module in favour of r1comb

Delete core/services/vault/k1.ts, its test and scripts/k1-spend-proof.ts;
core/index.ts re-exports r1comb (v4 customInstructions codec replaces v3).
Requires Plan 2's transfers rewrite (no remaining ./k1 importer; tsc clean).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.**

| Spec item | Where in this plan |
|---|---|
| §2.1 comb table `T_j`, 32 affine points, minimal scriptnum coordinates, G table constant, Q table memoised, never persisted | Task 2 (`combTableScalar`, `gTable`, `combTable` + 8-entry cache; asserted against fixture chunks 87–214) |
| §2.2 `le33`, `canonical(table)` 2,112 B, `commitment = hash160(salt ‖ canonical)`, 32-byte salt enforced by the app | Task 2 (`le33`, `canonicalTableBytes`, `commitment`, `saltBytes`; pinned sha256/commitments) |
| §2.3 lock layout H0–H5, G table, pre-loop, byte-identical comb loop, tail; sizes 27,855 / 27,831 + 25N; `R1C_LOCK_LEN` exact; `bakedCommitments` | Task 1 (`R1C_LOCK_LEN`), Task 3 (`emitHeaderPrefix`, `emitH5`, `sharedSuffix` == fixture `[87..150] ++ [215..end]`, lengths and chunk counts N = 1..5, pinned sha256 for N = 1, 2, dummy-pubkey chunk, `bakedCommitments` round trip + fail-closed) |
| §2.4 71-push unlock (r = full x, u2', u1', 64 coords, salt, s, s⁻¹, preimage), `recode`, `R1C_UNLOCK_LEN = 2560`, hard max 2,539 | Task 3 (`recode`), Task 5 (`buildUnlock`; 71 chunks, ≤ 2,539 B, pushes #1/#2 checked against `recode`, `R.x ≥ n` constructed case pushes the full x) |
| §2.5 preimage = `TransactionSignature.format(subscript 'ac', scope 0x41)`, signer digest = `reverse(hash256)`, DER in, s⁻¹ = s^(n−2), high-S accepted | Task 4 (`sighashPreimage` reconstructed field by field on the fixture, `signerDigest`, `decodeDerSignature`), Task 5 (`fullR`, `buildUnlock`, high-S/low-S round trip) |
| §2.6 version-2 withdrawals; `buildUnlock` refuses version ≠ 2; sighash 0x41 only; any sequence/lockTime/index/count | Task 5 (version-1 → `template-invalid` with "version" in the message; 25 random rounds vary sequence/lockTime/vout/outputs; 3-input mixed test) |
| §2.7 customInstructions v4, fail closed, v3 rejected, ≤ 4096 chars | Task 6 |
| §4.2 step "pushTxDerCheck for each; bump `sequenceNumber` on failure" (the pure predicate) | Task 4 (`pushTxSignatureS`, `peelLoopNonMinimalAt` on the §6.2 boundary table, `pushTxDerCheck`), Task 5/7 (`screenedPreimages` / the screen loop in the CLI) |
| §4.2 step "buildUnlock + verifyVaultInput per input" with strict flags | Task 5 (`R1C_VERIFY_FLAGS`, `verifyVaultInput`; fixture validates under the set; interpreter-verified 2026-09-10 that a peel-nonminimal v2 preimage is rejected under the set and accepted relaxed) |
| §7 Golden: lengths, pinned sha256s, shared suffix, `bakedCommitments` round trip | Task 3 |
| §7 Round trip: random keys, N = 1..5, each member can spend (random signer index), 1–3 vault inputs mixed with P2PKH, version 2, random sequence/lockTime/amounts, high-S and low-S, constructed `x ≥ n`, 31-byte coordinates, `pushTxDerCheck` agreement with the interpreter | Task 5 (all but "agreement on constructed failing preimages under v1 strict flags" — covered as the v2-under-explicit-flags rejection, which is the case the app actually hits; the peel model itself is unit-tested on the boundary table in Task 4) |
| §7 Negative: uncommitted key, wrong salt, tampered table, foreign signature, cross-input preimage, v1 refused by `buildUnlock`, v3 customInstructions rejected | Task 5 negatives (+ r + 1, s + 1, flipped preimage, sourceSatoshis + 1), Task 6 |
| §7 Codec fail-closed | Task 6 |
| §0 step 1 software-key spend proof: N = 2, one spend per key, 3-input, mixed vault + P2PKH (output > vault), all version 2, one constructed peel-nonminimal v2 spend, every txid printed | Task 7 Steps 7.1–7.3 |
| §5.3 deletions owned by Plan 1: `k1.ts`, `k1.test.ts`, `k1-spend-proof.ts`, `core/index.ts:269` | Task 7 Steps 7.4–7.7 (gated on ALL of Plan 2's Tasks 1–11 landing; runs before Plan 2's Task 12 — see Execution order) |

**Deliberately left to Plan 2 / Plan 3 (not gaps).**
- `'bad-version'` error code and the `abortAction` + re-create loop around `pushTxDerCheck`: Plan 2 (`types.ts`, `transfers.ts`). Plan 1 surfaces version ≠ 2 as `'template-invalid'` from `buildUnlock` (Global Constraints).
- Integration with `createAction`/`signAction`, BEEF parsing, `bakedCommitments`-vs-`commitment` check before signing, ceremony, store: Plan 2.
- Any UI, i18n, routes, `vaultEnabled` gate: Plan 3 / Plan 2.
- The hardware half of spec §0 (two real YubiKeys, 32-input NFC withdrawal): a dev build, after Plans 2–3.
- Real-node confirmation of the version-2 MINIMALDATA relaxation: only the network run of Task 7's script can give it; the SDK interpreter is the sole local oracle (ANALYSIS.md §11.1).

**Cross-plan overlaps to be aware of.**
- Resolved: the Execution order section fixes a single global sequence (P1 Tasks 1–6 → P2 Tasks 1–11 → P1 Task 7 → P2 Task 12 → Plan 3), so there is no longer a race for the `k1` deletion or the `core/index.ts` switch. Plan 2's File Structure no longer lists `k1.ts`/`k1.test.ts` as deletions or the `core/index.ts` `r1comb` export under its Task 12 — Task 7 owns both exclusively, always running first.
- Task 7's script reads `FUNDING_UTXO` from the environment (the convention of the deleted `r1k1-spend-proof.ts`, and the only practical way to hand it a UTXO), while the Global Constraints say the script "takes everything from argv". The `process.env` ban is scoped to `packages/expo-wallet-toolbox`; the script lives at the repo root. Flagged, not resolved.

**Placeholder scan.** Every referenced symbol is defined in the contract or in a code block above (`emitHeaderPrefix`, `emitH5`, `emitAdd`, `emitCombLoop`, `emitTail`, `derIntBytes`, `pushTxPubKey`, `requirePreimage`, `SUBSCRIPT`, `K_Q`, `K_CONSTS`, `BELOW`, `scalarDepth`, `tableBase`, test helpers `fakeCommitment`, `fromScriptNum`, `beBig`, `newMember`, `randSalt`, `digestBytes`, `signDer`, `p2pkhOut`, `NONCE_OUT`, `fundingStub`, `withPush`, `screenedPreimages`, `modpowT`, `modinvT`, `GOLDEN_*`, `FIXTURE_*`, `PUSH_TX_PUBKEY`). The two sha256 goldens and the dummy pubkey are real values computed from `gen2.mjs` / ANALYSIS.md §6.1 on 2026-09-10, not fill-ins. No TBD/TODO remains; each task ends in a commit whose last line is the required trailer.
