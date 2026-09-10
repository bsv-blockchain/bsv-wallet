# R1C Vault UI (Plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the K1/passphrase vault UI with the 1-of-N YubiKey vault UI — sequential multi-key enrollment wizard, key management screen with coverage badges and re-lock, key-chosen withdrawals with the new confirmations and post-transfer alerts, one error-copy table, all twelve locales, and the `vaultEnabled` host flag wired through the home button, the Settings row, `app/_layout.tsx` and `eas.json`.

**Architecture:** Everything here lives under `packages/expo-wallet-toolbox/ui` (screens, `components/vault`, `hooks`) plus three host files at the repo root. The UI consumes the Plan 1 template module and the Plan 2 services purely through the `@bsv/expo-wallet-toolbox` core barrel, by the names in the Interface Contract below; it never touches SQLite, the driver or the ceremony directly. Copy is i18n-only (`i18n.t`), errors flow through one `vaultErrorCopy(code, params)` helper, and native-module-boundary packages (expo-router, @expo/vector-icons) are required lazily exactly as the existing screens do.

**Tech Stack:** React Native 0.8x / Expo 55, expo-router, TypeScript strict, react-i18next (via the package's `i18n` instance), `@testing-library/react-native` 13 on `jest-expo` 55, `@bsv/sdk` types only.

**Spec:** `/Users/personal/git/bsv-wallet/docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md` — this plan covers §3.3 (wizard), §3.4 (managing keys), §4.1–4.3 user-visible parts, §4.4 copy merge, §5.2 UI lines, §5.3 UI deletions, §5.4, §5.5. The interface contract is reproduced verbatim below so the plan is self-contained.

## Execution order

Runs after Plan 1 Tasks 1–6, Plan 2 Tasks 1–11, Plan 1 Task 7, Plan 2 Task 12 — in that order.

## Global Constraints

- Repo root: `/Users/personal/git/bsv-wallet`; package root: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox`. All paths below are absolute.
- Run jest from the REPO ROOT: `cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/<file>`.
- Type-check the package with `cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json` (TypeScript `strict: true`, `include: ["core/**/*", "ui/**/*"]`).
- No `process.env` anywhere inside `packages/expo-wallet-toolbox` — the host reads env and passes it to `configureToolbox` (see `core/toolboxConfig.ts` header comment). `vaultEnabled` is read via `isVaultEnabled()` only.
- Curve: NIST P-256. `R1C_UNLOCK_LEN = 2560`. `R1C_LOCK_LEN(n)` = 27855 (n=1), 27831 + 25n (2 ≤ n ≤ 5). `VAULT_DEPOSIT_MIN = 100_000` sat. `VAULT_MAX_INPUTS = 32`. `VAULT_INPUTS_PER_TAP = 16`. `VAULT_MIN_KEYS = 2`, `VAULT_MAX_KEYS = 5` (`R1C_MAX_KEYS = 5`). Withdrawals/re-locks are transaction **version 2** (services' concern; the UI never sets version). Vault meta is **v5**; customInstructions are **v4**. PIV slot `0x82`.
- Twelve locales in `core/i18n/translations.tsx`, in this order and at these starting lines (pre-change): en 101, zh 805, hi 1442, es 2103, fr 2774, ar 3449, pt 4095, bn 4764, ru 5425, id 6092, ja 6759, pl 7436. The parity test `__tests__/i18n/translationParity.test.ts` checks (a) identical key sets, (b) identical `{{placeholder}}` sets, (c) no copy identical to English unless allow-listed.
- Follow the observed patterns: lazy `require('expo-router')` / `require('@expo/vector-icons')` inside `loadExpoRouter()` / `loadIonicons()` in every ui file that needs them; copy via `const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string`; `showAlert({ title, message, buttons: [{ text, key, style }] })` resolves to the pressed button's `key`; `showToast(msg, { type })`; `useWallet()` gives `{ managers, adminOriginator, storage, txStatusVersion, settings }`; `ExchangeRateContext` gives `{ satoshisPerUSD, usdToFiat }`; `formatAmount(sats, currency, satoshisPerUSD, { usdToFiat })`.
- Component tests use `@testing-library/react-native` (present at repo root `package.json` devDependencies, `^13.3.3`) and mock `@bsv/expo-wallet-toolbox` with a factory that spreads `jest.requireActual('../../core/theme/tokens')` for `spacing`/`radii`/`typography` and stubs `useTheme`, `i18n`, hooks and services — the shape `__tests__/ui/walletHomeBackup.test.tsx` uses.
- Commit after every task with a conventional-commit message whose last line is exactly:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Plans 1 and 2 must be merged (or their modules present) before Task 2 onward compiles: this plan imports `enrollKey`, `finalizeEnrollment`, `addVaultKey`, `disableVault`, `vaultStore`, `getVaultKeyCoverage`, `depositToVault`, `withdrawFromVault`, `relockVault`, `estimateRelockFee`, `R1C_LOCK_LEN`, `VAULT_DEPOSIT_MIN`, `isVaultEnabled`, `setMockPresentKey`, `getMockPresentKey`, `type VaultKeyRecord`, `type VaultMeta`, `type VaultKeyCoverage`, `type VaultSpendResult`, `type EnrollPhase` from the core barrel.

## File Structure

| Action | Path (under `/Users/personal/git/bsv-wallet/`) | Responsibility |
|---|---|---|
| Modify | `packages/expo-wallet-toolbox/core/i18n/translations.tsx` | Add the new vault keys and change the model-dependent copy in all 12 locales (Task 1); delete the dead keys in all 12 locales (Task 10) |
| Modify | `packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts` | Allow-list the one format-only key |
| Create | `packages/expo-wallet-toolbox/ui/components/vault/vaultErrorCopy.ts` | Single `VaultErrorCode → copy` table (merges `ERROR_COPY` + `translateVaultError`) |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/vaultErrorCopy.test.ts` | Unit tests for the table |
| Create | `packages/expo-wallet-toolbox/ui/hooks/useExportWalletData.ts` | Shared export-wallet-data action + spinner state |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/useExportWalletData.test.ts` | Hook tests |
| Modify | `packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx` | Use the hook instead of `handleExportData`; DEV mock present-key selector |
| Create | `packages/expo-wallet-toolbox/ui/hooks/useVaultCoverage.ts` | Reads `getVaultKeyCoverage` on mount / txStatusVersion / refresh |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/useVaultCoverage.test.ts` | Hook tests |
| Create | `packages/expo-wallet-toolbox/ui/components/vault/KeyChooser.tsx` | Radio list of enrolled keys, `nickname · …serialTail4` |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/keyChooser.test.tsx` | Component test |
| Rewrite | `packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx` | §3.3 wizard, modes `enroll` / `add-key` |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx` | Finish gating, duplicate serial, leave-confirm, pending survives remount |
| Modify | `packages/expo-wallet-toolbox/ui/components/vault/VaultCeremonySheet.tsx` | Progress from `state.progress`; copy via `vaultErrorCopy` |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/vaultCeremonySheet.test.tsx` | Progress line + error copy |
| Rewrite | `packages/expo-wallet-toolbox/ui/screens/VaultScreen.tsx` | §3.4 keys list, badges, add/remove/rename/re-lock, export row, footnote, disable, four states |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx` | Re-lock badge, Add hidden at 5, remove confirmation buttons, flag-off hero |
| Rewrite | `packages/expo-wallet-toolbox/ui/screens/VaultTransferScreen.tsx` | Key chooser, floor/fee line, remainder + first-deposit confirms, backup-off alert, post-transfer alerts |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/vaultTransferScreen.test.tsx` | Remainder confirm, chosen serial, unreachable alert |
| Modify | `packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx` | Vault button rendered only when `isVaultEnabled()` |
| Modify | `packages/expo-wallet-toolbox/__tests__/ui/walletHomeBackup.test.tsx` | Add `isVaultEnabled` to its toolbox mock |
| Create | `packages/expo-wallet-toolbox/__tests__/ui/walletHomeVaultGate.test.tsx` | Button hidden when flag off, shown when on |
| Modify | `packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx` | `/vault` row gated the same way |
| Delete | `packages/expo-wallet-toolbox/ui/screens/VaultRecoverScreen.tsx` | Phrase recovery — no longer exists |
| Delete | `packages/expo-wallet-toolbox/ui/components/vault/PassphraseField.tsx` | Passphrase entry — no longer exists |
| Delete | `packages/expo-wallet-toolbox/ui/components/vault/PhraseBackupSheet.tsx` | Old wizard's phrase reveal — no longer exists |
| Delete | `app/vault-recover.tsx` | Route stub for the deleted screen |
| Modify | `app/_layout.tsx` | Remove `<Stack.Screen name="vault-recover" />`; pass `vaultEnabled` to `configureToolbox` |
| Modify | `packages/expo-wallet-toolbox/ui/index.ts` | Drop `PassphraseField`, `PhraseBackupSheet`, `VaultRecoverScreen` exports; add `KeyChooser`, `vaultErrorCopy`, `useExportWalletData`, `useVaultCoverage` |
| Modify | `packages/expo-wallet-toolbox/README.md`, `README.md` | Remove the `VaultRecoverScreen` / `vault-recover.tsx` rows |
| Modify | `eas.json` | `EXPO_PUBLIC_VAULT_ENABLED=true` in `development` and `dev-physical` |
| Modify | `packages/expo-wallet-toolbox/CHANGELOG.md` | UI lines under the 0.5.0 entry |

## Interface Contract

(Copied verbatim from `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad/plan-contract.md`.)

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

(End of verbatim contract.)

## Shared test scaffolding conventions (used by every component test below)

Every component test in this plan mocks the core barrel with the same shape. Each test file repeats it in full (no cross-references), but the rules are:

- `jest.mock('@bsv/expo-wallet-toolbox', () => ({ ...jest.requireActual('../../core/theme/tokens'), useTheme: () => ({ colors: {} }), i18n: { t: mockT }, VaultError: jest.requireActual('../../core/services/vault/types').VaultError, ... }))` where `mockT = (k, o) => (o && Object.keys(o).length ? \`${k}:${JSON.stringify(o)}\` : k)` so assertions can match both the key and its interpolation params.
- `jest.mock('expo-router', () => ({ router: mockRouter, useLocalSearchParams: () => mockParams, useFocusEffect: () => {} }))`.
- `jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))`.
- `jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))`.
- `jest.mock('../../ui/components/ui/PressableScale', ...)` → a `Pressable` so `fireEvent.press` works and `onPress={undefined}` renders a disabled button (`props.onPress` undefined ⇒ assert with `expect(el.props.onPress).toBeUndefined()` — actually assert via `accessibilityState`; see each test).
- `jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: jest.fn() }))` and drive the pressed button with `mockResolvedValueOnce('key')`.
- `jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))`.
- `jest.mock('../../ui/components/ui/ListRow', ...)` → `Pressable` + `Text` for `label`, `subtitle`, `value` so `getByText` finds row text.
- `jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ header, footer, children }) => <>{header ? <Text>{header}</Text> : null}{children}{footer ? <Text>{footer}</Text> : null}</> }))` (built with `React.createElement` inside the factory).
- Settle async effects with `await act(async () => { await new Promise(r => setImmediate(r)) })`.

---

### Task 1: i18n — new vault keys and model-dependent copy changes in all twelve locales

**Files:**
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/core/i18n/translations.tsx` — en block lines 188–364 (`// ── Vault (YubiKey-gated high-value basket) ──` … `vault_deposit_blocked_dismiss`), and the matching vault block in each other locale (zh starts at 892 `// vault (machine-translated, needs native review)`, hi ~1530, es ~2191, fr ~2862, ar ~3536, pt ~4183, bn ~4852, ru ~5513, id ~6180, ja ~6850, pl ~7527 — locate each with `grep -n "vault_title:" core/i18n/translations.tsx`).
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts` lines 11–22 (`allowedUntranslated`).
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts` (existing; must pass).

**Interfaces:** Produces the i18n keys every later task consumes via `i18n.t`. Consumes nothing.

Dead keys are NOT deleted here (they are deleted in Task 10 together with the files that use them). This task only adds and changes.

- [ ] **Step 1: Add the new English keys and change the model-dependent English copy**

**Model-dependent copy change to a PRE-EXISTING key:** `vault_withdraw_reason` is the `reason` string `VaultTransferScreen` (Task 9) passes to `withdrawFromVault`, which the ceremony both displays inline (`VaultCeremonySheet`'s `state.reason`, Task 7) and forwards verbatim to `driver.start(reason)` as the native iOS NFC-scan alert text (contract: `VaultDriver.start(message?: string)`). The existing value, `'Withdraw {{amount}} sats from vault'`, narrates an outcome rather than instructing a tap, so it reads oddly as the text on the system NFC sheet (contrast `vault_relock_reason`'s `'Tap one of your existing keys ({{names}}) — not the one you just added.'`, which already works as both). This line stays the anchor for the insertion below; its VALUE is changed as one of the "existing English values in place" further down (English text given there — `'Hold your YubiKey here to sign — withdraw {{amount}} sats'`), and the matching change in each of the other eleven locales prepends that locale's own "Hold your YubiKey here to sign" phrase (already given, in `vault_nfc_sign_batch`) ahead of the existing `{{amount}}` clause. The parity test only checks key sets and placeholder sets, not wording, so this cannot be verified by `translationParity.test.ts` — do not skip it anyway: leaving eleven locales narrating outcomes on the NFC sheet while `en` instructs is exactly the kind of one-locale-only gap that test cannot catch.

Directly after the line `vault_withdraw_reason: 'Withdraw {{amount}} sats from vault',` (line 210), insert:

```ts
      // ── R1C vault: not-released state, wizard, key management, transfers ──
      vault_not_released_body: 'Not available yet — vault deposits are switched off in this release.',
      vault_intro_title: 'Set up your vault',
      vault_intro_what:
        'The vault locks money to your own YubiKeys. Nothing about the vault key ever exists on this phone; any one of your keys opens it.',
      vault_intro_two_keys: 'You need at least two YubiKeys.',
      vault_intro_apart: 'Keep them in different places — two keys stored together are one key.',
      vault_intro_backup: "Keep the wallet's encrypted backup on — it holds the record of each deposit.",
      vault_intro_ack:
        'I understand: only my YubiKeys open this vault. My recovery phrase does not. If I lose all of them, the money is gone.',
      vault_intro_begin: 'Begin',
      vault_key_step_title: 'Key {{k}} of up to 5',
      vault_key_step_replace: "Anything already stored in this YubiKey's vault slot will be replaced.",
      vault_nfc_enroll_message: 'Hold your YubiKey here to set it up',
      vault_nfc_sign_batch: 'Hold your YubiKey here to sign — batch {{b}} of {{n}}',
      vault_key_use_different: 'Use a different YubiKey',
      vault_key_setup_again: 'Set it up again',
      vault_name_title: 'Name this key',
      vault_name_default: 'Key {{k}}',
      vault_name_hint: "e.g. Desk, Safe, Parents' house",
      vault_more_title: 'Add another key?',
      vault_more_body: 'Up to 5 keys. Any one of them opens the whole vault on its own.',
      vault_more_add: 'Add another key',
      vault_more_finish: 'Finish',
      vault_more_need_two: 'Add a second key before finishing — one key means no recovery.',
      vault_leave_setup: 'Leave set-up',
      vault_leave_title: 'Leave set-up?',
      vault_leave_body:
        "The {{count}} YubiKey(s) you set up won't be saved yet. They keep their keys, so you can add them again in a minute.",
      vault_leave_confirm: 'Leave',
      vault_leave_stay: 'Stay',
      vault_done_body: '{{count}} keys can open this vault. Only these keys open it — your recovery phrase does not.',
      vault_done_cta: 'Done',
      vault_add_key_row: 'Add key',
      vault_add_key_done:
        '{{nickname}} can open deposits made from now on. Re-lock the vault so it can open everything.',
      vault_key_added_toast: 'Key added',
      vault_relock_row: 'Re-lock vault',
      vault_relock_now: 'Re-lock now',
      vault_relock_choose: 'Which key will you tap to re-lock?',
      vault_relock_reason: 'Tap one of your existing keys ({{names}}) — not the one you just added.',
      vault_relock_reason_generic: 'Hold your YubiKey here to sign — re-lock the vault to your current keys',
      vault_relock_done: 'Vault re-locked to your current keys',
      vault_relock_capped: '{{count}} more deposits remain — re-lock again to move them.',
      vault_relock_unreachable:
        '{{count}} deposits can only be opened by {{names}}. Re-lock again with one of those keys.',
      vault_badge_missing: '{{count}} deposits not yet open to {{nickname}}',
      vault_badge_removed: '{{count}} deposits still open to a removed key',
      vault_key_action_rename: 'Rename',
      vault_key_action_remove: 'Remove',
      vault_rename_title: 'Rename {{nickname}}',
      vault_rename_save: 'Save',
      vault_remove_title: 'Remove {{nickname}}?',
      vault_remove_body:
        'This stops the wallet using {{nickname}}. Money already in the vault stays openable by it until you re-lock (≈ {{fee}} sats).',
      vault_remove_and_relock: 'Remove and re-lock now',
      vault_remove_only: 'Remove only',
      vault_key_removed_toast: 'Key removed',
      vault_export_explainer:
        "Every vault deposit carries a unique piece of data that is needed to open it, along with your YubiKeys. It is stored in this wallet's database. Keep the encrypted backup on, and export a copy of the wallet data after making deposits.",
      vault_footnote: 'Only these keys open the vault. Your recovery phrase does not.',
      vault_floor_line:
        'Minimum deposit {{floorDisplay}} ({{floorSats}} sats). Creating a vault deposit costs about {{feeDisplay}}.',
      vault_first_deposit_title: 'First vault deposit',
      vault_first_deposit_body:
        "First vault deposit — {{amount}} will be openable only with {{count}} YubiKeys ({{names}}). Your recovery phrase won't help.",
      vault_backup_off_title: 'Turn backup on first',
      vault_backup_off_body:
        'Each vault deposit has a one-time secret stored only in this wallet. If this phone is lost and backup is off, no YubiKey can open the vault.',
      vault_backup_off_cta: 'Open settings',
      vault_choose_key: 'Which key will you tap?',
      vault_remainder_title: 'Withdraw everything?',
      vault_remainder_body:
        'Withdrawing {{amount}} leaves {{remainder}}, which is below the 100,000-sat vault minimum. The whole vault will move to your everyday balance.',
      vault_remainder_all: 'Withdraw everything',
      vault_remainder_change: 'Change amount',
      vault_unreachable_title: 'Part of the vault needs another key',
      vault_unreachable_body:
        'Part of the vault needs another key — moved {{moved}}. {{count}} deposits holding {{amount}} can only be opened by {{names}}. Withdraw again with one of those keys.',
      vault_sign_progress: 'Signed {{signed}} of {{total}}',
      vault_err_pin_locked_enroll:
        "This YubiKey's PIN is blocked. Unblock it with its PUK in Yubico Authenticator, or set up with a different YubiKey.",
      vault_err_serial_mismatch_chosen:
        "That's {{tappedName}}. You chose {{chosenName}} — tap it, or go back and choose {{tappedName}}.",
      vault_err_key_already_enrolled: "You've already added this YubiKey ({{nickname}}). Tap a different one.",
      vault_err_not_released: 'Vault deposits are switched off in this release.',
      vault_err_backup_off: 'Turn the encrypted wallet backup on before depositing to the vault.',
      vault_err_not_enough_keys: 'This vault has fewer than two keys. Set it up again.',
      vault_err_too_many_keys: 'A vault holds at most five keys.',
      vault_err_last_keys: 'A vault needs at least two keys. Add another key before removing this one.',
      vault_err_relock_required: 'Re-lock the vault first so your other keys can open every deposit.',
      vault_err_key_not_committed: "{{nickname}} can't open any of the deposits in this vault. Use another of your vault keys.",
      vault_err_key_cannot_cover:
        '{{nickname}} can open {{reachable}} of the {{total}} in the vault. Withdraw up to {{reachable}}, or use {{otherNames}} instead.',
      vault_err_too_small_to_relock:
        'This vault holds less than 100,000 sats, which is too small to re-lock. Withdraw it instead and deposit again.',
      vault_err_bad_version: 'The transaction was built in the wrong format. Nothing was signed — try again.',
```

Then change these existing English values in place (same keys, new copy):

```ts
      vault_withdraw_reason: 'Hold your YubiKey here to sign — withdraw {{amount}} sats',
      vault_hero_body: 'Cool storage for the long term, locked to your own YubiKeys. Needs two or more YubiKey 5 NFC.',
      vault_unsupported_body: 'Two or more YubiKey 5 NFC, plus a phone that can read them.',
      vault_key_section: 'Security keys ({{count}} of 5)',
      vault_deposit_sub: 'From your everyday balance. No YubiKey needed.',
      vault_withdraw_sub: 'Back to your everyday balance. Tap any of your vault keys.',
      vault_withdraw_partial: '{{count}} more deposits remain — withdraw again to move them.',
      vault_disable_message: "This forgets the vault's key list on this phone. The keys stay on your YubiKeys.",
      vault_err_pin_locked:
        "This YubiKey's PIN is blocked. Use another of your vault keys, or unblock this one with its PUK in Yubico Authenticator.",
      vault_err_wrong_key: "This YubiKey isn't one of this vault's keys.",
      vault_err_serial_mismatch: "This YubiKey isn't one of this vault's keys ({{names}}).",
```

- [ ] **Step 2: Run the parity test and watch it fail on every other locale**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```
Expected: 11 failures of `zh has exactly the English key set` (…`pl has exactly the English key set`), each listing the new keys as missing (`expect(englishKeys.filter(key => !(key in translation))).toEqual([])` with an array beginning `["vault_not_released_body", "vault_intro_title", …]`), plus 11 failures of `keeps the same interpolation placeholders` naming `vault_key_section`, `vault_err_serial_mismatch`.

- [ ] **Step 3: Add the same keys (translated) and the same in-place changes to zh, hi and es**

In each locale, insert the new block right after that locale's `vault_withdraw_reason:` line and change the eleven existing values in place — including `vault_withdraw_reason` itself: prepend that locale's own "Hold your YubiKey here to sign" phrase (the substring before the separator in that locale's `vault_nfc_sign_batch`, given below) ahead of its existing `{{amount}}` clause, exactly as the English change above.

**zh** — insert:
```ts
      vault_not_released_body: '暂不可用 — 此版本已关闭保险库存入。',
      vault_intro_title: '设置您的保险库',
      vault_intro_what: '保险库将资金锁定到您自己的 YubiKey。保险库密钥的任何部分都不会存在于这部手机上；您的任何一把密钥都能打开它。',
      vault_intro_two_keys: '您至少需要两把 YubiKey。',
      vault_intro_apart: '请把它们放在不同的地方 — 放在一起的两把密钥等于一把。',
      vault_intro_backup: '请保持钱包的加密备份开启 — 它保存着每次存入的记录。',
      vault_intro_ack: '我明白：只有我的 YubiKey 能打开这个保险库，我的恢复助记词不能。如果我丢失了全部密钥，这些钱就没了。',
      vault_intro_begin: '开始',
      vault_key_step_title: '第 {{k}} 把密钥（最多 5 把）',
      vault_key_step_replace: '这把 YubiKey 保险库槽位中已有的内容将被替换。',
      vault_nfc_enroll_message: '将 YubiKey 靠在这里以完成设置',
      vault_nfc_sign_batch: '将 YubiKey 靠在这里以签名 — 第 {{b}} 批，共 {{n}} 批',
      vault_key_use_different: '使用另一把 YubiKey',
      vault_key_setup_again: '重新设置',
      vault_name_title: '为这把密钥命名',
      vault_name_default: '密钥 {{k}}',
      vault_name_hint: '例如：书桌、保险箱、父母家',
      vault_more_title: '再添加一把密钥？',
      vault_more_body: '最多 5 把密钥。其中任何一把都能独立打开整个保险库。',
      vault_more_add: '再添加一把密钥',
      vault_more_finish: '完成',
      vault_more_need_two: '完成前请添加第二把密钥 — 只有一把密钥意味着无法恢复。',
      vault_leave_setup: '离开设置',
      vault_leave_title: '离开设置？',
      vault_leave_body: '您已设置的 {{count}} 把 YubiKey 尚未保存。它们仍保留各自的密钥，稍后可以再次添加。',
      vault_leave_confirm: '离开',
      vault_leave_stay: '留下',
      vault_done_body: '{{count}} 把密钥可以打开这个保险库。只有这些密钥能打开它 — 您的恢复助记词不能。',
      vault_done_cta: '完成',
      vault_add_key_row: '添加密钥',
      vault_add_key_done: '{{nickname}} 可以打开从现在起的存入。重新锁定保险库后，它就能打开全部资金。',
      vault_key_added_toast: '密钥已添加',
      vault_relock_row: '重新锁定保险库',
      vault_relock_now: '立即重新锁定',
      vault_relock_choose: '您将用哪把密钥重新锁定？',
      vault_relock_reason: '请轻触您现有的密钥之一（{{names}}）— 不是刚添加的那把。',
      vault_relock_reason_generic: '将 YubiKey 靠在这里以签名 — 将保险库重新锁定到您当前的密钥',
      vault_relock_done: '保险库已重新锁定到当前密钥',
      vault_relock_capped: '还剩 {{count}} 笔存入 — 再次重新锁定以移动它们。',
      vault_relock_unreachable: '{{count}} 笔存入只能由 {{names}} 打开。请用其中一把密钥再次重新锁定。',
      vault_badge_missing: '{{count}} 笔存入尚未对 {{nickname}} 开放',
      vault_badge_removed: '{{count}} 笔存入仍可由已移除的密钥打开',
      vault_key_action_rename: '重命名',
      vault_key_action_remove: '移除',
      vault_rename_title: '重命名 {{nickname}}',
      vault_rename_save: '保存',
      vault_remove_title: '移除 {{nickname}}？',
      vault_remove_body: '钱包将不再使用 {{nickname}}。保险库中已有的资金在您重新锁定之前仍可由它打开（约 {{fee}} sats）。',
      vault_remove_and_relock: '移除并立即重新锁定',
      vault_remove_only: '仅移除',
      vault_key_removed_toast: '密钥已移除',
      vault_export_explainer: '每笔保险库存入都带有一份打开它所需的唯一数据，与您的 YubiKey 配合使用。它保存在此钱包的数据库中。请保持加密备份开启，并在存入后导出一份钱包数据。',
      vault_footnote: '只有这些密钥能打开保险库。您的恢复助记词不能。',
      vault_floor_line: '最低存入 {{floorDisplay}}（{{floorSats}} sats）。创建一笔保险库存入约需 {{feeDisplay}}。',
      vault_first_deposit_title: '首次保险库存入',
      vault_first_deposit_body: '首次保险库存入 — {{amount}} 将只能由 {{count}} 把 YubiKey（{{names}}）打开。您的恢复助记词无济于事。',
      vault_backup_off_title: '请先开启备份',
      vault_backup_off_body: '每笔保险库存入都有一个仅存于此钱包的一次性秘密。如果手机丢失且备份关闭，任何 YubiKey 都无法打开保险库。',
      vault_backup_off_cta: '打开设置',
      vault_choose_key: '您将轻触哪把密钥？',
      vault_remainder_title: '全部取出？',
      vault_remainder_body: '取出 {{amount}} 后将剩余 {{remainder}}，低于 100,000 sat 的保险库最低额。整个保险库将转入您的日常余额。',
      vault_remainder_all: '全部取出',
      vault_remainder_change: '修改金额',
      vault_unreachable_title: '保险库的一部分需要另一把密钥',
      vault_unreachable_body: '保险库的一部分需要另一把密钥 — 已移动 {{moved}}。{{count}} 笔存入（共 {{amount}}）只能由 {{names}} 打开。请用其中一把密钥再次取出。',
      vault_sign_progress: '已签名 {{signed}} / {{total}}',
      vault_err_pin_locked_enroll: '这把 YubiKey 的 PIN 已被锁定。请在 Yubico Authenticator 中用其 PUK 解锁，或改用另一把 YubiKey 设置。',
      vault_err_serial_mismatch_chosen: '这是 {{tappedName}}。您选择的是 {{chosenName}} — 请轻触它，或返回并选择 {{tappedName}}。',
      vault_err_key_already_enrolled: '您已经添加过这把 YubiKey（{{nickname}}）。请轻触另一把。',
      vault_err_not_released: '此版本已关闭保险库存入。',
      vault_err_backup_off: '存入保险库前，请先开启加密钱包备份。',
      vault_err_not_enough_keys: '此保险库的密钥少于两把。请重新设置。',
      vault_err_too_many_keys: '一个保险库最多可有五把密钥。',
      vault_err_last_keys: '保险库至少需要两把密钥。请先添加另一把再移除这把。',
      vault_err_relock_required: '请先重新锁定保险库，让您的其他密钥能打开每笔存入。',
      vault_err_key_not_committed: '{{nickname}} 无法打开此保险库中的任何存入。请使用您的另一把保险库密钥。',
      vault_err_key_cannot_cover: '{{nickname}} 可以打开保险库中 {{total}} 里的 {{reachable}}。请最多取出 {{reachable}}，或改用 {{otherNames}}。',
      vault_err_too_small_to_relock: '此保险库的余额不足 100,000 sats，太少而无法重新锁定。请改为取出后再存入。',
      vault_err_bad_version: '交易以错误的格式构建。尚未签名 — 请重试。',
```
**zh** — change in place:
```ts
      vault_hero_body: '适合长期持有的存储，锁定到您自己的 YubiKey。需要两把或更多 YubiKey 5 NFC。',
      vault_unsupported_body: '需要两把或更多 YubiKey 5 NFC，以及能读取它们的手机。',
      vault_key_section: '安全密钥（{{count}} / 5）',
      vault_deposit_sub: '来自您的日常余额。无需 YubiKey。',
      vault_withdraw_sub: '回到您的日常余额。轻触您的任意一把保险库密钥。',
      vault_withdraw_partial: '还剩 {{count}} 笔存入 — 再次取出以移动它们。',
      vault_disable_message: '这将忘记这部手机上的保险库密钥列表。密钥仍保留在您的 YubiKey 上。',
      vault_err_pin_locked: '这把 YubiKey 的 PIN 已被锁定。请使用您的另一把保险库密钥，或在 Yubico Authenticator 中用其 PUK 解锁。',
      vault_err_wrong_key: '这把 YubiKey 不是此保险库的密钥之一。',
      vault_err_serial_mismatch: '这把 YubiKey 不是此保险库的密钥之一（{{names}}）。',
```

**hi** — insert:
```ts
      vault_not_released_body: 'अभी उपलब्ध नहीं — इस रिलीज़ में वॉल्ट जमा बंद हैं।',
      vault_intro_title: 'अपना वॉल्ट सेट करें',
      vault_intro_what: 'वॉल्ट पैसे को आपकी अपनी YubiKeys से लॉक करता है। वॉल्ट कुंजी का कोई भी हिस्सा इस फ़ोन पर कभी मौजूद नहीं होता; आपकी कोई भी एक कुंजी इसे खोलती है।',
      vault_intro_two_keys: 'आपको कम से कम दो YubiKeys चाहिए।',
      vault_intro_apart: 'उन्हें अलग-अलग जगहों पर रखें — एक साथ रखी दो कुंजियाँ एक कुंजी के बराबर हैं।',
      vault_intro_backup: 'वॉलेट का एन्क्रिप्टेड बैकअप चालू रखें — इसमें हर जमा का रिकॉर्ड रहता है।',
      vault_intro_ack: 'मैं समझता/समझती हूँ: केवल मेरी YubiKeys यह वॉल्ट खोलती हैं। मेरा रिकवरी फ़्रेज़ नहीं। यदि मैं सभी खो दूँ, तो पैसा चला जाएगा।',
      vault_intro_begin: 'शुरू करें',
      vault_key_step_title: 'कुंजी {{k}}, अधिकतम 5 में से',
      vault_key_step_replace: 'इस YubiKey के वॉल्ट स्लॉट में पहले से रखी कोई भी चीज़ बदल दी जाएगी।',
      vault_nfc_enroll_message: 'सेट करने के लिए अपनी YubiKey यहाँ रखें',
      vault_nfc_sign_batch: 'हस्ताक्षर के लिए अपनी YubiKey यहाँ रखें — बैच {{b}}/{{n}}',
      vault_key_use_different: 'दूसरी YubiKey उपयोग करें',
      vault_key_setup_again: 'फिर से सेट करें',
      vault_name_title: 'इस कुंजी का नाम रखें',
      vault_name_default: 'कुंजी {{k}}',
      vault_name_hint: 'जैसे डेस्क, तिजोरी, माता-पिता का घर',
      vault_more_title: 'एक और कुंजी जोड़ें?',
      vault_more_body: 'अधिकतम 5 कुंजियाँ। इनमें से कोई भी एक अकेले पूरा वॉल्ट खोल सकती है।',
      vault_more_add: 'एक और कुंजी जोड़ें',
      vault_more_finish: 'समाप्त',
      vault_more_need_two: 'समाप्त करने से पहले दूसरी कुंजी जोड़ें — एक कुंजी का मतलब कोई रिकवरी नहीं।',
      vault_leave_setup: 'सेटअप छोड़ें',
      vault_leave_title: 'सेटअप छोड़ें?',
      vault_leave_body: 'आपने जो {{count}} YubiKey सेट की हैं, वे अभी सहेजी नहीं जाएँगी। उनकी कुंजियाँ बनी रहती हैं, इसलिए आप उन्हें कुछ ही मिनट में फिर जोड़ सकते हैं।',
      vault_leave_confirm: 'छोड़ें',
      vault_leave_stay: 'रहें',
      vault_done_body: '{{count}} कुंजियाँ यह वॉल्ट खोल सकती हैं। केवल ये कुंजियाँ इसे खोलती हैं — आपका रिकवरी फ़्रेज़ नहीं।',
      vault_done_cta: 'हो गया',
      vault_add_key_row: 'कुंजी जोड़ें',
      vault_add_key_done: '{{nickname}} अब से की गई जमाओं को खोल सकती है। वॉल्ट को री-लॉक करें ताकि यह सब कुछ खोल सके।',
      vault_key_added_toast: 'कुंजी जोड़ी गई',
      vault_relock_row: 'वॉल्ट री-लॉक करें',
      vault_relock_now: 'अभी री-लॉक करें',
      vault_relock_choose: 'री-लॉक करने के लिए आप कौन-सी कुंजी टैप करेंगे?',
      vault_relock_reason: 'अपनी मौजूदा कुंजियों में से एक टैप करें ({{names}}) — वह नहीं जो आपने अभी जोड़ी।',
      vault_relock_reason_generic: 'हस्ताक्षर के लिए अपनी YubiKey यहाँ रखें — वॉल्ट को अपनी वर्तमान कुंजियों पर री-लॉक करें',
      vault_relock_done: 'वॉल्ट आपकी वर्तमान कुंजियों पर री-लॉक हो गया',
      vault_relock_capped: '{{count}} और जमा बाकी हैं — उन्हें ले जाने के लिए फिर री-लॉक करें।',
      vault_relock_unreachable: '{{count}} जमा केवल {{names}} से खुल सकती हैं। उनमें से किसी एक कुंजी से फिर री-लॉक करें।',
      vault_badge_missing: '{{count}} जमा अभी {{nickname}} के लिए खुली नहीं हैं',
      vault_badge_removed: '{{count}} जमा अभी भी हटाई गई कुंजी से खुल सकती हैं',
      vault_key_action_rename: 'नाम बदलें',
      vault_key_action_remove: 'हटाएँ',
      vault_rename_title: '{{nickname}} का नाम बदलें',
      vault_rename_save: 'सहेजें',
      vault_remove_title: '{{nickname}} हटाएँ?',
      vault_remove_body: 'इससे वॉलेट {{nickname}} का उपयोग बंद कर देगा। वॉल्ट में पहले से मौजूद पैसा री-लॉक करने तक इससे खुलता रहेगा (≈ {{fee}} sats)।',
      vault_remove_and_relock: 'हटाएँ और अभी री-लॉक करें',
      vault_remove_only: 'केवल हटाएँ',
      vault_key_removed_toast: 'कुंजी हटाई गई',
      vault_export_explainer: 'हर वॉल्ट जमा के साथ एक अनूठा डेटा होता है जो आपकी YubiKeys के साथ उसे खोलने के लिए ज़रूरी है। यह इस वॉलेट के डेटाबेस में रहता है। एन्क्रिप्टेड बैकअप चालू रखें, और जमा करने के बाद वॉलेट डेटा की एक प्रति निर्यात करें।',
      vault_footnote: 'केवल ये कुंजियाँ वॉल्ट खोलती हैं। आपका रिकवरी फ़्रेज़ नहीं।',
      vault_floor_line: 'न्यूनतम जमा {{floorDisplay}} ({{floorSats}} sats)। वॉल्ट जमा बनाने में लगभग {{feeDisplay}} लगता है।',
      vault_first_deposit_title: 'पहली वॉल्ट जमा',
      vault_first_deposit_body: 'पहली वॉल्ट जमा — {{amount}} केवल {{count}} YubiKeys ({{names}}) से खुल पाएगा। आपका रिकवरी फ़्रेज़ मदद नहीं करेगा।',
      vault_backup_off_title: 'पहले बैकअप चालू करें',
      vault_backup_off_body: 'हर वॉल्ट जमा का एक एक-बार का रहस्य केवल इस वॉलेट में रहता है। यदि यह फ़ोन खो जाए और बैकअप बंद हो, तो कोई YubiKey वॉल्ट नहीं खोल सकती।',
      vault_backup_off_cta: 'सेटिंग्स खोलें',
      vault_choose_key: 'आप कौन-सी कुंजी टैप करेंगे?',
      vault_remainder_title: 'सब कुछ निकालें?',
      vault_remainder_body: '{{amount}} निकालने पर {{remainder}} बचेगा, जो 100,000-sat वॉल्ट न्यूनतम से कम है। पूरा वॉल्ट आपके रोज़मर्रा के बैलेंस में चला जाएगा।',
      vault_remainder_all: 'सब कुछ निकालें',
      vault_remainder_change: 'राशि बदलें',
      vault_unreachable_title: 'वॉल्ट के एक हिस्से को दूसरी कुंजी चाहिए',
      vault_unreachable_body: 'वॉल्ट के एक हिस्से को दूसरी कुंजी चाहिए — {{moved}} ले जाया गया। {{amount}} वाली {{count}} जमा केवल {{names}} से खुल सकती हैं। उनमें से किसी एक कुंजी से फिर निकालें।',
      vault_sign_progress: '{{total}} में से {{signed}} हस्ताक्षरित',
      vault_err_pin_locked_enroll: 'इस YubiKey का PIN ब्लॉक है। Yubico Authenticator में इसके PUK से अनब्लॉक करें, या दूसरी YubiKey से सेट करें।',
      vault_err_serial_mismatch_chosen: 'यह {{tappedName}} है। आपने {{chosenName}} चुनी थी — उसे टैप करें, या वापस जाकर {{tappedName}} चुनें।',
      vault_err_key_already_enrolled: 'आप यह YubiKey ({{nickname}}) पहले ही जोड़ चुके हैं। दूसरी टैप करें।',
      vault_err_not_released: 'इस रिलीज़ में वॉल्ट जमा बंद हैं।',
      vault_err_backup_off: 'वॉल्ट में जमा करने से पहले एन्क्रिप्टेड वॉलेट बैकअप चालू करें।',
      vault_err_not_enough_keys: 'इस वॉल्ट में दो से कम कुंजियाँ हैं। इसे फिर से सेट करें।',
      vault_err_too_many_keys: 'एक वॉल्ट में अधिकतम पाँच कुंजियाँ हो सकती हैं।',
      vault_err_last_keys: 'वॉल्ट को कम से कम दो कुंजियाँ चाहिए। इसे हटाने से पहले दूसरी कुंजी जोड़ें।',
      vault_err_relock_required: 'पहले वॉल्ट री-लॉक करें ताकि आपकी अन्य कुंजियाँ हर जमा खोल सकें।',
      vault_err_key_not_committed: '{{nickname}} इस वॉल्ट की कोई भी जमा नहीं खोल सकती। अपनी दूसरी वॉल्ट कुंजी उपयोग करें।',
      vault_err_key_cannot_cover: '{{nickname}} वॉल्ट के {{total}} में से {{reachable}} खोल सकती है। अधिकतम {{reachable}} निकालें, या {{otherNames}} उपयोग करें।',
      vault_err_too_small_to_relock: 'इस वॉल्ट में 100,000 sats से कम है, जो री-लॉक के लिए बहुत कम है। इसे निकालें और फिर जमा करें।',
      vault_err_bad_version: 'लेन-देन गलत फ़ॉर्मैट में बना। कुछ भी हस्ताक्षरित नहीं हुआ — फिर कोशिश करें।',
```
**hi** — change in place:
```ts
      vault_hero_body: 'लंबी अवधि के लिए कूल स्टोरेज, आपकी अपनी YubiKeys से लॉक। दो या अधिक YubiKey 5 NFC चाहिए।',
      vault_unsupported_body: 'दो या अधिक YubiKey 5 NFC, और एक फ़ोन जो उन्हें पढ़ सके।',
      vault_key_section: 'सुरक्षा कुंजियाँ ({{count}}/5)',
      vault_deposit_sub: 'आपके रोज़मर्रा के बैलेंस से। YubiKey की ज़रूरत नहीं।',
      vault_withdraw_sub: 'वापस आपके रोज़मर्रा के बैलेंस में। अपनी किसी भी वॉल्ट कुंजी को टैप करें।',
      vault_withdraw_partial: '{{count}} और जमा बाकी हैं — उन्हें ले जाने के लिए फिर निकालें।',
      vault_disable_message: 'इससे इस फ़ोन पर वॉल्ट की कुंजी सूची भुला दी जाएगी। कुंजियाँ आपकी YubiKeys पर बनी रहती हैं।',
      vault_err_pin_locked: 'इस YubiKey का PIN ब्लॉक है। अपनी दूसरी वॉल्ट कुंजी उपयोग करें, या Yubico Authenticator में इसके PUK से इसे अनब्लॉक करें।',
      vault_err_wrong_key: 'यह YubiKey इस वॉल्ट की कुंजियों में से नहीं है।',
      vault_err_serial_mismatch: 'यह YubiKey इस वॉल्ट की कुंजियों में से नहीं है ({{names}})।',
```

**es** — insert:
```ts
      vault_not_released_body: 'Aún no disponible: los depósitos a la caja fuerte están desactivados en esta versión.',
      vault_intro_title: 'Configura tu caja fuerte',
      vault_intro_what: 'La caja fuerte bloquea el dinero con tus propias YubiKeys. Nada de la clave de la caja fuerte existe jamás en este teléfono; cualquiera de tus llaves la abre.',
      vault_intro_two_keys: 'Necesitas al menos dos YubiKeys.',
      vault_intro_apart: 'Guárdalas en lugares distintos: dos llaves guardadas juntas son una sola llave.',
      vault_intro_backup: 'Mantén activada la copia de seguridad cifrada de la billetera: guarda el registro de cada depósito.',
      vault_intro_ack: 'Entiendo: solo mis YubiKeys abren esta caja fuerte. Mi frase de recuperación no. Si las pierdo todas, el dinero se pierde.',
      vault_intro_begin: 'Empezar',
      vault_key_step_title: 'Llave {{k}} de hasta 5',
      vault_key_step_replace: 'Todo lo que ya esté guardado en la ranura de caja fuerte de esta YubiKey será reemplazado.',
      vault_nfc_enroll_message: 'Acerca tu YubiKey aquí para configurarla',
      vault_nfc_sign_batch: 'Acerca tu YubiKey aquí para firmar: lote {{b}} de {{n}}',
      vault_key_use_different: 'Usar otra YubiKey',
      vault_key_setup_again: 'Configurarla de nuevo',
      vault_name_title: 'Ponle nombre a esta llave',
      vault_name_default: 'Llave {{k}}',
      vault_name_hint: 'p. ej. Escritorio, Caja fuerte, Casa de mis padres',
      vault_more_title: '¿Añadir otra llave?',
      vault_more_body: 'Hasta 5 llaves. Cualquiera de ellas abre toda la caja fuerte por sí sola.',
      vault_more_add: 'Añadir otra llave',
      vault_more_finish: 'Terminar',
      vault_more_need_two: 'Añade una segunda llave antes de terminar: una sola llave significa que no hay recuperación.',
      vault_leave_setup: 'Salir de la configuración',
      vault_leave_title: '¿Salir de la configuración?',
      vault_leave_body: 'Las {{count}} YubiKey(s) que configuraste todavía no se guardarán. Conservan sus claves, así que podrás añadirlas de nuevo en un minuto.',
      vault_leave_confirm: 'Salir',
      vault_leave_stay: 'Quedarme',
      vault_done_body: '{{count}} llaves pueden abrir esta caja fuerte. Solo estas llaves la abren; tu frase de recuperación no.',
      vault_done_cta: 'Listo',
      vault_add_key_row: 'Añadir llave',
      vault_add_key_done: '{{nickname}} puede abrir los depósitos hechos a partir de ahora. Vuelve a bloquear la caja fuerte para que pueda abrirlo todo.',
      vault_key_added_toast: 'Llave añadida',
      vault_relock_row: 'Volver a bloquear la caja fuerte',
      vault_relock_now: 'Volver a bloquear ahora',
      vault_relock_choose: '¿Qué llave tocarás para volver a bloquear?',
      vault_relock_reason: 'Toca una de tus llaves existentes ({{names}}), no la que acabas de añadir.',
      vault_relock_reason_generic: 'Acerca tu YubiKey aquí para firmar: volver a bloquear la caja fuerte con tus llaves actuales',
      vault_relock_done: 'Caja fuerte bloqueada de nuevo con tus llaves actuales',
      vault_relock_capped: 'Quedan {{count}} depósitos más: vuelve a bloquear otra vez para moverlos.',
      vault_relock_unreachable: '{{count}} depósitos solo pueden abrirse con {{names}}. Vuelve a bloquear con una de esas llaves.',
      vault_badge_missing: '{{count}} depósitos aún no abiertos para {{nickname}}',
      vault_badge_removed: '{{count}} depósitos aún abiertos para una llave eliminada',
      vault_key_action_rename: 'Renombrar',
      vault_key_action_remove: 'Eliminar',
      vault_rename_title: 'Renombrar {{nickname}}',
      vault_rename_save: 'Guardar',
      vault_remove_title: '¿Eliminar {{nickname}}?',
      vault_remove_body: 'La billetera dejará de usar {{nickname}}. El dinero que ya está en la caja fuerte seguirá pudiendo abrirse con ella hasta que vuelvas a bloquear (≈ {{fee}} sats).',
      vault_remove_and_relock: 'Eliminar y volver a bloquear ahora',
      vault_remove_only: 'Solo eliminar',
      vault_key_removed_toast: 'Llave eliminada',
      vault_export_explainer: 'Cada depósito en la caja fuerte lleva un dato único que se necesita para abrirlo, junto con tus YubiKeys. Se guarda en la base de datos de esta billetera. Mantén activada la copia de seguridad cifrada y exporta una copia de los datos de la billetera después de hacer depósitos.',
      vault_footnote: 'Solo estas llaves abren la caja fuerte. Tu frase de recuperación no.',
      vault_floor_line: 'Depósito mínimo {{floorDisplay}} ({{floorSats}} sats). Crear un depósito en la caja fuerte cuesta unos {{feeDisplay}}.',
      vault_first_deposit_title: 'Primer depósito en la caja fuerte',
      vault_first_deposit_body: 'Primer depósito en la caja fuerte: {{amount}} solo podrá abrirse con {{count}} YubiKeys ({{names}}). Tu frase de recuperación no servirá.',
      vault_backup_off_title: 'Activa primero la copia de seguridad',
      vault_backup_off_body: 'Cada depósito en la caja fuerte tiene un secreto de un solo uso guardado únicamente en esta billetera. Si pierdes este teléfono y la copia de seguridad está desactivada, ninguna YubiKey podrá abrir la caja fuerte.',
      vault_backup_off_cta: 'Abrir ajustes',
      vault_choose_key: '¿Qué llave tocarás?',
      vault_remainder_title: '¿Retirar todo?',
      vault_remainder_body: 'Retirar {{amount}} deja {{remainder}}, por debajo del mínimo de 100,000 sats de la caja fuerte. Toda la caja fuerte pasará a tu saldo diario.',
      vault_remainder_all: 'Retirar todo',
      vault_remainder_change: 'Cambiar importe',
      vault_unreachable_title: 'Parte de la caja fuerte necesita otra llave',
      vault_unreachable_body: 'Parte de la caja fuerte necesita otra llave: se movieron {{moved}}. {{count}} depósitos con {{amount}} solo pueden abrirse con {{names}}. Retira de nuevo con una de esas llaves.',
      vault_sign_progress: 'Firmados {{signed}} de {{total}}',
      vault_err_pin_locked_enroll: 'El PIN de esta YubiKey está bloqueado. Desbloquéalo con su PUK en Yubico Authenticator o configura con otra YubiKey.',
      vault_err_serial_mismatch_chosen: 'Esa es {{tappedName}}. Elegiste {{chosenName}}: tócala, o vuelve atrás y elige {{tappedName}}.',
      vault_err_key_already_enrolled: 'Ya añadiste esta YubiKey ({{nickname}}). Toca otra distinta.',
      vault_err_not_released: 'Los depósitos a la caja fuerte están desactivados en esta versión.',
      vault_err_backup_off: 'Activa la copia de seguridad cifrada de la billetera antes de depositar en la caja fuerte.',
      vault_err_not_enough_keys: 'Esta caja fuerte tiene menos de dos llaves. Configúrala de nuevo.',
      vault_err_too_many_keys: 'Una caja fuerte admite como máximo cinco llaves.',
      vault_err_last_keys: 'Una caja fuerte necesita al menos dos llaves. Añade otra antes de eliminar esta.',
      vault_err_relock_required: 'Vuelve a bloquear la caja fuerte primero, para que tus otras llaves puedan abrir cada depósito.',
      vault_err_key_not_committed: '{{nickname}} no puede abrir ninguno de los depósitos de esta caja fuerte. Usa otra de tus llaves.',
      vault_err_key_cannot_cover: '{{nickname}} puede abrir {{reachable}} de los {{total}} de la caja fuerte. Retira hasta {{reachable}} o usa {{otherNames}}.',
      vault_err_too_small_to_relock: 'Esta caja fuerte tiene menos de 100,000 sats, demasiado poco para volver a bloquear. Retíralo y deposita de nuevo.',
      vault_err_bad_version: 'La transacción se construyó en un formato incorrecto. No se firmó nada: inténtalo de nuevo.',
```
**es** — change in place:
```ts
      vault_hero_body: 'Almacenamiento en frío a largo plazo, bloqueado con tus propias YubiKeys. Requiere dos o más YubiKey 5 NFC.',
      vault_unsupported_body: 'Dos o más YubiKey 5 NFC, más un teléfono que pueda leerlas.',
      vault_key_section: 'Llaves de seguridad ({{count}} de 5)',
      vault_deposit_sub: 'Desde tu saldo diario. No hace falta YubiKey.',
      vault_withdraw_sub: 'De vuelta a tu saldo diario. Toca cualquiera de tus llaves de la caja fuerte.',
      vault_withdraw_partial: 'Quedan {{count}} depósitos más: retira de nuevo para moverlos.',
      vault_disable_message: 'Esto olvida la lista de llaves de la caja fuerte en este teléfono. Las claves permanecen en tus YubiKeys.',
      vault_err_pin_locked: 'El PIN de esta YubiKey está bloqueado. Usa otra de tus llaves de la caja fuerte, o desbloquéala con su PUK en Yubico Authenticator.',
      vault_err_wrong_key: 'Esta YubiKey no es una de las llaves de esta caja fuerte.',
      vault_err_serial_mismatch: 'Esta YubiKey no es una de las llaves de esta caja fuerte ({{names}}).',
```

- [ ] **Step 4: Add the same keys and in-place changes to fr, ar and pt**

**fr** — insert:
```ts
      vault_not_released_body: 'Pas encore disponible — les dépôts dans le coffre sont désactivés dans cette version.',
      vault_intro_title: 'Configurer votre coffre',
      vault_intro_what: 'Le coffre verrouille l’argent avec vos propres YubiKeys. Rien de la clé du coffre n’existe jamais sur ce téléphone ; n’importe laquelle de vos clés l’ouvre.',
      vault_intro_two_keys: 'Il vous faut au moins deux YubiKeys.',
      vault_intro_apart: 'Gardez-les à des endroits différents — deux clés rangées ensemble n’en font qu’une.',
      vault_intro_backup: 'Laissez la sauvegarde chiffrée du portefeuille activée — elle contient la trace de chaque dépôt.',
      vault_intro_ack: 'Je comprends : seules mes YubiKeys ouvrent ce coffre. Ma phrase de récupération, non. Si je les perds toutes, l’argent est perdu.',
      vault_intro_begin: 'Commencer',
      vault_key_step_title: 'Clé {{k}} sur 5 maximum',
      vault_key_step_replace: 'Tout ce qui est déjà stocké dans l’emplacement coffre de cette YubiKey sera remplacé.',
      vault_nfc_enroll_message: 'Tenez votre YubiKey ici pour la configurer',
      vault_nfc_sign_batch: 'Tenez votre YubiKey ici pour signer — lot {{b}} sur {{n}}',
      vault_key_use_different: 'Utiliser une autre YubiKey',
      vault_key_setup_again: 'La reconfigurer',
      vault_name_title: 'Nommer cette clé',
      vault_name_default: 'Clé {{k}}',
      vault_name_hint: 'p. ex. Bureau, Coffre-fort, Chez mes parents',
      vault_more_title: 'Ajouter une autre clé ?',
      vault_more_body: 'Jusqu’à 5 clés. N’importe laquelle ouvre tout le coffre à elle seule.',
      vault_more_add: 'Ajouter une autre clé',
      vault_more_finish: 'Terminer',
      vault_more_need_two: 'Ajoutez une deuxième clé avant de terminer — une seule clé, c’est aucune récupération.',
      vault_leave_setup: 'Quitter la configuration',
      vault_leave_title: 'Quitter la configuration ?',
      vault_leave_body: 'Les {{count}} YubiKey(s) que vous avez configurées ne seront pas encore enregistrées. Elles conservent leurs clés, vous pourrez donc les rajouter dans une minute.',
      vault_leave_confirm: 'Quitter',
      vault_leave_stay: 'Rester',
      vault_done_body: '{{count}} clés peuvent ouvrir ce coffre. Seules ces clés l’ouvrent — pas votre phrase de récupération.',
      vault_done_cta: 'Terminé',
      vault_add_key_row: 'Ajouter une clé',
      vault_add_key_done: '{{nickname}} peut ouvrir les dépôts effectués à partir de maintenant. Reverrouillez le coffre pour qu’elle puisse tout ouvrir.',
      vault_key_added_toast: 'Clé ajoutée',
      vault_relock_row: 'Reverrouiller le coffre',
      vault_relock_now: 'Reverrouiller maintenant',
      vault_relock_choose: 'Quelle clé allez-vous approcher pour reverrouiller ?',
      vault_relock_reason: 'Approchez l’une de vos clés existantes ({{names}}) — pas celle que vous venez d’ajouter.',
      vault_relock_reason_generic: 'Tenez votre YubiKey ici pour signer — reverrouiller le coffre avec vos clés actuelles',
      vault_relock_done: 'Coffre reverrouillé avec vos clés actuelles',
      vault_relock_capped: 'Il reste {{count}} dépôts — reverrouillez à nouveau pour les déplacer.',
      vault_relock_unreachable: '{{count}} dépôts ne peuvent être ouverts que par {{names}}. Reverrouillez à nouveau avec l’une de ces clés.',
      vault_badge_missing: '{{count}} dépôts pas encore ouverts à {{nickname}}',
      vault_badge_removed: '{{count}} dépôts encore ouverts à une clé retirée',
      vault_key_action_rename: 'Renommer',
      vault_key_action_remove: 'Retirer',
      vault_rename_title: 'Renommer {{nickname}}',
      vault_rename_save: 'Enregistrer',
      vault_remove_title: 'Retirer {{nickname}} ?',
      vault_remove_body: 'Le portefeuille cessera d’utiliser {{nickname}}. L’argent déjà dans le coffre reste ouvrable par cette clé jusqu’au reverrouillage (≈ {{fee}} sats).',
      vault_remove_and_relock: 'Retirer et reverrouiller maintenant',
      vault_remove_only: 'Retirer seulement',
      vault_key_removed_toast: 'Clé retirée',
      vault_export_explainer: 'Chaque dépôt dans le coffre porte une donnée unique nécessaire pour l’ouvrir, avec vos YubiKeys. Elle est stockée dans la base de données de ce portefeuille. Laissez la sauvegarde chiffrée activée et exportez une copie des données du portefeuille après vos dépôts.',
      vault_footnote: 'Seules ces clés ouvrent le coffre. Votre phrase de récupération, non.',
      vault_floor_line: 'Dépôt minimum {{floorDisplay}} ({{floorSats}} sats). Créer un dépôt dans le coffre coûte environ {{feeDisplay}}.',
      vault_first_deposit_title: 'Premier dépôt dans le coffre',
      vault_first_deposit_body: 'Premier dépôt dans le coffre — {{amount}} ne pourra être ouvert qu’avec {{count}} YubiKeys ({{names}}). Votre phrase de récupération ne servira à rien.',
      vault_backup_off_title: 'Activez d’abord la sauvegarde',
      vault_backup_off_body: 'Chaque dépôt dans le coffre a un secret à usage unique stocké uniquement dans ce portefeuille. Si ce téléphone est perdu et que la sauvegarde est désactivée, aucune YubiKey ne pourra ouvrir le coffre.',
      vault_backup_off_cta: 'Ouvrir les réglages',
      vault_choose_key: 'Quelle clé allez-vous approcher ?',
      vault_remainder_title: 'Tout retirer ?',
      vault_remainder_body: 'Retirer {{amount}} laisse {{remainder}}, en dessous du minimum de 100 000 sats du coffre. Tout le coffre passera dans votre solde courant.',
      vault_remainder_all: 'Tout retirer',
      vault_remainder_change: 'Changer le montant',
      vault_unreachable_title: 'Une partie du coffre nécessite une autre clé',
      vault_unreachable_body: 'Une partie du coffre nécessite une autre clé — {{moved}} déplacés. {{count}} dépôts totalisant {{amount}} ne peuvent être ouverts que par {{names}}. Retirez à nouveau avec l’une de ces clés.',
      vault_sign_progress: '{{signed}} sur {{total}} signés',
      vault_err_pin_locked_enroll: 'Le PIN de cette YubiKey est bloqué. Débloquez-le avec son PUK dans Yubico Authenticator, ou configurez avec une autre YubiKey.',
      vault_err_serial_mismatch_chosen: 'C’est {{tappedName}}. Vous avez choisi {{chosenName}} — approchez-la, ou revenez en arrière et choisissez {{tappedName}}.',
      vault_err_key_already_enrolled: 'Vous avez déjà ajouté cette YubiKey ({{nickname}}). Approchez-en une autre.',
      vault_err_not_released: 'Les dépôts dans le coffre sont désactivés dans cette version.',
      vault_err_backup_off: 'Activez la sauvegarde chiffrée du portefeuille avant de déposer dans le coffre.',
      vault_err_not_enough_keys: 'Ce coffre a moins de deux clés. Reconfigurez-le.',
      vault_err_too_many_keys: 'Un coffre accepte au plus cinq clés.',
      vault_err_last_keys: 'Un coffre a besoin d’au moins deux clés. Ajoutez-en une autre avant de retirer celle-ci.',
      vault_err_relock_required: 'Reverrouillez d’abord le coffre pour que vos autres clés puissent ouvrir chaque dépôt.',
      vault_err_key_not_committed: '{{nickname}} ne peut ouvrir aucun des dépôts de ce coffre. Utilisez une autre de vos clés.',
      vault_err_key_cannot_cover: '{{nickname}} peut ouvrir {{reachable}} sur les {{total}} du coffre. Retirez jusqu’à {{reachable}}, ou utilisez {{otherNames}}.',
      vault_err_too_small_to_relock: 'Ce coffre contient moins de 100 000 sats, trop peu pour reverrouiller. Retirez-le plutôt et déposez à nouveau.',
      vault_err_bad_version: 'La transaction a été construite dans le mauvais format. Rien n’a été signé — réessayez.',
```
**fr** — change in place:
```ts
      vault_hero_body: 'Stockage à froid pour le long terme, verrouillé avec vos propres YubiKeys. Nécessite deux YubiKey 5 NFC ou plus.',
      vault_unsupported_body: 'Deux YubiKey 5 NFC ou plus, et un téléphone capable de les lire.',
      vault_key_section: 'Clés de sécurité ({{count}} sur 5)',
      vault_deposit_sub: 'Depuis votre solde courant. Aucune YubiKey nécessaire.',
      vault_withdraw_sub: 'Retour vers votre solde courant. Approchez n’importe laquelle de vos clés du coffre.',
      vault_withdraw_partial: 'Il reste {{count}} dépôts — retirez à nouveau pour les déplacer.',
      vault_disable_message: 'Cela oublie la liste des clés du coffre sur ce téléphone. Les clés restent sur vos YubiKeys.',
      vault_err_pin_locked: 'Le PIN de cette YubiKey est bloqué. Utilisez une autre de vos clés du coffre, ou débloquez celle-ci avec son PUK dans Yubico Authenticator.',
      vault_err_wrong_key: 'Cette YubiKey n’est pas l’une des clés de ce coffre.',
      vault_err_serial_mismatch: 'Cette YubiKey n’est pas l’une des clés de ce coffre ({{names}}).',
```

**ar** — insert:
```ts
      vault_not_released_body: 'غير متاح بعد — إيداعات الخزنة معطّلة في هذا الإصدار.',
      vault_intro_title: 'إعداد خزنتك',
      vault_intro_what: 'تقفل الخزنة الأموال بمفاتيح YubiKey الخاصة بك. لا يوجد أي جزء من مفتاح الخزنة على هذا الهاتف أبدًا؛ وأي مفتاح من مفاتيحك يفتحها.',
      vault_intro_two_keys: 'تحتاج إلى مفتاحَي YubiKey على الأقل.',
      vault_intro_apart: 'احتفظ بها في أماكن مختلفة — مفتاحان محفوظان معًا هما مفتاح واحد.',
      vault_intro_backup: 'أبقِ النسخة الاحتياطية المشفّرة للمحفظة مفعّلة — فهي تحتفظ بسجل كل إيداع.',
      vault_intro_ack: 'أفهم: مفاتيح YubiKey الخاصة بي فقط تفتح هذه الخزنة. عبارة الاسترداد لا تفتحها. إذا فقدتها كلها، تضيع الأموال.',
      vault_intro_begin: 'ابدأ',
      vault_key_step_title: 'المفتاح {{k}} من 5 كحدّ أقصى',
      vault_key_step_replace: 'سيتم استبدال أي شيء مخزّن مسبقًا في خانة الخزنة لهذا المفتاح.',
      vault_nfc_enroll_message: 'ضع مفتاح YubiKey هنا لإعداده',
      vault_nfc_sign_batch: 'ضع مفتاح YubiKey هنا للتوقيع — الدفعة {{b}} من {{n}}',
      vault_key_use_different: 'استخدام مفتاح YubiKey آخر',
      vault_key_setup_again: 'إعداده من جديد',
      vault_name_title: 'سمِّ هذا المفتاح',
      vault_name_default: 'المفتاح {{k}}',
      vault_name_hint: 'مثلًا: المكتب، الخزانة، بيت الوالدين',
      vault_more_title: 'إضافة مفتاح آخر؟',
      vault_more_body: 'حتى 5 مفاتيح. أي واحد منها يفتح الخزنة كاملة بمفرده.',
      vault_more_add: 'إضافة مفتاح آخر',
      vault_more_finish: 'إنهاء',
      vault_more_need_two: 'أضف مفتاحًا ثانيًا قبل الإنهاء — مفتاح واحد يعني عدم وجود استرداد.',
      vault_leave_setup: 'مغادرة الإعداد',
      vault_leave_title: 'مغادرة الإعداد؟',
      vault_leave_body: 'لن تُحفظ مفاتيح YubiKey ({{count}}) التي أعددتها بعد. تحتفظ بمفاتيحها، فيمكنك إضافتها مجددًا خلال دقيقة.',
      vault_leave_confirm: 'مغادرة',
      vault_leave_stay: 'البقاء',
      vault_done_body: '{{count}} مفاتيح يمكنها فتح هذه الخزنة. هذه المفاتيح فقط تفتحها — وليس عبارة الاسترداد.',
      vault_done_cta: 'تم',
      vault_add_key_row: 'إضافة مفتاح',
      vault_add_key_done: 'يمكن لـ {{nickname}} فتح الإيداعات التي تُجرى من الآن. أعد قفل الخزنة ليتمكن من فتح كل شيء.',
      vault_key_added_toast: 'تمت إضافة المفتاح',
      vault_relock_row: 'إعادة قفل الخزنة',
      vault_relock_now: 'إعادة القفل الآن',
      vault_relock_choose: 'أي مفتاح ستلمس لإعادة القفل؟',
      vault_relock_reason: 'المس أحد مفاتيحك الحالية ({{names}}) — وليس الذي أضفته للتو.',
      vault_relock_reason_generic: 'ضع مفتاح YubiKey هنا للتوقيع — إعادة قفل الخزنة على مفاتيحك الحالية',
      vault_relock_done: 'أُعيد قفل الخزنة على مفاتيحك الحالية',
      vault_relock_capped: 'بقي {{count}} إيداعًا — أعد القفل مجددًا لنقلها.',
      vault_relock_unreachable: '{{count}} إيداعًا لا يفتحها سوى {{names}}. أعد القفل مجددًا بأحد تلك المفاتيح.',
      vault_badge_missing: '{{count}} إيداعًا غير مفتوح بعد لـ {{nickname}}',
      vault_badge_removed: '{{count}} إيداعًا ما زال مفتوحًا لمفتاح تمت إزالته',
      vault_key_action_rename: 'إعادة التسمية',
      vault_key_action_remove: 'إزالة',
      vault_rename_title: 'إعادة تسمية {{nickname}}',
      vault_rename_save: 'حفظ',
      vault_remove_title: 'إزالة {{nickname}}؟',
      vault_remove_body: 'ستتوقف المحفظة عن استخدام {{nickname}}. تبقى الأموال الموجودة في الخزنة قابلة للفتح به حتى تعيد القفل (≈ {{fee}} ساتوشي).',
      vault_remove_and_relock: 'إزالة وإعادة القفل الآن',
      vault_remove_only: 'إزالة فقط',
      vault_key_removed_toast: 'تمت إزالة المفتاح',
      vault_export_explainer: 'يحمل كل إيداع في الخزنة جزءًا فريدًا من البيانات مطلوبًا لفتحه، إلى جانب مفاتيح YubiKey. وهو مخزّن في قاعدة بيانات هذه المحفظة. أبقِ النسخة الاحتياطية المشفّرة مفعّلة، وصدّر نسخة من بيانات المحفظة بعد الإيداع.',
      vault_footnote: 'هذه المفاتيح فقط تفتح الخزنة. عبارة الاسترداد لا تفتحها.',
      vault_floor_line: 'الحدّ الأدنى للإيداع {{floorDisplay}} ({{floorSats}} ساتوشي). يكلّف إنشاء إيداع في الخزنة نحو {{feeDisplay}}.',
      vault_first_deposit_title: 'أول إيداع في الخزنة',
      vault_first_deposit_body: 'أول إيداع في الخزنة — لن يمكن فتح {{amount}} إلا بـ {{count}} مفاتيح YubiKey ({{names}}). عبارة الاسترداد لن تفيد.',
      vault_backup_off_title: 'فعّل النسخ الاحتياطي أولًا',
      vault_backup_off_body: 'لكل إيداع في الخزنة سرّ لمرة واحدة مخزّن في هذه المحفظة فقط. إذا فُقد هذا الهاتف والنسخ الاحتياطي معطّل، فلن يفتح أي مفتاح YubiKey الخزنة.',
      vault_backup_off_cta: 'فتح الإعدادات',
      vault_choose_key: 'أي مفتاح ستلمس؟',
      vault_remainder_title: 'سحب كل شيء؟',
      vault_remainder_body: 'سحب {{amount}} يترك {{remainder}}، وهو أقل من الحدّ الأدنى للخزنة 100,000 ساتوشي. ستنتقل الخزنة كاملة إلى رصيدك اليومي.',
      vault_remainder_all: 'سحب كل شيء',
      vault_remainder_change: 'تغيير المبلغ',
      vault_unreachable_title: 'جزء من الخزنة يحتاج إلى مفتاح آخر',
      vault_unreachable_body: 'جزء من الخزنة يحتاج إلى مفتاح آخر — نُقل {{moved}}. {{count}} إيداعًا بقيمة {{amount}} لا يفتحها سوى {{names}}. اسحب مجددًا بأحد تلك المفاتيح.',
      vault_sign_progress: 'تم توقيع {{signed}} من {{total}}',
      vault_err_pin_locked_enroll: 'رمز PIN لهذا المفتاح محظور. أزل الحظر بـ PUK في Yubico Authenticator، أو أعدّ بمفتاح YubiKey آخر.',
      vault_err_serial_mismatch_chosen: 'هذا هو {{tappedName}}. اخترت {{chosenName}} — المسه، أو ارجع واختر {{tappedName}}.',
      vault_err_key_already_enrolled: 'لقد أضفت هذا المفتاح من قبل ({{nickname}}). المس مفتاحًا آخر.',
      vault_err_not_released: 'إيداعات الخزنة معطّلة في هذا الإصدار.',
      vault_err_backup_off: 'فعّل النسخة الاحتياطية المشفّرة للمحفظة قبل الإيداع في الخزنة.',
      vault_err_not_enough_keys: 'هذه الخزنة لديها أقل من مفتاحين. أعد إعدادها.',
      vault_err_too_many_keys: 'تتّسع الخزنة لخمسة مفاتيح كحدّ أقصى.',
      vault_err_last_keys: 'تحتاج الخزنة إلى مفتاحين على الأقل. أضف مفتاحًا آخر قبل إزالة هذا.',
      vault_err_relock_required: 'أعد قفل الخزنة أولًا حتى تتمكن مفاتيحك الأخرى من فتح كل إيداع.',
      vault_err_key_not_committed: 'لا يمكن لـ {{nickname}} فتح أي من إيداعات هذه الخزنة. استخدم مفتاحًا آخر من مفاتيح خزنتك.',
      vault_err_key_cannot_cover: 'يمكن لـ {{nickname}} فتح {{reachable}} من أصل {{total}} في الخزنة. اسحب حتى {{reachable}}، أو استخدم {{otherNames}} بدلًا منه.',
      vault_err_too_small_to_relock: 'تحوي هذه الخزنة أقل من 100,000 ساتوشي، وهو أقل من أن يُعاد قفله. اسحبها بدلًا من ذلك ثم أودع مجددًا.',
      vault_err_bad_version: 'بُنيت المعاملة بتنسيق خاطئ. لم يُوقَّع شيء — حاول مجددًا.',
```
**ar** — change in place:
```ts
      vault_hero_body: 'تخزين طويل الأمد مقفل بمفاتيح YubiKey الخاصة بك. يحتاج إلى مفتاحَي YubiKey 5 NFC أو أكثر.',
      vault_unsupported_body: 'مفتاحا YubiKey 5 NFC أو أكثر، وهاتف قادر على قراءتها.',
      vault_key_section: 'مفاتيح الأمان ({{count}} من 5)',
      vault_deposit_sub: 'من رصيدك اليومي. لا حاجة إلى YubiKey.',
      vault_withdraw_sub: 'عودة إلى رصيدك اليومي. المس أي مفتاح من مفاتيح خزنتك.',
      vault_withdraw_partial: 'بقي {{count}} إيداعًا — اسحب مجددًا لنقلها.',
      vault_disable_message: 'هذا يمحو قائمة مفاتيح الخزنة من هذا الهاتف. تبقى المفاتيح على مفاتيح YubiKey الخاصة بك.',
      vault_err_pin_locked: 'رمز PIN لهذا المفتاح محظور. استخدم مفتاحًا آخر من مفاتيح خزنتك، أو أزل حظره بـ PUK في Yubico Authenticator.',
      vault_err_wrong_key: 'هذا المفتاح ليس من مفاتيح هذه الخزنة.',
      vault_err_serial_mismatch: 'هذا المفتاح ليس من مفاتيح هذه الخزنة ({{names}}).',
```

**pt** — insert:
```ts
      vault_not_released_body: 'Ainda não disponível — os depósitos no cofre estão desativados nesta versão.',
      vault_intro_title: 'Configure o seu cofre',
      vault_intro_what: 'O cofre tranca o dinheiro com as suas próprias YubiKeys. Nada da chave do cofre existe neste telefone; qualquer uma das suas chaves o abre.',
      vault_intro_two_keys: 'Você precisa de pelo menos duas YubiKeys.',
      vault_intro_apart: 'Guarde-as em lugares diferentes — duas chaves guardadas juntas são uma só.',
      vault_intro_backup: 'Mantenha o backup criptografado da carteira ativado — ele guarda o registro de cada depósito.',
      vault_intro_ack: 'Eu entendo: só as minhas YubiKeys abrem este cofre. A minha frase de recuperação não. Se eu perder todas, o dinheiro se perde.',
      vault_intro_begin: 'Começar',
      vault_key_step_title: 'Chave {{k}} de até 5',
      vault_key_step_replace: 'Tudo o que já estiver guardado no slot de cofre desta YubiKey será substituído.',
      vault_nfc_enroll_message: 'Encoste a sua YubiKey aqui para configurá-la',
      vault_nfc_sign_batch: 'Encoste a sua YubiKey aqui para assinar — lote {{b}} de {{n}}',
      vault_key_use_different: 'Usar outra YubiKey',
      vault_key_setup_again: 'Configurar de novo',
      vault_name_title: 'Dê um nome a esta chave',
      vault_name_default: 'Chave {{k}}',
      vault_name_hint: 'ex.: Escritório, Cofre, Casa dos pais',
      vault_more_title: 'Adicionar outra chave?',
      vault_more_body: 'Até 5 chaves. Qualquer uma delas abre o cofre inteiro sozinha.',
      vault_more_add: 'Adicionar outra chave',
      vault_more_finish: 'Concluir',
      vault_more_need_two: 'Adicione uma segunda chave antes de concluir — uma só chave significa nenhuma recuperação.',
      vault_leave_setup: 'Sair da configuração',
      vault_leave_title: 'Sair da configuração?',
      vault_leave_body: 'As {{count}} YubiKey(s) que você configurou ainda não serão salvas. Elas mantêm as suas chaves, então você pode adicioná-las de novo em um minuto.',
      vault_leave_confirm: 'Sair',
      vault_leave_stay: 'Ficar',
      vault_done_body: '{{count}} chaves podem abrir este cofre. Só estas chaves o abrem — a sua frase de recuperação não.',
      vault_done_cta: 'Concluído',
      vault_add_key_row: 'Adicionar chave',
      vault_add_key_done: '{{nickname}} pode abrir os depósitos feitos a partir de agora. Retranque o cofre para que ela possa abrir tudo.',
      vault_key_added_toast: 'Chave adicionada',
      vault_relock_row: 'Retrancar o cofre',
      vault_relock_now: 'Retrancar agora',
      vault_relock_choose: 'Qual chave você vai encostar para retrancar?',
      vault_relock_reason: 'Encoste uma das suas chaves existentes ({{names}}) — não a que você acabou de adicionar.',
      vault_relock_reason_generic: 'Encoste a sua YubiKey aqui para assinar — retrancar o cofre com as suas chaves atuais',
      vault_relock_done: 'Cofre retrancado com as suas chaves atuais',
      vault_relock_capped: 'Restam {{count}} depósitos — retranque de novo para movê-los.',
      vault_relock_unreachable: '{{count}} depósitos só podem ser abertos por {{names}}. Retranque de novo com uma dessas chaves.',
      vault_badge_missing: '{{count}} depósitos ainda não abertos para {{nickname}}',
      vault_badge_removed: '{{count}} depósitos ainda abertos para uma chave removida',
      vault_key_action_rename: 'Renomear',
      vault_key_action_remove: 'Remover',
      vault_rename_title: 'Renomear {{nickname}}',
      vault_rename_save: 'Salvar',
      vault_remove_title: 'Remover {{nickname}}?',
      vault_remove_body: 'A carteira deixará de usar {{nickname}}. O dinheiro que já está no cofre continua podendo ser aberto por ela até você retrancar (≈ {{fee}} sats).',
      vault_remove_and_relock: 'Remover e retrancar agora',
      vault_remove_only: 'Só remover',
      vault_key_removed_toast: 'Chave removida',
      vault_export_explainer: 'Cada depósito no cofre carrega um dado único necessário para abri-lo, junto com as suas YubiKeys. Ele fica guardado no banco de dados desta carteira. Mantenha o backup criptografado ativado e exporte uma cópia dos dados da carteira depois de fazer depósitos.',
      vault_footnote: 'Só estas chaves abrem o cofre. A sua frase de recuperação não.',
      vault_floor_line: 'Depósito mínimo {{floorDisplay}} ({{floorSats}} sats). Criar um depósito no cofre custa cerca de {{feeDisplay}}.',
      vault_first_deposit_title: 'Primeiro depósito no cofre',
      vault_first_deposit_body: 'Primeiro depósito no cofre — {{amount}} só poderá ser aberto com {{count}} YubiKeys ({{names}}). A sua frase de recuperação não vai ajudar.',
      vault_backup_off_title: 'Ative o backup primeiro',
      vault_backup_off_body: 'Cada depósito no cofre tem um segredo de uso único guardado apenas nesta carteira. Se este telefone for perdido e o backup estiver desativado, nenhuma YubiKey poderá abrir o cofre.',
      vault_backup_off_cta: 'Abrir configurações',
      vault_choose_key: 'Qual chave você vai encostar?',
      vault_remainder_title: 'Sacar tudo?',
      vault_remainder_body: 'Sacar {{amount}} deixa {{remainder}}, abaixo do mínimo de 100.000 sats do cofre. O cofre inteiro vai para o seu saldo do dia a dia.',
      vault_remainder_all: 'Sacar tudo',
      vault_remainder_change: 'Alterar valor',
      vault_unreachable_title: 'Parte do cofre precisa de outra chave',
      vault_unreachable_body: 'Parte do cofre precisa de outra chave — {{moved}} movidos. {{count}} depósitos com {{amount}} só podem ser abertos por {{names}}. Saque de novo com uma dessas chaves.',
      vault_sign_progress: '{{signed}} de {{total}} assinados',
      vault_err_pin_locked_enroll: 'O PIN desta YubiKey está bloqueado. Desbloqueie-o com o PUK no Yubico Authenticator, ou configure com outra YubiKey.',
      vault_err_serial_mismatch_chosen: 'Essa é {{tappedName}}. Você escolheu {{chosenName}} — encoste-a, ou volte e escolha {{tappedName}}.',
      vault_err_key_already_enrolled: 'Você já adicionou esta YubiKey ({{nickname}}). Encoste outra.',
      vault_err_not_released: 'Os depósitos no cofre estão desativados nesta versão.',
      vault_err_backup_off: 'Ative o backup criptografado da carteira antes de depositar no cofre.',
      vault_err_not_enough_keys: 'Este cofre tem menos de duas chaves. Configure-o de novo.',
      vault_err_too_many_keys: 'Um cofre aceita no máximo cinco chaves.',
      vault_err_last_keys: 'Um cofre precisa de pelo menos duas chaves. Adicione outra antes de remover esta.',
      vault_err_relock_required: 'Retranque o cofre primeiro para que as suas outras chaves possam abrir cada depósito.',
      vault_err_key_not_committed: '{{nickname}} não consegue abrir nenhum dos depósitos deste cofre. Use outra das suas chaves.',
      vault_err_key_cannot_cover: '{{nickname}} consegue abrir {{reachable}} dos {{total}} do cofre. Saque até {{reachable}}, ou use {{otherNames}}.',
      vault_err_too_small_to_relock: 'Este cofre tem menos de 100.000 sats, pouco demais para retrancar. Saque-o e deposite de novo.',
      vault_err_bad_version: 'A transação foi montada no formato errado. Nada foi assinado — tente de novo.',
```
**pt** — change in place:
```ts
      vault_hero_body: 'Armazenamento a frio de longo prazo, trancado com as suas próprias YubiKeys. Requer duas ou mais YubiKey 5 NFC.',
      vault_unsupported_body: 'Duas ou mais YubiKey 5 NFC, mais um telefone que consiga lê-las.',
      vault_key_section: 'Chaves de segurança ({{count}} de 5)',
      vault_deposit_sub: 'Do seu saldo do dia a dia. Não precisa de YubiKey.',
      vault_withdraw_sub: 'De volta ao seu saldo do dia a dia. Encoste qualquer uma das suas chaves do cofre.',
      vault_withdraw_partial: 'Restam {{count}} depósitos — saque de novo para movê-los.',
      vault_disable_message: 'Isto esquece a lista de chaves do cofre neste telefone. As chaves permanecem nas suas YubiKeys.',
      vault_err_pin_locked: 'O PIN desta YubiKey está bloqueado. Use outra das suas chaves do cofre, ou desbloqueie esta com o PUK no Yubico Authenticator.',
      vault_err_wrong_key: 'Esta YubiKey não é uma das chaves deste cofre.',
      vault_err_serial_mismatch: 'Esta YubiKey não é uma das chaves deste cofre ({{names}}).',
```

- [ ] **Step 5: Add the same keys and in-place changes to bn, ru and id**

**bn** — insert:
```ts
      vault_not_released_body: 'এখনও উপলব্ধ নয় — এই রিলিজে ভল্টে জমা বন্ধ রাখা হয়েছে।',
      vault_intro_title: 'আপনার ভল্ট সেট আপ করুন',
      vault_intro_what: 'ভল্ট আপনার নিজের YubiKey দিয়ে টাকা লক করে। ভল্ট কী-এর কোনো অংশই কখনও এই ফোনে থাকে না; আপনার যেকোনো একটি কী এটি খোলে।',
      vault_intro_two_keys: 'আপনার কমপক্ষে দুটি YubiKey লাগবে।',
      vault_intro_apart: 'এগুলি আলাদা জায়গায় রাখুন — একসাথে রাখা দুটি কী মানে একটি কী।',
      vault_intro_backup: 'ওয়ালেটের এনক্রিপ্টেড ব্যাকআপ চালু রাখুন — এতে প্রতিটি জমার রেকর্ড থাকে।',
      vault_intro_ack: 'আমি বুঝেছি: কেবল আমার YubiKey-গুলিই এই ভল্ট খোলে। আমার রিকভারি ফ্রেজ নয়। সবগুলি হারালে টাকা চিরতরে হারিয়ে যাবে।',
      vault_intro_begin: 'শুরু করুন',
      vault_key_step_title: 'কী {{k}}, সর্বোচ্চ ৫টির মধ্যে',
      vault_key_step_replace: 'এই YubiKey-এর ভল্ট স্লটে আগে থেকে রাখা যা কিছু আছে তা প্রতিস্থাপিত হবে।',
      vault_nfc_enroll_message: 'সেট আপ করতে আপনার YubiKey এখানে ধরুন',
      vault_nfc_sign_batch: 'সই করতে আপনার YubiKey এখানে ধরুন — ব্যাচ {{b}}/{{n}}',
      vault_key_use_different: 'অন্য একটি YubiKey ব্যবহার করুন',
      vault_key_setup_again: 'আবার সেট আপ করুন',
      vault_name_title: 'এই কী-এর নাম দিন',
      vault_name_default: 'কী {{k}}',
      vault_name_hint: 'যেমন ডেস্ক, সিন্দুক, বাবা-মায়ের বাড়ি',
      vault_more_title: 'আরেকটি কী যোগ করবেন?',
      vault_more_body: 'সর্বোচ্চ ৫টি কী। এর যেকোনো একটি একাই পুরো ভল্ট খুলতে পারে।',
      vault_more_add: 'আরেকটি কী যোগ করুন',
      vault_more_finish: 'শেষ করুন',
      vault_more_need_two: 'শেষ করার আগে দ্বিতীয় কী যোগ করুন — একটি কী মানে কোনো পুনরুদ্ধার নেই।',
      vault_leave_setup: 'সেটআপ ছেড়ে যান',
      vault_leave_title: 'সেটআপ ছেড়ে যাবেন?',
      vault_leave_body: 'আপনি যে {{count}}টি YubiKey সেট আপ করেছেন তা এখনও সংরক্ষিত হবে না। তাদের কী থেকে যায়, তাই এক মিনিটের মধ্যে আবার যোগ করতে পারবেন।',
      vault_leave_confirm: 'ছেড়ে যান',
      vault_leave_stay: 'থাকুন',
      vault_done_body: '{{count}}টি কী এই ভল্ট খুলতে পারে। কেবল এই কী-গুলিই এটি খোলে — আপনার রিকভারি ফ্রেজ নয়।',
      vault_done_cta: 'সম্পন্ন',
      vault_add_key_row: 'কী যোগ করুন',
      vault_add_key_done: '{{nickname}} এখন থেকে করা জমা খুলতে পারবে। ভল্ট পুনরায় লক করুন যাতে এটি সবকিছু খুলতে পারে।',
      vault_key_added_toast: 'কী যোগ করা হয়েছে',
      vault_relock_row: 'ভল্ট পুনরায় লক করুন',
      vault_relock_now: 'এখনই পুনরায় লক করুন',
      vault_relock_choose: 'পুনরায় লক করতে কোন কী ট্যাপ করবেন?',
      vault_relock_reason: 'আপনার বিদ্যমান কী-গুলির একটি ট্যাপ করুন ({{names}}) — যেটি এখনই যোগ করলেন সেটি নয়।',
      vault_relock_reason_generic: 'সই করতে আপনার YubiKey এখানে ধরুন — আপনার বর্তমান কী-গুলিতে ভল্ট পুনরায় লক করুন',
      vault_relock_done: 'ভল্ট আপনার বর্তমান কী-গুলিতে পুনরায় লক হয়েছে',
      vault_relock_capped: 'আরও {{count}}টি জমা বাকি — সরাতে আবার পুনরায় লক করুন।',
      vault_relock_unreachable: '{{count}}টি জমা কেবল {{names}} দিয়ে খোলা যায়। সেগুলির একটি দিয়ে আবার পুনরায় লক করুন।',
      vault_badge_missing: '{{count}}টি জমা এখনও {{nickname}}-এর জন্য খোলা নয়',
      vault_badge_removed: '{{count}}টি জমা এখনও একটি সরানো কী দিয়ে খোলা যায়',
      vault_key_action_rename: 'নাম বদলান',
      vault_key_action_remove: 'সরান',
      vault_rename_title: '{{nickname}}-এর নাম বদলান',
      vault_rename_save: 'সংরক্ষণ',
      vault_remove_title: '{{nickname}} সরাবেন?',
      vault_remove_body: 'ওয়ালেট আর {{nickname}} ব্যবহার করবে না। ভল্টে থাকা টাকা পুনরায় লক না করা পর্যন্ত এটি দিয়ে খোলা যাবে (≈ {{fee}} sats)।',
      vault_remove_and_relock: 'সরান এবং এখনই পুনরায় লক করুন',
      vault_remove_only: 'কেবল সরান',
      vault_key_removed_toast: 'কী সরানো হয়েছে',
      vault_export_explainer: 'প্রতিটি ভল্ট জমার সাথে একটি অনন্য তথ্য থাকে যা আপনার YubiKey-এর সাথে এটি খুলতে দরকার। এটি এই ওয়ালেটের ডেটাবেসে সংরক্ষিত। এনক্রিপ্টেড ব্যাকআপ চালু রাখুন এবং জমার পরে ওয়ালেট ডেটার একটি কপি রপ্তানি করুন।',
      vault_footnote: 'কেবল এই কী-গুলিই ভল্ট খোলে। আপনার রিকভারি ফ্রেজ নয়।',
      vault_floor_line: 'সর্বনিম্ন জমা {{floorDisplay}} ({{floorSats}} sats)। একটি ভল্ট জমা তৈরিতে প্রায় {{feeDisplay}} খরচ হয়।',
      vault_first_deposit_title: 'প্রথম ভল্ট জমা',
      vault_first_deposit_body: 'প্রথম ভল্ট জমা — {{amount}} কেবল {{count}}টি YubiKey ({{names}}) দিয়ে খোলা যাবে। আপনার রিকভারি ফ্রেজ কাজে আসবে না।',
      vault_backup_off_title: 'প্রথমে ব্যাকআপ চালু করুন',
      vault_backup_off_body: 'প্রতিটি ভল্ট জমার একটি একবারের গোপন তথ্য কেবল এই ওয়ালেটে থাকে। এই ফোন হারালে এবং ব্যাকআপ বন্ধ থাকলে কোনো YubiKey ভল্ট খুলতে পারবে না।',
      vault_backup_off_cta: 'সেটিংস খুলুন',
      vault_choose_key: 'কোন কী ট্যাপ করবেন?',
      vault_remainder_title: 'সব তুলে নেবেন?',
      vault_remainder_body: '{{amount}} তুললে {{remainder}} থাকবে, যা ১০০,০০০ sat ভল্ট ন্যূনতমের নিচে। পুরো ভল্ট আপনার দৈনন্দিন ব্যালেন্সে চলে যাবে।',
      vault_remainder_all: 'সব তুলে নিন',
      vault_remainder_change: 'পরিমাণ বদলান',
      vault_unreachable_title: 'ভল্টের একটি অংশে অন্য কী দরকার',
      vault_unreachable_body: 'ভল্টের একটি অংশে অন্য কী দরকার — {{moved}} সরানো হয়েছে। {{amount}} ধারণকারী {{count}}টি জমা কেবল {{names}} দিয়ে খোলা যায়। সেগুলির একটি দিয়ে আবার তুলুন।',
      vault_sign_progress: '{{total}}টির মধ্যে {{signed}}টি সই হয়েছে',
      vault_err_pin_locked_enroll: 'এই YubiKey-এর PIN ব্লক করা। Yubico Authenticator-এ এর PUK দিয়ে আনব্লক করুন, অথবা অন্য YubiKey দিয়ে সেট আপ করুন।',
      vault_err_serial_mismatch_chosen: 'এটি {{tappedName}}। আপনি {{chosenName}} বেছেছিলেন — সেটি ট্যাপ করুন, অথবা ফিরে গিয়ে {{tappedName}} বাছুন।',
      vault_err_key_already_enrolled: 'আপনি এই YubiKey ({{nickname}}) আগেই যোগ করেছেন। অন্য একটি ট্যাপ করুন।',
      vault_err_not_released: 'এই রিলিজে ভল্টে জমা বন্ধ রাখা হয়েছে।',
      vault_err_backup_off: 'ভল্টে জমা দেওয়ার আগে এনক্রিপ্টেড ওয়ালেট ব্যাকআপ চালু করুন।',
      vault_err_not_enough_keys: 'এই ভল্টে দুটির কম কী আছে। আবার সেট আপ করুন।',
      vault_err_too_many_keys: 'একটি ভল্টে সর্বোচ্চ পাঁচটি কী থাকতে পারে।',
      vault_err_last_keys: 'ভল্টে কমপক্ষে দুটি কী দরকার। এটি সরানোর আগে আরেকটি যোগ করুন।',
      vault_err_relock_required: 'প্রথমে ভল্ট পুনরায় লক করুন যাতে আপনার অন্য কী-গুলি প্রতিটি জমা খুলতে পারে।',
      vault_err_key_not_committed: '{{nickname}} এই ভল্টের কোনো জমাই খুলতে পারে না। আপনার অন্য একটি ভল্ট কী ব্যবহার করুন।',
      vault_err_key_cannot_cover: '{{nickname}} ভল্টের {{total}}-এর মধ্যে {{reachable}} খুলতে পারে। সর্বোচ্চ {{reachable}} তুলুন, অথবা {{otherNames}} ব্যবহার করুন।',
      vault_err_too_small_to_relock: 'এই ভল্টে ১০০,০০০ sats-এর কম আছে, যা পুনরায় লক করার জন্য খুব কম। বরং তুলে নিয়ে আবার জমা দিন।',
      vault_err_bad_version: 'লেনদেনটি ভুল ফরম্যাটে তৈরি হয়েছে। কিছুই সই হয়নি — আবার চেষ্টা করুন।',
```
**bn** — change in place:
```ts
      vault_hero_body: 'দীর্ঘমেয়াদের জন্য কোল্ড স্টোরেজ, আপনার নিজের YubiKey দিয়ে লক করা। দুটি বা তার বেশি YubiKey 5 NFC লাগবে।',
      vault_unsupported_body: 'দুটি বা তার বেশি YubiKey 5 NFC, এবং সেগুলি পড়তে পারে এমন একটি ফোন।',
      vault_key_section: 'সিকিউরিটি কী ({{count}}/৫)',
      vault_deposit_sub: 'আপনার দৈনন্দিন ব্যালেন্স থেকে। YubiKey লাগবে না।',
      vault_withdraw_sub: 'আপনার দৈনন্দিন ব্যালেন্সে ফেরত। আপনার যেকোনো ভল্ট কী ট্যাপ করুন।',
      vault_withdraw_partial: 'আরও {{count}}টি জমা বাকি — সরাতে আবার তুলুন।',
      vault_disable_message: 'এটি এই ফোনে ভল্টের কী তালিকা মুছে দেয়। কী-গুলি আপনার YubiKey-তে থেকে যায়।',
      vault_err_pin_locked: 'এই YubiKey-এর PIN ব্লক করা। আপনার অন্য একটি ভল্ট কী ব্যবহার করুন, অথবা Yubico Authenticator-এ এর PUK দিয়ে আনব্লক করুন।',
      vault_err_wrong_key: 'এই YubiKey এই ভল্টের কী-গুলির একটি নয়।',
      vault_err_serial_mismatch: 'এই YubiKey এই ভল্টের কী-গুলির একটি নয় ({{names}})।',
```

**ru** — insert:
```ts
      vault_not_released_body: 'Пока недоступно — пополнение хранилища отключено в этой версии.',
      vault_intro_title: 'Настройте хранилище',
      vault_intro_what: 'Хранилище запирает деньги вашими собственными YubiKey. Ничего из ключа хранилища никогда не хранится на этом телефоне; любой из ваших ключей открывает его.',
      vault_intro_two_keys: 'Нужно как минимум два YubiKey.',
      vault_intro_apart: 'Храните их в разных местах — два ключа, лежащие вместе, это один ключ.',
      vault_intro_backup: 'Не выключайте зашифрованную резервную копию кошелька — в ней запись о каждом пополнении.',
      vault_intro_ack: 'Я понимаю: только мои YubiKey открывают это хранилище. Моя фраза восстановления — нет. Если я потеряю их все, деньги пропадут.',
      vault_intro_begin: 'Начать',
      vault_key_step_title: 'Ключ {{k}} из не более 5',
      vault_key_step_replace: 'Всё, что уже хранится в слоте хранилища этого YubiKey, будет заменено.',
      vault_nfc_enroll_message: 'Приложите YubiKey сюда, чтобы настроить его',
      vault_nfc_sign_batch: 'Приложите YubiKey сюда для подписи — пакет {{b}} из {{n}}',
      vault_key_use_different: 'Использовать другой YubiKey',
      vault_key_setup_again: 'Настроить заново',
      vault_name_title: 'Назовите этот ключ',
      vault_name_default: 'Ключ {{k}}',
      vault_name_hint: 'например: Стол, Сейф, У родителей',
      vault_more_title: 'Добавить ещё ключ?',
      vault_more_body: 'До 5 ключей. Любой из них сам по себе открывает всё хранилище.',
      vault_more_add: 'Добавить ещё ключ',
      vault_more_finish: 'Готово',
      vault_more_need_two: 'Добавьте второй ключ перед завершением — один ключ означает отсутствие восстановления.',
      vault_leave_setup: 'Выйти из настройки',
      vault_leave_title: 'Выйти из настройки?',
      vault_leave_body: 'Настроенные вами YubiKey ({{count}}) пока не будут сохранены. Ключи на них остаются, так что вы сможете добавить их снова через минуту.',
      vault_leave_confirm: 'Выйти',
      vault_leave_stay: 'Остаться',
      vault_done_body: '{{count}} ключей могут открыть это хранилище. Только эти ключи открывают его — фраза восстановления нет.',
      vault_done_cta: 'Готово',
      vault_add_key_row: 'Добавить ключ',
      vault_add_key_done: '{{nickname}} может открывать пополнения, сделанные с этого момента. Перезапирайте хранилище, чтобы он мог открыть всё.',
      vault_key_added_toast: 'Ключ добавлен',
      vault_relock_row: 'Перезапереть хранилище',
      vault_relock_now: 'Перезапереть сейчас',
      vault_relock_choose: 'Каким ключом вы будете перезапирать?',
      vault_relock_reason: 'Приложите один из существующих ключей ({{names}}) — не тот, что вы только что добавили.',
      vault_relock_reason_generic: 'Приложите YubiKey сюда для подписи — перезапереть хранилище на текущие ключи',
      vault_relock_done: 'Хранилище перезаперто на текущие ключи',
      vault_relock_capped: 'Осталось ещё {{count}} пополнений — перезапирайте снова, чтобы перенести их.',
      vault_relock_unreachable: '{{count}} пополнений могут открыть только {{names}}. Перезапирайте снова одним из этих ключей.',
      vault_badge_missing: '{{count}} пополнений ещё не открыты для {{nickname}}',
      vault_badge_removed: '{{count}} пополнений всё ещё открыты для удалённого ключа',
      vault_key_action_rename: 'Переименовать',
      vault_key_action_remove: 'Удалить',
      vault_rename_title: 'Переименовать {{nickname}}',
      vault_rename_save: 'Сохранить',
      vault_remove_title: 'Удалить {{nickname}}?',
      vault_remove_body: 'Кошелёк перестанет использовать {{nickname}}. Деньги, уже лежащие в хранилище, остаются доступны этому ключу до перезапирания (≈ {{fee}} сат).',
      vault_remove_and_relock: 'Удалить и перезапереть сейчас',
      vault_remove_only: 'Только удалить',
      vault_key_removed_toast: 'Ключ удалён',
      vault_export_explainer: 'Каждое пополнение хранилища несёт уникальные данные, которые вместе с вашими YubiKey нужны, чтобы его открыть. Они хранятся в базе данных этого кошелька. Держите зашифрованную резервную копию включённой и экспортируйте копию данных кошелька после пополнений.',
      vault_footnote: 'Только эти ключи открывают хранилище. Фраза восстановления — нет.',
      vault_floor_line: 'Минимальное пополнение {{floorDisplay}} ({{floorSats}} сат). Создание пополнения хранилища стоит около {{feeDisplay}}.',
      vault_first_deposit_title: 'Первое пополнение хранилища',
      vault_first_deposit_body: 'Первое пополнение хранилища — {{amount}} можно будет открыть только {{count}} ключами YubiKey ({{names}}). Фраза восстановления не поможет.',
      vault_backup_off_title: 'Сначала включите резервную копию',
      vault_backup_off_body: 'У каждого пополнения хранилища есть одноразовый секрет, хранящийся только в этом кошельке. Если телефон потерян, а резервная копия выключена, ни один YubiKey не откроет хранилище.',
      vault_backup_off_cta: 'Открыть настройки',
      vault_choose_key: 'Какой ключ вы приложите?',
      vault_remainder_title: 'Вывести всё?',
      vault_remainder_body: 'После вывода {{amount}} останется {{remainder}} — меньше минимума хранилища в 100 000 сат. Всё хранилище перейдёт на ваш обычный баланс.',
      vault_remainder_all: 'Вывести всё',
      vault_remainder_change: 'Изменить сумму',
      vault_unreachable_title: 'Части хранилища нужен другой ключ',
      vault_unreachable_body: 'Части хранилища нужен другой ключ — перенесено {{moved}}. {{count}} пополнений на {{amount}} могут открыть только {{names}}. Выведите снова одним из этих ключей.',
      vault_sign_progress: 'Подписано {{signed}} из {{total}}',
      vault_err_pin_locked_enroll: 'PIN этого YubiKey заблокирован. Разблокируйте его PUK-кодом в Yubico Authenticator или настройте другой YubiKey.',
      vault_err_serial_mismatch_chosen: 'Это {{tappedName}}. Вы выбрали {{chosenName}} — приложите его или вернитесь и выберите {{tappedName}}.',
      vault_err_key_already_enrolled: 'Вы уже добавили этот YubiKey ({{nickname}}). Приложите другой.',
      vault_err_not_released: 'Пополнение хранилища отключено в этой версии.',
      vault_err_backup_off: 'Включите зашифрованную резервную копию кошелька перед пополнением хранилища.',
      vault_err_not_enough_keys: 'В этом хранилище меньше двух ключей. Настройте его заново.',
      vault_err_too_many_keys: 'В хранилище может быть не более пяти ключей.',
      vault_err_last_keys: 'Хранилищу нужно как минимум два ключа. Добавьте другой ключ, прежде чем удалять этот.',
      vault_err_relock_required: 'Сначала перезапирайте хранилище, чтобы другие ключи могли открыть каждое пополнение.',
      vault_err_key_not_committed: '{{nickname}} не может открыть ни одно пополнение в этом хранилище. Используйте другой ключ хранилища.',
      vault_err_key_cannot_cover: '{{nickname}} может открыть {{reachable}} из {{total}} в хранилище. Выведите не более {{reachable}} или используйте {{otherNames}}.',
      vault_err_too_small_to_relock: 'В этом хранилище меньше 100 000 сат — слишком мало для перезапирания. Выведите их и пополните снова.',
      vault_err_bad_version: 'Транзакция собрана в неверном формате. Ничего не подписано — попробуйте снова.',
```
**ru** — change in place:
```ts
      vault_hero_body: 'Холодное хранение на долгий срок, запертое вашими собственными YubiKey. Нужны два или более YubiKey 5 NFC.',
      vault_unsupported_body: 'Два или более YubiKey 5 NFC и телефон, который может их считать.',
      vault_key_section: 'Ключи безопасности ({{count}} из 5)',
      vault_deposit_sub: 'С вашего обычного баланса. YubiKey не нужен.',
      vault_withdraw_sub: 'Обратно на обычный баланс. Приложите любой из ключей хранилища.',
      vault_withdraw_partial: 'Осталось ещё {{count}} пополнений — выведите снова, чтобы перенести их.',
      vault_disable_message: 'Это стирает список ключей хранилища на этом телефоне. Сами ключи остаются на ваших YubiKey.',
      vault_err_pin_locked: 'PIN этого YubiKey заблокирован. Используйте другой ключ хранилища или разблокируйте этот PUK-кодом в Yubico Authenticator.',
      vault_err_wrong_key: 'Этот YubiKey не входит в ключи этого хранилища.',
      vault_err_serial_mismatch: 'Этот YubiKey не входит в ключи этого хранилища ({{names}}).',
```

**id** — insert:
```ts
      vault_not_released_body: 'Belum tersedia — setoran brankas dimatikan pada rilis ini.',
      vault_intro_title: 'Siapkan brankas Anda',
      vault_intro_what: 'Brankas mengunci uang dengan YubiKey milik Anda sendiri. Tidak ada bagian dari kunci brankas yang pernah ada di ponsel ini; salah satu kunci Anda saja cukup untuk membukanya.',
      vault_intro_two_keys: 'Anda memerlukan setidaknya dua YubiKey.',
      vault_intro_apart: 'Simpan di tempat yang berbeda — dua kunci yang disimpan bersama sama dengan satu kunci.',
      vault_intro_backup: 'Biarkan cadangan terenkripsi dompet tetap aktif — di sanalah catatan setiap setoran disimpan.',
      vault_intro_ack: 'Saya mengerti: hanya YubiKey saya yang membuka brankas ini. Frasa pemulihan saya tidak. Jika semuanya hilang, uangnya hilang.',
      vault_intro_begin: 'Mulai',
      vault_key_step_title: 'Kunci {{k}} dari maksimal 5',
      vault_key_step_replace: 'Apa pun yang sudah tersimpan di slot brankas YubiKey ini akan diganti.',
      vault_nfc_enroll_message: 'Tempelkan YubiKey Anda di sini untuk menyiapkannya',
      vault_nfc_sign_batch: 'Tempelkan YubiKey Anda di sini untuk menandatangani — kelompok {{b}} dari {{n}}',
      vault_key_use_different: 'Gunakan YubiKey lain',
      vault_key_setup_again: 'Siapkan lagi',
      vault_name_title: 'Beri nama kunci ini',
      vault_name_default: 'Kunci {{k}}',
      vault_name_hint: 'mis. Meja, Brankas, Rumah orang tua',
      vault_more_title: 'Tambah kunci lain?',
      vault_more_body: 'Hingga 5 kunci. Salah satunya saja bisa membuka seluruh brankas.',
      vault_more_add: 'Tambah kunci lain',
      vault_more_finish: 'Selesai',
      vault_more_need_two: 'Tambahkan kunci kedua sebelum selesai — satu kunci berarti tidak ada pemulihan.',
      vault_leave_setup: 'Keluar dari penyiapan',
      vault_leave_title: 'Keluar dari penyiapan?',
      vault_leave_body: '{{count}} YubiKey yang Anda siapkan belum akan disimpan. Kuncinya tetap ada, jadi Anda bisa menambahkannya lagi sebentar lagi.',
      vault_leave_confirm: 'Keluar',
      vault_leave_stay: 'Tetap di sini',
      vault_done_body: '{{count}} kunci dapat membuka brankas ini. Hanya kunci-kunci ini yang membukanya — frasa pemulihan Anda tidak.',
      vault_done_cta: 'Selesai',
      vault_add_key_row: 'Tambah kunci',
      vault_add_key_done: '{{nickname}} dapat membuka setoran yang dibuat mulai sekarang. Kunci ulang brankas agar ia bisa membuka semuanya.',
      vault_key_added_toast: 'Kunci ditambahkan',
      vault_relock_row: 'Kunci ulang brankas',
      vault_relock_now: 'Kunci ulang sekarang',
      vault_relock_choose: 'Kunci mana yang akan Anda tempelkan untuk mengunci ulang?',
      vault_relock_reason: 'Tempelkan salah satu kunci Anda yang sudah ada ({{names}}) — bukan yang baru saja Anda tambahkan.',
      vault_relock_reason_generic: 'Tempelkan YubiKey Anda di sini untuk menandatangani — kunci ulang brankas ke kunci Anda saat ini',
      vault_relock_done: 'Brankas dikunci ulang ke kunci Anda saat ini',
      vault_relock_capped: '{{count}} setoran lagi tersisa — kunci ulang lagi untuk memindahkannya.',
      vault_relock_unreachable: '{{count}} setoran hanya bisa dibuka oleh {{names}}. Kunci ulang lagi dengan salah satu kunci itu.',
      vault_badge_missing: '{{count}} setoran belum terbuka untuk {{nickname}}',
      vault_badge_removed: '{{count}} setoran masih terbuka untuk kunci yang dihapus',
      vault_key_action_rename: 'Ubah nama',
      vault_key_action_remove: 'Hapus',
      vault_rename_title: 'Ubah nama {{nickname}}',
      vault_rename_save: 'Simpan',
      vault_remove_title: 'Hapus {{nickname}}?',
      vault_remove_body: 'Dompet akan berhenti menggunakan {{nickname}}. Uang yang sudah ada di brankas tetap bisa dibuka olehnya sampai Anda mengunci ulang (≈ {{fee}} sat).',
      vault_remove_and_relock: 'Hapus dan kunci ulang sekarang',
      vault_remove_only: 'Hapus saja',
      vault_key_removed_toast: 'Kunci dihapus',
      vault_export_explainer: 'Setiap setoran brankas membawa satu data unik yang diperlukan untuk membukanya, bersama YubiKey Anda. Data itu disimpan di basis data dompet ini. Biarkan cadangan terenkripsi tetap aktif, dan ekspor salinan data dompet setelah melakukan setoran.',
      vault_footnote: 'Hanya kunci-kunci ini yang membuka brankas. Frasa pemulihan Anda tidak.',
      vault_floor_line: 'Setoran minimum {{floorDisplay}} ({{floorSats}} sat). Membuat setoran brankas berbiaya sekitar {{feeDisplay}}.',
      vault_first_deposit_title: 'Setoran brankas pertama',
      vault_first_deposit_body: 'Setoran brankas pertama — {{amount}} hanya bisa dibuka dengan {{count}} YubiKey ({{names}}). Frasa pemulihan Anda tidak akan membantu.',
      vault_backup_off_title: 'Aktifkan cadangan dahulu',
      vault_backup_off_body: 'Setiap setoran brankas memiliki rahasia sekali pakai yang hanya tersimpan di dompet ini. Jika ponsel ini hilang dan cadangan mati, tidak ada YubiKey yang bisa membuka brankas.',
      vault_backup_off_cta: 'Buka pengaturan',
      vault_choose_key: 'Kunci mana yang akan Anda tempelkan?',
      vault_remainder_title: 'Tarik semuanya?',
      vault_remainder_body: 'Menarik {{amount}} menyisakan {{remainder}}, di bawah minimum brankas 100.000 sat. Seluruh brankas akan pindah ke saldo harian Anda.',
      vault_remainder_all: 'Tarik semuanya',
      vault_remainder_change: 'Ubah jumlah',
      vault_unreachable_title: 'Sebagian brankas memerlukan kunci lain',
      vault_unreachable_body: 'Sebagian brankas memerlukan kunci lain — {{moved}} dipindahkan. {{count}} setoran senilai {{amount}} hanya bisa dibuka oleh {{names}}. Tarik lagi dengan salah satu kunci itu.',
      vault_sign_progress: '{{signed}} dari {{total}} ditandatangani',
      vault_err_pin_locked_enroll: 'PIN YubiKey ini terblokir. Buka blokirnya dengan PUK di Yubico Authenticator, atau siapkan dengan YubiKey lain.',
      vault_err_serial_mismatch_chosen: 'Itu {{tappedName}}. Anda memilih {{chosenName}} — tempelkan itu, atau kembali dan pilih {{tappedName}}.',
      vault_err_key_already_enrolled: 'Anda sudah menambahkan YubiKey ini ({{nickname}}). Tempelkan yang lain.',
      vault_err_not_released: 'Setoran brankas dimatikan pada rilis ini.',
      vault_err_backup_off: 'Aktifkan cadangan dompet terenkripsi sebelum menyetor ke brankas.',
      vault_err_not_enough_keys: 'Brankas ini memiliki kurang dari dua kunci. Siapkan lagi.',
      vault_err_too_many_keys: 'Brankas menampung paling banyak lima kunci.',
      vault_err_last_keys: 'Brankas memerlukan setidaknya dua kunci. Tambahkan kunci lain sebelum menghapus yang ini.',
      vault_err_relock_required: 'Kunci ulang brankas dahulu agar kunci Anda yang lain bisa membuka setiap setoran.',
      vault_err_key_not_committed: '{{nickname}} tidak bisa membuka satu pun setoran di brankas ini. Gunakan kunci brankas Anda yang lain.',
      vault_err_key_cannot_cover: '{{nickname}} bisa membuka {{reachable}} dari {{total}} di brankas. Tarik hingga {{reachable}}, atau gunakan {{otherNames}}.',
      vault_err_too_small_to_relock: 'Brankas ini berisi kurang dari 100.000 sat, terlalu kecil untuk dikunci ulang. Tarik saja lalu setor lagi.',
      vault_err_bad_version: 'Transaksi dibangun dalam format yang salah. Tidak ada yang ditandatangani — coba lagi.',
```
**id** — change in place:
```ts
      vault_hero_body: 'Penyimpanan dingin jangka panjang, dikunci dengan YubiKey milik Anda sendiri. Memerlukan dua YubiKey 5 NFC atau lebih.',
      vault_unsupported_body: 'Dua YubiKey 5 NFC atau lebih, plus ponsel yang bisa membacanya.',
      vault_key_section: 'Kunci keamanan ({{count}} dari 5)',
      vault_deposit_sub: 'Dari saldo harian Anda. Tidak perlu YubiKey.',
      vault_withdraw_sub: 'Kembali ke saldo harian Anda. Tempelkan salah satu kunci brankas Anda.',
      vault_withdraw_partial: '{{count}} setoran lagi tersisa — tarik lagi untuk memindahkannya.',
      vault_disable_message: 'Ini melupakan daftar kunci brankas di ponsel ini. Kuncinya tetap ada di YubiKey Anda.',
      vault_err_pin_locked: 'PIN YubiKey ini terblokir. Gunakan kunci brankas Anda yang lain, atau buka blokirnya dengan PUK di Yubico Authenticator.',
      vault_err_wrong_key: 'YubiKey ini bukan salah satu kunci brankas ini.',
      vault_err_serial_mismatch: 'YubiKey ini bukan salah satu kunci brankas ini ({{names}}).',
```

- [ ] **Step 6: Add the same keys and in-place changes to ja and pl**

**ja** — insert:
```ts
      vault_not_released_body: 'まだ利用できません — このリリースでは保管庫への入金は無効になっています。',
      vault_intro_title: '保管庫を設定する',
      vault_intro_what: '保管庫はあなた自身の YubiKey で資金をロックします。保管庫の鍵はこのスマートフォン上に一切存在せず、どの鍵一本でも開けられます。',
      vault_intro_two_keys: 'YubiKey が少なくとも 2 本必要です。',
      vault_intro_apart: '別々の場所に保管してください — 一緒に保管した 2 本の鍵は 1 本と同じです。',
      vault_intro_backup: 'ウォレットの暗号化バックアップをオンにしておいてください — 各入金の記録が含まれます。',
      vault_intro_ack: '理解しました：この保管庫を開けられるのは自分の YubiKey だけで、リカバリーフレーズでは開けられません。すべて失えば資金は失われます。',
      vault_intro_begin: '開始',
      vault_key_step_title: '鍵 {{k}}（最大 5 本）',
      vault_key_step_replace: 'この YubiKey の保管庫スロットに既に保存されている内容は置き換えられます。',
      vault_nfc_enroll_message: '設定するには YubiKey をここにかざしてください',
      vault_nfc_sign_batch: '署名するには YubiKey をここにかざしてください — バッチ {{b}}/{{n}}',
      vault_key_use_different: '別の YubiKey を使う',
      vault_key_setup_again: 'もう一度設定する',
      vault_name_title: 'この鍵に名前を付ける',
      vault_name_default: '鍵 {{k}}',
      vault_name_hint: '例：デスク、金庫、実家',
      vault_more_title: '別の鍵を追加しますか？',
      vault_more_body: '最大 5 本。どの 1 本でも単独で保管庫全体を開けられます。',
      vault_more_add: '別の鍵を追加',
      vault_more_finish: '完了',
      vault_more_need_two: '完了する前に 2 本目の鍵を追加してください — 鍵が 1 本では復旧できません。',
      vault_leave_setup: '設定をやめる',
      vault_leave_title: '設定をやめますか？',
      vault_leave_body: '設定した {{count}} 本の YubiKey はまだ保存されません。鍵は本体に残るので、すぐにまた追加できます。',
      vault_leave_confirm: 'やめる',
      vault_leave_stay: '続ける',
      vault_done_body: '{{count}} 本の鍵でこの保管庫を開けられます。開けられるのはこれらの鍵だけで、リカバリーフレーズでは開けられません。',
      vault_done_cta: '完了',
      vault_add_key_row: '鍵を追加',
      vault_add_key_done: '{{nickname}} は今後の入金を開けられます。すべてを開けられるように保管庫を再ロックしてください。',
      vault_key_added_toast: '鍵を追加しました',
      vault_relock_row: '保管庫を再ロック',
      vault_relock_now: '今すぐ再ロック',
      vault_relock_choose: '再ロックにはどの鍵をかざしますか？',
      vault_relock_reason: '既存の鍵のいずれか（{{names}}）をかざしてください — 今追加した鍵ではありません。',
      vault_relock_reason_generic: '署名するには YubiKey をここにかざしてください — 保管庫を現在の鍵に再ロックする',
      vault_relock_done: '保管庫を現在の鍵に再ロックしました',
      vault_relock_capped: 'あと {{count}} 件の入金が残っています — 移動するには再度再ロックしてください。',
      vault_relock_unreachable: '{{count}} 件の入金は {{names}} でしか開けられません。それらの鍵のいずれかで再度再ロックしてください。',
      vault_badge_missing: '{{count}} 件の入金がまだ {{nickname}} で開けられません',
      vault_badge_removed: '{{count}} 件の入金がまだ削除済みの鍵で開けられます',
      vault_key_action_rename: '名前を変更',
      vault_key_action_remove: '削除',
      vault_rename_title: '{{nickname}} の名前を変更',
      vault_rename_save: '保存',
      vault_remove_title: '{{nickname}} を削除しますか？',
      vault_remove_body: 'ウォレットは {{nickname}} の使用を停止します。保管庫に既にある資金は、再ロックするまでこの鍵で開けられたままです（約 {{fee}} sats）。',
      vault_remove_and_relock: '削除して今すぐ再ロック',
      vault_remove_only: '削除のみ',
      vault_key_removed_toast: '鍵を削除しました',
      vault_export_explainer: '保管庫への各入金には、YubiKey と併せて開けるために必要な固有のデータが付いています。それはこのウォレットのデータベースに保存されています。暗号化バックアップをオンにしておき、入金後にウォレットデータのコピーをエクスポートしてください。',
      vault_footnote: '保管庫を開けられるのはこれらの鍵だけです。リカバリーフレーズでは開けられません。',
      vault_floor_line: '最低入金額 {{floorDisplay}}（{{floorSats}} sats）。保管庫への入金の作成には約 {{feeDisplay}} かかります。',
      vault_first_deposit_title: '保管庫への初回入金',
      vault_first_deposit_body: '保管庫への初回入金 — {{amount}} は {{count}} 本の YubiKey（{{names}}）でしか開けられなくなります。リカバリーフレーズは役に立ちません。',
      vault_backup_off_title: 'まずバックアップをオンにしてください',
      vault_backup_off_body: '保管庫への各入金には、このウォレットにのみ保存される使い捨ての秘密があります。このスマートフォンを紛失しバックアップがオフだと、どの YubiKey でも保管庫を開けられません。',
      vault_backup_off_cta: '設定を開く',
      vault_choose_key: 'どの鍵をかざしますか？',
      vault_remainder_title: 'すべて引き出しますか？',
      vault_remainder_body: '{{amount}} を引き出すと {{remainder}} が残り、保管庫の最低額 100,000 sat を下回ります。保管庫全体が普段の残高に移動します。',
      vault_remainder_all: 'すべて引き出す',
      vault_remainder_change: '金額を変更',
      vault_unreachable_title: '保管庫の一部には別の鍵が必要です',
      vault_unreachable_body: '保管庫の一部には別の鍵が必要です — {{moved}} を移動しました。{{amount}} 分の {{count}} 件の入金は {{names}} でしか開けられません。それらの鍵のいずれかで再度引き出してください。',
      vault_sign_progress: '{{total}} 件中 {{signed}} 件に署名済み',
      vault_err_pin_locked_enroll: 'この YubiKey の PIN はブロックされています。Yubico Authenticator で PUK を使って解除するか、別の YubiKey で設定してください。',
      vault_err_serial_mismatch_chosen: 'これは {{tappedName}} です。選択したのは {{chosenName}} です — それをかざすか、戻って {{tappedName}} を選択してください。',
      vault_err_key_already_enrolled: 'この YubiKey（{{nickname}}）は既に追加済みです。別の鍵をかざしてください。',
      vault_err_not_released: 'このリリースでは保管庫への入金は無効になっています。',
      vault_err_backup_off: '保管庫に入金する前に、ウォレットの暗号化バックアップをオンにしてください。',
      vault_err_not_enough_keys: 'この保管庫の鍵は 2 本未満です。もう一度設定してください。',
      vault_err_too_many_keys: '保管庫の鍵は最大 5 本です。',
      vault_err_last_keys: '保管庫には少なくとも 2 本の鍵が必要です。この鍵を削除する前に別の鍵を追加してください。',
      vault_err_relock_required: '他の鍵ですべての入金を開けられるように、まず保管庫を再ロックしてください。',
      vault_err_key_not_committed: '{{nickname}} ではこの保管庫の入金をどれも開けられません。別の保管庫の鍵を使ってください。',
      vault_err_key_cannot_cover: '{{nickname}} は保管庫の {{total}} のうち {{reachable}} を開けられます。{{reachable}} まで引き出すか、代わりに {{otherNames}} を使ってください。',
      vault_err_too_small_to_relock: 'この保管庫の残高は 100,000 sats 未満で、再ロックするには少なすぎます。代わりに引き出してから再度入金してください。',
      vault_err_bad_version: 'トランザクションが誤った形式で作成されました。何も署名されていません — もう一度お試しください。',
```
**ja** — change in place:
```ts
      vault_hero_body: '長期保有向けのコールドストレージ。あなた自身の YubiKey でロックします。YubiKey 5 NFC が 2 本以上必要です。',
      vault_unsupported_body: 'YubiKey 5 NFC が 2 本以上と、それを読み取れるスマートフォン。',
      vault_key_section: 'セキュリティキー（{{count}}/5）',
      vault_deposit_sub: '普段の残高から。YubiKey は不要です。',
      vault_withdraw_sub: '普段の残高に戻します。保管庫の鍵のいずれかをかざしてください。',
      vault_withdraw_partial: 'あと {{count}} 件の入金が残っています — 移動するには再度引き出してください。',
      vault_disable_message: 'このスマートフォン上の保管庫の鍵リストを消去します。鍵自体は YubiKey に残ります。',
      vault_err_pin_locked: 'この YubiKey の PIN はブロックされています。別の保管庫の鍵を使うか、Yubico Authenticator で PUK を使って解除してください。',
      vault_err_wrong_key: 'この YubiKey はこの保管庫の鍵ではありません。',
      vault_err_serial_mismatch: 'この YubiKey はこの保管庫の鍵ではありません（{{names}}）。',
```

**pl** — insert:
```ts
      vault_not_released_body: 'Jeszcze niedostępne — wpłaty do sejfu są wyłączone w tym wydaniu.',
      vault_intro_title: 'Skonfiguruj swój sejf',
      vault_intro_what: 'Sejf zamyka pieniądze Twoimi własnymi kluczami YubiKey. Żaden fragment klucza sejfu nigdy nie istnieje na tym telefonie; otwiera go dowolny z Twoich kluczy.',
      vault_intro_two_keys: 'Potrzebujesz co najmniej dwóch kluczy YubiKey.',
      vault_intro_apart: 'Trzymaj je w różnych miejscach — dwa klucze przechowywane razem to jeden klucz.',
      vault_intro_backup: 'Zostaw włączoną zaszyfrowaną kopię zapasową portfela — zawiera zapis każdej wpłaty.',
      vault_intro_ack: 'Rozumiem: ten sejf otwierają tylko moje klucze YubiKey. Moja fraza odzyskiwania — nie. Jeśli stracę je wszystkie, pieniądze przepadną.',
      vault_intro_begin: 'Rozpocznij',
      vault_key_step_title: 'Klucz {{k}} z maks. 5',
      vault_key_step_replace: 'Wszystko, co już znajduje się w slocie sejfu tego klucza YubiKey, zostanie zastąpione.',
      vault_nfc_enroll_message: 'Przyłóż tutaj klucz YubiKey, aby go skonfigurować',
      vault_nfc_sign_batch: 'Przyłóż tutaj klucz YubiKey, aby podpisać — partia {{b}} z {{n}}',
      vault_key_use_different: 'Użyj innego klucza YubiKey',
      vault_key_setup_again: 'Skonfiguruj ponownie',
      vault_name_title: 'Nazwij ten klucz',
      vault_name_default: 'Klucz {{k}}',
      vault_name_hint: 'np. Biurko, Sejf, Dom rodziców',
      vault_more_title: 'Dodać kolejny klucz?',
      vault_more_body: 'Do 5 kluczy. Każdy z nich sam otwiera cały sejf.',
      vault_more_add: 'Dodaj kolejny klucz',
      vault_more_finish: 'Zakończ',
      vault_more_need_two: 'Dodaj drugi klucz przed zakończeniem — jeden klucz oznacza brak odzyskiwania.',
      vault_leave_setup: 'Opuść konfigurację',
      vault_leave_title: 'Opuścić konfigurację?',
      vault_leave_body: 'Skonfigurowane klucze YubiKey ({{count}}) nie zostaną jeszcze zapisane. Zachowują swoje klucze, więc za chwilę możesz dodać je ponownie.',
      vault_leave_confirm: 'Opuść',
      vault_leave_stay: 'Zostań',
      vault_done_body: '{{count}} kluczy może otworzyć ten sejf. Otwierają go tylko te klucze — Twoja fraza odzyskiwania nie.',
      vault_done_cta: 'Gotowe',
      vault_add_key_row: 'Dodaj klucz',
      vault_add_key_done: '{{nickname}} może otwierać wpłaty dokonane od teraz. Zablokuj sejf ponownie, aby mógł otworzyć wszystko.',
      vault_key_added_toast: 'Klucz dodany',
      vault_relock_row: 'Zablokuj sejf ponownie',
      vault_relock_now: 'Zablokuj ponownie teraz',
      vault_relock_choose: 'Który klucz przyłożysz, aby zablokować ponownie?',
      vault_relock_reason: 'Przyłóż jeden z istniejących kluczy ({{names}}) — nie ten, który właśnie dodałeś.',
      vault_relock_reason_generic: 'Przyłóż tutaj klucz YubiKey, aby podpisać — zablokuj sejf ponownie na obecne klucze',
      vault_relock_done: 'Sejf zablokowany ponownie na obecne klucze',
      vault_relock_capped: 'Pozostało jeszcze {{count}} wpłat — zablokuj ponownie, aby je przenieść.',
      vault_relock_unreachable: '{{count}} wpłat może otworzyć tylko {{names}}. Zablokuj ponownie jednym z tych kluczy.',
      vault_badge_missing: '{{count}} wpłat jeszcze nieotwartych dla {{nickname}}',
      vault_badge_removed: '{{count}} wpłat nadal otwartych dla usuniętego klucza',
      vault_key_action_rename: 'Zmień nazwę',
      vault_key_action_remove: 'Usuń',
      vault_rename_title: 'Zmień nazwę {{nickname}}',
      vault_rename_save: 'Zapisz',
      vault_remove_title: 'Usunąć {{nickname}}?',
      vault_remove_body: 'Portfel przestanie używać {{nickname}}. Pieniądze już w sejfie pozostają dostępne dla tego klucza do ponownego zablokowania (≈ {{fee}} sat).',
      vault_remove_and_relock: 'Usuń i zablokuj ponownie teraz',
      vault_remove_only: 'Tylko usuń',
      vault_key_removed_toast: 'Klucz usunięty',
      vault_export_explainer: 'Każda wpłata do sejfu niesie unikalny fragment danych, potrzebny do jej otwarcia razem z Twoimi kluczami YubiKey. Jest on przechowywany w bazie danych tego portfela. Zostaw włączoną zaszyfrowaną kopię zapasową i eksportuj kopię danych portfela po dokonaniu wpłat.',
      vault_footnote: 'Sejf otwierają tylko te klucze. Twoja fraza odzyskiwania — nie.',
      vault_floor_line: 'Minimalna wpłata {{floorDisplay}} ({{floorSats}} sat). Utworzenie wpłaty do sejfu kosztuje około {{feeDisplay}}.',
      vault_first_deposit_title: 'Pierwsza wpłata do sejfu',
      vault_first_deposit_body: 'Pierwsza wpłata do sejfu — {{amount}} będzie można otworzyć tylko {{count}} kluczami YubiKey ({{names}}). Twoja fraza odzyskiwania nie pomoże.',
      vault_backup_off_title: 'Najpierw włącz kopię zapasową',
      vault_backup_off_body: 'Każda wpłata do sejfu ma jednorazowy sekret przechowywany tylko w tym portfelu. Jeśli ten telefon zaginie, a kopia zapasowa jest wyłączona, żaden klucz YubiKey nie otworzy sejfu.',
      vault_backup_off_cta: 'Otwórz ustawienia',
      vault_choose_key: 'Który klucz przyłożysz?',
      vault_remainder_title: 'Wypłacić wszystko?',
      vault_remainder_body: 'Wypłata {{amount}} pozostawia {{remainder}}, czyli mniej niż minimum sejfu 100 000 sat. Cały sejf przejdzie na Twoje codzienne saldo.',
      vault_remainder_all: 'Wypłać wszystko',
      vault_remainder_change: 'Zmień kwotę',
      vault_unreachable_title: 'Część sejfu wymaga innego klucza',
      vault_unreachable_body: 'Część sejfu wymaga innego klucza — przeniesiono {{moved}}. {{count}} wpłat o wartości {{amount}} może otworzyć tylko {{names}}. Wypłać ponownie jednym z tych kluczy.',
      vault_sign_progress: 'Podpisano {{signed}} z {{total}}',
      vault_err_pin_locked_enroll: 'PIN tego klucza YubiKey jest zablokowany. Odblokuj go kodem PUK w Yubico Authenticator lub skonfiguruj inny klucz YubiKey.',
      vault_err_serial_mismatch_chosen: 'To {{tappedName}}. Wybrałeś {{chosenName}} — przyłóż go albo wróć i wybierz {{tappedName}}.',
      vault_err_key_already_enrolled: 'Ten klucz YubiKey ({{nickname}}) został już dodany. Przyłóż inny.',
      vault_err_not_released: 'Wpłaty do sejfu są wyłączone w tym wydaniu.',
      vault_err_backup_off: 'Włącz zaszyfrowaną kopię zapasową portfela przed wpłatą do sejfu.',
      vault_err_not_enough_keys: 'Ten sejf ma mniej niż dwa klucze. Skonfiguruj go ponownie.',
      vault_err_too_many_keys: 'Sejf może mieć najwyżej pięć kluczy.',
      vault_err_last_keys: 'Sejf wymaga co najmniej dwóch kluczy. Dodaj inny klucz, zanim usuniesz ten.',
      vault_err_relock_required: 'Najpierw zablokuj sejf ponownie, aby pozostałe klucze mogły otworzyć każdą wpłatę.',
      vault_err_key_not_committed: '{{nickname}} nie może otworzyć żadnej wpłaty w tym sejfie. Użyj innego klucza sejfu.',
      vault_err_key_cannot_cover: '{{nickname}} może otworzyć {{reachable}} z {{total}} w sejfie. Wypłać do {{reachable}} albo użyj {{otherNames}}.',
      vault_err_too_small_to_relock: 'Ten sejf zawiera mniej niż 100 000 sat — za mało, by zablokować go ponownie. Zamiast tego wypłać i wpłać ponownie.',
      vault_err_bad_version: 'Transakcja została zbudowana w złym formacie. Nic nie podpisano — spróbuj ponownie.',
```
**pl** — change in place:
```ts
      vault_hero_body: 'Zimne przechowywanie na długi termin, zablokowane Twoimi własnymi kluczami YubiKey. Wymaga dwóch lub więcej YubiKey 5 NFC.',
      vault_unsupported_body: 'Dwa lub więcej YubiKey 5 NFC oraz telefon, który potrafi je odczytać.',
      vault_key_section: 'Klucze bezpieczeństwa ({{count}} z 5)',
      vault_deposit_sub: 'Z Twojego codziennego salda. YubiKey nie jest potrzebny.',
      vault_withdraw_sub: 'Z powrotem na codzienne saldo. Przyłóż dowolny z kluczy sejfu.',
      vault_withdraw_partial: 'Pozostało jeszcze {{count}} wpłat — wypłać ponownie, aby je przenieść.',
      vault_disable_message: 'To usuwa listę kluczy sejfu z tego telefonu. Klucze pozostają na Twoich YubiKey.',
      vault_err_pin_locked: 'PIN tego klucza YubiKey jest zablokowany. Użyj innego klucza sejfu albo odblokuj ten kodem PUK w Yubico Authenticator.',
      vault_err_wrong_key: 'Ten klucz YubiKey nie jest jednym z kluczy tego sejfu.',
      vault_err_serial_mismatch: 'Ten klucz YubiKey nie jest jednym z kluczy tego sejfu ({{names}}).',
```

- [ ] **Step 7: Run the parity test — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```
Expected: `Tests: 33 passed` (3 checks × 11 locales). If `has no copy left in English` fails for a key, the translation is byte-identical to English — fix the translation, do not add to the allow-list (none of the new keys is a product name or pure format string).

- [ ] **Step 8: Type-check and commit**

```
npx tsc --noEmit -p tsconfig.json
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/core/i18n/translations.tsx && git commit -m "feat(expo-wallet-toolbox): i18n for the 1-of-N YubiKey vault in all twelve locales

Adds the wizard, key-management, transfer-confirmation and error keys the
R1C vault UI uses, and changes the copy that depended on the single-key
K1 model (hero, deposit/withdraw subtitles, key section, disable, PIN
locked, wrong key, serial mismatch). Dead K1/passphrase keys are removed
with the code that uses them in a later commit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `vaultErrorCopy` — one `VaultErrorCode → copy` table

**Files:**
- Create: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/vaultErrorCopy.ts`
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultErrorCopy.test.ts`

**Interfaces:**
- Produces: `vaultErrorCopy(code: VaultErrorCode | undefined, params?: VaultErrorParams): string`, `RETRYABLE_VAULT_ERRORS: ReadonlySet<VaultErrorCode>`, `type VaultErrorParams`.
- Consumes: `i18n`, `type VaultErrorCode` (post-Plan-2 union, 33 codes — see the contract's Plan 2 section) from the core barrel; the Task 1 keys `vault_err_*`, `vault_err_serial_mismatch_chosen`, `vault_pin_retries`.

Merges `VaultCeremonySheet`'s `ERROR_COPY` (`ui/components/vault/VaultCeremonySheet.tsx:57–73`) and `VaultTransferScreen`'s `translateVaultError` (`ui/screens/VaultTransferScreen.tsx:92–97`). The three legacy alias keys the old table pointed at (`vault_err_removed`, `vault_err_unavailable`, `vault_err_mgmt_key`) are NOT used here — the code-derived keys (`vault_err_key_removed_mid_op`, `vault_err_driver_unavailable`, `vault_err_mgmt_key_custom`) are, so the aliases go dead and Task 10 deletes them.

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultErrorCopy.test.ts`:

```ts
/**
 * vaultErrorCopy is the ONLY place a VaultErrorCode becomes words. Every code
 * in the union must resolve to a real key (never the raw key, never a string
 * with `{{placeholders}}` left in it), and copy that names keys or amounts
 * must degrade to param-free copy when the caller has nothing to name.
 */
const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k

// `mockT` is referenced lazily (inside an arrow) so the hoisted factory never
// touches it before the `const` above has initialised.
jest.mock('@bsv/expo-wallet-toolbox', () => ({
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) }
}))

import { vaultErrorCopy, RETRYABLE_VAULT_ERRORS } from '../../ui/components/vault/vaultErrorCopy'
import type { VaultErrorCode } from '../../core/services/vault/types'

const ALL_CODES: VaultErrorCode[] = [
  'unsupported-platform', 'no-key', 'wrong-key', 'pin-required', 'pin-invalid', 'pin-locked',
  'touch-timeout', 'key-removed-mid-op', 'mgmt-key-custom', 'slot-occupied', 'template-invalid',
  'serial-mismatch', 'user-cancelled', 'not-enrolled', 'driver-unavailable', 'vault-empty',
  'amount-exceeds-balance', 'below-dust', 'no-transaction', 'nfc-lost', 'too-many-inputs',
  'requires-online', 'not-released', 'backup-off', 'not-enough-keys', 'key-already-enrolled',
  'too-many-keys', 'last-keys', 'relock-required', 'key-not-committed', 'key-cannot-cover',
  'too-small-to-relock', 'bad-version'
]

describe('vaultErrorCopy', () => {
  test('every code resolves to a vault_err_* key, never the generic fallback', () => {
    for (const code of ALL_CODES) {
      const params = {
        nickname: 'Desk · …0001',
        names: 'Desk · …0001, Safe · …0002',
        otherNames: 'Safe · …0002',
        tappedName: 'Safe · …0002',
        chosenName: 'Desk · …0001',
        reachable: '40,000 satoshis',
        total: '100,000 satoshis',
        count: 2
      }
      const copy = vaultErrorCopy(code, params)
      expect(copy.startsWith('vault_err_')).toBe(true)
      expect(copy).not.toBe('vault_err_generic')
      expect(copy).not.toMatch(/{{/)
    }
  })

  test('undefined and unknown codes fall back to the generic line', () => {
    expect(vaultErrorCopy(undefined)).toBe('vault_err_generic')
    expect(vaultErrorCopy('seal-corrupt' as unknown as VaultErrorCode)).toBe('vault_err_generic')
  })

  test('plain codes use the code-derived key (aliases from the old ERROR_COPY are gone)', () => {
    expect(vaultErrorCopy('key-removed-mid-op')).toBe('vault_err_key_removed_mid_op')
    expect(vaultErrorCopy('driver-unavailable')).toBe('vault_err_driver_unavailable')
    expect(vaultErrorCopy('mgmt-key-custom')).toBe('vault_err_mgmt_key_custom')
    expect(vaultErrorCopy('pin-required')).toBe('vault_err_pin_required')
    expect(vaultErrorCopy('not-released')).toBe('vault_err_not_released')
    expect(vaultErrorCopy('bad-version')).toBe('vault_err_bad_version')
  })

  test('serial-mismatch names the tapped and chosen keys when both are known', () => {
    expect(vaultErrorCopy('serial-mismatch', { tappedName: 'Safe · …0002', chosenName: 'Desk · …0001' })).toBe(
      'vault_err_serial_mismatch_chosen:{"tappedName":"Safe · …0002","chosenName":"Desk · …0001"}'
    )
  })

  test('serial-mismatch lists the vault keys when only their names are known', () => {
    expect(vaultErrorCopy('serial-mismatch', { names: 'Desk · …0001, Safe · …0002' })).toBe(
      'vault_err_serial_mismatch:{"names":"Desk · …0001, Safe · …0002"}'
    )
  })

  test('serial-mismatch with no names degrades to the plain wrong-key line', () => {
    expect(vaultErrorCopy('serial-mismatch')).toBe('vault_err_wrong_key')
  })

  test('key-already-enrolled names the duplicate, or says nothing specific without a name', () => {
    expect(vaultErrorCopy('key-already-enrolled', { nickname: 'Desk' })).toBe(
      'vault_err_key_already_enrolled:{"nickname":"Desk"}'
    )
    expect(vaultErrorCopy('key-already-enrolled')).toBe('vault_err_generic')
  })

  test('key-cannot-cover needs all four params, else falls back to amount-exceeds-balance', () => {
    expect(
      vaultErrorCopy('key-cannot-cover', {
        nickname: 'Desk · …0001',
        reachable: '40,000 satoshis',
        total: '100,000 satoshis',
        otherNames: 'Safe · …0002'
      })
    ).toBe(
      'vault_err_key_cannot_cover:{"nickname":"Desk · …0001","reachable":"40,000 satoshis","total":"100,000 satoshis","otherNames":"Safe · …0002"}'
    )
    expect(vaultErrorCopy('key-cannot-cover', { nickname: 'Desk · …0001' })).toBe('vault_err_amount_exceeds_balance')
  })

  test('key-not-committed needs the nickname', () => {
    expect(vaultErrorCopy('key-not-committed', { nickname: 'Desk · …0001' })).toBe(
      'vault_err_key_not_committed:{"nickname":"Desk · …0001"}'
    )
    expect(vaultErrorCopy('key-not-committed')).toBe('vault_err_generic')
  })

  test('pin-invalid appends the attempts-left line when a count is given', () => {
    expect(vaultErrorCopy('pin-invalid', { count: 2 })).toBe('vault_err_pin_invalid vault_pin_retries:{"count":2}')
    expect(vaultErrorCopy('pin-invalid')).toBe('vault_err_pin_invalid')
  })

  test('the retryable set is exactly the two tap-again codes', () => {
    expect([...RETRYABLE_VAULT_ERRORS].sort()).toEqual(['nfc-lost', 'touch-timeout'])
  })
})
```

- [ ] **Step 2: Run the test — expect a module-not-found failure**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultErrorCopy.test.ts
```
Expected: `Cannot find module '../../ui/components/vault/vaultErrorCopy'`.

- [ ] **Step 3: Implement the table**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/vaultErrorCopy.ts`:

```ts
/**
 * One table from VaultErrorCode to user copy.
 *
 * Replaces two tables that disagreed with each other: VaultCeremonySheet's
 * ERROR_COPY (a hand-written code → key map with alias keys) and
 * VaultTransferScreen's translateVaultError (a `vault_err_${code}` naming
 * convention with a generic fallback). Every code in the union is listed, so
 * adding a code without copy is a type error rather than a raw key on screen.
 *
 * Copy that names keys or amounts takes them from `params`. When a caller has
 * nothing to name, the code degrades to the closest copy that needs no
 * parameters (see the switch) — never to a string with `{{placeholders}}`
 * left in it.
 *
 * Contract note: `VaultError` carries a code, an optional message and
 * `retriesLeft`, plus an optional structured `details` object services may
 * attach (the DECISION: `serial-mismatch` → `{ tapped, chosen }`,
 * `key-already-enrolled` → `{ serial }`, `key-cannot-cover` → `{ reachable,
 * total }`). Callers derive `tappedName`/`chosenName` from `error.details`
 * (Plan 2's `requestSigner` / `enrollKey`), and `reachable`/`total` likewise
 * from `error.details` (see VaultTransferScreen's readErrorDetails). None of
 * this is required: the fallbacks below are what the user sees when a
 * service omits `details`.
 */
import { i18n, type VaultErrorCode } from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

export interface VaultErrorParams {
  /** The key the copy is about, as `nickname · …tail4` (KeyChooser's vaultKeyLabel) or a bare nickname. */
  nickname?: string
  /** Every enrolled key, joined with ', '. */
  names?: string
  /** The other enrolled keys (all but `nickname`), joined with ', '. */
  otherNames?: string
  /** serial-mismatch: the tapped card, when it is itself an enrolled key. */
  tappedName?: string
  /** serial-mismatch: the key the user chose in-app. */
  chosenName?: string
  /** key-cannot-cover: formatted amounts (formatAmount output), not raw sats. */
  reachable?: string
  total?: string
  /** pin-invalid: attempts left, appended as a second sentence. */
  count?: number
}

/**
 * Exhaustive over the union: TypeScript rejects a missing or extra entry the
 * moment `VaultErrorCode` changes.
 */
const KEY: Record<VaultErrorCode, string> = {
  'unsupported-platform': 'vault_err_unsupported_platform',
  'no-key': 'vault_err_no_key',
  'wrong-key': 'vault_err_wrong_key',
  'pin-required': 'vault_err_pin_required',
  'pin-invalid': 'vault_err_pin_invalid',
  'pin-locked': 'vault_err_pin_locked',
  'touch-timeout': 'vault_err_touch_timeout',
  'key-removed-mid-op': 'vault_err_key_removed_mid_op',
  'mgmt-key-custom': 'vault_err_mgmt_key_custom',
  'slot-occupied': 'vault_err_slot_occupied',
  'template-invalid': 'vault_err_template_invalid',
  'serial-mismatch': 'vault_err_serial_mismatch',
  'user-cancelled': 'vault_err_user_cancelled',
  'not-enrolled': 'vault_err_not_enrolled',
  'driver-unavailable': 'vault_err_driver_unavailable',
  'vault-empty': 'vault_err_vault_empty',
  'amount-exceeds-balance': 'vault_err_amount_exceeds_balance',
  'below-dust': 'vault_err_below_dust',
  'no-transaction': 'vault_err_no_transaction',
  'nfc-lost': 'vault_err_nfc_lost',
  'too-many-inputs': 'vault_err_too_many_inputs',
  'requires-online': 'vault_err_requires_online',
  'not-released': 'vault_err_not_released',
  'backup-off': 'vault_err_backup_off',
  'not-enough-keys': 'vault_err_not_enough_keys',
  'key-already-enrolled': 'vault_err_key_already_enrolled',
  'too-many-keys': 'vault_err_too_many_keys',
  'last-keys': 'vault_err_last_keys',
  'relock-required': 'vault_err_relock_required',
  'key-not-committed': 'vault_err_key_not_committed',
  'key-cannot-cover': 'vault_err_key_cannot_cover',
  'too-small-to-relock': 'vault_err_too_small_to_relock',
  'bad-version': 'vault_err_bad_version'
}

/**
 * Errors where the fix is simply "do the tap again" — worth a Retry button
 * instead of only Dismiss. Must stay a SUBSET of `CeremonyController`'s own
 * retryable set (core/services/vault/ceremony.ts, `RETRYABLE_TAP_ERRORS`) or
 * the button renders but does nothing. 'key-removed-mid-op' is deliberately
 * excluded even though the signing loop can produce it, because it can ALSO
 * arrive from a moment the loop does not cover (waiting-for-key), where retry
 * would be a dead button.
 */
export const RETRYABLE_VAULT_ERRORS: ReadonlySet<VaultErrorCode> = new Set<VaultErrorCode>([
  'touch-timeout',
  'nfc-lost'
])

export function vaultErrorCopy(code: VaultErrorCode | undefined, params: VaultErrorParams = {}): string {
  // `code in KEY` guards a code the natives might emit that the union does not
  // know (vaultErrorFromNative casts freely); it must land on the generic line,
  // not on the raw `vault_err_<code>` key.
  if (!code || !(code in KEY)) return t('vault_err_generic')
  switch (code) {
    case 'serial-mismatch':
      if (params.tappedName && params.chosenName) {
        return t('vault_err_serial_mismatch_chosen', {
          tappedName: params.tappedName,
          chosenName: params.chosenName
        })
      }
      if (params.names) return t('vault_err_serial_mismatch', { names: params.names })
      return t('vault_err_wrong_key')
    case 'key-already-enrolled':
    case 'key-not-committed':
      return params.nickname ? t(KEY[code], { nickname: params.nickname }) : t('vault_err_generic')
    case 'key-cannot-cover':
      return params.nickname && params.reachable && params.total && params.otherNames
        ? t(KEY[code], {
            nickname: params.nickname,
            reachable: params.reachable,
            total: params.total,
            otherNames: params.otherNames
          })
        : t('vault_err_amount_exceeds_balance')
    case 'pin-invalid':
      return typeof params.count === 'number'
        ? `${t(KEY[code])} ${t('vault_pin_retries', { count: params.count })}`
        : t(KEY[code])
    default:
      return t(KEY[code])
  }
}
```

- [ ] **Step 4: Run the test — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultErrorCopy.test.ts
```
Expected: `Tests: 11 passed`.

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json
```
Expected: no errors in `ui/components/vault/vaultErrorCopy.ts`. (Errors in `VaultScreen.tsx`, `VaultTransferScreen.tsx`, `EnrollWizard.tsx`, `VaultRecoverScreen.tsx` against the Plan 2 services are expected until Tasks 6, 8, 9 and 10 land — they are the four residuals Plan 2 leaves for this plan.)

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/components/vault/vaultErrorCopy.ts packages/expo-wallet-toolbox/__tests__/ui/vaultErrorCopy.test.ts && git commit -m "feat(expo-wallet-toolbox): one vaultErrorCopy table for every VaultErrorCode

Merges VaultCeremonySheet's ERROR_COPY and VaultTransferScreen's
translateVaultError into a single exhaustive code → copy table with
parameterised copy for serial-mismatch, key-already-enrolled,
key-not-committed, key-cannot-cover and pin-invalid, each degrading to
param-free copy when the caller has nothing to name. Exports the
retryable set the ceremony sheet's Retry button keys off.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `useExportWalletData` hook, WalletConfigScreen switched to it, DEV present-key selector

**Files:**
- Create: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/hooks/useExportWalletData.ts`
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/useExportWalletData.test.ts`
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx` (imports lines 5–35 and 69; state line 133; `handleExportData` lines 373–383; DEV mock toggle rows lines 786–802; export row lines 818–825)

**Interfaces:**
- Produces: `useExportWalletData(): { exportData: () => Promise<void>; exporting: boolean }`.
- Consumes: `useWallet().storage`, `exportAllWalletDatabases(storage)` from `ui/exportDatabases.ts:51`; `setMockPresentKey`, `getMockPresentKey` from the core barrel (Plan 2 `devMock.ts`).

- [ ] **Step 1: Write the failing hook test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/useExportWalletData.test.ts`:

```ts
/**
 * The export action shared by Settings and the Vault screen: one in-flight
 * export at a time, a spinner flag while it runs, failures swallowed (the OS
 * share sheet being dismissed is not an error worth a red line).
 */
let mockStorage: unknown = { dbName: 'wallet-0f7ae53f-mainnet-1788405945.db' }
const mockExport = jest.fn()

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => ({ storage: mockStorage })
}))
jest.mock('../../ui/exportDatabases', () => ({
  exportAllWalletDatabases: (...args: unknown[]) => mockExport(...args)
}))

import { act, renderHook } from '@testing-library/react-native'
import { useExportWalletData } from '../../ui/hooks/useExportWalletData'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mockExport.mockReset()
  mockStorage = { dbName: 'wallet-0f7ae53f-mainnet-1788405945.db' }
})

describe('useExportWalletData', () => {
  test('exports the current storage and exposes the in-flight state', async () => {
    const first = deferred<number>()
    mockExport.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useExportWalletData())
    expect(result.current.exporting).toBe(false)

    let run!: Promise<void>
    act(() => {
      run = result.current.exportData()
    })
    expect(result.current.exporting).toBe(true)
    expect(mockExport).toHaveBeenCalledTimes(1)
    expect(mockExport).toHaveBeenCalledWith(mockStorage)

    await act(async () => {
      first.resolve(1)
      await run
    })
    expect(result.current.exporting).toBe(false)
  })

  test('ignores a second tap while an export is in flight', async () => {
    const first = deferred<number>()
    mockExport.mockReturnValueOnce(first.promise)
    const { result } = renderHook(() => useExportWalletData())

    let a!: Promise<void>
    let b!: Promise<void>
    act(() => {
      a = result.current.exportData()
      b = result.current.exportData()
    })
    expect(mockExport).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(1)
      await Promise.all([a, b])
    })
    expect(result.current.exporting).toBe(false)
  })

  test('swallows a failed export and clears the spinner', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockExport.mockRejectedValueOnce(new Error('share sheet dismissed'))
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData()
    })
    expect(result.current.exporting).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test('passes a null storage through (exportAllWalletDatabases returns 0 for it)', async () => {
    mockStorage = null
    mockExport.mockResolvedValueOnce(0)
    const { result } = renderHook(() => useExportWalletData())
    await act(async () => {
      await result.current.exportData()
    })
    expect(mockExport).toHaveBeenCalledWith(null)
  })
})
```

- [ ] **Step 2: Run — expect module-not-found**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/useExportWalletData.test.ts
```
Expected: `Cannot find module '../../ui/hooks/useExportWalletData'`.

- [ ] **Step 3: Implement the hook**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/hooks/useExportWalletData.ts`:

```ts
/**
 * Export the wallet database through the OS share sheet — the action behind
 * Settings › "Export Wallet Data" and the Vault screen's row of the same name
 * (spec §3.4: the vault screen is where the user is thinking about recovery,
 * and every vault deposit's salt lives only in this database).
 *
 * Lifted from WalletConfigScreen.handleExportData so both screens share one
 * implementation: one export at a time, `exporting` for the spinner, failures
 * logged rather than surfaced (a dismissed share sheet is not an error).
 */
import { useCallback, useRef, useState } from 'react'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { exportAllWalletDatabases } from '../exportDatabases'

export function useExportWalletData(): { exportData: () => Promise<void>; exporting: boolean } {
  const { storage } = useWallet()
  const [exporting, setExporting] = useState(false)
  // A ref, not the state: two taps in the same tick both see `exporting ===
  // false` in their closure, and the second must still be refused.
  const inFlightRef = useRef(false)

  const exportData = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setExporting(true)
    try {
      await exportAllWalletDatabases(storage)
    } catch (e) {
      console.warn('[exportWalletData] Export failed:', e)
    } finally {
      inFlightRef.current = false
      setExporting(false)
    }
  }, [storage])

  return { exportData, exporting }
}
```

- [ ] **Step 4: Run — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/useExportWalletData.test.ts
```
Expected: `Tests: 4 passed`.

- [ ] **Step 5: Switch WalletConfigScreen to the hook and add the DEV present-key row**

In `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx`:

(a) In the barrel import (lines 5–35), replace the line
```ts
  setMockDriverEnabled,
```
with
```ts
  setMockDriverEnabled,
  setMockPresentKey,
  getMockPresentKey,
```

(b) Replace line 69
```ts
import { exportAllWalletDatabases } from '../exportDatabases'
```
with
```ts
import { useExportWalletData } from '../hooks/useExportWalletData'
```

(c) Directly after the `loadExpoRouter` function (after its closing `}` at line 103), add:

```ts
/** The three serials the DEV mock can present, cycled by the selector row below. */
type MockPresentKey = Parameters<typeof setMockPresentKey>[0]
const NEXT_MOCK_KEY: Record<MockPresentKey, MockPresentKey> = {
  'MOCK-DEV-1': 'MOCK-DEV-2',
  'MOCK-DEV-2': 'MOCK-DEV-3',
  'MOCK-DEV-3': 'MOCK-DEV-1'
}
```

(d) Replace the state line 133
```ts
  const [isExporting, setIsExporting] = useState(false)
```
with
```ts
  const { exportData, exporting } = useExportWalletData()
  // Not read from getMockPresentKey() at mount: the mock is off by default and
  // the row is hidden until the toggle turns it on, at which point it syncs.
  const [mockPresent, setMockPresent] = useState<MockPresentKey>('MOCK-DEV-1')
```

(e) Delete lines 373–383 (`const handleExportData = async () => { … }` through its closing `}` and the blank line after it).

(f) Replace the DEV mock toggle block (lines 786–802):
```tsx
            {/* Vault's primary entry lives on the wallet menu (below Payments).
                The DEV mock toggle stays here. */}
            {__DEV__ && (
              <ListRow
                label={t('vault_mock_toggle')}
                icon="bug-outline"
                iconColor="#8E8E93"
                showChevron={false}
                value={vaultMockOn ? t('vault_on') : t('vault_off')}
                onPress={() => {
                  const next = !vaultMockOn
                  setVaultMockOn(next)
                  setMockDriverEnabled(next)
                }}
              />
            )}
```
with
```tsx
            {/* Vault's primary entry lives on the wallet menu (below Payments).
                The DEV mock toggle stays here. */}
            {__DEV__ && (
              <ListRow
                label={t('vault_mock_toggle')}
                icon="bug-outline"
                iconColor="#8E8E93"
                showChevron={false}
                value={vaultMockOn ? t('vault_on') : t('vault_off')}
                onPress={() => {
                  const next = !vaultMockOn
                  setVaultMockOn(next)
                  setMockDriverEnabled(next)
                  if (next) setMockPresent(getMockPresentKey())
                }}
              />
            )}
            {/* Which of the three mock YubiKeys is "on the phone" right now.
                A 1-of-N vault enrolled with MOCK-DEV-1 and MOCK-DEV-2 is
                exercised by switching the present key between taps. Label is a
                DEV-only literal, like the "Debugging" row below — not user copy. */}
            {__DEV__ && vaultMockOn && (
              <ListRow
                label="Mock key present (dev)"
                icon="key-outline"
                iconColor="#8E8E93"
                showChevron={false}
                value={mockPresent}
                onPress={() => {
                  const next = NEXT_MOCK_KEY[mockPresent]
                  setMockPresent(next)
                  setMockPresentKey(next)
                }}
              />
            )}
```

(g) Replace the export row (lines 818–825):
```tsx
            <ListRow
              label={t('export_wallet_data')}
              icon="share-outline"
              iconColor="#32ADE6"
              onPress={handleExportData}
              showChevron={false}
              trailing={isExporting ? <ActivityIndicator size="small" /> : undefined}
            />
```
with
```tsx
            <ListRow
              label={t('export_wallet_data')}
              icon="share-outline"
              iconColor="#32ADE6"
              onPress={() => void exportData()}
              showChevron={false}
              trailing={exporting ? <ActivityIndicator size="small" /> : undefined}
            />
```

- [ ] **Step 6: Verify the screen still renders under the existing test, type-check, commit**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/walletHomeBackup.test.tsx packages/expo-wallet-toolbox/__tests__/ui/useExportWalletData.test.ts
```
Expected: both files pass (`walletHomeBackup` renders `WalletConfigScreen` in its last test; the hook reads `storage: null` from that test's `mockWallet` and the DEV row stays hidden because `vaultMockOn` starts false, so no new mocks are needed there).

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'WalletConfigScreen\|useExportWalletData'
```
Expected: empty.

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/hooks/useExportWalletData.ts packages/expo-wallet-toolbox/__tests__/ui/useExportWalletData.test.ts packages/expo-wallet-toolbox/ui/screens/WalletConfigScreen.tsx && git commit -m "feat(expo-wallet-toolbox): useExportWalletData hook and DEV present-key selector

Lifts WalletConfigScreen.handleExportData into a shared hook so the vault
screen's Export wallet data row (Task 8) and Settings run the same action.
Adds the DEV-only row that cycles the mock YubiKey present on the phone
(MOCK-DEV-1/2/3) so a multi-key vault can be exercised without hardware.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `useVaultCoverage` hook

**Files:**
- Create: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/hooks/useVaultCoverage.ts`
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/useVaultCoverage.test.ts`

**Interfaces:**
- Produces: `useVaultCoverage(): { coverage: VaultKeyCoverage | null; refresh: () => void }`.
- Consumes: `useWallet()` (`managers.permissionsManager`, `adminOriginator`, `txStatusVersion`), `useVault()` (ceremony phase), `getVaultKeyCoverage(w, adminOriginator)`, `type VaultKeyCoverage`, `type VaultWallet` from the core barrel.

Reads on mount, on every `txStatusVersion` bump, on `refresh()`, and — like `useVaultBalance` (`ui/hooks/useVaultBalance.ts:17–81`) — never while a transfer is mid-flight (`preparing` / `broadcasting`), refetching once when that window closes. `coverage` is `null` until the first read lands and whenever there is no built wallet (nothing can be listed, so nothing can be claimed about it — Task 8's Remove action treats `null` as "cannot verify").

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/useVaultCoverage.test.ts`:

```ts
/**
 * useVaultCoverage feeds the vault screen's "N deposits not yet open to X"
 * badges and the Remove-key safety check. It must follow the same
 * invalidation signals as useVaultBalance (mount, txStatusVersion, manual
 * refresh) and the same freeze while a transfer is in flight, and it must
 * report `null` — not an empty coverage — while nothing can be read.
 */
let mockWalletCtx: { managers: unknown; adminOriginator: string; txStatusVersion: number }
let mockVaultPhase: string

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  useWallet: () => mockWalletCtx,
  useVault: () => ({ state: { phase: mockVaultPhase }, submitPin: () => {}, cancel: () => {}, retry: () => {} }),
  getVaultKeyCoverage: jest.fn()
}))

import { act, renderHook } from '@testing-library/react-native'
import { getVaultKeyCoverage } from '@bsv/expo-wallet-toolbox'
import { useVaultCoverage } from '../../ui/hooks/useVaultCoverage'

const fetchCoverage = getVaultKeyCoverage as jest.Mock
const COVERAGE = { outputs: 4, stale: 1, missingKeys: ['02' + 'b'.repeat(64)], removedKeyOutputs: 0 }

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  })
}

beforeEach(() => {
  fetchCoverage.mockReset()
  mockWalletCtx = { managers: { permissionsManager: {} }, adminOriginator: 'admin', txStatusVersion: 0 }
  mockVaultPhase = 'idle'
})

describe('useVaultCoverage', () => {
  test('reads on mount and again on a txStatusVersion bump', async () => {
    fetchCoverage.mockResolvedValue(COVERAGE)
    const { result, rerender } = renderHook(() => useVaultCoverage())
    expect(result.current.coverage).toBeNull()
    await settle()
    expect(result.current.coverage).toEqual(COVERAGE)
    expect(fetchCoverage).toHaveBeenCalledTimes(1)
    expect(fetchCoverage).toHaveBeenCalledWith(mockWalletCtx.managers.permissionsManager, 'admin')

    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
    rerender(undefined)
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(2)
  })

  test('refresh() reads again', async () => {
    fetchCoverage.mockResolvedValue(COVERAGE)
    const { result } = renderHook(() => useVaultCoverage())
    await settle()
    act(() => result.current.refresh())
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(2)
  })

  test.each(['preparing', 'broadcasting'])('does not read while %s, then reads once when idle again', async phase => {
    fetchCoverage.mockResolvedValue(COVERAGE)
    const { result, rerender } = renderHook(() => useVaultCoverage())
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(1)

    mockVaultPhase = phase
    mockWalletCtx = { ...mockWalletCtx, txStatusVersion: 1 }
    rerender(undefined)
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(1)
    expect(result.current.coverage).toEqual(COVERAGE)

    mockVaultPhase = 'idle'
    rerender(undefined)
    await settle()
    expect(fetchCoverage).toHaveBeenCalledTimes(2)
  })

  test('stays null with no built wallet and never calls the service', async () => {
    mockWalletCtx = { managers: { permissionsManager: null }, adminOriginator: 'admin', txStatusVersion: 0 }
    const { result } = renderHook(() => useVaultCoverage())
    await settle()
    expect(result.current.coverage).toBeNull()
    expect(fetchCoverage).not.toHaveBeenCalled()
  })

  test('keeps the last coverage when a read fails', async () => {
    fetchCoverage.mockResolvedValueOnce(COVERAGE).mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useVaultCoverage())
    await settle()
    act(() => result.current.refresh())
    await settle()
    expect(result.current.coverage).toEqual(COVERAGE)
  })

  test('ignores a read that resolves after unmount', async () => {
    let resolve!: (c: typeof COVERAGE) => void
    fetchCoverage.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const { result, unmount } = renderHook(() => useVaultCoverage())
    unmount()
    await act(async () => resolve(COVERAGE))
    await settle()
    expect(result.current.coverage).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect module-not-found**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/useVaultCoverage.test.ts
```
Expected: `Cannot find module '../../ui/hooks/useVaultCoverage'`.

- [ ] **Step 3: Implement**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/hooks/useVaultCoverage.ts`:

```ts
/**
 * Which vault outputs are committed to the current key set — the source of the
 * vault screen's badges ("{{count}} deposits not yet open to {{nickname}}",
 * "{{count}} deposits still open to a removed key") and of the Remove-key
 * safety check (spec §3.4).
 *
 * Same invalidation contract as useVaultBalance: read on mount, on every
 * txStatusVersion bump and on refresh(); frozen while a transfer is in flight
 * (the spent outputs are gone and the re-vaulted remainder not yet visible, so
 * a read in that window is wrong), with one read when the window closes.
 *
 * `null` means "nothing readable yet": before the first read lands, and
 * whenever there is no built wallet. It is deliberately not an empty coverage
 * record — a caller deciding whether a key removal would orphan an output
 * must not mistake "could not look" for "looked and saw nothing".
 */
import { useCallback, useEffect, useState } from 'react'
import { useWallet, useVault, getVaultKeyCoverage, type VaultKeyCoverage, type VaultWallet } from '@bsv/expo-wallet-toolbox'

export function useVaultCoverage(): { coverage: VaultKeyCoverage | null; refresh: () => void } {
  const { managers, adminOriginator, txStatusVersion } = useWallet()
  const { state: vaultState } = useVault()
  const transferInFlight = vaultState.phase === 'preparing' || vaultState.phase === 'broadcasting'
  const [coverage, setCoverage] = useState<VaultKeyCoverage | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const refresh = useCallback(() => {
    setRefreshVersion(prev => prev + 1)
  }, [])

  useEffect(() => {
    const pm = managers?.permissionsManager
    if (!pm) {
      setCoverage(null)
      return
    }
    if (transferInFlight) return
    let cancelled = false
    getVaultKeyCoverage(pm as unknown as VaultWallet, adminOriginator)
      .then(next => {
        if (!cancelled) setCoverage(next)
      })
      .catch(() => {
        // Leave the last known coverage in place on a transient failure.
      })
    return () => {
      cancelled = true
    }
  }, [managers?.permissionsManager, adminOriginator, txStatusVersion, transferInFlight, refreshVersion])

  return { coverage, refresh }
}
```

- [ ] **Step 4: Run — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/useVaultCoverage.test.ts
```
Expected: `Tests: 7 passed` (the `test.each` counts twice).

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json 2>&1 | grep useVaultCoverage
```
Expected: empty.

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/hooks/useVaultCoverage.ts packages/expo-wallet-toolbox/__tests__/ui/useVaultCoverage.test.ts && git commit -m "feat(expo-wallet-toolbox): useVaultCoverage hook for the key-coverage badges

Reads getVaultKeyCoverage on mount, txStatusVersion and refresh(), frozen
during a transfer like useVaultBalance; null while nothing is readable so
the Remove-key check cannot mistake an unreadable wallet for a safe one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `KeyChooser` — radio list of enrolled keys

**Files:**
- Create: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/KeyChooser.tsx`
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/keyChooser.test.tsx`

**Interfaces:**
- Produces: `KeyChooser: React.FC<{ keys: VaultKeyRecord[]; selected?: string; onSelect: (serial: string) => void }>` (contract), plus the shared label helper `vaultKeyLabel(k: { nickname: string; serial: string }): string` → `` `${nickname} · …${serial.slice(-4)}` `` used by every later task.
- Consumes: `useTheme`, `spacing`, `radii`, `typography`, `type VaultKeyRecord` from the core barrel; `PressableScale`; lazy Ionicons.

The chooser is controlled: `selected` is the caller's state. "Default selected = lastUsedSerial" is the caller's job (Tasks 8 and 9 both initialise `selected` to `meta.lastUsedSerial` when that serial is still enrolled, else the first key).

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/keyChooser.test.tsx`:

```tsx
import React from 'react'
import { fireEvent, render } from '@testing-library/react-native'

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} })
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})

import { KeyChooser, vaultKeyLabel } from '../../ui/components/vault/KeyChooser'

const KEYS = [
  { serial: '12340001', slot: 0x82, pubkey: '02' + 'a'.repeat(64), nickname: 'Desk', enrolledAt: 1 },
  { serial: '12340002', slot: 0x82, pubkey: '02' + 'b'.repeat(64), nickname: 'Safe', enrolledAt: 2 }
]

test('vaultKeyLabel is nickname · …serialTail4', () => {
  expect(vaultKeyLabel(KEYS[0])).toBe('Desk · …0001')
  expect(vaultKeyLabel({ nickname: 'X', serial: '7' })).toBe('X · …7')
})

test('renders one radio row per key, marks the selected one, reports a press', () => {
  const onSelect = jest.fn()
  const screen = render(<KeyChooser keys={KEYS} selected="12340002" onSelect={onSelect} />)
  const rows = screen.getAllByRole('radio')
  expect(rows).toHaveLength(2)
  expect(screen.getByText('Desk · …0001')).toBeTruthy()
  expect(screen.getByText('Safe · …0002')).toBeTruthy()
  expect(rows[0].props.accessibilityState).toEqual({ selected: false })
  expect(rows[1].props.accessibilityState).toEqual({ selected: true })

  fireEvent.press(screen.getByText('Desk · …0001'))
  expect(onSelect).toHaveBeenCalledWith('12340001')
})

test('with no selection nothing is marked', () => {
  const screen = render(<KeyChooser keys={KEYS} onSelect={() => {}} />)
  for (const row of screen.getAllByRole('radio')) {
    expect(row.props.accessibilityState).toEqual({ selected: false })
  }
})
```

- [ ] **Step 2: Run — expect module-not-found**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/keyChooser.test.tsx
```
Expected: `Cannot find module '../../ui/components/vault/KeyChooser'`.

- [ ] **Step 3: Implement**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/KeyChooser.tsx`:

```tsx
/**
 * "Which key will you tap?" — a radio list of the vault's enrolled keys, used
 * before a withdrawal (spec §4.2 step 1) and before a re-lock (§4.3). Keys are
 * shown everywhere as `nickname · …serialTail4` (§3.3), which is what
 * `vaultKeyLabel` produces; the wizard, the vault screen and the transfer
 * screen all import it from here so the format is written once.
 *
 * Controlled: `selected` is the caller's state, and the default (the key used
 * last, `meta.lastUsedSerial`) is the caller's decision.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import PressableScale from '../ui/PressableScale'
import { useTheme, spacing, radii, typography, type VaultKeyRecord } from '@bsv/expo-wallet-toolbox'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as this
 * package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/** The one display form of a vault key: `nickname · …serialTail4`. */
export function vaultKeyLabel(k: { nickname: string; serial: string }): string {
  return `${k.nickname} · …${k.serial.slice(-4)}`
}

export const KeyChooser: React.FC<{ keys: VaultKeyRecord[]; selected?: string; onSelect: (serial: string) => void }> = ({
  keys,
  selected,
  onSelect
}) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  return (
    <View style={[styles.list, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
      {keys.map((k, i) => {
        const on = k.serial === selected
        return (
          <PressableScale
            key={k.serial}
            haptic="tap"
            scaleTo={0.98}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(k.serial)}
            style={[
              styles.row,
              i < keys.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
            ]}
          >
            <Ionicons
              name={on ? 'radio-button-on' : 'radio-button-off'}
              size={22}
              color={on ? colors.accent : colors.textTertiary}
            />
            <Text style={[styles.label, { color: colors.textPrimary }]} numberOfLines={1}>
              {vaultKeyLabel(k)}
            </Text>
          </PressableScale>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg
  },
  label: { ...typography.body, flex: 1 }
})
```

- [ ] **Step 4: Run — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/keyChooser.test.tsx
```
Expected: `Tests: 3 passed`.

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json 2>&1 | grep KeyChooser
```
Expected: empty.

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/components/vault/KeyChooser.tsx packages/expo-wallet-toolbox/__tests__/ui/keyChooser.test.tsx && git commit -m "feat(expo-wallet-toolbox): KeyChooser radio list and the vaultKeyLabel format

Controlled radio list of enrolled keys for withdraw and re-lock, and the
single nickname · …serialTail4 label helper every vault surface uses.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `EnrollWizard` rewrite — intro → key × k → more → done, and add-key mode

**Files:**
- Rewrite: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx` (whole file; the current 627-line K1/passphrase wizard is replaced)
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx`

**Interfaces:**
- Produces: `EnrollWizard: React.FC<{ mode: 'enroll' | 'add-key'; onDone: () => void; onCancel: () => void }>` (contract).
- Consumes: `enrollKey`, `finalizeEnrollment`, `addVaultKey`, `vaultStore.getMeta`, `VAULT_MIN_KEYS`, `VAULT_MAX_KEYS`, `VaultError`, `isBackupPushEnabled`, `sounds`, `haptics`, `i18n`, `type VaultKeyRecord`, `type VaultErrorCode`, `type EnrollPhase` from the core barrel; `vaultErrorCopy` (Task 2); `vaultKeyLabel` (Task 5); `showAlert`, `showToast`, `PressableScale`; lazy expo-router (`router.push('/wallet-config')` when backup is off) and Ionicons.

Behaviour (spec §3.3):
- **intro** — copy, three bullet lines, acknowledgement checkbox, Begin enabled by the checkbox. Begin checks `isBackupPushEnabled()`; when off it shows the backup-off alert whose CTA routes to `/wallet-config` (D13) and does not advance.
- **key k** (title `Key {{k}} of up to 5`), sub-states:
  - `pin`: PIN field (6–8 digits); when the PIN typed is the factory `123456` a second "Set a new PIN" field appears and Continue needs both. Nothing touches the card yet.
  - `tap`: one card session via `enrollKey({ pendingSerials, onPhase, getPin, requestPinChange })` where `pendingSerials` = meta serials ∪ pending serials. Phase copy uses `vault_enroll_phase_${phase.replace(/-/g, '_')}` — this fixes the `vault_enroll_phase_pin-check` key mismatch the old wizard had (spec §5.4 "fix in passing").
  - `name`: "Name this key", default `Key {{k}}`, hint. Continue records `{ ...record, nickname }`.
  - `error`: `pin-locked` → `vault_err_pin_locked_enroll` with **Use a different YubiKey / Try again**; `key-already-enrolled` → `vault_err_key_already_enrolled` naming the duplicate (the tapped serial is read from `VaultError.details.serial`, per the DECISION that services populate structured `details` rather than encode them in `message`; it is matched against pending and enrolled records) with **Use a different YubiKey**, plus **Set it up again** when the duplicate is a *pending* key of this run (re-runs the tap with that serial removed from `pendingSerials`, then replaces the pending record); every other fault (session-failed → `user-cancelled`/`no-key`, `key-removed-mid-op`, `driver-unavailable`, …) → copy via `vaultErrorCopy` with **Try again / Cancel** (Cancel = leave, through the leave-confirm). `pin-invalid` returns to the `pin` sub-state with `Wrong PIN. {{count}} attempts left`. A `user-cancelled` (the user dismissed the NFC sheet) returns to `pin` quietly. The tap itself passes `nfcMessage: t('vault_nfc_enroll_message')` to `enrollKey` so the iOS scan sheet reads "Hold your YubiKey here to set it up" rather than the native default.
- **more** — reached after EVERY key (including key 1, so Finish can be shown disabled with `vault_more_need_two`): the pending list, **Add another key** (hidden once meta + pending = 5), **Finish** (enabled only with ≥ 2 pending; runs `finalizeEnrollment(pending)`).
- **done** — enroll: `vault_done_body` + Done → `onDone`; add-key: `vault_add_key_done` + **Re-lock now** → `onDone` (the host screen opens the re-lock sheet; Task 8).
- **add-key mode** — starts at `key` with `enrolled = meta.keys`, one key, `addVaultKey(record)`, toast `vault_key_added_toast`, then `done`.
- **Leaving** — "Leave set-up" link on every step after intro (reads "Cancel" while nothing is pending), Android hardware back, and the error-state Cancel all go through `leave()`: with ≥ 1 pending key it asks `Leave set-up?` with **Leave / Stay**. Pending records (public data only) live in component state, so they survive backgrounding; the host hides its own back chevron while the wizard is mounted (Task 8) so this is the only way out.

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx`:

```tsx
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
const mockEnrollKey = jest.fn()
const mockFinalize = jest.fn()
const mockAddVaultKey = jest.fn()
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
let mockMeta: unknown = null
let mockBackupOn = true

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
  VaultError: jest.requireActual('../../core/services/vault/types').VaultError,
  enrollKey: (...a: unknown[]) => mockEnrollKey(...a),
  finalizeEnrollment: (...a: unknown[]) => mockFinalize(...a),
  addVaultKey: (...a: unknown[]) => mockAddVaultKey(...a),
  vaultStore: { getMeta: async () => mockMeta },
  isBackupPushEnabled: async () => mockBackupOn,
  VAULT_MIN_KEYS: 2,
  VAULT_MAX_KEYS: 5,
  sounds: { vaultOpen: jest.fn(), vaultClose: jest.fn() },
  haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
}))
jest.mock('expo-router', () => ({ router: mockRouter, useLocalSearchParams: () => ({}), useFocusEffect: () => {} }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))

import { EnrollWizard } from '../../ui/components/vault/EnrollWizard'
import { VaultError } from '../../core/services/vault/types'

const record = (serial: string, tail: string) => ({
  serial,
  slot: 0x82,
  pubkey: '02' + tail.repeat(32),
  nickname: '',
  enrolledAt: 1_700_000_000_000
})

/**
 * A key-already-enrolled rejection the way Plan 2's enrollKey throws it: code
 * plus a structured `details.serial` naming the duplicate (the DECISION is
 * that services attach `details`, not that the message encodes it).
 */
const dupError = (serial: string): VaultError & { details: { serial: string } } => {
  const e = new VaultError('key-already-enrolled', serial) as VaultError & { details: { serial: string } }
  e.details = { serial }
  return e
}

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMeta = null
  mockBackupOn = true
  mockEnrollKey.mockReset()
  mockFinalize.mockReset().mockResolvedValue(undefined)
  mockAddVaultKey.mockReset().mockResolvedValue({ v: 5, createdAt: 1, keys: [] })
  mockShowAlert.mockReset()
})

/** intro → key 1 pin sub-state. */
async function beginEnroll() {
  const onDone = jest.fn()
  const onCancel = jest.fn()
  const screen = render(<EnrollWizard mode="enroll" onDone={onDone} onCancel={onCancel} />)
  await settle()
  fireEvent.press(screen.getByText('vault_intro_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  return { screen, onDone, onCancel }
}

/** From the pin sub-state: type a PIN, tap, name the key. Ends on `more` (enroll) or `done` (add-key). */
async function enrolOneKey(screen: ReturnType<typeof render>, name: string) {
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  fireEvent.changeText(screen.getByLabelText('vault_name_title'), name)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
}

test('Begin is inert until the acknowledgement is ticked', async () => {
  const screen = render(<EnrollWizard mode="enroll" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  expect(screen.queryByText('vault_key_step_title:{"k":1}')).toBeNull()
  fireEvent.press(screen.getByText('vault_intro_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  expect(screen.getByText('vault_key_step_title:{"k":1}')).toBeTruthy()
})

test('Begin routes to settings instead of the key step while backup push is off', async () => {
  mockBackupOn = false
  mockShowAlert.mockResolvedValueOnce('settings')
  const screen = render(<EnrollWizard mode="enroll" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  fireEvent.press(screen.getByText('vault_intro_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_intro_begin')))
  await settle()
  expect(mockShowAlert).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'vault_backup_off_title', message: 'vault_backup_off_body' })
  )
  expect(mockRouter.push).toHaveBeenCalledWith('/wallet-config')
  expect(screen.queryByText('vault_key_step_title:{"k":1}')).toBeNull()
})

test('Finish is disabled with one key and enabled with two; finalizeEnrollment gets both records', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a')).mockResolvedValueOnce(record('12340002', 'b'))
  const { screen, onDone } = await beginEnroll()

  await enrolOneKey(screen, 'Desk')
  expect(mockEnrollKey).toHaveBeenLastCalledWith(expect.objectContaining({ pendingSerials: [] }))
  expect(screen.getByText('vault_more_title')).toBeTruthy()
  expect(screen.getByText('vault_more_need_two')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_more_finish')))
  expect(mockFinalize).not.toHaveBeenCalled()

  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
  expect(screen.getByText('vault_key_step_title:{"k":2}')).toBeTruthy()
  await enrolOneKey(screen, 'Safe')
  expect(mockEnrollKey).toHaveBeenLastCalledWith(expect.objectContaining({ pendingSerials: ['12340001'] }))
  expect(screen.queryByText('vault_more_need_two')).toBeNull()
  expect(screen.getByText('Desk · …0001')).toBeTruthy()
  expect(screen.getByText('Safe · …0002')).toBeTruthy()

  await act(async () => fireEvent.press(screen.getByText('vault_more_finish')))
  await settle()
  expect(mockFinalize).toHaveBeenCalledTimes(1)
  expect(mockFinalize.mock.calls[0][0]).toEqual([
    expect.objectContaining({ serial: '12340001', nickname: 'Desk' }),
    expect.objectContaining({ serial: '12340002', nickname: 'Safe' })
  ])
  expect(mockShowToast).toHaveBeenCalledWith('vault_enrolled_toast', { type: 'success' })
  expect(screen.getByText('vault_done_body:{"count":2}')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_done_cta'))
  expect(onDone).toHaveBeenCalledTimes(1)
})

test('an empty name falls back to Key {{k}}', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  await enrolOneKey(screen, '')
  expect(screen.getByText('vault_name_default:{"k":1} · …0001')).toBeTruthy()
})

test('a duplicate of a pending key names it and offers Set it up again', async () => {
  mockEnrollKey
    .mockResolvedValueOnce(record('12340001', 'a'))
    .mockRejectedValueOnce(dupError('12340001'))
    .mockResolvedValueOnce(record('12340001', 'c'))
  const { screen } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')
  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))

  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_key_already_enrolled:{"nickname":"Desk"}')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()

  // Set it up again: the duplicate's serial is dropped from pendingSerials so
  // the service regenerates, and the new record REPLACES the pending one.
  await act(async () => fireEvent.press(screen.getByText('vault_key_setup_again')))
  await settle()
  expect(mockEnrollKey).toHaveBeenLastCalledWith(expect.objectContaining({ pendingSerials: [] }))
  fireEvent.changeText(screen.getByLabelText('vault_name_title'), 'Desk again')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('Desk again · …0001')).toBeTruthy()
  expect(screen.queryByText('Desk · …0001')).toBeNull()
  expect(screen.getByText('vault_more_need_two')).toBeTruthy()
})

test('a duplicate of an already-enrolled key (add-key mode) has no Set it up again', async () => {
  mockMeta = { v: 5, createdAt: 1, keys: [{ ...record('12340001', 'a'), nickname: 'Desk' }, { ...record('12340002', 'b'), nickname: 'Safe' }] }
  mockEnrollKey.mockRejectedValueOnce(dupError('12340002'))
  const screen = render(<EnrollWizard mode="add-key" onDone={jest.fn()} onCancel={jest.fn()} />)
  await settle()
  expect(screen.getByText('vault_key_step_title:{"k":3}')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalledWith(expect.objectContaining({ pendingSerials: ['12340001', '12340002'] }))
  expect(screen.getByText('vault_err_key_already_enrolled:{"nickname":"Safe"}')).toBeTruthy()
  expect(screen.queryByText('vault_key_setup_again')).toBeNull()
})

test('a blocked PIN keeps the pending keys and offers a different YubiKey or a retry', async () => {
  mockEnrollKey
    .mockResolvedValueOnce(record('12340001', 'a'))
    .mockRejectedValueOnce(new VaultError('pin-locked'))
    .mockResolvedValueOnce(record('12340002', 'b'))
  const { screen } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')
  await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '654321')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_pin_locked_enroll')).toBeTruthy()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_retry')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalledTimes(3)
  expect(screen.getByLabelText('vault_name_title')).toBeTruthy()
})

test('a wrong PIN returns to the PIN field with the attempts left', async () => {
  mockEnrollKey.mockRejectedValueOnce(new VaultError('pin-invalid', undefined, 2))
  const { screen } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '111111')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(screen.getByText('vault_err_pin_invalid vault_pin_retries:{"count":2}')).toBeTruthy()
  expect(screen.getByLabelText('vault_enter_pin')).toBeTruthy()
})

test('the factory PIN demands a new PIN before the tap and passes both to enrollKey', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_enter_pin'), '123456')
  expect(screen.getByLabelText('vault_set_new_pin')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  expect(mockEnrollKey).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('vault_set_new_pin'), '778899')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  const args = mockEnrollKey.mock.calls[0][0]
  await expect(args.getPin()).resolves.toBe('123456')
  await expect(args.requestPinChange(3)).resolves.toEqual({ oldPin: '123456', newPin: '778899' })
})

test('leaving with a pending key asks first; Stay keeps the wizard, Leave cancels it', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen, onCancel } = await beginEnroll()
  await enrolOneKey(screen, 'Desk')

  mockShowAlert.mockResolvedValueOnce('stay')
  await act(async () => fireEvent.press(screen.getByText('vault_leave_setup')))
  await settle()
  expect(mockShowAlert).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'vault_leave_title', message: 'vault_leave_body:{"count":1}' })
  )
  expect(onCancel).not.toHaveBeenCalled()
  expect(screen.getByText('vault_more_title')).toBeTruthy()

  mockShowAlert.mockResolvedValueOnce('leave')
  await act(async () => fireEvent.press(screen.getByText('vault_leave_setup')))
  await settle()
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test('leaving with nothing pending cancels without asking', async () => {
  const { screen, onCancel } = await beginEnroll()
  await act(async () => fireEvent.press(screen.getByText('vault_cancel')))
  await settle()
  expect(mockShowAlert).not.toHaveBeenCalled()
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test('add-key mode runs one key step, calls addVaultKey and ends on the re-lock hint', async () => {
  mockMeta = { v: 5, createdAt: 1, keys: [{ ...record('12340001', 'a'), nickname: 'Desk' }, { ...record('12340002', 'b'), nickname: 'Safe' }] }
  mockEnrollKey.mockResolvedValueOnce(record('12340003', 'c'))
  const onDone = jest.fn()
  const screen = render(<EnrollWizard mode="add-key" onDone={onDone} onCancel={jest.fn()} />)
  await settle()
  expect(screen.queryByText('vault_intro_title')).toBeNull()
  await enrolOneKey(screen, 'Car')
  expect(mockAddVaultKey).toHaveBeenCalledWith(expect.objectContaining({ serial: '12340003', nickname: 'Car' }))
  expect(mockShowToast).toHaveBeenCalledWith('vault_key_added_toast', { type: 'success' })
  expect(screen.getByText('vault_add_key_done:{"nickname":"Car"}')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_relock_now'))
  expect(onDone).toHaveBeenCalledTimes(1)
  expect(mockFinalize).not.toHaveBeenCalled()
})

test('Add another key disappears once five keys are set up', async () => {
  mockEnrollKey
    .mockResolvedValueOnce(record('12340001', 'a'))
    .mockResolvedValueOnce(record('12340002', 'b'))
    .mockResolvedValueOnce(record('12340003', 'c'))
    .mockResolvedValueOnce(record('12340004', 'd'))
    .mockResolvedValueOnce(record('12340005', 'e'))
  const { screen } = await beginEnroll()
  for (let i = 1; i <= 5; i++) {
    if (i > 1) await act(async () => fireEvent.press(screen.getByText('vault_more_add')))
    await enrolOneKey(screen, `K${i}`)
  }
  expect(screen.queryByText('vault_more_add')).toBeNull()
  expect(screen.getByText('vault_more_finish')).toBeTruthy()
})
```

- [ ] **Step 2: Run — expect failures against the old wizard**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx
```
Expected: every test fails. The first failure is a render error from the old wizard's imports (`useLocalStorage is not a function` from the mocked barrel, or `Unable to find an element with text: vault_intro_ack`).

- [ ] **Step 3: Rewrite the wizard**

Replace the entire contents of `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx` with:

```tsx
/**
 * Vault enrollment wizard — spec §3.3.
 *
 *   enroll mode:  intro → key (× k; sub-states pin · tap · name · error) → more → done
 *   add-key mode: key → done
 *
 * Nothing is persisted until Finish (enroll) or until the single key step
 * completes (add-key). `pending` holds public records only — serial, slot,
 * pubkey, nickname, enrolledAt — in component state, so it survives
 * backgrounding but not leaving. Every prompt (the PIN, and a new PIN when the
 * card still carries the factory default) is gathered BEFORE the tap, because
 * the iOS NFC sheet covers the app for the whole card session.
 *
 * The host screen hides its own back chevron while this is mounted: leaving
 * goes through `leave()` — the leave-confirm alert when at least one key is
 * pending — which is also wired to Android's hardware back button.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ScrollView, ActivityIndicator, BackHandler } from 'react-native'
import PressableScale from '../ui/PressableScale'
import { showAlert } from '../ui/AlertCard'
import { showToast } from '../ui/Toast'
import { vaultErrorCopy } from './vaultErrorCopy'
import { vaultKeyLabel } from './KeyChooser'
import {
  useTheme,
  spacing,
  radii,
  typography,
  enrollKey,
  finalizeEnrollment,
  addVaultKey,
  vaultStore,
  VAULT_MIN_KEYS,
  VAULT_MAX_KEYS,
  VaultError,
  isBackupPushEnabled,
  sounds,
  haptics,
  i18n,
  type VaultKeyRecord,
  type VaultErrorCode,
  type EnrollPhase
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as this
 * package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as VaultScreen.tsx.
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

type Step = 'intro' | 'key' | 'more' | 'done'
type KeySub = 'pin' | 'tap' | 'name' | 'error'

/** The PIV factory PIN. Typing it means the card was never personalised, so a new PIN is demanded before the tap. */
const DEFAULT_PIV_PIN = '123456'
const PIN_MIN = 6
const PIN_MAX = 8

interface KeyStepError {
  code: VaultErrorCode | undefined
  copy: string
  /** Serial of a key pending in THIS run that the tapped card duplicates — offers "Set it up again". */
  pendingDuplicate?: string
}

export const EnrollWizard: React.FC<{ mode: 'enroll' | 'add-key'; onDone: () => void; onCancel: () => void }> = ({
  mode,
  onDone,
  onCancel
}) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  const { router } = loadExpoRouter()

  const [step, setStep] = useState<Step>(mode === 'enroll' ? 'intro' : 'key')
  const [sub, setSub] = useState<KeySub>('pin')
  const [ack, setAck] = useState(false)
  /** Keys already in meta (add-key mode). Empty in enroll mode — there is no meta yet. */
  const [enrolled, setEnrolled] = useState<VaultKeyRecord[]>([])
  /** Keys set up in this run and not yet persisted. */
  const [pending, setPending] = useState<VaultKeyRecord[]>([])
  const [pin, setPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [phase, setPhase] = useState<EnrollPhase | null>(null)
  /** The record the card just produced, awaiting its nickname. */
  const [fresh, setFresh] = useState<VaultKeyRecord | null>(null)
  const [name, setName] = useState('')
  /** Index in `pending` the record being named replaces ("Set it up again"); null = append. */
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null)
  const [keyError, setKeyError] = useState<KeyStepError | null>(null)
  const [busy, setBusy] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)
  const [addedNickname, setAddedNickname] = useState('')

  useEffect(() => {
    let alive = true
    void vaultStore.getMeta().then(m => {
      if (alive && m) setEnrolled(m.keys)
    })
    return () => {
      alive = false
    }
  }, [])

  const total = enrolled.length + pending.length
  /** Ordinal of the key on screen: the next slot, or the pending slot being redone. */
  const k = replaceIndex === null ? total + 1 : enrolled.length + replaceIndex + 1
  const needsNewPin = pin === DEFAULT_PIV_PIN
  const pinLengthOk = (p: string) => p.length >= PIN_MIN && p.length <= PIN_MAX
  const pinOk = pinLengthOk(pin) && (!needsNewPin || (pinLengthOk(newPin) && newPin !== DEFAULT_PIV_PIN))

  // ── leaving ─────────────────────────────────────────────────────────
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (pending.length === 0) return true
    const choice = await showAlert({
      title: t('vault_leave_title'),
      message: t('vault_leave_body', { count: pending.length }),
      buttons: [
        { text: t('vault_leave_confirm'), key: 'leave', style: 'destructive' },
        { text: t('vault_leave_stay'), key: 'stay', style: 'cancel' }
      ]
    })
    return choice === 'leave'
  }, [pending.length])

  const leave = useCallback(async () => {
    if (busy) return
    if (await confirmLeave()) onCancel()
  }, [busy, confirmLeave, onCancel])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void leave()
      return true
    })
    return () => subscription.remove()
  }, [leave])

  // ── intro → key 1 ───────────────────────────────────────────────────
  const begin = useCallback(async () => {
    if (!ack) return
    // D13: the salts of every future deposit live only in this wallet's
    // database, so enrolment refuses to start while the encrypted backup is
    // off. Settings is where it is switched on; push keeps this screen behind.
    if (!(await isBackupPushEnabled())) {
      const choice = await showAlert({
        title: t('vault_backup_off_title'),
        message: t('vault_backup_off_body'),
        buttons: [
          { text: t('vault_backup_off_cta'), key: 'settings' },
          { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
        ]
      })
      if (choice === 'settings') router.push('/wallet-config')
      return
    }
    setStep('key')
    setSub('pin')
  }, [ack, router])

  // ── the card session ────────────────────────────────────────────────
  const runTap = useCallback(
    async (replaceSerial?: string) => {
      setSub('tap')
      setPhase(null)
      setKeyError(null)
      setStepError(null)
      const known = [...enrolled.map(r => r.serial), ...pending.map(r => r.serial)]
      try {
        const record = await enrollKey({
          // "Set it up again" drops the duplicate's own serial so the service
          // regenerates on that card instead of refusing it a second time.
          pendingSerials: replaceSerial ? known.filter(s => s !== replaceSerial) : known,
          onPhase: setPhase,
          getPin: async () => pin,
          requestPinChange: needsNewPin ? async () => ({ oldPin: pin, newPin }) : undefined,
          // Localised iOS NFC sheet text for this tap (Plan 2's enrollKey
          // forwards it to withKeySession's opts.nfcMessage → driver.start).
          // Omitting it would fall back to the native default wording.
          nfcMessage: t('vault_nfc_enroll_message')
        })
        setReplaceIndex(replaceSerial ? pending.findIndex(p => p.serial === replaceSerial) : null)
        setFresh(record)
        setName('')
        setSub('name')
        haptics.success()
      } catch (e) {
        haptics.error()
        const err = e instanceof VaultError ? e : undefined
        // A wrong PIN is feedback on the PIN, so it belongs on the PIN field.
        // Nothing has been written to the card (verifyPin runs before
        // generateVaultKey), so re-entering is safe. On NFC it costs a re-tap.
        if (err?.code === 'pin-invalid') {
          setPinError(vaultErrorCopy('pin-invalid', { count: err.retriesLeft }))
          setSub('pin')
          return
        }
        // The user dismissed the system NFC sheet: not an error to explain.
        if (err?.code === 'user-cancelled') {
          setSub('pin')
          return
        }
        // The services attach the duplicate serial as VaultError.details.serial
        // for key-already-enrolled (structural read: VaultError does not
        // formally type `details`, so this degrades to undefined for any
        // error that omits it, same as every other vaultErrorCopy param).
        const tapped = (err as { details?: { serial?: string } } | undefined)?.details?.serial
        const dupPending = tapped ? pending.find(p => p.serial === tapped) : undefined
        const dupEnrolled = tapped ? enrolled.find(p => p.serial === tapped) : undefined
        let copy: string
        if (err?.code === 'key-already-enrolled') {
          copy = vaultErrorCopy(err.code, {
            nickname: dupPending?.nickname ?? dupEnrolled?.nickname ?? t('vault_name_default', { k })
          })
        } else if (err?.code === 'pin-locked') {
          // Enrolment-specific: there is no "use another of your vault keys"
          // yet, so the remedy is the PUK or a different card.
          copy = t('vault_err_pin_locked_enroll')
        } else {
          copy = vaultErrorCopy(err?.code)
        }
        setKeyError({ code: err?.code, copy, pendingDuplicate: dupPending?.serial })
        setSub('error')
      }
    },
    [enrolled, pending, pin, newPin, needsNewPin, k]
  )

  // ── naming → more / addVaultKey ─────────────────────────────────────
  const saveName = useCallback(async () => {
    if (!fresh || busy) return
    const nickname = name.trim() || t('vault_name_default', { k })
    const record: VaultKeyRecord = { ...fresh, nickname }
    setFresh(null)
    setName('')
    setPin('')
    setNewPin('')
    setPinError(null)
    if (mode === 'add-key') {
      setBusy(true)
      setStepError(null)
      try {
        await addVaultKey(record)
        haptics.success()
        showToast(t('vault_key_added_toast'), { type: 'success' })
        setAddedNickname(record.nickname)
        setStep('done')
      } catch (e) {
        haptics.error()
        setStepError(vaultErrorCopy(e instanceof VaultError ? e.code : undefined))
        setSub('pin')
      } finally {
        setBusy(false)
      }
      return
    }
    setPending(prev => (replaceIndex === null ? [...prev, record] : prev.map((p, i) => (i === replaceIndex ? record : p))))
    setReplaceIndex(null)
    setStep('more')
  }, [fresh, busy, name, k, mode, replaceIndex])

  // ── finish (enroll mode) ────────────────────────────────────────────
  const finish = useCallback(async () => {
    if (pending.length < VAULT_MIN_KEYS || busy) return
    setBusy(true)
    setStepError(null)
    try {
      await finalizeEnrollment(pending)
      sounds.vaultOpen()
      haptics.success()
      showToast(t('vault_enrolled_toast'), { type: 'success' })
      setStep('done')
    } catch (e) {
      haptics.error()
      setStepError(vaultErrorCopy(e instanceof VaultError ? e.code : undefined))
    } finally {
      setBusy(false)
    }
  }, [pending, busy])

  const addAnother = useCallback(() => {
    setStepError(null)
    setStep('key')
    setSub('pin')
  }, [])

  const useDifferentKey = useCallback(() => {
    setKeyError(null)
    setPin('')
    setNewPin('')
    setPinError(null)
    setSub('pin')
  }, [])

  const leaveLink = (
    <PressableScale onPress={() => void leave()} style={styles.secondary}>
      <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
        {pending.length > 0 ? t('vault_leave_setup') : t('vault_cancel')}
      </Text>
    </PressableScale>
  )

  // ── intro ───────────────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_intro_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_intro_what')}</Text>
        <View style={[styles.bullets, { borderColor: colors.separator }]}>
          <Bullet icon="key-outline" text={t('vault_intro_two_keys')} />
          <Bullet icon="location-outline" text={t('vault_intro_apart')} />
          <Bullet icon="cloud-upload-outline" text={t('vault_intro_backup')} />
        </View>
        <PressableScale
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ack }}
          haptic="tap"
          onPress={() => setAck(a => !a)}
          style={[styles.ackRow, { borderColor: ack ? colors.accent : colors.separator }]}
        >
          <Ionicons name={ack ? 'checkbox' : 'square-outline'} size={24} color={ack ? colors.accent : colors.textTertiary} />
          <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_intro_ack')}</Text>
        </PressableScale>
        <ActionButton label={t('vault_intro_begin')} enabled={ack} onPress={() => void begin()} />
        <PressableScale onPress={onCancel} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── key k ───────────────────────────────────────────────────────────
  if (step === 'key') {
    if (sub === 'pin') {
      return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_key_step_title', { k })}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_key_step_replace')}</Text>

          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_enter_pin')}</Text>
          {/* Which PIN, and what it is if they have never set one: the prompt
              is otherwise ambiguous with the phone's own passcode. */}
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_enter_pin_sub')}</Text>
          <TextInput
            accessibilityLabel={t('vault_enter_pin')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={pin}
            onChangeText={text => {
              setPinError(null)
              setPin(text)
            }}
            placeholder="••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            // Masking only once there is something to mask: iOS renders a
            // secure field's PLACEHOLDER with masked-glyph metrics, which
            // stretches the bullets apart before any digit is typed.
            secureTextEntry={pin.length > 0}
            maxLength={PIN_MAX}
            autoFocus
          />
          {needsNewPin && (
            <>
              <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_set_new_pin')}</Text>
              <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_default_pin_warning')}</Text>
              <TextInput
                accessibilityLabel={t('vault_set_new_pin')}
                style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
                value={newPin}
                onChangeText={setNewPin}
                placeholder="••••••"
                placeholderTextColor={colors.textTertiary}
                keyboardType="number-pad"
                secureTextEntry={newPin.length > 0}
                maxLength={PIN_MAX}
              />
            </>
          )}
          {pinError && <Text style={[styles.err, { color: colors.error }]}>{pinError}</Text>}
          {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
          <ActionButton label={t('vault_continue')} enabled={pinOk && !busy} onPress={() => void runTap()} />
          {leaveLink}
        </ScrollView>
      )
    }

    if (sub === 'tap') {
      return (
        <View style={styles.body}>
          <ActivityIndicator color={colors.textPrimary} size="large" style={styles.hero} />
          <Text style={[styles.h1, { color: colors.textPrimary }]}>
            {phase ? t(`vault_enroll_phase_${phase.replace(/-/g, '_')}`) : t('vault_reading_key')}
          </Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_touch_when_blinks')}</Text>
        </View>
      )
    }

    if (sub === 'name') {
      return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Ionicons name="checkmark-circle" size={48} color={colors.success} style={styles.hero} />
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_name_title')}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{fresh ? `…${fresh.serial.slice(-4)}` : ''}</Text>
          <TextInput
            accessibilityLabel={t('vault_name_title')}
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={name}
            onChangeText={setName}
            placeholder={t('vault_name_default', { k })}
            placeholderTextColor={colors.textTertiary}
            maxLength={32}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => void saveName()}
            autoFocus
          />
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_name_hint')}</Text>
          {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
          <ActionButton label={t('vault_continue')} busy={busy} onPress={() => void saveName()} />
        </ScrollView>
      )
    }

    // sub === 'error'
    const code = keyError?.code
    return (
      <View style={styles.body}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.error} style={styles.hero} />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{keyError?.copy ?? t('vault_err_generic')}</Text>
        {code === 'pin-locked' && (
          <>
            <ActionButton label={t('vault_key_use_different')} onPress={useDifferentKey} />
            <ActionButton label={t('vault_retry')} variant="outline" onPress={() => void runTap()} />
          </>
        )}
        {code === 'key-already-enrolled' && (
          <>
            {keyError?.pendingDuplicate && (
              <ActionButton label={t('vault_key_setup_again')} onPress={() => void runTap(keyError.pendingDuplicate)} />
            )}
            <ActionButton
              label={t('vault_key_use_different')}
              variant={keyError?.pendingDuplicate ? 'outline' : 'primary'}
              onPress={useDifferentKey}
            />
          </>
        )}
        {code !== 'pin-locked' && code !== 'key-already-enrolled' && (
          <>
            <ActionButton label={t('vault_retry')} onPress={() => void runTap()} />
            <PressableScale onPress={() => void leave()} style={styles.secondary}>
              <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
            </PressableScale>
          </>
        )}
      </View>
    )
  }

  // ── more ────────────────────────────────────────────────────────────
  if (step === 'more') {
    const canAdd = total < VAULT_MAX_KEYS
    const canFinish = pending.length >= VAULT_MIN_KEYS
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_more_title')}</Text>
        <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_more_body')}</Text>
        <View style={[styles.list, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          {pending.map((p, i) => (
            <View
              key={p.serial}
              style={[
                styles.listRow,
                i < pending.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
              ]}
            >
              <Ionicons name="key-outline" size={20} color={colors.success} />
              <Text style={[styles.listLabel, { color: colors.textPrimary }]} numberOfLines={1}>
                {vaultKeyLabel(p)}
              </Text>
            </View>
          ))}
        </View>
        {!canFinish && <Text style={[styles.warn, { color: colors.warning }]}>{t('vault_more_need_two')}</Text>}
        {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
        {canAdd && <ActionButton label={t('vault_more_add')} enabled={!busy} onPress={addAnother} />}
        <ActionButton
          label={t('vault_more_finish')}
          variant={canAdd && !canFinish ? 'outline' : 'primary'}
          enabled={canFinish}
          busy={busy}
          onPress={() => void finish()}
        />
        {leaveLink}
      </ScrollView>
    )
  }

  // ── done ────────────────────────────────────────────────────────────
  return (
    <View style={[styles.body, styles.doneBody]}>
      <Ionicons name="checkmark-circle" size={56} color={colors.success} style={styles.hero} />
      <Text style={[styles.h1, { color: colors.textPrimary }]}>
        {mode === 'enroll' ? t('vault_enrolled_toast') : t('vault_key_added_toast')}
      </Text>
      <Text style={[styles.p, { color: colors.textSecondary }]}>
        {mode === 'enroll'
          ? t('vault_done_body', { count: pending.length })
          : t('vault_add_key_done', { nickname: addedNickname })}
      </Text>
      <ActionButton label={mode === 'enroll' ? t('vault_done_cta') : t('vault_relock_now')} onPress={onDone} />
    </View>
  )
}

/** One intro bullet: glyph + line. */
const Bullet: React.FC<{ icon: React.ComponentProps<IoniconsComponent>['name']; text: string }> = ({ icon, text }) => {
  const { colors } = useTheme()
  const Ionicons = loadIonicons()
  return (
    <View style={styles.bulletRow}>
      <Ionicons name={icon} size={18} color={colors.info} />
      <Text style={[styles.bulletText, { color: colors.textPrimary }]}>{text}</Text>
    </View>
  )
}

/**
 * The wizard's button. Filled accent when primary and enabled; outlined when
 * disabled or `variant="outline"` — filled with the secondary background it was
 * indistinguishable from the page in dark mode.
 */
const ActionButton: React.FC<{
  label: string
  enabled?: boolean
  busy?: boolean
  variant?: 'primary' | 'outline'
  onPress: () => void
}> = ({ label, enabled = true, busy = false, variant = 'primary', onPress }) => {
  const { colors } = useTheme()
  const active = enabled && !busy
  const filled = active && variant === 'primary'
  return (
    <PressableScale
      haptic="confirm"
      onPress={active ? onPress : undefined}
      accessibilityState={{ disabled: !active }}
      style={[
        styles.primary,
        filled
          ? { backgroundColor: colors.accent }
          : { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }
      ]}
    >
      {busy ? (
        <ActivityIndicator color={filled ? colors.textOnAccent : colors.textPrimary} />
      ) : (
        <Text
          style={[
            styles.primaryLabel,
            { color: filled ? colors.textOnAccent : active ? colors.textPrimary : colors.textTertiary }
          ]}
        >
          {label}
        </Text>
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  body: { padding: spacing.xl, gap: spacing.lg },
  doneBody: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  hero: { marginTop: spacing.lg, alignSelf: 'center' },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  label: { ...typography.headline },
  hint: { ...typography.footnote },
  warn: { ...typography.footnote, textAlign: 'center' },
  err: { ...typography.footnote, textAlign: 'center' },
  bullets: {
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  bulletText: { ...typography.subhead, flex: 1 },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  ackText: { ...typography.subhead, flex: 1 },
  input: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...typography.body
  },
  pin: {
    width: '70%',
    alignSelf: 'center',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 8,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  list: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg
  },
  listLabel: { ...typography.body, flex: 1 },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body }
})
```

- [ ] **Step 4: Run — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx
```
Expected: `Tests: 13 passed`.

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json 2>&1 | grep EnrollWizard
```
Expected: empty. (`VaultScreen.tsx` still fails on `<EnrollWizard onDone onCancel />` lacking `mode` and on `meta?.yubiSerial` until Task 8 — expected.)

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx && git commit -m "feat(expo-wallet-toolbox)!: sequential multi-key vault enrollment wizard

Replaces the K1 passphrase wizard with the 1-of-N flow: intro with the
acknowledgement and the backup-push gate, one card session per key with
PIN gathered before the tap, naming, Add another / Finish (two keys
minimum), leave-confirm while keys are pending, and an add-key mode that
appends one key and hands off to re-lock. Duplicate and PIN-locked cards
get their own copy and remedies. Fixes the vault_enroll_phase_pin-check
key mismatch.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `VaultCeremonySheet` — per-batch progress, error copy via `vaultErrorCopy`

**Files:**
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/VaultCeremonySheet.tsx` (whole file replaced below — the `ERROR_COPY` / `RETRYABLE_ERRORS` tables at lines 57–81 go, the progress line and the key-name lookup come in; everything else is kept verbatim)
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultCeremonySheet.test.tsx`

**Interfaces:**
- Consumes: `useVault().state` incl. the contract's `CeremonyState.progress?: { signed: number; total: number }`; `VAULT_INPUTS_PER_TAP` (ceremonyHost); `vaultStore.getMeta` (to name keys in `serial-mismatch` copy — `CeremonyState` deliberately carries no serial, so the sheet can only list the vault's keys, never "That's X, you chose Y"; that copy is the transfer screen's, Task 9); `vaultErrorCopy` + `RETRYABLE_VAULT_ERRORS` (Task 2); `vaultKeyLabel` (Task 5).

Copy rules:
- `preparing` with `progress` → subtitle `Signed {{signed}} of {{total}}` (replaces `vault_unlocking_sub` while signatures are being gathered).
- `waiting-for-key` / `awaiting-touch` / `connecting` with `progress.signed > 0` (i.e. between batches, after the first NFC sheet dismissed) → an extra line `Hold your YubiKey here to sign — batch {{b}} of {{n}}` with `b = floor(signed / VAULT_INPUTS_PER_TAP) + 1`, `n = ceil(total / VAULT_INPUTS_PER_TAP)`, plus the `Signed … of …` line.
- `error` → title from `vaultErrorCopy(code, { names })`; Retry only for `RETRYABLE_VAULT_ERRORS`.

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultCeremonySheet.test.tsx`:

```tsx
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
let mockState: Record<string, unknown> = { phase: 'idle' }
let mockMeta: unknown = null
const mockRetry = jest.fn()
const mockCancel = jest.fn()

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
  useVault: () => ({ state: mockState, submitPin: jest.fn(), cancel: mockCancel, retry: mockRetry }),
  vaultStore: { getMeta: async () => mockMeta },
  VAULT_INPUTS_PER_TAP: 16,
  haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('../../ui/components/ui/Sheet', () => {
  const React = require('react')
  return { __esModule: true, default: ({ visible, children }: any) => (visible ? React.createElement(React.Fragment, null, children) : null) }
})
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})

import { VaultCeremonySheet } from '../../ui/components/vault/VaultCeremonySheet'

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMeta = {
    v: 5,
    createdAt: 1,
    keys: [
      { serial: '12340001', slot: 0x82, pubkey: '02' + 'a'.repeat(64), nickname: 'Desk', enrolledAt: 1 },
      { serial: '12340002', slot: 0x82, pubkey: '02' + 'b'.repeat(64), nickname: 'Safe', enrolledAt: 2 }
    ]
  }
})

test('hidden while idle and while armed', async () => {
  mockState = { phase: 'idle' }
  const a = render(<VaultCeremonySheet />)
  await settle()
  expect(a.queryByText('vault_title')).toBeNull()
  mockState = { phase: 'armed', armedUntil: Date.now() + 1000 }
  const b = render(<VaultCeremonySheet />)
  await settle()
  expect(b.queryByText('vault_unlocking_funds')).toBeNull()
})

test('preparing shows the signing progress line from state.progress', async () => {
  mockState = { phase: 'preparing', reason: 'Withdraw 50,000 sats from vault', progress: { signed: 3, total: 20 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_unlocking_funds')).toBeTruthy()
  expect(screen.getByText('vault_sign_progress:{"signed":3,"total":20}')).toBeTruthy()
  expect(screen.queryByText('vault_unlocking_sub')).toBeNull()
})

test('preparing without progress keeps the generic busy line', async () => {
  mockState = { phase: 'preparing' }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_unlocking_sub')).toBeTruthy()
})

test('waiting for the next batch says which batch of how many', async () => {
  mockState = { phase: 'waiting-for-key', progress: { signed: 16, total: 40 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_nfc_sign_batch:{"b":2,"n":3}')).toBeTruthy()
  expect(screen.getByText('vault_sign_progress:{"signed":16,"total":40}')).toBeTruthy()
})

test('the first tap has no batch line', async () => {
  mockState = { phase: 'waiting-for-key', progress: { signed: 0, total: 40 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.queryByText(/vault_nfc_sign_batch/)).toBeNull()
})

test('a retryable error offers Try again and routes it to retry()', async () => {
  mockState = { phase: 'error', error: { code: 'nfc-lost' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_nfc_lost')).toBeTruthy()
  fireEvent.press(screen.getByText('vault_retry'))
  expect(mockRetry).toHaveBeenCalledTimes(1)
})

test('a hard error has Dismiss only', async () => {
  mockState = { phase: 'error', error: { code: 'pin-locked' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_pin_locked')).toBeTruthy()
  expect(screen.queryByText('vault_retry')).toBeNull()
  fireEvent.press(screen.getByText('vault_dismiss'))
  expect(mockCancel).toHaveBeenCalledTimes(1)
})

test('serial-mismatch names the vault keys read from meta', async () => {
  mockState = { phase: 'error', error: { code: 'serial-mismatch' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_serial_mismatch:{"names":"Desk · …0001, Safe · …0002"}')).toBeTruthy()
})

test('serial-mismatch with no meta falls back to the plain wrong-key line', async () => {
  mockMeta = null
  mockState = { phase: 'error', error: { code: 'serial-mismatch' } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_err_wrong_key')).toBeTruthy()
})

test('a wrong PIN shows the attempts left under the error', async () => {
  mockState = { phase: 'error', error: { code: 'pin-invalid', retriesLeft: 2 } }
  const screen = render(<VaultCeremonySheet />)
  await settle()
  expect(screen.getByText('vault_pin_invalid_retry:{"count":2}')).toBeTruthy()
})
```

- [ ] **Step 2: Run — expect failures on the progress and error-copy assertions**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultCeremonySheet.test.tsx
```
Expected: `preparing shows the signing progress line…`, `waiting for the next batch…`, `serial-mismatch names…` fail (`Unable to find an element with text: vault_sign_progress…`; the old table renders `vault_err_wrong_key` for serial-mismatch regardless of meta). The idle/armed, hard-error and retry tests pass already.

- [ ] **Step 3: Replace the sheet**

Replace the entire contents of `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/VaultCeremonySheet.tsx` with:

```tsx
/**
 * The vault ceremony sheet — the one place the user is told what to do with the
 * YubiKey and why. Globally mounted (beside PermissionSheet); driven by
 * VaultContext, which mirrors the ceremony singleton.
 *
 * Every phase says three things: WHY (the reason string / transfer summary),
 * WHAT to do now (the phase copy + illustration), and how far along it is
 * (countdown on awaiting-touch; `Signed k of n` and the batch number while a
 * multi-input withdrawal is being signed — spec §4.2 step 8). Motion is
 * scale/opacity of the sheet's own subviews only — never a fractional-opacity
 * animation over glass (the UIVisualEffectView freeze guardrail).
 *
 * Error copy comes from vaultErrorCopy. CeremonyState carries no serial, so a
 * serial-mismatch here can only list the vault's keys (read from meta); the
 * "That's X — you chose Y" wording is the transfer screen's, which knows both.
 */
import React, { useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, TextInput, ActivityIndicator, Platform } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
  useReducedMotion,
  Easing
} from 'react-native-reanimated'
import Sheet from '../ui/Sheet'
import PressableScale from '../ui/PressableScale'
import { vaultErrorCopy, RETRYABLE_VAULT_ERRORS } from './vaultErrorCopy'
import { vaultKeyLabel } from './KeyChooser'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useVault,
  vaultStore,
  VAULT_INPUTS_PER_TAP,
  haptics,
  i18n,
  type CeremonyPhase,
  type VaultErrorCode
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, opts?: Record<string, unknown>) => i18n.t(k, opts) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/** Swallows the sheet's dismiss while work is in flight — `Sheet` requires an
 * onClose, and cancelling mid-operation is the thing we are preventing. */
const noop = (): void => {}

const PhaseIcon: Record<CeremonyPhase, keyof IoniconsComponent['glyphMap']> = {
  idle: 'lock-closed',
  'waiting-for-key': 'hardware-chip-outline',
  connecting: 'sync-outline',
  'pin-entry': 'keypad-outline',
  'awaiting-touch': 'finger-print-outline',
  preparing: 'lock-open-outline',
  broadcasting: 'paper-plane-outline',
  armed: 'lock-open',
  error: 'alert-circle-outline'
}

export const VaultCeremonySheet: React.FC = () => {
  const { colors } = useTheme()
  const { state, submitPin, cancel, retry } = useVault()
  const reducedMotion = useReducedMotion()
  const [pin, setPin] = useState('')
  const [keyNames, setKeyNames] = useState('')
  const Ionicons = loadIonicons()

  const phase = state.phase
  // 'armed' stays hidden: it persists for the whole retention window, so
  // showing it would leave the sheet up for minutes after a transfer is done.
  const visible = phase !== 'idle' && phase !== 'armed'

  /**
   * Work is under way and there is nothing for the user to do but wait.
   *
   * The sheet is deliberately NOT dismissable here. A backdrop tap runs
   * cancel(), which mid-operation is the abandonment this progress display
   * exists to prevent — and a cancelled withdrawal can leave the vault UTXO
   * reserved. Cancel stays available while we are waiting on the user
   * (waiting-for-key, pin-entry).
   */
  const busy = phase === 'preparing' || phase === 'broadcasting'

  // Pulse the icon while waiting for the user to act (insert / touch).
  const pulse = useSharedValue(1)
  useEffect(() => {
    const active =
      phase === 'waiting-for-key' ||
      phase === 'awaiting-touch' ||
      phase === 'preparing' ||
      phase === 'broadcasting'
    if (active && !reducedMotion) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1.12, { duration: 700, easing: Easing.inOut(Easing.quad) }),
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) })
        ),
        -1,
        false
      )
    } else {
      cancelAnimation(pulse)
      pulse.value = withTiming(1, { duration: 150 })
    }
    return () => cancelAnimation(pulse)
  }, [phase, reducedMotion, pulse])
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }))

  // Reset the PIN field whenever we (re)enter pin-entry.
  useEffect(() => {
    if (phase === 'pin-entry') setPin('')
  }, [phase])

  // The vault's key labels, for serial-mismatch copy. Read once per ceremony
  // (when the sheet becomes visible), never during idle: this component is
  // mounted for the app's whole life.
  useEffect(() => {
    if (!visible) return
    let alive = true
    void vaultStore
      .getMeta()
      .then(m => {
        if (alive) setKeyNames(m ? m.keys.map(vaultKeyLabel).join(', ') : '')
      })
      .catch(() => {
        if (alive) setKeyNames('')
      })
    return () => {
      alive = false
    }
  }, [visible])

  const reason = state.reason
  const errCode = state.error?.code as VaultErrorCode | undefined
  const progress = state.progress

  // Batch arithmetic (spec §4.2 step 6): at most VAULT_INPUTS_PER_TAP digests
  // per tap. `signed > 0` while waiting for a key means "between batches".
  const batches = progress ? Math.max(1, Math.ceil(progress.total / VAULT_INPUTS_PER_TAP)) : 0
  const batchIndex = progress ? Math.min(batches, Math.floor(progress.signed / VAULT_INPUTS_PER_TAP) + 1) : 0
  const betweenBatches =
    !!progress &&
    progress.signed > 0 &&
    (phase === 'waiting-for-key' || phase === 'awaiting-touch' || phase === 'connecting')

  // iOS talks to the key over NFC (a tap), Android over USB (insert + touch).
  const nfc = Platform.OS === 'ios'

  const title = (() => {
    switch (phase) {
      case 'waiting-for-key':
        return nfc ? t('vault_hold_key_nfc') : t('vault_insert_key')
      case 'connecting':
        return t('vault_reading_key')
      case 'pin-entry':
        return t('vault_enter_pin')
      case 'awaiting-touch':
        return nfc ? t('vault_keep_holding_nfc') : t('vault_touch_contact')
      case 'preparing':
        return t('vault_unlocking_funds')
      case 'broadcasting':
        return t('vault_sending_to_network')
      case 'error':
        return vaultErrorCopy(errCode, { names: keyNames || undefined })
      default:
        return ''
    }
  })()

  const iconColor = phase === 'error' ? colors.error : colors.accent

  return (
    <Sheet visible={visible} onClose={busy ? noop : cancel} title={t('vault_title')} fitContent>
      <View style={styles.body}>
        {reason ? <Text style={[styles.reason, { color: colors.textSecondary }]}>{reason}</Text> : null}

        <Animated.View style={[styles.iconWrap, { backgroundColor: colors.backgroundSecondary }, pulseStyle]}>
          {phase === 'connecting' || busy ? (
            <ActivityIndicator color={iconColor} />
          ) : (
            <Ionicons name={PhaseIcon[phase]} size={40} color={iconColor} />
          )}
        </Animated.View>

        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>

        {/* Between taps of a multi-batch signing: which batch this is, and how
            far along. The iOS system NFC sheet covers this while it is up, so
            this is what the user sees as it dismisses and before the next tap. */}
        {betweenBatches && progress && (
          <>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {t('vault_nfc_sign_batch', { b: batchIndex, n: batches })}
            </Text>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              {t('vault_sign_progress', { signed: progress.signed, total: progress.total })}
            </Text>
          </>
        )}

        {/* The whole point of the busy phases: say the work is real and say
            not to leave. While signatures are being gathered, say how many. */}
        {busy && (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {phase === 'broadcasting'
              ? t('vault_sending_sub')
              : progress
                ? t('vault_sign_progress', { signed: progress.signed, total: progress.total })
                : t('vault_unlocking_sub')}
          </Text>
        )}

        {phase === 'awaiting-touch' && <TouchCountdown color={colors.accent} trackColor={colors.backgroundSecondary} />}

        {phase === 'pin-entry' && (
          <>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {nfc ? t('vault_pin_sub_nfc') : t('vault_pin_sub_usb')}
            </Text>
            <TextInput
              style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
              value={pin}
              onChangeText={setPin}
              placeholder="••••••"
              placeholderTextColor={colors.textTertiary}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              autoFocus
            />
            {state.error?.code === 'pin-invalid' && typeof state.error.retriesLeft === 'number' && (
              <Text style={[styles.hint, { color: colors.warning }]}>
                {t('vault_pin_retries', { count: state.error.retriesLeft })}
              </Text>
            )}
            <PressableScale
              haptic="confirm"
              onPress={() => {
                if (pin.length >= 4) submitPin(pin)
              }}
              style={[styles.primaryBtn, { backgroundColor: colors.accent, opacity: pin.length >= 4 ? 1 : 0.4 }]}
            >
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_unlock_cta')}</Text>
            </PressableScale>
          </>
        )}

        {phase === 'error' && errCode === 'pin-invalid' && (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {typeof state.error?.retriesLeft === 'number'
              ? t('vault_pin_invalid_retry', { count: state.error.retriesLeft })
              : t('vault_pin_invalid_retry_generic')}
          </Text>
        )}

        {phase === 'error' && (
          <View style={styles.errorActions}>
            {errCode && RETRYABLE_VAULT_ERRORS.has(errCode) && (
              <PressableScale
                haptic="confirm"
                onPress={retry}
                style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
              >
                <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_retry')}</Text>
              </PressableScale>
            )}
            <PressableScale onPress={cancel} style={styles.secondaryBtn}>
              <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_dismiss')}</Text>
            </PressableScale>
          </View>
        )}

        {(phase === 'waiting-for-key' || phase === 'awaiting-touch' || phase === 'connecting') && (
          <PressableScale onPress={cancel} style={styles.secondaryBtn}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
          </PressableScale>
        )}
      </View>
    </Sheet>
  )
}

/** 15-second ring that empties while the key waits for a touch. Purely a UI
 * countdown — the native touch policy enforces the real timeout. */
const TouchCountdown: React.FC<{ color: string; trackColor: string }> = ({ color, trackColor }) => {
  const reducedMotion = useReducedMotion()
  const progress = useSharedValue(1)
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (reducedMotion) return
    haptics.tap()
    progress.value = withTiming(0, { duration: 15000, easing: Easing.linear })
    return () => cancelAnimation(progress)
  }, [progress, reducedMotion])
  const style = useAnimatedStyle(() => ({ width: `${Math.max(0, progress.value) * 100}%` }))
  return (
    <View style={[styles.countdownTrack, { backgroundColor: trackColor }]}>
      <Animated.View style={[styles.countdownFill, { backgroundColor: color }, style]} />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, alignItems: 'center', gap: spacing.lg },
  reason: { ...typography.subhead, textAlign: 'center' },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md
  },
  title: { ...typography.title3, textAlign: 'center' },
  subtitle: { ...typography.subhead, textAlign: 'center', marginTop: -spacing.sm },
  pin: {
    width: '70%',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 8,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  hint: { ...typography.footnote },
  primaryBtn: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondaryBtn: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  errorActions: { width: '100%', gap: spacing.sm },
  countdownTrack: { width: '80%', height: 6, borderRadius: 3, overflow: 'hidden' },
  countdownFill: { height: '100%' }
})
```

- [ ] **Step 4: Run — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultCeremonySheet.test.tsx
```
Expected: `Tests: 10 passed`.

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json 2>&1 | grep VaultCeremonySheet
```
Expected: empty.

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/components/vault/VaultCeremonySheet.tsx packages/expo-wallet-toolbox/__tests__/ui/vaultCeremonySheet.test.tsx && git commit -m "feat(expo-wallet-toolbox): ceremony sheet shows signing progress and batch number

Reads CeremonyState.progress for 'Signed k of n' during preparing and the
'batch b of n' line between NFC taps; error copy comes from vaultErrorCopy
(serial-mismatch lists the vault's keys from meta) and Retry keys off
RETRYABLE_VAULT_ERRORS instead of a private table.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `VaultScreen` rewrite — four states, key list, badges, add / rename / remove / re-lock, export, disable

**Files:**
- Rewrite: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/VaultScreen.tsx` (whole file)
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx`

**Interfaces:**
- Produces: `VaultScreen(): JSX.Element` (unchanged export).
- Consumes: `useVaultBalance` (unchanged), `useVaultCoverage` (Task 4), `useExportWalletData` (Task 3), `EnrollWizard` (Task 6), `KeyChooser` + `vaultKeyLabel` (Task 5), `vaultErrorCopy` (Task 2), `VaultBackdrop` (unchanged), `Sheet`, `BiometricAdvisoryModal`, `ListRow`, `GroupedSection`, `PressableScale`, `AmountDisplay`, `showAlert`, `showToast`; from the core barrel: `useWallet`, `useLocalStorage`, `vaultStore` (`getMeta`, `removeKey`, `renameKey`), `relockVault`, `orphanedIfRemoved`, `estimateRelockFee`, `R1C_LOCK_LEN`, `reclaimStagingOutputs` (legacy, kept), `getVaultDriver`, `isVaultEnabled`, `disableVault`, `getOnline`, `generateMnemonicWallet`, `backupAttestation`, `VaultError`, `VAULT_MIN_KEYS`, `VAULT_MAX_KEYS`, `haptics`, `i18n`, types `VaultMeta`, `VaultKeyRecord`, `VaultSpendResult`, `VaultWallet`.

Behaviour (spec §3.4, §4.3, §5.4, §5.5):
- **States.** `meta === undefined` → spinner. Wizard open → `EnrollWizard` (the header's back chevron is replaced by an empty spacer so leaving goes through the wizard's own leave-confirm). Not enrolled: flag off → hero + `vault_not_released_body` + disabled CTA; driver unsupported → hero + `vault_unsupported_*` + disabled CTA; else hero with the CTA opening the wizard in `enroll` mode. Enrolled → the full screen. An enrolled vault with the flag off keeps the enrolled view (withdrawals are never gated, §5.5) but Deposit, Add key and Re-lock are inert and the notice sits under the action row.
- **Badges** (from `useVaultCoverage`): `missingKeys.length > 0` → `vault_badge_missing` with `count = coverage.stale` and `nickname` = the missing keys' nicknames joined with ', ' (the contract's `VaultKeyCoverage` has no per-key counts, so `stale` is the count shown); `removedKeyOutputs > 0` → `vault_badge_removed`. Either badge opens the re-lock sheet.
- **Key rows**: `nickname · …tail4`, subtitle = enrolled date (`toLocaleDateString`). Tapping a row opens an alert menu **Rename / Remove / Cancel** (three buttons → AlertCard stacks them).
- **Add key**: row under the list, hidden at `VAULT_MAX_KEYS` (and inert with the flag off); opens the wizard in `add-key` mode. When the wizard reports done, the screen reloads meta, diffs serials to find the new key and — if the vault holds anything — opens the re-lock sheet with reason `vault_relock_reason` naming the existing keys and the new key excluded from the chooser.
- **Remove**: refused with `vault_err_last_keys` at `VAULT_MIN_KEYS`; refused with `vault_err_relock_required` when `orphanedIfRemoved(w, adminOriginator, key.pubkey)` reports any output that would lose every remaining committed key — checked exactly against each output's real committed key set (spec §3.4), not approximated from `useVaultCoverage`. Otherwise the confirmation with **Remove and re-lock now / Remove only / Cancel**, the fee being `estimateRelockFee(max(coverage?.outputs ?? 1, 1), R1C_LOCK_LEN(keys − 1))`. "Remove and re-lock now" removes, then opens the re-lock sheet.
- **Rename**: a `Sheet` with one text field and **Save** → `vaultStore.renameKey`.
- **Re-lock**: a `Sheet` with the reason line, `vault_relock_choose`, a `KeyChooser` (default = `lastUsedSerial` if still enrolled, else the first key) and **Re-lock now**. Runs `relockVault(w, adminOriginator, reason, chosenSerial, opts)` in a loop while `cappedInputs > 0` (toasting `vault_relock_capped` between passes; each pass is one ceremony tap), bounded by `MAX_RELOCK_PASSES = 32` (≤ 1000 outputs / 32 per pass); when the last pass reports `unreachable.count > 0` it stops with the `vault_relock_unreachable` alert naming those keys, else toasts `vault_relock_done`. Errors (`too-small-to-relock`, `vault-empty`, ceremony faults) show inside the sheet via `vaultErrorCopy`.
- **Deposit / Withdraw** push to `/vault-transfer?direction=…`. Deposit first runs the lazy wallet-creation path when there is no built wallet (biometric advisory → `ensureWalletExists`, copied from WalletHomeScreen).
- **Export wallet data** row (`export_wallet_data`, `share-outline`, spinner while exporting) with `vault_export_explainer` as the section footer; **Disable vault** in its own section, refused while the balance is above zero.
- **Footnote** `vault_footnote` is the key section's footer, always visible.
- The legacy `reclaimStagingOutputs` effect is kept exactly as it was.

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx`:

```tsx
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
const mockGetMeta = jest.fn()
const mockRemoveKey = jest.fn()
const mockRenameKey = jest.fn()
const mockRelock = jest.fn()
const mockOrphanedIfRemoved = jest.fn()
const mockDisable = jest.fn()
const mockReclaim = jest.fn()
const mockRefreshCoverage = jest.fn()
const mockExportData = jest.fn()
let mockVaultEnabled = true
let mockSupported = true
let mockBalance: number | null = 0
let mockCoverage: unknown = null
let mockWallet: any

jest.mock('@bsv/expo-wallet-toolbox', () => ({
  ...jest.requireActual('../../core/theme/tokens'),
  useTheme: () => ({ colors: {} }),
  i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
  useWallet: () => mockWallet,
  useLocalStorage: () => ({ hasStoredIdentity: async () => true, createMnemonic: jest.fn(), secretsReady: true }),
  VaultError: jest.requireActual('../../core/services/vault/types').VaultError,
  vaultStore: {
    getMeta: (...a: unknown[]) => mockGetMeta(...a),
    removeKey: (...a: unknown[]) => mockRemoveKey(...a),
    renameKey: (...a: unknown[]) => mockRenameKey(...a)
  },
  getVaultDriver: () => ({ isSupported: () => mockSupported }),
  isVaultEnabled: () => mockVaultEnabled,
  disableVault: (...a: unknown[]) => mockDisable(...a),
  relockVault: (...a: unknown[]) => mockRelock(...a),
  orphanedIfRemoved: (...a: unknown[]) => mockOrphanedIfRemoved(...a),
  reclaimStagingOutputs: (...a: unknown[]) => mockReclaim(...a),
  estimateRelockFee: () => 2900,
  R1C_LOCK_LEN: () => 27881,
  VAULT_MIN_KEYS: 2,
  VAULT_MAX_KEYS: 5,
  getOnline: async () => true,
  generateMnemonicWallet: jest.fn(),
  backupAttestation: { markPending: jest.fn() },
  sounds: { vaultOpen: jest.fn(), vaultClose: jest.fn() },
  haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
}))
jest.mock('expo-router', () => ({ router: mockRouter, useLocalSearchParams: () => ({}), useFocusEffect: () => {} }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))
jest.mock('../../ui/components/ui/ListRow', () => {
  const React = require('react')
  const { Pressable, Text } = require('react-native')
  return {
    ListRow: ({ label, subtitle, value, onPress }: any) =>
      React.createElement(
        Pressable,
        { onPress, accessibilityState: { disabled: !onPress } },
        React.createElement(Text, null, label),
        subtitle ? React.createElement(Text, null, subtitle) : null,
        value ? React.createElement(Text, null, value) : null
      )
  }
})
jest.mock('../../ui/components/ui/GroupedList', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return {
    GroupedSection: ({ header, footer, children }: any) =>
      React.createElement(
        React.Fragment,
        null,
        header ? React.createElement(Text, null, header) : null,
        children,
        footer ? React.createElement(Text, null, footer) : null
      )
  }
})
jest.mock('../../ui/components/ui/Sheet', () => {
  const React = require('react')
  return { __esModule: true, default: ({ visible, children }: any) => (visible ? React.createElement(React.Fragment, null, children) : null) }
})
jest.mock('../../ui/components/wallet/AmountDisplay', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { __esModule: true, default: ({ children }: any) => React.createElement(Text, null, `${children} sats`) }
})
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({ BiometricAdvisoryModal: () => null }))
jest.mock('../../ui/components/vault/VaultBackdrop', () => ({ VaultBackdrop: () => null }))
jest.mock('../../ui/components/vault/EnrollWizard', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { EnrollWizard: ({ mode }: any) => React.createElement(Text, null, `WIZARD:${mode}`) }
})
jest.mock('../../ui/hooks/useVaultBalance', () => ({
  useVaultBalance: () => ({ balance: mockBalance, loading: false, refresh: jest.fn() })
}))
jest.mock('../../ui/hooks/useVaultCoverage', () => ({
  useVaultCoverage: () => ({ coverage: mockCoverage, refresh: mockRefreshCoverage })
}))
jest.mock('../../ui/hooks/useExportWalletData', () => ({
  useExportWalletData: () => ({ exportData: mockExportData, exporting: false })
}))

import { VaultScreen } from '../../ui/screens/VaultScreen'

const PUB = (c: string) => '02' + c.repeat(64)
const key = (n: number, nickname: string, c: string) => ({
  serial: `1234000${n}`,
  slot: 0x82,
  pubkey: PUB(c),
  nickname,
  enrolledAt: 1_700_000_000_000 + n
})
const META2 = { v: 5, createdAt: 1, lastUsedSerial: '12340002', keys: [key(1, 'Desk', 'a'), key(2, 'Safe', 'b')] }
const META3 = { ...META2, keys: [...META2.keys, key(3, 'Car', 'c')] }
const META5 = { ...META2, keys: [...META3.keys, key(4, 'Bank', 'd'), key(5, 'Parents', 'e')] }
const CLEAN = { outputs: 4, stale: 0, missingKeys: [], removedKeyOutputs: 0 }
const NO_UNREACHABLE = { count: 0, satoshis: 0, keys: [] }

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

async function renderVault() {
  const screen = render(<VaultScreen />)
  await settle()
  return screen
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVaultEnabled = true
  mockSupported = true
  mockBalance = 0
  mockCoverage = CLEAN
  mockGetMeta.mockReset().mockResolvedValue(META2)
  mockRemoveKey.mockReset().mockResolvedValue(META2)
  mockRenameKey.mockReset().mockResolvedValue(META2)
  mockRelock.mockReset()
  mockOrphanedIfRemoved.mockReset().mockResolvedValue(0)
  mockDisable.mockReset().mockResolvedValue(undefined)
  mockReclaim.mockReset().mockResolvedValue({ reclaimed: 0, satoshis: 0 })
  mockShowAlert.mockReset()
  mockWallet = {
    managers: { permissionsManager: { listOutputs: jest.fn() } },
    adminOriginator: 'admin.test',
    storage: null,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn()
  }
})

describe('not enrolled', () => {
  test('flag off: hero with the not-released notice and an inert CTA', async () => {
    mockVaultEnabled = false
    mockGetMeta.mockResolvedValue(null)
    const screen = await renderVault()
    expect(screen.getByText('vault_hero_title')).toBeTruthy()
    expect(screen.getByText('vault_not_released_body')).toBeTruthy()
    await act(async () => fireEvent.press(screen.getByText('vault_enroll_begin')))
    expect(screen.queryByText('WIZARD:enroll')).toBeNull()
  })

  test('driver unsupported: hero with the needs-a-YubiKey notice and an inert CTA', async () => {
    mockSupported = false
    mockGetMeta.mockResolvedValue(null)
    const screen = await renderVault()
    expect(screen.getByText('vault_unsupported_title')).toBeTruthy()
    await act(async () => fireEvent.press(screen.getByText('vault_enroll_begin')))
    expect(screen.queryByText('WIZARD:enroll')).toBeNull()
  })

  test('flag on, supported: the CTA opens the wizard in enroll mode', async () => {
    mockGetMeta.mockResolvedValue(null)
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_enroll_begin')))
    expect(screen.getByText('WIZARD:enroll')).toBeTruthy()
  })
})

describe('enrolled', () => {
  test('lists every key as nickname · …tail4 with the footnote and the key-count header', async () => {
    const screen = await renderVault()
    expect(screen.getByText('vault_key_section:{"count":2}')).toBeTruthy()
    expect(screen.getByText('Desk · …0001')).toBeTruthy()
    expect(screen.getByText('Safe · …0002')).toBeTruthy()
    expect(screen.getByText('vault_footnote')).toBeTruthy()
    expect(screen.getByText('vault_export_explainer')).toBeTruthy()
    expect(screen.getByText('export_wallet_data')).toBeTruthy()
  })

  test('shows the not-yet-open badge when outputs are stale and it opens re-lock', async () => {
    mockCoverage = { outputs: 4, stale: 3, missingKeys: [PUB('b')], removedKeyOutputs: 0 }
    mockBalance = 300_000
    const screen = await renderVault()
    const badge = screen.getByText('vault_badge_missing:{"count":3,"nickname":"Safe"}')
    expect(screen.queryByText(/vault_badge_removed/)).toBeNull()
    fireEvent.press(badge)
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
    expect(screen.getByText('vault_relock_reason_generic')).toBeTruthy()
  })

  test('shows the removed-key badge', async () => {
    mockCoverage = { outputs: 4, stale: 2, missingKeys: [], removedKeyOutputs: 2 }
    const screen = await renderVault()
    expect(screen.getByText('vault_badge_removed:{"count":2}')).toBeTruthy()
  })

  test('no badges when every output carries the current key set', async () => {
    const screen = await renderVault()
    expect(screen.queryByText(/vault_badge_/)).toBeNull()
  })

  test('Add key is shown below five keys and opens the wizard in add-key mode', async () => {
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_add_key_row')))
    expect(screen.getByText('WIZARD:add-key')).toBeTruthy()
  })

  test('Add key is hidden at five keys', async () => {
    mockGetMeta.mockResolvedValue(META5)
    const screen = await renderVault()
    expect(screen.getByText('vault_key_section:{"count":5}')).toBeTruthy()
    expect(screen.queryByText('vault_add_key_row')).toBeNull()
  })

  test('Add key is inert while the flag is off, but the enrolled view stays', async () => {
    mockVaultEnabled = false
    const screen = await renderVault()
    expect(screen.getByText('vault_withdraw_cta')).toBeTruthy()
    expect(screen.getByText('vault_not_released_body')).toBeTruthy()
    expect(screen.queryByText('vault_add_key_row')).toBeNull()
  })

  test('removing a key shows the three-button confirmation and removes on Remove only', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('remove')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · …0001')))
    await settle()
    expect(mockOrphanedIfRemoved).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', PUB('a'))
    expect(mockShowAlert).toHaveBeenCalledTimes(2)
    expect(mockShowAlert.mock.calls[0][0].buttons.map((b: any) => b.text)).toEqual([
      'vault_key_action_rename',
      'vault_key_action_remove',
      'vault_cancel'
    ])
    const confirm = mockShowAlert.mock.calls[1][0]
    expect(confirm.title).toBe('vault_remove_title:{"nickname":"Desk"}')
    expect(confirm.message).toBe('vault_remove_body:{"nickname":"Desk","fee":"2,900"}')
    expect(confirm.buttons.map((b: any) => b.text)).toEqual(['vault_remove_and_relock', 'vault_remove_only', 'vault_cancel'])
    expect(mockRemoveKey).toHaveBeenCalledWith('12340001')
    expect(mockShowToast).toHaveBeenCalledWith('vault_key_removed_toast', { type: 'info' })
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('Remove and re-lock now removes, then opens the re-lock sheet', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('relock')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Car · …0003')))
    await settle()
    expect(mockRemoveKey).toHaveBeenCalledWith('12340003')
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
  })

  test('removal is refused at two keys', async () => {
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · …0001')))
    await settle()
    expect(mockShowAlert.mock.calls[1][0].message).toBe('vault_err_last_keys')
    expect(mockRemoveKey).not.toHaveBeenCalled()
  })

  test('removal is refused with relock-required when orphanedIfRemoved reports an orphan', async () => {
    mockGetMeta.mockResolvedValue(META3)
    mockOrphanedIfRemoved.mockResolvedValueOnce(1)
    mockShowAlert.mockResolvedValueOnce('remove').mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Desk · …0001')))
    await settle()
    expect(mockOrphanedIfRemoved).toHaveBeenCalledWith(mockWallet.managers.permissionsManager, 'admin.test', PUB('a'))
    expect(mockShowAlert.mock.calls[1][0].message).toBe('vault_err_relock_required')
    expect(mockRemoveKey).not.toHaveBeenCalled()
  })

  test('rename saves through vaultStore.renameKey', async () => {
    mockShowAlert.mockResolvedValueOnce('rename')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('Safe · …0002')))
    await settle()
    const field = screen.getByLabelText('vault_rename_title:{"nickname":"Safe"}')
    fireEvent.changeText(field, 'Office safe')
    await act(async () => fireEvent.press(screen.getByText('vault_rename_save')))
    await settle()
    expect(mockRenameKey).toHaveBeenCalledWith('12340002', 'Office safe')
  })

  test('re-lock defaults to the last-used key, loops while capped, then reports the unreachable keys', async () => {
    mockBalance = 300_000
    mockRelock
      .mockResolvedValueOnce({ txid: 'a', cappedInputs: 2, unreachable: NO_UNREACHABLE })
      .mockResolvedValueOnce({
        txid: 'b',
        cappedInputs: 0,
        unreachable: { count: 1, satoshis: 50_000, keys: [{ serial: '12340001', pubkey: PUB('a') }] }
      })
    mockShowAlert.mockResolvedValueOnce('ok')
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_relock_row')))
    const radios = screen.getAllByRole('radio')
    expect(radios[1].props.accessibilityState).toEqual({ selected: true }) // Safe = lastUsedSerial

    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(mockRelock).toHaveBeenCalledTimes(2)
    expect(mockRelock.mock.calls[0].slice(1, 4)).toEqual(['admin.test', 'vault_relock_reason_generic', '12340002'])
    expect(mockShowToast).toHaveBeenCalledWith('vault_relock_capped:{"count":2}', { type: 'info' })
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'vault_relock_unreachable:{"count":1,"names":"Desk · …0001"}'
      })
    )
    expect(mockRefreshCoverage).toHaveBeenCalled()
  })

  test('a clean re-lock toasts done', async () => {
    mockBalance = 300_000
    mockRelock.mockResolvedValueOnce({ txid: 'a', cappedInputs: 0, unreachable: NO_UNREACHABLE })
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_relock_row')))
    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(mockShowToast).toHaveBeenCalledWith('vault_relock_done', { type: 'success' })
    expect(screen.queryByText('vault_relock_choose')).toBeNull()
  })

  test('a re-lock error stays in the sheet with its copy', async () => {
    mockBalance = 50_000
    const { VaultError } = jest.requireActual('../../core/services/vault/types')
    mockRelock.mockRejectedValueOnce(new VaultError('too-small-to-relock'))
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_relock_row')))
    await act(async () => fireEvent.press(screen.getByText('vault_relock_now')))
    await settle()
    expect(screen.getByText('vault_err_too_small_to_relock')).toBeTruthy()
    expect(screen.getByText('vault_relock_choose')).toBeTruthy()
  })

  test('disable is refused while the vault holds funds and clears meta when empty', async () => {
    mockBalance = 10
    mockShowAlert.mockResolvedValueOnce('ok')
    let screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_disable_row')))
    await settle()
    expect(mockShowAlert).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'vault_disable_blocked_title' }))
    expect(mockDisable).not.toHaveBeenCalled()

    screen.unmount()
    mockBalance = 0
    mockShowAlert.mockResolvedValueOnce('confirm')
    screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_disable_row')))
    await settle()
    expect(mockDisable).toHaveBeenCalledTimes(1)
  })

  test('the export row runs the shared export action', async () => {
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('export_wallet_data')))
    expect(mockExportData).toHaveBeenCalledTimes(1)
  })

  test('deposit pushes the transfer route when a wallet exists; withdraw always does', async () => {
    const screen = await renderVault()
    await act(async () => fireEvent.press(screen.getByText('vault_deposit_cta')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault-transfer?direction=deposit')
    await act(async () => fireEvent.press(screen.getByText('vault_withdraw_cta')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault-transfer?direction=withdraw')
  })

  test('the legacy staging reclaim still runs once for an enrolled vault', async () => {
    await renderVault()
    expect(mockReclaim).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run — expect failures against the old screen**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx
```
Expected: the `not enrolled` flag-off test fails (`Unable to find an element with text: vault_not_released_body`), every `enrolled` test fails (the old screen renders `vault_key_serial` / `meta.yubiSerial`, never a key list). The unsupported and enroll-mode tests pass already.

- [ ] **Step 3: Rewrite the screen**

Replace the entire contents of `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/VaultScreen.tsx` with:

```tsx
/**
 * The Vault screen — spec §3.4 / §5.4.
 *
 * Four states:
 *   • vaultEnabled off, not enrolled   → hero, "Not available yet" notice, inert CTA
 *   • driver unsupported, not enrolled → hero, "Needs a YubiKey" notice, inert CTA
 *   • not enrolled                     → hero; "Set up vault" opens the EnrollWizard
 *   • enrolled                         → balance, deposit / withdraw, the key list with
 *                                        coverage badges, add / rename / remove / re-lock,
 *                                        export wallet data, disable
 *
 * An ENROLLED vault with the flag off keeps the enrolled view — withdrawals of
 * pre-existing outputs are never gated (spec §5.5) — with deposit, add-key and
 * re-lock inert and the same "Not available yet" notice under the actions.
 *
 * Enrolment needs no built wallet. The Deposit button (not the Vault button)
 * runs the same lazy wallet-creation path as WalletHomeScreen; its
 * ensureWalletExists (ui/screens/WalletHomeScreen.tsx:268–298) is repeated
 * here rather than shared because this is the only other place that needs it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GroupedSection } from '../components/ui/GroupedList'
import { ListRow } from '../components/ui/ListRow'
import PressableScale from '../components/ui/PressableScale'
import Sheet from '../components/ui/Sheet'
import AmountDisplay from '../components/wallet/AmountDisplay'
import { BiometricAdvisoryModal } from '../components/wallet/BiometricAdvisoryModal'
import { showAlert } from '../components/ui/AlertCard'
import { showToast } from '../components/ui/Toast'
import { EnrollWizard } from '../components/vault/EnrollWizard'
import { KeyChooser, vaultKeyLabel } from '../components/vault/KeyChooser'
import { VaultBackdrop } from '../components/vault/VaultBackdrop'
import { vaultErrorCopy } from '../components/vault/vaultErrorCopy'
import { useVaultBalance } from '../hooks/useVaultBalance'
import { useVaultCoverage } from '../hooks/useVaultCoverage'
import { useExportWalletData } from '../hooks/useExportWalletData'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  useLocalStorage,
  reclaimStagingOutputs,
  relockVault,
  orphanedIfRemoved,
  estimateRelockFee,
  R1C_LOCK_LEN,
  type VaultWallet,
  type VaultSpendResult,
  vaultStore,
  type VaultMeta,
  type VaultKeyRecord,
  VAULT_MIN_KEYS,
  VAULT_MAX_KEYS,
  getVaultDriver,
  isVaultEnabled,
  disableVault,
  getOnline,
  generateMnemonicWallet,
  backupAttestation,
  VaultError,
  haptics,
  i18n
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Loaded lazily, only when actually rendering, same pattern as this
 * package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as
 * core/context/WalletContext.tsx's and WalletHomeScreen.tsx's lazy
 * expo-router load.
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

/**
 * Upper bound on re-lock passes in one go. Each pass moves at least one and at
 * most VAULT_MAX_INPUTS (32) outputs, and listOutputs is capped at 1000, so
 * 32 passes covers the largest vault the transfer layer can see.
 */
const MAX_RELOCK_PASSES = 32

/** Swallows the sheet's dismiss while a re-lock is in flight. */
const noop = (): void => {}

interface RelockRequest {
  /** The reason line the ceremony sheet shows and relockVault records. */
  reason: string
  /** A serial to leave out of the chooser — the key just added, which cannot open the old outputs. */
  exclude?: string
}

export function VaultScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router } = loadExpoRouter()
  const Ionicons = loadIonicons()
  const { balance, loading, refresh } = useVaultBalance()
  const { coverage, refresh: refreshCoverage } = useVaultCoverage()
  const { exportData, exporting } = useExportWalletData()
  const { managers, adminOriginator, storage, walletBuilding, buildWalletFromMnemonic } = useWallet()
  const { createMnemonic, hasStoredIdentity, secretsReady } = useLocalStorage()

  /** undefined = loading; null = not enrolled. */
  const [meta, setMeta] = useState<VaultMeta | null | undefined>(undefined)
  const metaRef = useRef<VaultMeta | null>(null)
  const [wizard, setWizard] = useState<'enroll' | 'add-key' | null>(null)
  const serialsBeforeAdd = useRef<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<VaultKeyRecord | null>(null)
  const [renameText, setRenameText] = useState('')
  const [relock, setRelock] = useState<RelockRequest | null>(null)
  const [relockSerial, setRelockSerial] = useState<string | undefined>(undefined)
  const [relocking, setRelocking] = useState(false)
  const [relockError, setRelockError] = useState<string | null>(null)
  const [showBiometricAdvisory, setShowBiometricAdvisory] = useState(false)
  const [creatingWallet, setCreatingWallet] = useState(false)

  const enabled = isVaultEnabled()
  const supported = getVaultDriver()?.isSupported() ?? false
  const enrolled = meta != null

  const reload = useCallback(async (): Promise<VaultMeta | null> => {
    const m = await vaultStore.getMeta()
    metaRef.current = m
    setMeta(m)
    return m
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Recover money the retired two-transaction deposit stranded (tx1 landed,
  // tx2 failed). Stranded coins are invisible to BOTH balances — the main
  // balance counts only the default basket, the vault balance only the vault
  // basket — so this cannot wait for the user to notice anything. One attempt
  // per screen visit; a wallet with nothing stranded returns without touching
  // anything. No ceremony: staging keys are ordinary wallet-derived keys.
  const pm = managers?.permissionsManager
  useEffect(() => {
    if (!enrolled || !pm) return
    let stale = false
    reclaimStagingOutputs(pm as unknown as VaultWallet, adminOriginator, {
      releaseStrandedStaging: storage ? () => storage.releaseVaultStagingStrandedByInvalidTx() : undefined,
      findSpendingReferences: storage ? outpoints => storage.findSpendingReferences(outpoints) : undefined
    })
      .then(r => {
        if (stale || r.reclaimed === 0) return
        console.log(`[vault] reclaimed ${r.reclaimed} staging output(s), ${r.satoshis} sats · txid=${r.txid}`)
        showToast(t('vault_reclaim_done'), { type: 'success' })
      })
      .catch(e => console.log('[vault] staging reclaim failed:', (e as Error)?.message))
    return () => {
      stale = true
    }
  }, [enrolled, pm, adminOriginator, storage])

  // ── helpers ─────────────────────────────────────────────────────────
  /** `nickname · …tail4` for each referenced key; a key no longer in meta shows its pubkey tail. */
  const namesFor = useCallback(
    (refs: { serial?: string; pubkey: string }[]): string =>
      refs
        .map(r => {
          const rec = metaRef.current?.keys.find(k => (r.serial !== undefined && k.serial === r.serial) || k.pubkey === r.pubkey)
          return rec ? vaultKeyLabel(rec) : `…${r.pubkey.slice(-4)}`
        })
        .join(', '),
    []
  )

  const transferOpts = useCallback(
    () => ({
      // Lets the reservation heal find the reserving transaction with one
      // indexed query instead of paging every action in the wallet.
      findSpendingReferences: storage ? (outpoints: string[]) => storage.findSpendingReferences(outpoints) : undefined,
      isOnline: getOnline
    }),
    [storage]
  )

  // ── re-lock ─────────────────────────────────────────────────────────
  const openRelock = useCallback((request: RelockRequest) => {
    const m = metaRef.current
    if (!m) return
    const candidates = request.exclude ? m.keys.filter(k => k.serial !== request.exclude) : m.keys
    const lastUsed = candidates.find(k => k.serial === m.lastUsedSerial)
    setRelockSerial((lastUsed ?? candidates[0])?.serial)
    setRelockError(null)
    setRelock(request)
  }, [])

  const closeRelock = useCallback(() => {
    setRelock(null)
    setRelockError(null)
  }, [])

  const runRelock = useCallback(async () => {
    if (!pm || !relock || !relockSerial || relocking) return
    setRelocking(true)
    setRelockError(null)
    try {
      const w = pm as unknown as VaultWallet
      let result: VaultSpendResult
      let passes = 0
      // One pass per tap while the cap left outputs behind (spec §4.3). The
      // ceremony sheet runs each tap; this loop only re-invokes the spend.
      do {
        result = await relockVault(w, adminOriginator, relock.reason, relockSerial, transferOpts())
        passes += 1
        if (result.cappedInputs > 0) showToast(t('vault_relock_capped', { count: result.cappedInputs }), { type: 'info' })
      } while (result.cappedInputs > 0 && passes < MAX_RELOCK_PASSES)
      closeRelock()
      refresh()
      refreshCoverage()
      if (result.unreachable.count > 0) {
        // Only outputs this key is NOT committed to remain: another key has
        // to finish the job.
        await showAlert({
          title: t('vault_relock_row'),
          message: t('vault_relock_unreachable', {
            count: result.unreachable.count,
            names: namesFor(result.unreachable.keys)
          }),
          buttons: [{ text: t('vault_ok'), key: 'ok' }]
        })
      } else {
        showToast(t('vault_relock_done'), { type: 'success' })
      }
    } catch (e) {
      console.error('[vault] re-lock failed:', e instanceof Error ? e.message : e, e)
      haptics.error()
      setRelockError(
        vaultErrorCopy(e instanceof VaultError ? e.code : undefined, {
          names: metaRef.current?.keys.map(vaultKeyLabel).join(', ') || undefined
        })
      )
    } finally {
      setRelocking(false)
    }
  }, [pm, relock, relockSerial, relocking, adminOriginator, transferOpts, closeRelock, refresh, refreshCoverage, namesFor])

  // ── wizard hand-offs ────────────────────────────────────────────────
  const onEnrolled = useCallback(async () => {
    setWizard(null)
    await reload()
    refresh()
    refreshCoverage()
  }, [reload, refresh, refreshCoverage])

  const openAddKey = useCallback(() => {
    serialsBeforeAdd.current = new Set(metaRef.current?.keys.map(k => k.serial) ?? [])
    setWizard('add-key')
  }, [])

  const onKeyAdded = useCallback(async () => {
    setWizard(null)
    const m = await reload()
    refreshCoverage()
    if (!m) return
    const before = serialsBeforeAdd.current
    const added = m.keys.filter(k => !before.has(k.serial))
    const others = m.keys.filter(k => before.has(k.serial))
    // The new key can open deposits made from now on; a re-lock makes it open
    // everything. Pointless on an empty vault, so only offered when it holds
    // something — the wizard's done step already said so either way.
    if (added.length > 0 && (balance ?? 0) > 0) {
      openRelock({
        reason: t('vault_relock_reason', { names: others.map(vaultKeyLabel).join(', ') }),
        exclude: added[0].serial
      })
    }
  }, [reload, refreshCoverage, balance, openRelock])

  // ── rename / remove ─────────────────────────────────────────────────
  const saveRename = useCallback(async () => {
    if (!renaming) return
    const next = renameText.trim()
    if (next && next !== renaming.nickname) {
      try {
        await vaultStore.renameKey(renaming.serial, next)
        await reload()
      } catch (e) {
        haptics.error()
        showToast(vaultErrorCopy(e instanceof VaultError ? e.code : undefined), { type: 'error' })
      }
    }
    setRenaming(null)
  }, [renaming, renameText, reload])

  const removeKey = useCallback(
    async (rec: VaultKeyRecord) => {
      const m = metaRef.current
      if (!m) return
      const title = t('vault_remove_title', { nickname: rec.nickname })
      if (m.keys.length <= VAULT_MIN_KEYS) {
        await showAlert({ title, message: vaultErrorCopy('last-keys'), buttons: [{ text: t('vault_ok'), key: 'ok' }] })
        return
      }
      // Every output must stay committed to at least one remaining key
      // (spec §3.4) — checked exactly, against each output's real committed
      // key set, not approximated from the coverage record.
      const w = pm as unknown as VaultWallet
      const orphans = await orphanedIfRemoved(w, adminOriginator, rec.pubkey)
      if (orphans > 0) {
        await showAlert({ title, message: vaultErrorCopy('relock-required'), buttons: [{ text: t('vault_ok'), key: 'ok' }] })
        return
      }
      const fee = estimateRelockFee(Math.max(coverage?.outputs ?? 1, 1), R1C_LOCK_LEN(m.keys.length - 1))
      const choice = await showAlert({
        title,
        message: t('vault_remove_body', { nickname: rec.nickname, fee: fee.toLocaleString('en-US') }),
        buttons: [
          { text: t('vault_remove_and_relock'), key: 'relock' },
          { text: t('vault_remove_only'), key: 'remove', style: 'destructive' },
          { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
        ]
      })
      if (choice !== 'relock' && choice !== 'remove') return
      try {
        await vaultStore.removeKey(rec.serial)
      } catch (e) {
        haptics.error()
        await showAlert({
          title,
          message: vaultErrorCopy(e instanceof VaultError ? e.code : undefined),
          buttons: [{ text: t('vault_ok'), key: 'ok' }]
        })
        return
      }
      haptics.warning()
      showToast(t('vault_key_removed_toast'), { type: 'info' })
      await reload()
      refreshCoverage()
      if (choice === 'relock') openRelock({ reason: t('vault_relock_reason_generic') })
    },
    [coverage, pm, adminOriginator, reload, refreshCoverage, openRelock]
  )

  const keyActions = useCallback(
    async (rec: VaultKeyRecord) => {
      const choice = await showAlert({
        title: vaultKeyLabel(rec),
        buttons: [
          { text: t('vault_key_action_rename'), key: 'rename' },
          { text: t('vault_key_action_remove'), key: 'remove', style: 'destructive' },
          { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
        ]
      })
      if (choice === 'rename') {
        setRenameText(rec.nickname)
        setRenaming(rec)
      } else if (choice === 'remove') {
        await removeKey(rec)
      }
    },
    [removeKey]
  )

  // ── disable ─────────────────────────────────────────────────────────
  const confirmDisable = useCallback(async () => {
    // Refuse while funds remain: disabling forgets the key list, and with it
    // the only in-app way to sign for those outputs.
    if ((balance ?? 0) > 0) {
      await showAlert({
        title: t('vault_disable_blocked_title'),
        message: t('vault_disable_blocked_message'),
        buttons: [{ text: t('vault_ok'), key: 'ok' }]
      })
      return
    }
    const choice = await showAlert({
      title: t('vault_disable_title'),
      message: t('vault_disable_message'),
      buttons: [
        { text: t('vault_disable_confirm'), key: 'confirm', style: 'destructive' },
        { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
      ]
    })
    if (choice !== 'confirm') return
    await disableVault()
    haptics.warning()
    showToast(t('vault_disabled_toast'), { type: 'info' })
    await reload()
  }, [balance, reload])

  // ── deposit: lazy wallet creation ───────────────────────────────────
  /**
   * Apple HIG: never ask for Face ID/Touch ID before the user has done
   * something that explains why. Enrolment needs no wallet, so a user can
   * reach this screen on a fresh install with none; the Deposit tap is the
   * moment that explains the prompt. Same flow as WalletHomeScreen's
   * destinationPress → BiometricAdvisoryModal → ensureWalletExists.
   */
  const creatingWalletRef = useRef(false)
  const ensureWalletExists = useCallback(async (): Promise<boolean> => {
    if (managers.permissionsManager) return true
    if (!secretsReady || walletBuilding || creatingWalletRef.current) return false
    creatingWalletRef.current = true
    try {
      // A missing manager during migration, unlock, or a failed build does
      // not mean the device has no wallet. Never replace that stored identity.
      if (await hasStoredIdentity()) return false
      const wallet = generateMnemonicWallet()
      const stored = await createMnemonic(wallet.mnemonic)
      if (!stored) {
        if (!(await hasStoredIdentity())) router.replace('/auth/mnemonic')
        return false
      }
      try {
        await backupAttestation.markPending(wallet.identityKey)
      } catch (error) {
        console.warn('[vault] Could not record pending backup reminder:', error)
      }
      await buildWalletFromMnemonic(wallet.mnemonic)
      return true
    } catch (error) {
      console.warn('[vault] Wallet creation did not complete:', error)
      return false
    } finally {
      creatingWalletRef.current = false
    }
  }, [managers.permissionsManager, secretsReady, walletBuilding, hasStoredIdentity, createMnemonic, buildWalletFromMnemonic, router])

  const onDeposit = useCallback(async () => {
    if (managers.permissionsManager) {
      router.push('/vault-transfer?direction=deposit')
      return
    }
    if (!secretsReady || walletBuilding) return
    try {
      if (await hasStoredIdentity()) return
    } catch {
      return
    }
    setShowBiometricAdvisory(true)
  }, [managers.permissionsManager, secretsReady, walletBuilding, hasStoredIdentity, router])

  const onAdvisoryContinue = useCallback(() => {
    setCreatingWallet(true)
    void (async () => {
      try {
        // Yield once so the spinner paints before the blocking key math starts.
        await new Promise(resolve => setTimeout(resolve, 0))
        const created = await ensureWalletExists()
        setShowBiometricAdvisory(false)
        if (created) router.push('/vault-transfer?direction=deposit')
      } finally {
        setCreatingWallet(false)
      }
    })()
  }, [ensureWalletExists, router])

  // ── header ──────────────────────────────────────────────────────────
  // While the wizard is up, back means "leave set-up" and goes through the
  // wizard's own leave-confirm (it owns the pending keys), so the chevron is
  // replaced by a spacer and the wizard's Leave link is the only way out.
  const Header = (
    <View style={[styles.header, { borderBottomColor: colors.separator }]}>
      {wizard ? (
        <View style={styles.iconBtn} />
      ) : (
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
      )}
      <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('vault_title')}</Text>
      <View style={styles.iconBtn} />
    </View>
  )

  if (meta === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </View>
    )
  }

  // ── enrollment / add-key wizard ─────────────────────────────────────
  if (wizard) {
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        <EnrollWizard mode={wizard} onDone={wizard === 'enroll' ? onEnrolled : onKeyAdded} onCancel={() => setWizard(null)} />
      </View>
    )
  }

  // ── not enrolled ─────────────────────────────────────────────────────
  if (meta === null) {
    const canEnroll = enabled && supported
    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
        {Header}
        {/* Backdrop is clipped to the area below the header rather than laid over
            the whole screen, so the line work never crosses the title bar. */}
        <View style={styles.heroArea}>
          <View style={styles.heroArt}>
            <VaultBackdrop color={colors.textPrimary} />
          </View>
          <ScrollView contentContainerStyle={styles.heroScroll}>
            {/* 1:4 spacers sit the copy block high, just under the header,
                clear of the drawing — a ratio rather than a magic padding. */}
            <View style={styles.heroSpacerTop} />
            <View style={styles.heroCopy}>
              <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_hero_title')}</Text>
              <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_hero_body')}</Text>
              <PressableScale
                haptic="confirm"
                onPress={canEnroll ? () => setWizard('enroll') : undefined}
                accessibilityState={{ disabled: !canEnroll }}
                style={[
                  styles.primary,
                  canEnroll
                    ? { backgroundColor: colors.accent }
                    : { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }
                ]}
              >
                <Text style={[styles.primaryLabel, { color: canEnroll ? colors.textOnAccent : colors.textTertiary }]}>
                  {t('vault_enroll_begin')}
                </Text>
              </PressableScale>
              {/* Release gate first (spec §5.5): a build with the flag off says
                  so before it says anything about hardware. */}
              {!enabled && (
                <View style={styles.heroNotice}>
                  <Text style={[styles.heroNoticeBody, { color: colors.textSecondary }]}>{t('vault_not_released_body')}</Text>
                </View>
              )}
              {enabled && !supported && (
                <View style={styles.heroNotice}>
                  <Text style={[styles.heroNoticeTitle, { color: colors.error }]}>{t('vault_unsupported_title')}</Text>
                  <Text style={[styles.heroNoticeBody, { color: colors.textSecondary }]}>{t('vault_unsupported_body')}</Text>
                </View>
              )}
            </View>
            <View style={styles.heroSpacerBottom} />
          </ScrollView>
        </View>
      </View>
    )
  }

  // ── enrolled ─────────────────────────────────────────────────────────
  const canAdd = enabled && meta.keys.length < VAULT_MAX_KEYS
  const missingNames = coverage
    ? meta.keys
        .filter(k => coverage.missingKeys.includes(k.pubkey))
        .map(k => k.nickname)
        .join(', ')
    : ''
  const relockCandidates = relock?.exclude ? meta.keys.filter(k => k.serial !== relock.exclude) : meta.keys
  const openGenericRelock = enabled ? () => openRelock({ reason: t('vault_relock_reason_generic') }) : undefined

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      {Header}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.balanceBlock}>
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>{t('vault_balance_label')}</Text>
          <TouchableOpacity onPress={refresh} activeOpacity={0.7}>
            {loading && balance === null ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={[styles.balance, { color: colors.textPrimary }]}>
                <AmountDisplay>{balance ?? 0}</AmountDisplay>
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.actions}>
          <PressableScale
            haptic="confirm"
            onPress={enabled ? () => void onDeposit() : undefined}
            accessibilityState={{ disabled: !enabled }}
            style={[styles.actionBtn, { backgroundColor: enabled ? colors.accent : colors.backgroundElevated }]}
          >
            <Ionicons name="arrow-down" size={18} color={enabled ? colors.textOnAccent : colors.textTertiary} />
            <Text style={[styles.actionLabel, { color: enabled ? colors.textOnAccent : colors.textTertiary }]}>
              {t('vault_deposit_cta')}
            </Text>
          </PressableScale>
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/vault-transfer?direction=withdraw')}
            style={[
              styles.actionBtn,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.separator, borderWidth: StyleSheet.hairlineWidth }
            ]}
          >
            <Ionicons name="arrow-up" size={18} color={colors.accent} />
            <Text style={[styles.actionLabel, { color: colors.accent }]}>{t('vault_withdraw_cta')}</Text>
          </PressableScale>
        </View>
        {!enabled && <Text style={[styles.notice, { color: colors.textSecondary }]}>{t('vault_not_released_body')}</Text>}

        <GroupedSection header={t('vault_key_section', { count: meta.keys.length })} footer={t('vault_footnote')}>
          {coverage && coverage.missingKeys.length > 0 && (
            <ListRow
              label={t('vault_badge_missing', { count: coverage.stale, nickname: missingNames })}
              icon="alert-circle-outline"
              iconColor={colors.warning}
              showChevron={false}
              onPress={openGenericRelock}
            />
          )}
          {coverage && coverage.removedKeyOutputs > 0 && (
            <ListRow
              label={t('vault_badge_removed', { count: coverage.removedKeyOutputs })}
              icon="alert-circle-outline"
              iconColor={colors.warning}
              showChevron={false}
              onPress={openGenericRelock}
            />
          )}
          {meta.keys.map((rec, i) => (
            <ListRow
              key={rec.serial}
              label={vaultKeyLabel(rec)}
              subtitle={new Date(rec.enrolledAt).toLocaleDateString()}
              icon="key-outline"
              iconColor={colors.permissionSpending}
              showChevron={false}
              onPress={() => void keyActions(rec)}
              isLast={i === meta.keys.length - 1 && !canAdd}
            />
          ))}
          {canAdd && (
            <ListRow label={t('vault_add_key_row')} icon="add-circle-outline" iconColor={colors.info} onPress={openAddKey} isLast />
          )}
        </GroupedSection>

        <GroupedSection header={t('vault_manage_section')} footer={t('vault_export_explainer')}>
          <ListRow
            label={t('vault_relock_row')}
            icon="refresh-outline"
            iconColor={colors.info}
            showChevron={false}
            onPress={openGenericRelock}
          />
          <ListRow
            label={t('export_wallet_data')}
            icon="share-outline"
            iconColor="#32ADE6"
            showChevron={false}
            onPress={exporting ? undefined : () => void exportData()}
            trailing={exporting ? <ActivityIndicator size="small" /> : undefined}
            isLast
          />
        </GroupedSection>

        <GroupedSection>
          <ListRow
            label={t('vault_disable_row')}
            icon="lock-open"
            iconColor={colors.error}
            destructive
            onPress={() => void confirmDisable()}
            isLast
          />
        </GroupedSection>
      </ScrollView>

      {/* Rename — nickname only. */}
      <Sheet
        visible={renaming !== null}
        onClose={() => setRenaming(null)}
        title={renaming ? t('vault_rename_title', { nickname: renaming.nickname }) : ''}
        fitContent
      >
        <View style={styles.sheetBody}>
          <TextInput
            accessibilityLabel={renaming ? t('vault_rename_title', { nickname: renaming.nickname }) : ''}
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={renameText}
            onChangeText={setRenameText}
            placeholder={renaming?.nickname}
            placeholderTextColor={colors.textTertiary}
            maxLength={32}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={() => void saveRename()}
            autoFocus
          />
          <PressableScale haptic="confirm" onPress={() => void saveRename()} style={[styles.primary, { backgroundColor: colors.accent }]}>
            <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_rename_save')}</Text>
          </PressableScale>
          <PressableScale onPress={() => setRenaming(null)} style={styles.secondary}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
          </PressableScale>
        </View>
      </Sheet>

      {/* Re-lock — choose the key, then one ceremony tap per pass. */}
      <Sheet visible={relock !== null} onClose={relocking ? noop : closeRelock} title={t('vault_relock_row')} fitContent>
        <View style={styles.sheetBody}>
          {relock?.reason ? <Text style={[styles.p, { color: colors.textSecondary }]}>{relock.reason}</Text> : null}
          <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>{t('vault_relock_choose')}</Text>
          <KeyChooser keys={relockCandidates} selected={relockSerial} onSelect={setRelockSerial} />
          {relockError && <Text style={[styles.err, { color: colors.error }]}>{relockError}</Text>}
          <PressableScale
            haptic="confirm"
            onPress={relockSerial && !relocking ? () => void runRelock() : undefined}
            accessibilityState={{ disabled: !relockSerial || relocking }}
            style={[styles.primary, { backgroundColor: colors.accent, opacity: relockSerial && !relocking ? 1 : 0.5 }]}
          >
            {relocking ? (
              <ActivityIndicator color={colors.textOnAccent} />
            ) : (
              <Text style={[styles.primaryLabel, { color: colors.textOnAccent }]}>{t('vault_relock_now')}</Text>
            )}
          </PressableScale>
          <PressableScale onPress={relocking ? undefined : closeRelock} style={styles.secondary}>
            <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
          </PressableScale>
        </View>
      </Sheet>

      <BiometricAdvisoryModal
        visible={showBiometricAdvisory}
        loading={creatingWallet}
        onCancel={() => setShowBiometricAdvisory(false)}
        onContinue={onAdvisoryContinue}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline },
  centered: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  // NO horizontal padding here. GroupedSection insets itself (its card carries
  // marginHorizontal: spacing.lg, its header paddingHorizontal: spacing.xl), so
  // padding this container would double-inset every grouped card. Direct
  // children carry their own gutter instead.
  content: { paddingTop: spacing.lg, paddingBottom: spacing.xxxl },
  heroArea: { flex: 1, overflow: 'hidden' },
  heroArt: { position: 'absolute', bottom: '7%', left: 0, right: 0, height: '56%' },
  heroScroll: { flexGrow: 1 },
  heroNotice: { alignItems: 'center', gap: spacing.xs },
  heroNoticeTitle: { ...typography.subhead, fontWeight: '600', textAlign: 'center' },
  heroNoticeBody: { ...typography.footnote, textAlign: 'center' },
  heroSpacerTop: { flex: 1 },
  heroSpacerBottom: { flex: 4 },
  heroCopy: { alignSelf: 'stretch', alignItems: 'center', paddingHorizontal: spacing.xl, gap: spacing.lg },
  h1: { ...typography.title1, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  notice: { ...typography.footnote, textAlign: 'center', paddingHorizontal: spacing.xl, marginBottom: spacing.xxl },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body },
  err: { ...typography.footnote, textAlign: 'center' },
  balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
  // No textTransform, matching the wallet screen: "Vault holds" is a phrase
  // leading into the amount, and casing belongs to the translation.
  balanceLabel: { ...typography.footnote },
  // tabular-nums so the balance does not jitter as digits change.
  balance: { ...typography.display, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.xxl },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingVertical: spacing.lg
  },
  actionLabel: { ...typography.headline },
  sheetBody: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.lg },
  sheetLabel: { ...typography.headline },
  input: {
    width: '100%',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...typography.body
  }
})
```

- [ ] **Step 4: Run — expect PASS**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx
```
Expected: `Tests: 22 passed`.

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'ui/screens/VaultScreen'
```
Expected: empty.

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/screens/VaultScreen.tsx packages/expo-wallet-toolbox/__tests__/ui/vaultScreen.test.tsx && git commit -m "feat(expo-wallet-toolbox)!: vault screen for the 1-of-N key list

Four states (flag off, unsupported, not enrolled, enrolled), the key list
with coverage badges, add / rename / remove with the re-lock-required
guard, the re-lock sheet that loops one tap per capped pass and stops on
unreachable outputs, Export wallet data with its explainer, the footnote,
disable when empty, and the lazy wallet-creation path behind Deposit.
Keeps the legacy staging reclaim.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `VaultTransferScreen` rewrite — floor/fee line, first-deposit and remainder confirms, key chooser, post-transfer alerts

**Files:**
- Rewrite: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/VaultTransferScreen.tsx` (whole file)
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultTransferScreen.test.tsx`

**Interfaces:**
- Produces: `VaultTransferScreen(): JSX.Element` (unchanged export).
- Consumes: `KeyChooser` + `vaultKeyLabel` (Task 5), `vaultErrorCopy` (Task 2), `useVaultBalance`, `AmountInput` + `SEND_MAX_VALUE`, `AmountDisplay`, `PressableScale`, `showAlert`, `showToast`; from the core barrel: `useWallet`, `ExchangeRateContext`, `formatAmount`, `vaultStore.getMeta`, `depositToVault(w, o, sats, opts)`, `withdrawFromVault(w, o, amount, reason, chosenSerial, opts)`, `VAULT_DEPOSIT_MIN`, `VAULT_MAX_KEYS`, `estimateRelockFee`, `R1C_LOCK_LEN`, `isVaultEnabled`, `isBackupPushEnabled`, `getOnline`, `VaultError`, `haptics`, `i18n`, types `VaultMeta`, `VaultWallet`, `VaultSpendResult`.

Behaviour (spec §4.1, §4.2, §5.4):
- **Deposit.** Inline line under the amount: `vault_floor_line` with `floorDisplay = formatAmount(VAULT_DEPOSIT_MIN, …)`, `floorSats = VAULT_DEPOSIT_MIN.toLocaleString('en-US')`, `feeDisplay = formatAmount(estimateRelockFee(0, R1C_LOCK_LEN(keyCount)), …)` — the lock's own size at the toolbox rate plus its 10 % margin (≈ 3,080 sat for two keys; the funding input adds ~15 sat). `formatAmount` is the same formatter `AmountDisplay` wraps (`ui/components/wallet/AmountDisplay.tsx:39`); a component cannot be interpolated into `i18n.t`, so the string form is used. CTA inert below `VAULT_DEPOSIT_MIN`, while `!isVaultEnabled()` (with `vault_not_released_body` inline), or with no built wallet. Before running: `isBackupPushEnabled()` false → the backup-off alert (`vault_backup_off_*`, CTA pushes `/wallet-config`); `balance === 0` → the first-deposit confirm (`vault_first_deposit_*`, **Deposit / Cancel**). Then `depositToVault(w, adminOriginator, sats, { isOnline: getOnline })` — no ceremony, no reason string. `backup-off` / `not-released` thrown by the service land on the same alert / inline line.
- **Withdraw.** `vault_choose_key` + `KeyChooser` (default `lastUsedSerial` when still enrolled, else the first key). Remainder rule: `0 < balance − amount < VAULT_DEPOSIT_MIN` → `vault_remainder_*` confirm with **Withdraw everything / Change amount**; "everything" runs with `'all'`. `withdrawFromVault(w, adminOriginator, isMax ? 'all' : sats, t('vault_withdraw_reason', { amount }), chosenSerial, { findSpendingReferences, isOnline })`. Afterwards, alerts rather than toasts: `unreachable.count > 0` → `vault_unreachable_*` (moved = the amount that did move, `count`, `amount` = unreachable sats, `names` from `unreachable.keys` resolved against meta); then `cappedInputs > 0` → `vault_withdraw_partial` under the `vault_withdraw_done` title; otherwise the `vault_withdraw_done` toast.
- **Errors** → `vaultErrorCopy(code, params)` inline, where `params` carries the chosen key's label, the other keys, all keys, the tapped key (resolved from `VaultError.details.tapped` — the DECISION's `serial-mismatch` → `{ tapped, chosen }` shape — when it is an enrolled serial, so `serial-mismatch` can say "That's X. You chose Y") and, for `key-cannot-cover`, `reachable`/`total` likewise read from `VaultError.details` (`readErrorDetails`; formatted with `formatAmount`). When the services attach no `details`, the copy degrades exactly as Task 2 specifies.
- Lazy wallet creation is not this screen's job: the Deposit button on the Vault screen (Task 8) creates the wallet before pushing here, so with no `permissionsManager` the CTA is simply inert.

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/vaultTransferScreen.test.tsx`:

```tsx
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'

const mockT = (k: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() }
const mockShowAlert = jest.fn()
const mockShowToast = jest.fn()
const mockDeposit = jest.fn()
const mockWithdraw = jest.fn()
const mockRefresh = jest.fn()
let mockParams: { direction?: string } = {}
let mockMeta: unknown = null
let mockBalance: number | null = 0
let mockVaultEnabled = true
let mockBackupOn = true
let mockWallet: any

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    useTheme: () => ({ colors: {} }),
    i18n: { t: (k: string, o?: Record<string, unknown>) => mockT(k, o) },
    useWallet: () => mockWallet,
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 0, usdToFiat: {} }),
    formatAmount: (sats: number) => `${sats.toLocaleString('en-US')} sats`,
    VaultError: jest.requireActual('../../core/services/vault/types').VaultError,
    vaultStore: { getMeta: async () => mockMeta },
    depositToVault: (...a: unknown[]) => mockDeposit(...a),
    withdrawFromVault: (...a: unknown[]) => mockWithdraw(...a),
    isVaultEnabled: () => mockVaultEnabled,
    isBackupPushEnabled: async () => mockBackupOn,
    getOnline: async () => true,
    estimateRelockFee: () => 3080,
    R1C_LOCK_LEN: () => 27881,
    VAULT_DEPOSIT_MIN: 100_000,
    VAULT_MAX_KEYS: 5,
    haptics: { tap: jest.fn(), confirm: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() }
  }
})
jest.mock('expo-router', () => ({ router: mockRouter, useLocalSearchParams: () => mockParams, useFocusEffect: () => {} }))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/AlertCard', () => ({ showAlert: (...a: unknown[]) => mockShowAlert(...a) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: (...a: unknown[]) => mockShowToast(...a) }))
jest.mock('../../ui/components/wallet/AmountInput', () => {
  const React = require('react')
  const { TextInput } = require('react-native')
  return {
    SEND_MAX_VALUE: '2099999999999999',
    AmountInput: ({ value, onChangeText }: any) => React.createElement(TextInput, { testID: 'amount', value, onChangeText })
  }
})
jest.mock('../../ui/components/wallet/AmountDisplay', () => {
  const React = require('react')
  const { Text } = require('react-native')
  return { __esModule: true, default: ({ children }: any) => React.createElement(Text, null, `${children} sats`) }
})
jest.mock('../../ui/hooks/useVaultBalance', () => ({
  useVaultBalance: () => ({ balance: mockBalance, loading: false, refresh: mockRefresh })
}))

import { VaultTransferScreen } from '../../ui/screens/VaultTransferScreen'
import { VaultError } from '../../core/services/vault/types'

const PUB = (c: string) => '02' + c.repeat(64)
const key = (n: number, nickname: string, c: string) => ({
  serial: `1234000${n}`,
  slot: 0x82,
  pubkey: PUB(c),
  nickname,
  enrolledAt: 1_700_000_000_000 + n
})
const META = { v: 5, createdAt: 1, lastUsedSerial: '12340002', keys: [key(1, 'Desk', 'a'), key(2, 'Safe', 'b')] }
const OK_RESULT = { txid: 'tx', cappedInputs: 0, unreachable: { count: 0, satoshis: 0, keys: [] } }

const settle = async () => {
  await act(async () => {
    await new Promise(r => setImmediate(r))
  })
}

async function renderTransfer(direction: 'deposit' | 'withdraw') {
  mockParams = { direction }
  const screen = render(<VaultTransferScreen />)
  await settle()
  return screen
}

async function typeAndRun(screen: ReturnType<typeof render>, amount: string, cta: string) {
  fireEvent.changeText(screen.getByTestId('amount'), amount)
  await act(async () => fireEvent.press(screen.getByText(cta)))
  await settle()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMeta = META
  mockBalance = 0
  mockVaultEnabled = true
  mockBackupOn = true
  mockDeposit.mockReset().mockResolvedValue({ txid: 'd' })
  mockWithdraw.mockReset().mockResolvedValue(OK_RESULT)
  mockShowAlert.mockReset()
  mockWallet = {
    managers: { permissionsManager: { createAction: jest.fn() } },
    adminOriginator: 'admin.test',
    storage: null,
    settings: { currency: 'BSV' }
  }
})

describe('deposit', () => {
  test('renders the floor and fee line', async () => {
    const screen = await renderTransfer('deposit')
    expect(
      screen.getByText('vault_floor_line:{"floorDisplay":"100,000 sats","floorSats":"100,000","feeDisplay":"3,080 sats"}')
    ).toBeTruthy()
    expect(screen.getByText('vault_deposit_sub')).toBeTruthy()
    expect(screen.queryByText('vault_choose_key')).toBeNull()
  })

  test('the CTA is inert below the floor', async () => {
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '99999', 'vault_deposit_cta')
    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockShowAlert).not.toHaveBeenCalled()
  })

  test('a first deposit confirms with the key names, then deposits without a reason string', async () => {
    mockShowAlert.mockResolvedValueOnce('deposit')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vault_first_deposit_title',
        message: 'vault_first_deposit_body:{"amount":"150,000 sats","count":2,"names":"Desk · …0001, Safe · …0002"}'
      })
    )
    expect(mockDeposit).toHaveBeenCalledTimes(1)
    expect(mockDeposit.mock.calls[0].slice(0, 3)).toEqual([mockWallet.managers.permissionsManager, 'admin.test', 150000])
    expect(mockDeposit.mock.calls[0]).toHaveLength(4)
    expect(mockShowToast).toHaveBeenCalledWith('vault_deposit_done', { type: 'success' })
    expect(mockRefresh).toHaveBeenCalled()
    expect(mockRouter.back).toHaveBeenCalled()
  })

  test('cancelling the first-deposit confirm deposits nothing', async () => {
    mockShowAlert.mockResolvedValueOnce('cancel')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  test('a later deposit skips the confirm', async () => {
    mockBalance = 500_000
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockDeposit).toHaveBeenCalledTimes(1)
  })

  test('backup off: the alert with the settings CTA, no deposit', async () => {
    mockBackupOn = false
    mockShowAlert.mockResolvedValueOnce('settings')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'vault_backup_off_title', message: 'vault_backup_off_body' })
    )
    expect(mockRouter.push).toHaveBeenCalledWith('/wallet-config')
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  test('the service refusing with backup-off lands on the same alert', async () => {
    mockBalance = 500_000
    mockDeposit.mockRejectedValueOnce(new VaultError('backup-off'))
    mockShowAlert.mockResolvedValueOnce('cancel')
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(expect.objectContaining({ title: 'vault_backup_off_title' }))
  })

  test('flag off: not-released copy inline and an inert CTA', async () => {
    mockVaultEnabled = false
    const screen = await renderTransfer('deposit')
    expect(screen.getByText('vault_not_released_body')).toBeTruthy()
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(mockDeposit).not.toHaveBeenCalled()
  })

  test('a service error shows its copy inline', async () => {
    mockBalance = 500_000
    mockDeposit.mockRejectedValueOnce(new VaultError('requires-online'))
    const screen = await renderTransfer('deposit')
    await typeAndRun(screen, '150000', 'vault_deposit_cta')
    expect(screen.getByText('vault_err_requires_online')).toBeTruthy()
  })
})

describe('withdraw', () => {
  test('shows the key chooser with the last-used key selected', async () => {
    mockBalance = 500_000
    const screen = await renderTransfer('withdraw')
    expect(screen.getByText('vault_choose_key')).toBeTruthy()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios[1].props.accessibilityState).toEqual({ selected: true })
  })

  test('passes the chosen serial to withdrawFromVault, and follows a change of choice', async () => {
    mockBalance = 500_000
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(mockWithdraw).toHaveBeenCalledTimes(1)
    expect(mockWithdraw.mock.calls[0].slice(0, 5)).toEqual([
      mockWallet.managers.permissionsManager,
      'admin.test',
      50000,
      'vault_withdraw_reason:{"amount":50000}',
      '12340002'
    ])
    expect(mockShowToast).toHaveBeenCalledWith('vault_withdraw_done', { type: 'success' })

    mockRouter.back.mockClear()
    fireEvent.press(screen.getByText('Desk · …0001'))
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(mockWithdraw.mock.calls[1][4]).toBe('12340001')
  })

  test('a remainder below the floor confirms; Withdraw everything runs with all', async () => {
    mockBalance = 150_000
    mockShowAlert.mockResolvedValueOnce('all')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '80000', 'vault_withdraw_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vault_remainder_title',
        message: 'vault_remainder_body:{"amount":"80,000 sats","remainder":"70,000 sats"}'
      })
    )
    expect(mockShowAlert.mock.calls[0][0].buttons.map((b: any) => b.text)).toEqual(['vault_remainder_all', 'vault_remainder_change'])
    expect(mockWithdraw.mock.calls[0][2]).toBe('all')
    expect(mockWithdraw.mock.calls[0][3]).toBe('vault_withdraw_reason:{"amount":150000}')
  })

  test('Change amount on the remainder confirm withdraws nothing', async () => {
    mockBalance = 150_000
    mockShowAlert.mockResolvedValueOnce('change')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '80000', 'vault_withdraw_cta')
    expect(mockWithdraw).not.toHaveBeenCalled()
  })

  test('a remainder at or above the floor needs no confirm', async () => {
    mockBalance = 200_000
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '100000', 'vault_withdraw_cta')
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockWithdraw.mock.calls[0][2]).toBe(100000)
  })

  test('unreachable outputs produce an alert after the transfer, naming the keys', async () => {
    mockBalance = 500_000
    mockWithdraw.mockResolvedValueOnce({
      txid: 'tx',
      cappedInputs: 0,
      unreachable: { count: 2, satoshis: 120_000, keys: [{ serial: '12340001', pubkey: PUB('a') }] }
    })
    mockShowAlert.mockResolvedValueOnce('ok')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'vault_unreachable_title',
        message:
          'vault_unreachable_body:{"moved":"50,000 sats","count":2,"amount":"120,000 sats","names":"Desk · …0001"}'
      })
    )
    expect(mockShowToast).not.toHaveBeenCalledWith('vault_withdraw_done', expect.anything())
    expect(mockRouter.back).toHaveBeenCalled()
  })

  test('a capped withdrawal alerts with the remaining count', async () => {
    mockBalance = 5_000_000
    mockWithdraw.mockResolvedValueOnce({ ...OK_RESULT, cappedInputs: 7 })
    mockShowAlert.mockResolvedValueOnce('ok')
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '4000000', 'vault_withdraw_cta')
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'vault_withdraw_done', message: 'vault_withdraw_partial:{"count":7}' })
    )
  })

  test('serial-mismatch names the tapped and the chosen key when details carries both serials', async () => {
    mockBalance = 500_000
    const err = new VaultError('serial-mismatch') as VaultError & { details?: unknown }
    err.details = { tapped: '12340001', chosen: '12340002' }
    mockWithdraw.mockRejectedValueOnce(err)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(
      screen.getByText('vault_err_serial_mismatch_chosen:{"tappedName":"Desk · …0001","chosenName":"Safe · …0002"}')
    ).toBeTruthy()
  })

  test('serial-mismatch for an unknown card lists the vault keys', async () => {
    mockBalance = 500_000
    const err = new VaultError('serial-mismatch') as VaultError & { details?: unknown }
    err.details = { tapped: '99999999', chosen: '12340002' }
    mockWithdraw.mockRejectedValueOnce(err)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '50000', 'vault_withdraw_cta')
    expect(screen.getByText('vault_err_serial_mismatch:{"names":"Desk · …0001, Safe · …0002"}')).toBeTruthy()
  })

  test('key-cannot-cover uses reachable/total from the error details when present', async () => {
    mockBalance = 500_000
    const err = new VaultError('key-cannot-cover') as VaultError & { details?: unknown }
    err.details = { reachable: 200_000, total: 500_000 }
    mockWithdraw.mockRejectedValueOnce(err)
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '300000', 'vault_withdraw_cta')
    expect(
      screen.getByText(
        'vault_err_key_cannot_cover:{"nickname":"Safe · …0002","reachable":"200,000 sats","total":"500,000 sats","otherNames":"Desk · …0001"}'
      )
    ).toBeTruthy()
  })

  test('key-cannot-cover without details degrades to amount-exceeds-balance', async () => {
    mockBalance = 500_000
    mockWithdraw.mockRejectedValueOnce(new VaultError('key-cannot-cover'))
    const screen = await renderTransfer('withdraw')
    await typeAndRun(screen, '300000', 'vault_withdraw_cta')
    expect(screen.getByText('vault_err_amount_exceeds_balance')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run — expect failures against the old screen**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultTransferScreen.test.tsx
```
Expected: every test fails — the old screen renders no floor line and no chooser, calls `depositToVault` with a reason string as the 4th argument, and calls `withdrawFromVault` without a serial (`Unable to find an element with text: vault_floor_line…`, `expect(received).toEqual(expected)` on the argument lists).

- [ ] **Step 3: Rewrite the screen**

Replace the entire contents of `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/VaultTransferScreen.tsx` with:

```tsx
/**
 * Vault deposit / withdraw — full screen, not a drawer. Spec §4.1 / §4.2.
 *
 * Direction comes from the `direction` search param ('deposit' | 'withdraw').
 *
 * Deposit needs no hardware: the wallet builds an R1C output committed to every
 * enrolled key and broadcasts it (depositToVault). The screen shows the floor
 * and the fee inline, confirms the FIRST deposit into an empty vault, and
 * refuses while the encrypted backup is off — every deposit's salt lives only
 * in this wallet's database (D13).
 *
 * Withdraw asks which key will be tapped BEFORE anything runs (the NFC sheet is
 * modal), confirms when the remainder would fall under the vault floor, and
 * reports what did NOT move afterwards as alerts rather than toasts: outputs
 * the chosen key cannot open, and outputs left behind by the input cap.
 *
 * Lazy wallet creation is the Vault screen's job (its Deposit button); with no
 * built wallet the CTA here is simply inert.
 */
import React, { useCallback, useContext, useEffect, useState } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, TouchableOpacity } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AmountInput, SEND_MAX_VALUE } from '../components/wallet/AmountInput'
import PressableScale from '../components/ui/PressableScale'
import AmountDisplay from '../components/wallet/AmountDisplay'
import { showToast } from '../components/ui/Toast'
import { showAlert } from '../components/ui/AlertCard'
import { KeyChooser, vaultKeyLabel } from '../components/vault/KeyChooser'
import { vaultErrorCopy, type VaultErrorParams } from '../components/vault/vaultErrorCopy'
import { useVaultBalance } from '../hooks/useVaultBalance'
import {
  useTheme,
  spacing,
  radii,
  typography,
  useWallet,
  ExchangeRateContext,
  formatAmount,
  vaultStore,
  depositToVault,
  withdrawFromVault,
  VAULT_DEPOSIT_MIN,
  VAULT_MAX_KEYS,
  estimateRelockFee,
  R1C_LOCK_LEN,
  isVaultEnabled,
  isBackupPushEnabled,
  type VaultWallet,
  type VaultMeta,
  type VaultSpendResult,
  getOnline,
  VaultError,
  haptics,
  i18n
} from '@bsv/expo-wallet-toolbox'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. `useLocalSearchParams` is a hook, but
 * calling it via `loadExpoRouter().useLocalSearchParams()` is the exact same
 * function reference on every render, which is what the rules of hooks
 * actually require (a stable, unconditional call per render).
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

/**
 * Optional structured details services attach to a VaultError per the
 * DECISION: `key-cannot-cover` → `{ reachable, total }` (what the chosen key
 * can reach and the vault's total); `serial-mismatch` → `{ tapped, chosen }`
 * (both serials, so the sheet can say "That's X — you chose Y"). Read
 * structurally so this file depends on no service type; when absent the copy
 * degrades per vaultErrorCopy.
 */
function readErrorDetails(e: unknown): { reachable?: number; total?: number; tapped?: string; chosen?: string } {
  const details = (e as { details?: unknown } | null)?.details
  if (!details || typeof details !== 'object') return {}
  const d = details as Record<string, unknown>
  return {
    reachable: typeof d.reachable === 'number' ? d.reachable : undefined,
    total: typeof d.total === 'number' ? d.total : undefined,
    tapped: typeof d.tapped === 'string' ? d.tapped : undefined,
    chosen: typeof d.chosen === 'string' ? d.chosen : undefined
  }
}

export function VaultTransferScreen() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router, useLocalSearchParams } = loadExpoRouter()
  const Ionicons = loadIonicons()
  const { direction } = useLocalSearchParams<{ direction?: string }>()
  const { managers, adminOriginator, storage, settings } = useWallet()
  const { satoshisPerUSD, usdToFiat = {} } = useContext(ExchangeRateContext)
  const { balance, refresh } = useVaultBalance()
  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [amount, setAmount] = useState('')
  const [chosenSerial, setChosenSerial] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isDeposit = direction !== 'withdraw'
  const isMax = amount === SEND_MAX_VALUE
  const released = isVaultEnabled()
  const pm = managers?.permissionsManager
  const currency = settings?.currency || 'BSV'
  const fmt = useCallback(
    (sats: number) => formatAmount(sats, currency, satoshisPerUSD, { usdToFiat }),
    [currency, satoshisPerUSD, usdToFiat]
  )

  useEffect(() => {
    let alive = true
    void vaultStore.getMeta().then(m => {
      if (!alive) return
      setMeta(m)
      if (!m || m.keys.length === 0) return
      // Default to the key used last; a removed serial falls back to the first.
      const lastUsed = m.keys.find(k => k.serial === m.lastUsedSerial)
      setChosenSerial((lastUsed ?? m.keys[0]).serial)
    })
    return () => {
      alive = false
    }
  }, [])

  const keys = meta?.keys ?? []
  const chosen = keys.find(k => k.serial === chosenSerial)
  const allNames = keys.map(vaultKeyLabel).join(', ')

  // The lock's own size at the toolbox rate, plus its 10 % margin. The funding
  // input adds ~15 sat on top; "about" is the right word for the copy.
  const depositFee = estimateRelockFee(0, R1C_LOCK_LEN(Math.min(VAULT_MAX_KEYS, Math.max(1, keys.length))))

  const sats = parseInt(amount, 10)
  const validAmount = isDeposit
    ? Number.isFinite(sats) && sats >= VAULT_DEPOSIT_MIN
    : isMax || (Number.isFinite(sats) && sats > 0)
  const canRun = validAmount && !busy && !!pm && (isDeposit ? released : chosen !== undefined)

  /** `nickname · …tail4` for each referenced key; a key no longer in meta shows its pubkey tail. */
  const namesFor = useCallback(
    (refs: { serial?: string; pubkey: string }[]): string =>
      refs
        .map(r => {
          const rec = keys.find(k => (r.serial !== undefined && k.serial === r.serial) || k.pubkey === r.pubkey)
          return rec ? vaultKeyLabel(rec) : `…${r.pubkey.slice(-4)}`
        })
        .join(', '),
    [keys]
  )

  const backupOffAlert = useCallback(async () => {
    haptics.error()
    const choice = await showAlert({
      title: t('vault_backup_off_title'),
      message: t('vault_backup_off_body'),
      buttons: [
        { text: t('vault_backup_off_cta'), key: 'settings' },
        { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
      ]
    })
    // push (not replace) keeps this screen on the stack so the user can come
    // back and retry the deposit after switching backup on.
    if (choice === 'settings') router.push('/wallet-config')
  }, [router])

  /** Everything vaultErrorCopy can name for this screen's errors. */
  const errorParams = useCallback(
    (e: unknown): VaultErrorParams => {
      const details = readErrorDetails(e)
      // The DECISION: serial-mismatch carries { tapped, chosen } in
      // VaultError.details, not in message — details.tapped is only ever an
      // enrolled serial (or absent), so a lookup miss degrades to undefined
      // exactly like every other missing param.
      const tapped = details.tapped ? keys.find(k => k.serial === details.tapped) : undefined
      const others = keys.filter(k => k.serial !== chosenSerial)
      return {
        nickname: chosen ? vaultKeyLabel(chosen) : undefined,
        chosenName: chosen ? vaultKeyLabel(chosen) : undefined,
        tappedName: tapped ? vaultKeyLabel(tapped) : undefined,
        otherNames: others.length ? others.map(vaultKeyLabel).join(', ') : undefined,
        names: allNames || undefined,
        reachable: details.reachable !== undefined ? fmt(details.reachable) : undefined,
        total: details.total !== undefined ? fmt(details.total) : undefined,
        count: e instanceof VaultError ? e.retriesLeft : undefined
      }
    },
    [keys, chosen, chosenSerial, allNames, fmt]
  )

  const run = useCallback(async () => {
    if (!pm || !canRun) return
    const w = pm as unknown as VaultWallet
    const total = balance ?? 0
    setError(null)
    try {
      if (isDeposit) {
        // D13 first: the salt of this deposit will live only in this wallet's
        // database, so an unbacked wallet must not create it.
        if (!(await isBackupPushEnabled())) {
          await backupOffAlert()
          return
        }
        // The first deposit is the moment the recovery model becomes real
        // money: say it once, with the names of the keys that hold it.
        if (total === 0) {
          const choice = await showAlert({
            title: t('vault_first_deposit_title'),
            message: t('vault_first_deposit_body', { amount: fmt(sats), count: keys.length, names: allNames }),
            buttons: [
              { text: t('vault_deposit_cta'), key: 'deposit' },
              { text: t('vault_cancel'), key: 'cancel', style: 'cancel' }
            ]
          })
          if (choice !== 'deposit') return
        }
        setBusy(true)
        await depositToVault(w, adminOriginator, sats, { isOnline: getOnline })
        // The success toast carries the success haptic (Toast.tsx).
        showToast(t('vault_deposit_done'), { type: 'success' })
      } else {
        if (!chosen) return
        let withdrawAll = isMax
        // Remainder rule (spec §4.2 step 4): a leftover under the floor cannot
        // be re-vaulted, so the whole vault would move. Say so before running.
        if (!withdrawAll && total - sats > 0 && total - sats < VAULT_DEPOSIT_MIN) {
          const choice = await showAlert({
            title: t('vault_remainder_title'),
            message: t('vault_remainder_body', { amount: fmt(sats), remainder: fmt(total - sats) }),
            buttons: [
              { text: t('vault_remainder_all'), key: 'all' },
              { text: t('vault_remainder_change'), key: 'change', style: 'cancel' }
            ]
          })
          if (choice !== 'all') return
          withdrawAll = true
        }
        setBusy(true)
        const result: VaultSpendResult = await withdrawFromVault(
          w,
          adminOriginator,
          withdrawAll ? 'all' : sats,
          t('vault_withdraw_reason', { amount: withdrawAll ? total : sats }),
          chosen.serial,
          {
            // Lets the reservation heal find the reserving transaction with one
            // indexed query instead of paging every action in the wallet.
            findSpendingReferences: storage ? outpoints => storage.findSpendingReferences(outpoints) : undefined,
            isOnline: getOnline
          }
        )
        // Alerts, not toasts, for what did NOT move (spec §4.2 step 8): the
        // user has to act on both, and a toast can be missed.
        const moved = withdrawAll ? Math.max(0, total - result.unreachable.satoshis) : sats
        let reported = false
        if (result.unreachable.count > 0) {
          reported = true
          await showAlert({
            title: t('vault_unreachable_title'),
            message: t('vault_unreachable_body', {
              moved: fmt(moved),
              count: result.unreachable.count,
              amount: fmt(result.unreachable.satoshis),
              names: namesFor(result.unreachable.keys)
            }),
            buttons: [{ text: t('vault_ok'), key: 'ok' }]
          })
        }
        if (result.cappedInputs > 0) {
          reported = true
          await showAlert({
            title: t('vault_withdraw_done'),
            message: t('vault_withdraw_partial', { count: result.cappedInputs }),
            buttons: [{ text: t('vault_ok'), key: 'ok' }]
          })
        }
        if (!reported) showToast(t('vault_withdraw_done'), { type: 'success' })
      }
      setAmount('')
      refresh()
      router.back()
    } catch (e) {
      console.error('[vault] transfer failed:', e instanceof Error ? e.message : e, e)
      const code = e instanceof VaultError ? e.code : undefined
      if (code === 'backup-off') {
        await backupOffAlert()
        return
      }
      haptics.error()
      setError(vaultErrorCopy(code, errorParams(e)))
    } finally {
      setBusy(false)
    }
  }, [pm, canRun, balance, isDeposit, isMax, sats, keys.length, allNames, chosen, adminOriginator, storage, fmt, namesFor, backupOffAlert, errorParams, refresh, router])

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>
          {isDeposit ? t('vault_deposit_title') : t('vault_withdraw_title')}
        </Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.balanceBlock}>
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>{t('vault_balance_label')}</Text>
          <Text style={[styles.balance, { color: colors.textPrimary }]}>
            <AmountDisplay>{balance ?? 0}</AmountDisplay>
          </Text>
        </View>

        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {isDeposit ? t('vault_deposit_sub') : t('vault_withdraw_sub')}
        </Text>

        {!isDeposit && keys.length > 0 && (
          <View style={styles.chooser}>
            <Text style={[styles.chooserLabel, { color: colors.textPrimary }]}>{t('vault_choose_key')}</Text>
            <KeyChooser keys={keys} selected={chosenSerial} onSelect={setChosenSerial} />
          </View>
        )}

        <AmountInput value={amount} onChangeText={setAmount} showMax={!isDeposit} maxLabelKey="entire_vault_balance" />

        {isDeposit && (
          <Text style={[styles.floor, { color: colors.textSecondary }]}>
            {t('vault_floor_line', {
              floorDisplay: fmt(VAULT_DEPOSIT_MIN),
              floorSats: VAULT_DEPOSIT_MIN.toLocaleString('en-US'),
              feeDisplay: fmt(depositFee)
            })}
          </Text>
        )}

        {isDeposit && !released && (
          <Text style={[styles.floor, { color: colors.textSecondary }]}>{t('vault_not_released_body')}</Text>
        )}

        {error && <Text style={[styles.err, { color: colors.error }]}>{error}</Text>}

        <PressableScale
          haptic="confirm"
          onPress={canRun ? () => void run() : undefined}
          accessibilityState={{ disabled: !canRun }}
          style={[
            styles.primary,
            { backgroundColor: canRun ? colors.accent : colors.backgroundElevated, opacity: busy ? 0.6 : 1 }
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.textOnAccent} />
          ) : (
            <Text style={[styles.primaryLabel, { color: canRun ? colors.textOnAccent : colors.textTertiary }]}>
              {isDeposit ? t('vault_deposit_cta') : t('vault_withdraw_cta')}
            </Text>
          )}
        </PressableScale>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...typography.headline },
  body: { padding: spacing.xl, gap: spacing.lg },
  balanceBlock: { alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.md },
  balanceLabel: { ...typography.footnote, textTransform: 'uppercase' },
  balance: { ...typography.title1, fontVariant: ['tabular-nums'] },
  sub: { ...typography.subhead, textAlign: 'center' },
  chooser: { gap: spacing.sm },
  chooserLabel: { ...typography.headline },
  floor: { ...typography.footnote, textAlign: 'center' },
  err: { ...typography.footnote, textAlign: 'center' },
  primary: { borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline }
})
```

- [ ] **Step 4: Run — expect PASS**

```
npx jest packages/expo-wallet-toolbox/__tests__/ui/vaultTransferScreen.test.tsx
```
Expected: `Tests: 20 passed`.

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'VaultTransferScreen'
```
Expected: empty. The only remaining `tsc` errors in the package should now be in `ui/screens/VaultRecoverScreen.tsx` (deleted in Task 10).

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/screens/VaultTransferScreen.tsx packages/expo-wallet-toolbox/__tests__/ui/vaultTransferScreen.test.tsx && git commit -m "feat(expo-wallet-toolbox)!: vault transfer screen for key-chosen withdrawals

Deposit: inline floor and fee, first-deposit confirm naming the keys,
backup-off alert, not-released copy, hardware-free depositToVault.
Withdraw: key chooser defaulting to the last-used key, remainder confirm,
withdrawFromVault with the chosen serial, post-transfer alerts for
unreachable and capped outputs, and error copy through vaultErrorCopy.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Deletions, route, barrel exports, README rows, dead i18n keys

**Files:**
- Delete: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/VaultRecoverScreen.tsx`, `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/PassphraseField.tsx`, `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/components/vault/PhraseBackupSheet.tsx`, `/Users/personal/git/bsv-wallet/app/vault-recover.tsx`
- Modify: `/Users/personal/git/bsv-wallet/app/_layout.tsx` (line 174)
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/index.ts` (lines 111–125)
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/README.md` (line 291), `/Users/personal/git/bsv-wallet/README.md` (lines 117, 129)
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/core/i18n/translations.tsx` (54 dead keys × 12 locales, plus their `en` comment headers)
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts` (existing; must pass), every `__tests__/ui/*` file (must pass), `tsc` (must be clean).

**Interfaces:** `ui/index.ts` drops `PassphraseField`, `PassphraseFieldProps`, `PhraseBackupSheet`, `VaultRecoverScreen`; adds `KeyChooser`, `vaultKeyLabel`, `vaultErrorCopy`, `RETRYABLE_VAULT_ERRORS`, `type VaultErrorParams`, `useExportWalletData`, `useVaultCoverage`. Nothing else in the package imports the deleted files (verified: `grep -rl 'PassphraseField\|PhraseBackupSheet\|VaultRecoverScreen' packages/expo-wallet-toolbox/__tests__ app scripts` → only `app/vault-recover.tsx`, deleted here).

The dead keys were derived by grepping every `vault_*` key of the `en` block against `ui/`, `core/`, `app/` and `scripts/` with word boundaries, excluding `translations.tsx` and the seven files Tasks 6–9 rewrite or this task deletes, then removing from the remainder every key the rewritten files reference. Kept although they look K1-era: `vault_shares_unavailable` and `vault_shares_word_count` (used by `app/auth/mnemonic.tsx:311–312`), `vault_locked` (VaultContext), `vault_ok`/`vault_mock_toggle`/`vault_on`/`vault_off` (WalletConfigScreen), `vault_row_title` (SettingsScreen), `vault_reclaim_done` (legacy reclaim, spec §5.2), `vault_err_slot_occupied` / `vault_err_pin_required` / `vault_err_no_transaction` (codes still in the union, mapped by Task 2), `vault_nfc_enroll_message` (consumed directly by `EnrollWizard.tsx`, Task 6, as `enrollKey`'s `nfcMessage` argument — NOT dead).

- [ ] **Step 1: Delete the phrase-era files and the route stub**

```
git rm packages/expo-wallet-toolbox/ui/screens/VaultRecoverScreen.tsx packages/expo-wallet-toolbox/ui/components/vault/PassphraseField.tsx packages/expo-wallet-toolbox/ui/components/vault/PhraseBackupSheet.tsx app/vault-recover.tsx
```

- [ ] **Step 2: Remove the route registration**

In `/Users/personal/git/bsv-wallet/app/_layout.tsx` delete line 174:
```tsx
                            <Stack.Screen name="vault-recover" />
```
(`<Stack.Screen name="vault" />` and `<Stack.Screen name="vault-transfer" />` stay.)

- [ ] **Step 3: Update the `ui` barrel**

In `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/index.ts` replace lines 111–125:
```ts
// Vault UI (components/vault) + vault screens (Task 23 — extracted from
// app/vault.tsx, app/vault-recover.tsx, app/vault-transfer.tsx). Also home
// to VaultCeremonySheet, mounted at the app-shell level (app/_layout.tsx)
// alongside PermissionSheet/ToastHost above.
export { EnrollWizard } from './components/vault/EnrollWizard'
export { PassphraseField, type PassphraseFieldProps } from './components/vault/PassphraseField'
export { PhraseBackupSheet } from './components/vault/PhraseBackupSheet'
export { BackupReminderSheet } from './components/wallet/BackupReminderSheet'
export { BiometricAdvisoryModal } from './components/wallet/BiometricAdvisoryModal'
export { ImportFromBackupPrompt } from './components/wallet/ImportFromBackupPrompt'
export { VaultCeremonySheet } from './components/vault/VaultCeremonySheet'
export { useVaultBalance } from './hooks/useVaultBalance'
export { VaultScreen } from './screens/VaultScreen'
export { VaultRecoverScreen } from './screens/VaultRecoverScreen'
export { VaultTransferScreen } from './screens/VaultTransferScreen'
```
with:
```ts
// Vault UI (components/vault) + vault screens (app/vault.tsx,
// app/vault-transfer.tsx). Also home to VaultCeremonySheet, mounted at the
// app-shell level (app/_layout.tsx) alongside PermissionSheet/ToastHost above.
// The 1-of-N YubiKey vault has no phrase path: PassphraseField,
// PhraseBackupSheet and VaultRecoverScreen are gone (spec §3.5).
export { EnrollWizard } from './components/vault/EnrollWizard'
export { KeyChooser, vaultKeyLabel } from './components/vault/KeyChooser'
export { vaultErrorCopy, RETRYABLE_VAULT_ERRORS, type VaultErrorParams } from './components/vault/vaultErrorCopy'
export { BackupReminderSheet } from './components/wallet/BackupReminderSheet'
export { BiometricAdvisoryModal } from './components/wallet/BiometricAdvisoryModal'
export { ImportFromBackupPrompt } from './components/wallet/ImportFromBackupPrompt'
export { VaultCeremonySheet } from './components/vault/VaultCeremonySheet'
export { useVaultBalance } from './hooks/useVaultBalance'
export { useVaultCoverage } from './hooks/useVaultCoverage'
export { useExportWalletData } from './hooks/useExportWalletData'
export { VaultScreen } from './screens/VaultScreen'
export { VaultTransferScreen } from './screens/VaultTransferScreen'
```

- [ ] **Step 4: README rows**

In `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/README.md` delete line 291:
```
| `VaultRecoverScreen` | `app/vault-recover.tsx` |
```

In `/Users/personal/git/bsv-wallet/README.md` delete line 117:
```
│   ├── vault-recover.tsx           #   Vault recovery flow
```
and change line 129 from
```
│   ├── vault/                  #   Enrollment wizard, ceremony sheet, passphrase field
```
to
```
│   ├── vault/                  #   Enrollment wizard, ceremony sheet, key chooser
```

- [ ] **Step 5: Delete the 54 dead keys from all twelve locales**

Write the scratch script `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/6c152a17-eafa-44af-829b-b3e1bd439710/scratchpad/drop-dead-vault-keys.js` (it is not committed):

```js
// Removes the dead vault keys from every locale of translations.tsx. Prettier
// keeps each entry on one line, or on two when it moved a long value to the
// next line (`key:\n  'value',`) — a string literal never spans more lines than
// that — so an entry ends at the first line that ends with a comma.
const fs = require('fs')
const path = 'packages/expo-wallet-toolbox/core/i18n/translations.tsx'
const dead = [
  'vault_key_serial',
  'vault_deposit_reason',
  'vault_enroll_title',
  'vault_enroll_intro',
  'vault_back',
  'vault_recover_legacy_label',
  'vault_recover_passphrase_label',
  'vault_recover_passphrase_help',
  'vault_recover_passphrase_placeholder',
  'vault_recover_wrong_passphrase',
  'vault_continue_setup',
  'vault_print_shares_cta',
  'vault_requires_mnemonic',
  'vault_passphrase_no_reset',
  'vault_err_bad_passphrase',
  'vault_err_bad_mnemonic',
  'vault_err_bad_derivation_index',
  'vault_enroll_phase_adopting',
  'vault_slot_in_use_title',
  'vault_slot_in_use_body',
  'vault_use_existing_key',
  'vault_unlocking',
  'vault_err_removed',
  'vault_err_unavailable',
  'vault_err_mgmt_key',
  'vault_recover_row',
  'vault_recover_title',
  'vault_recover_sub',
  'vault_recover_placeholder',
  'vault_recover_cta',
  'vault_recover_reason',
  'vault_recover_too_short',
  'vault_recover_failed',
  'vault_recovered_toast',
  'vault_backup_title',
  'vault_backup_intro',
  'vault_backup_phrase_title',
  'vault_backup_phrase_sub',
  'vault_backup_shares_title',
  'vault_backup_shares_sub',
  'vault_backup_attest_failed',
  'vault_backup_attest_failed_printed',
  'vault_phrase_title',
  'vault_phrase_intro',
  'vault_phrase_copy',
  'vault_phrase_copied',
  'vault_phrase_warning',
  'vault_phrase_attest',
  'vault_phrase_done',
  'vault_err_backup_required',
  'vault_deposit_blocked_title',
  'vault_deposit_blocked_message',
  'vault_deposit_blocked_cta',
  'vault_deposit_blocked_dismiss'
]
const lines = fs.readFileSync(path, 'utf8').split('\n')
const out = []
const removed = Object.fromEntries(dead.map(k => [k, 0]))
for (let i = 0; i < lines.length; i++) {
  const m = /^\s+([a-z_0-9]+):/.exec(lines[i])
  if (m && m[1] in removed) {
    removed[m[1]] += 1
    if (!/,\s*$/.test(lines[i])) i += 1 // value on the next line
    continue
  }
  out.push(lines[i])
}
fs.writeFileSync(path, out.join('\n'))
for (const [k, n] of Object.entries(removed)) console.log(`${k} ${n}`)
```

Run it from the repo root:
```
cd /Users/personal/git/bsv-wallet && node /private/tmp/claude-502/-Users-personal-git-bsv-wallet/6c152a17-eafa-44af-829b-b3e1bd439710/scratchpad/drop-dead-vault-keys.js
```
Expected: 54 lines, every one ending in ` 12` (each key removed exactly once per locale). A key printing fewer than 12 means a locale spells it differently — find it with `grep -n "<key>" packages/expo-wallet-toolbox/core/i18n/translations.tsx` and delete by hand; a key printing more than 12 means a non-vault key shares the name — impossible for these names, but re-check with the same grep before committing.

Then, in the `en` block only, delete the comment headers that introduced the removed entries (they are the only comments the script leaves orphaned; the other locales carry a single `// vault (machine-translated, needs native review)` header, which stays):
- the four lines beginning `// Recovery — there are exactly two paths, and the copy must not imply a third.` through `// seed-equivalent paper.`
- `// Passphrase step`
- the two lines `// Backup prerequisite — a vault with no recovery path is worse than no` / `// vault, so this step gates enrollment and deposits.`
- the two lines `// Recording the attestation is entirely local — a key derivation and a` / `// storage write — so neither message may blame the network.`
- the two lines `// The paper is real and correct here; only the record is missing. Say so,` / `// or the user reprints shares they already have.`
- `// Phrase reveal`
- `// Deposit gate`

Verify no live code references a removed key and that no removed key survives:
```
cd /Users/personal/git/bsv-wallet && for k in vault_key_serial vault_deposit_reason vault_enroll_title vault_enroll_intro vault_back vault_recover_legacy_label vault_recover_passphrase_label vault_recover_passphrase_help vault_recover_passphrase_placeholder vault_recover_wrong_passphrase vault_continue_setup vault_print_shares_cta vault_requires_mnemonic vault_passphrase_no_reset vault_err_bad_passphrase vault_err_bad_mnemonic vault_err_bad_derivation_index vault_enroll_phase_adopting vault_slot_in_use_title vault_slot_in_use_body vault_use_existing_key vault_unlocking vault_err_removed vault_err_unavailable vault_err_mgmt_key vault_recover_row vault_recover_title vault_recover_sub vault_recover_placeholder vault_recover_cta vault_recover_reason vault_recover_too_short vault_recover_failed vault_recovered_toast vault_backup_title vault_backup_intro vault_backup_phrase_title vault_backup_phrase_sub vault_backup_shares_title vault_backup_shares_sub vault_backup_attest_failed vault_backup_attest_failed_printed vault_phrase_title vault_phrase_intro vault_phrase_copy vault_phrase_copied vault_phrase_warning vault_phrase_attest vault_phrase_done vault_err_backup_required vault_deposit_blocked_title vault_deposit_blocked_message vault_deposit_blocked_cta vault_deposit_blocked_dismiss; do grep -rnE "(^|[^a-zA-Z0-9_])$k([^a-zA-Z0-9_]|$)" packages/expo-wallet-toolbox/ui packages/expo-wallet-toolbox/core app scripts && echo "STILL REFERENCED: $k"; done; echo done
```
Expected: only `done` — no `STILL REFERENCED` line (the loop prints nothing else because `translations.tsx` no longer contains the keys either).

- [ ] **Step 6: Run the parity test, every ui test, and tsc**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```
Expected: `Tests: 33 passed` — the key sets shrank by 54 in lockstep.

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui
```
Expected: every suite passes (the suites added in Tasks 2–9 plus the pre-existing ones).

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json
```
Expected: no output — the last residual (`VaultRecoverScreen.tsx`) is gone. If Plan 2 left any other residual, it is Plan 2's to fix, not this task's.

- [ ] **Step 7: Commit**

```
cd /Users/personal/git/bsv-wallet && git add -A app/_layout.tsx packages/expo-wallet-toolbox/ui/index.ts packages/expo-wallet-toolbox/README.md README.md packages/expo-wallet-toolbox/core/i18n/translations.tsx && git commit -m "feat(expo-wallet-toolbox)!: remove the phrase recovery screen, passphrase field and their copy

The 1-of-N vault has no passphrase and no phrase path (spec §3.5), so
VaultRecoverScreen, PassphraseField, PhraseBackupSheet and the
vault-recover route go, the ui barrel exports KeyChooser, vaultErrorCopy,
useExportWalletData and useVaultCoverage instead, and the 54 i18n keys
only that code used are deleted from all twelve locales.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Gate the home Vault button and the Settings row on `isVaultEnabled()`

**Files:**
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx` (import list line 73; the Vault destination, lines 1219–1226)
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx` (import line 4; rows lines 130–143)
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/walletHomeBackup.test.tsx` (barrel mock, after line 46)
- Test: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/walletHomeVaultGate.test.tsx`

**Interfaces:** Consumes `isVaultEnabled()` from the core barrel (Plan 2 Task 2). The Vault button keeps `router.push('/vault')` — enrolment needs no wallet, so it does not go through `destinationPress`.

- [ ] **Step 1: Write the failing test**

Create `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/walletHomeVaultGate.test.tsx`:

```tsx
/**
 * The vault's release gate (spec §5.5, D15): with `vaultEnabled` off the home
 * screen has no Vault destination and Settings has no Vault row, so no path
 * can enrol hardware or create a vault output; with it on, both appear and
 * push /vault directly (enrolment needs no wallet).
 *
 * The barrel mock mirrors walletHomeBackup.test.tsx — WalletHomeScreen pulls
 * in the whole wallet surface — plus `isVaultEnabled`.
 */
import React from 'react'
import { act, fireEvent, render } from '@testing-library/react-native'
import { WalletHomeScreen } from '../../ui/screens/WalletHomeScreen'
import { SettingsScreen } from '../../ui/screens/SettingsScreen'

const IDENTITY = '02' + 'a'.repeat(64)
const mockRouter = { push: jest.fn(), replace: jest.fn() }
let mockVaultEnabled = false
let mockWallet: any

jest.mock('@bsv/expo-wallet-toolbox', () => {
  const React = require('react')
  return {
    ...jest.requireActual('../../core/theme/tokens'),
    useTheme: () => ({ colors: {} }),
    useWallet: () => mockWallet,
    useLocalStorage: () => ({
      hasStoredIdentity: async () => true,
      createMnemonic: jest.fn(),
      getMnemonic: async () => 'synthetic stored phrase',
      getRecoveredKey: async () => null,
      secretsReady: true
    }),
    generateMnemonicWallet: jest.fn(),
    backupAttestation: jest.requireActual('../../core/services/vault/backupAttestation').backupAttestation,
    ExchangeRateContext: React.createContext({ satoshisPerUSD: 1000, usdToFiat: {} }),
    UserContext: React.createContext({ appName: 'Test Wallet' }),
    formatAmountParts: () => ({ integer: '0', fraction: '', unit: 'BSV' }),
    formatAmount: () => '0',
    formatSatoshisAsBsvDecimal: () => '0',
    TaskCreditInbox: { lastAttentionCount: 0 },
    TaskSendOffline: { lastStall: null },
    isBackupPushEnabled: async () => true,
    isVaultEnabled: () => mockVaultEnabled,
    arcUrlStorageKey: () => 'arc_url',
    arcApiTokenStorageKey: () => 'arc_token',
    DEFAULT_ARC_URLS: { main: '' },
    KNOWN_ARC_URLS: [],
    DISPLAY_CURRENCY_OPTIONS: [],
    DEFAULT_AUTO_APPROVE_THRESHOLD: 0,
    AUTO_APPROVE_STORAGE_KEY: 'auto_approve',
    ADVANCED_SETTINGS_EXPANDED_KEY: 'advanced',
    getBackupUrl: () => ''
  }
})
jest.mock('expo-router', () => ({
  router: mockRouter,
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect])
}))
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null, MaterialCommunityIcons: () => null }))
jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: jest.fn() }))
jest.mock('@bsv/wallet-toolbox-mobile', () => ({ sdk: { specOpWalletBalance: 'specOpWalletBalance' } }))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
jest.mock('../../ui/components/wallet/BackupReminderSheet', () => ({ BackupReminderSheet: () => null }))
jest.mock('../../ui/components/wallet/BiometricAdvisoryModal', () => ({ BiometricAdvisoryModal: () => null }))
jest.mock('../../ui/components/wallet/ImportFromBackupPrompt', () => ({ ImportFromBackupPrompt: () => null }))
jest.mock('../../ui/components/wallet/ActivityRow', () => () => null)
jest.mock('../../ui/components/security/WalletLockNotice', () => () => null)
jest.mock('../../ui/components/pay/OfflineNotice', () => () => null)
jest.mock('../../ui/hooks/useOnline', () => ({ useOnline: () => false }))
jest.mock('../../ui/hooks/useOfflineNoticeActions', () => ({ useOfflineNoticeActions: () => ({}) }))
jest.mock('../../ui/components/ui/Toast', () => ({ showToast: jest.fn() }))
jest.mock('../../ui/exportTransactions', () => ({ exportTransactionsAsCsv: jest.fn() }))
jest.mock('../../ui/components/ui/ScreenGradient', () => ({ __esModule: true, default: ({ children }: any) => children }))
jest.mock('../../ui/components/ui/ScrollFade', () => ({
  __esModule: true,
  default: () => null,
  sampleScreenGradient: () => '#000000'
}))
jest.mock('../../ui/components/ui/PressableScale', () => {
  const React = require('react')
  const { Pressable } = require('react-native')
  return ({ children, onPress, ...props }: any) => React.createElement(Pressable, { onPress, ...props }, children)
})
jest.mock('../../ui/components/ui/ListRow', () => {
  const React = require('react')
  const { Pressable, Text } = require('react-native')
  return { ListRow: ({ label, onPress }: any) => React.createElement(Pressable, { onPress }, React.createElement(Text, {}, label)) }
})
jest.mock('../../ui/components/ui/GroupedList', () => ({ GroupedSection: ({ children }: any) => children }))

beforeEach(() => {
  jest.clearAllMocks()
  mockVaultEnabled = false
  mockWallet = {
    managers: {
      permissionsManager: {
        getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY })),
        listOutputs: jest.fn(async () => ({ totalOutputs: 0 }))
      }
    },
    adminOriginator: 'admin.test',
    selectedNetwork: 'main',
    settings: {},
    storage: null,
    txStatusVersion: 0,
    walletUserId: null,
    walletBuilt: true,
    walletBuilding: false,
    buildWalletFromMnemonic: jest.fn()
  }
})

describe('WalletHomeScreen', () => {
  test('has no Vault destination while the flag is off', async () => {
    const screen = render(<WalletHomeScreen />)
    await act(async () => {})
    expect(screen.getByText('pay_direction_pay')).toBeTruthy()
    expect(screen.queryByText('wallet_vault')).toBeNull()
  })

  test('shows the Vault destination when the flag is on and pushes /vault directly', async () => {
    mockVaultEnabled = true
    const screen = render(<WalletHomeScreen />)
    await act(async () => {})
    await act(async () => fireEvent.press(screen.getByText('wallet_vault')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault')
  })
})

describe('SettingsScreen', () => {
  test('has no Vault row while the flag is off', async () => {
    const screen = render(<SettingsScreen />)
    await act(async () => {})
    expect(screen.getByText('payments')).toBeTruthy()
    expect(screen.queryByText('vault_row_title')).toBeNull()
  })

  test('shows the Vault row when the flag is on', async () => {
    mockVaultEnabled = true
    const screen = render(<SettingsScreen />)
    await act(async () => {})
    await act(async () => fireEvent.press(screen.getByText('vault_row_title')))
    expect(mockRouter.push).toHaveBeenCalledWith('/vault')
  })
})
```

- [ ] **Step 2: Run — expect the two "flag off" tests to fail**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/walletHomeVaultGate.test.tsx
```
Expected: `has no Vault destination while the flag is off` and `has no Vault row while the flag is off` fail (`expect(received).toBeNull()` — the button and the row render unconditionally today); the two "flag on" tests pass.

- [ ] **Step 3: Gate both surfaces**

In `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx`:

(a) In the barrel import, replace line 73
```ts
  backupAttestation,
```
with
```ts
  backupAttestation,
  isVaultEnabled,
```

(b) Replace the Vault destination (lines 1219–1226):
```tsx
          <PressableScale
            haptic="confirm"
            onPress={() => router.push('/vault')}
            style={[styles.dest, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
          >
            <MaterialCommunityIcons name="safe" size={19} color={colors.textPrimary} />
            <Text style={[styles.destLabel, { color: colors.textPrimary }]}>{t('wallet_vault')}</Text>
          </PressableScale>
```
with
```tsx
          {/* Release-gated (spec §5.5): no Vault destination until the host
              turns vaultEnabled on. Plain push, not destinationPress —
              enrolment needs no wallet, and the Vault screen's own Deposit
              button runs the lazy wallet-creation path when it comes to that. */}
          {isVaultEnabled() && (
            <PressableScale
              haptic="confirm"
              onPress={() => router.push('/vault')}
              style={[styles.dest, { backgroundColor: colors.surfaceRaised, borderColor: colors.surfaceRaisedBorder }]}
            >
              <MaterialCommunityIcons name="safe" size={19} color={colors.textPrimary} />
              <Text style={[styles.destLabel, { color: colors.textPrimary }]}>{t('wallet_vault')}</Text>
            </PressableScale>
          )}
```
(`isVaultEnabled()` reads module state installed once at app entry, so the `heroHeader` `useMemo` dependency list is unchanged.)

In `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx`:

(c) Replace line 4
```ts
import { useTheme, spacing, typography, useWallet } from '@bsv/expo-wallet-toolbox'
```
with
```ts
import { useTheme, spacing, typography, useWallet, isVaultEnabled } from '@bsv/expo-wallet-toolbox'
```

(d) Replace the Payments + Vault rows (lines 130–143):
```tsx
          <ListRow
            label={t('payments')}
            icon="swap-horizontal-outline"
            iconColor={colors.success}
            onPress={() => router.push('/pay')}
          />
          <ListRow
            label={t('vault_row_title')}
            icon="safe"
            iconFamily="material-community"
            iconColor="#30B0C7"
            onPress={() => router.push('/vault' as any)}
            isLast
          />
```
with
```tsx
          <ListRow
            label={t('payments')}
            icon="swap-horizontal-outline"
            iconColor={colors.success}
            onPress={() => router.push('/pay')}
            isLast={!isVaultEnabled()}
          />
          {/* Same release gate as the home screen's Vault destination (spec §5.5). */}
          {isVaultEnabled() && (
            <ListRow
              label={t('vault_row_title')}
              icon="safe"
              iconFamily="material-community"
              iconColor="#30B0C7"
              onPress={() => router.push('/vault' as any)}
              isLast
            />
          )}
```

(e) In `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/__tests__/ui/walletHomeBackup.test.tsx`, after line 46 (`    isBackupPushEnabled: async () => true,`) add:
```ts
    isVaultEnabled: () => true,
```

- [ ] **Step 4: Run both test files — expect PASS**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui/walletHomeVaultGate.test.tsx packages/expo-wallet-toolbox/__tests__/ui/walletHomeBackup.test.tsx
```
Expected: both suites pass (`walletHomeVaultGate`: 4 passed).

- [ ] **Step 5: Type-check and commit**

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json
```
Expected: clean.

```
cd /Users/personal/git/bsv-wallet && git add packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx packages/expo-wallet-toolbox/ui/screens/SettingsScreen.tsx packages/expo-wallet-toolbox/__tests__/ui/walletHomeBackup.test.tsx packages/expo-wallet-toolbox/__tests__/ui/walletHomeVaultGate.test.tsx && git commit -m "feat(expo-wallet-toolbox): gate the Vault button and Settings row on vaultEnabled

Both surfaces render only when isVaultEnabled() — the release gate of
spec §5.5 — and keep pushing /vault directly, since enrolment needs no
built wallet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Host wiring — `vaultEnabled` from `EXPO_PUBLIC_VAULT_ENABLED`, eas.json profiles, changelog, final verification

**Files:**
- Modify: `/Users/personal/git/bsv-wallet/app/_layout.tsx` (doc comment lines 37–51; `configureToolbox` call lines 52–53)
- Modify: `/Users/personal/git/bsv-wallet/eas.json` (`development` env lines 14–17; `dev-physical` env lines 22–25; `production` untouched)
- Modify: `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/CHANGELOG.md` (under `## 0.5.0`)
- Test: the full `__tests__/ui` and `__tests__/i18n` runs and `tsc`.

**Interfaces:** Consumes `ToolboxConfig.vaultEnabled?: boolean` (Plan 2 Task 2). No `process.env` read is added inside the package — the host reads it here, where Expo inlines `EXPO_PUBLIC_*`.

- [ ] **Step 1: Pass the flag from the host**

In `/Users/personal/git/bsv-wallet/app/_layout.tsx` replace lines 47–53:
```ts
 * backupUrl: null (no EXPO_PUBLIC_BACKUP_URL) disables backup entirely — that is
 * what a plain local `npm run ios` with no .env.local gets. The EAS development,
 * dev-physical and production profiles set it; preview-apk carries no env block
 * at all. See eas.json.
 */
configureToolbox({
  backupUrl: process.env.EXPO_PUBLIC_BACKUP_URL ?? null,
```
with
```ts
 * backupUrl: null (no EXPO_PUBLIC_BACKUP_URL) disables backup entirely — that is
 * what a plain local `npm run ios` with no .env.local gets. The EAS development,
 * dev-physical and production profiles set it; preview-apk carries no env block
 * at all. See eas.json.
 *
 * vaultEnabled: the YubiKey vault's release gate (its spec §0 / §5.5). Only
 * the literal string "true" turns it on. The development and dev-physical
 * profiles set EXPO_PUBLIC_VAULT_ENABLED; production omits it, so store builds
 * hide the vault until the device run and the mainnet proof are recorded.
 */
configureToolbox({
  backupUrl: process.env.EXPO_PUBLIC_BACKUP_URL ?? null,
  vaultEnabled: process.env.EXPO_PUBLIC_VAULT_ENABLED === 'true',
```

- [ ] **Step 2: Turn it on for the two dev profiles only**

In `/Users/personal/git/bsv-wallet/eas.json` replace lines 14–17 (`development.env`):
```json
      "env": {
        "RCT_USE_PREBUILT_RNCORE": "0",
        "EXPO_PUBLIC_BACKUP_URL": "https://backup.bsvblockchain.tech"
      }
```
with
```json
      "env": {
        "RCT_USE_PREBUILT_RNCORE": "0",
        "EXPO_PUBLIC_BACKUP_URL": "https://backup.bsvblockchain.tech",
        "EXPO_PUBLIC_VAULT_ENABLED": "true"
      }
```
and lines 22–25 (`dev-physical.env`) identically:
```json
      "env": {
        "RCT_USE_PREBUILT_RNCORE": "0",
        "EXPO_PUBLIC_BACKUP_URL": "https://backup.bsvblockchain.tech",
        "EXPO_PUBLIC_VAULT_ENABLED": "true"
      }
```
The `production` and `production-apk` profiles are not touched; `preview-apk` has no env block and stays that way. Verify:
```
cd /Users/personal/git/bsv-wallet && node -e "const e=require('./eas.json').build; console.log(['development','dev-physical','preview-apk','production'].map(p=>p+'='+(e[p].env?.EXPO_PUBLIC_VAULT_ENABLED??'unset')).join(' '))"
```
Expected: `development=true dev-physical=true preview-apk=unset production=unset`.

- [ ] **Step 3: Changelog**

In `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/CHANGELOG.md`, Plan 2's final task adds the `## 0.5.0` entry (services) directly above `## 0.4.0`. Add this subsection at the END of that `## 0.5.0` entry (immediately above the `## 0.4.0` line). If `## 0.5.0` does not exist yet because Plan 2 has not landed, insert `## 0.5.0` followed by a blank line above `## 0.4.0` first, then this block:

```md
### Vault UI (breaking)

- `EnrollWizard` is the sequential multi-key wizard (`mode: 'enroll' | 'add-key'`):
  intro with the acknowledgement and the backup-push gate, one card session per
  key with the PIN gathered before the tap, naming, Add another / Finish with
  two keys minimum, leave-confirm while keys are pending.
- `VaultScreen` shows the key list (`nickname · …serialTail4`), coverage badges,
  add / rename / remove (refused when a re-lock is needed first), the re-lock
  sheet, an **Export wallet data** row with its explainer, the footnote and
  disable-when-empty. Deposit runs the lazy wallet-creation path.
- `VaultTransferScreen` renders the deposit floor and fee inline, confirms the
  first deposit and a below-floor remainder, lets the user choose the key
  before a withdrawal, and reports unreachable and capped outputs as alerts.
- `VaultCeremonySheet` shows `Signed k of n` and the batch number between taps.
- New exports: `KeyChooser`, `vaultKeyLabel`, `vaultErrorCopy`,
  `RETRYABLE_VAULT_ERRORS`, `useExportWalletData`, `useVaultCoverage`.
- Removed exports: `PassphraseField`, `PhraseBackupSheet`, `VaultRecoverScreen`
  (there is no phrase path). Hosts must drop their `vault-recover` route.
- The home Vault button and the Settings Vault row render only when the host
  passes `vaultEnabled: true` to `configureToolbox`.
- i18n: the wizard, key-management, transfer-confirmation and error keys added
  in all twelve locales; the K1/passphrase-era keys removed.
```

- [ ] **Step 4: Final verification**

```
cd /Users/personal/git/bsv-wallet && npx jest packages/expo-wallet-toolbox/__tests__/ui packages/expo-wallet-toolbox/__tests__/i18n
```
Expected: every suite passes — including the ten suites this plan added (`vaultErrorCopy`, `useExportWalletData`, `useVaultCoverage`, `keyChooser`, `enrollWizard`, `vaultCeremonySheet`, `vaultScreen`, `vaultTransferScreen`, `walletHomeVaultGate`, and the modified `walletHomeBackup`) and `translationParity` at `33 passed`.

```
cd /Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox && npx tsc --noEmit -p tsconfig.json
```
Expected: no output.

```
cd /Users/personal/git/bsv-wallet && npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'app/_layout\|app/vault' ; echo "host tsc checked"
```
Expected: only `host tsc checked` (the host's `configureToolbox` call type-checks against `ToolboxConfig.vaultEnabled`; `app/vault-recover.tsx` no longer exists to fail).

```
cd /Users/personal/git/bsv-wallet && grep -rn 'process.env' packages/expo-wallet-toolbox/core packages/expo-wallet-toolbox/ui ; echo "no env reads in the package"
```
Expected: only `no env reads in the package`.

- [ ] **Step 5: Commit**

```
cd /Users/personal/git/bsv-wallet && git add app/_layout.tsx eas.json packages/expo-wallet-toolbox/CHANGELOG.md && git commit -m "feat(app): vaultEnabled from EXPO_PUBLIC_VAULT_ENABLED, on for dev profiles

The host reads the flag where Expo inlines EXPO_PUBLIC_* and passes it to
configureToolbox; development and dev-physical set it to true, production
omits it so store builds hide the vault until the release gate is met.
Records the 0.5.0 vault UI changes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage — every user-visible item in §3.3, §3.4, §4, §5.4 and §5.5, and the task that delivers it:**

| Spec item | Task |
|---|---|
| §3.3 intro copy, three bullets, acknowledgement checkbox gating Begin, backup-off routes to settings first (D13) | 6 |
| §3.3 key k title, PIN (and default-PIN change) before the tap, `pendingSerials` = meta ∪ pending, `key-already-enrolled` copy naming the key, "Set it up again" for a pending duplicate, `pin-locked` copy with Use a different YubiKey / Try again, session faults with Cancel / Try again, PIN errors back to the PIN field with retries | 6 |
| §3.3 naming ("Name this key", default `Key {{k}}`, hint), `nickname · …serialTail4` everywhere | 5, 6 |
| §3.3 more step (Add another / Finish, two keys minimum, `finalizeEnrollment`) | 6 |
| §3.3 leave-confirm with ≥ 1 pending; pending survives backgrounding | 6 (+ 8 hides the host chevron) |
| §3.4 coverage badges (not-yet-open / removed-key) and the Re-lock action | 4, 8 |
| §3.4 Add key (hidden at 5), done state "Re-lock now", re-lock reason naming existing keys | 6, 8 |
| §3.4 Remove key: refused at 2 (`last-keys`), refused with `relock-required` when `orphanedIfRemoved` reports the removal would orphan an output, confirmation "Remove and re-lock now / Remove only / Cancel" with the fee | 8 |
| §3.4 Rename | 8 |
| §3.4 Export wallet data row + explainer, shared handler with Settings | 3, 8 |
| §3.4 Disable vault only at zero balance, its copy | 1, 8 |
| §3.4 footnote always visible | 8 |
| §4.1 not-released / backup-off / inline floor+fee / CTA disabled below the floor / first-deposit confirm / deposit needs a built wallet (lazy creation behind Deposit) | 8, 9 |
| §4.2 step 1 key chooser defaulting to `lastUsedSerial`; step 4 remainder confirm; step 6 serial-mismatch copy naming tapped and chosen; step 8 post-transfer alerts (unreachable, capped) and per-input progress between batches | 2, 5, 7, 9 |
| §4.3 re-lock: chooser, one pass per tap while capped, stop with the unreachable alert, `too-small-to-relock` copy | 2, 8 |
| §4.4 one `vaultErrorCopy(code, params)` table over the whole union; model-dependent copy changes | 1, 2 |
| §5.4 UI list (wizard, VaultScreen states, VaultTransferScreen, VaultCeremonySheet, twelve locales, `vault_enroll_phase_pin-check` fix) | 1, 6, 7, 8, 9 |
| §5.5 flag gates the home button, the Settings row, the vault route's hero, deposit and re-lock; withdrawals never gated | 8, 9, 11, 12 |
| §5.3 UI deletions and the `_layout` entry; `ui/index.ts`; README rows; dead keys in the same commit as their code | 10 |
| Host wiring (`app/_layout.tsx`, `eas.json`), changelog | 12 |

**Owned by Plans 1–2, consumed here by contract name only:** `r1comb.ts` (`R1C_LOCK_LEN`), `types.ts` (`VaultErrorCode` union), `vaultStore` v5 (`getMeta`, `removeKey`, `renameKey`, `noteLastUsed`, `migrateLegacySeal` — called from `VaultProvider`, Plan 2), `VaultKeyService` (`enrollKey`, `finalizeEnrollment`, `addVaultKey`, `disableVault`, `VAULT_MIN_KEYS`, `VAULT_MAX_KEYS`, `EnrollPhase`), ceremony (`VaultSigner`, `CeremonyState.progress`, `requestVaultSigner`, `VAULT_INPUTS_PER_TAP`, the NFC alert text passed to `driver.start(message)` — including the `vault_nfc_enroll_message` string), transfers (`depositToVault`, `withdrawFromVault`, `relockVault`, `getVaultKeyCoverage`, `orphanedIfRemoved`, `getVaultBalance`, `estimateRelockFee`, `VaultSpendResult`, `VAULT_DEPOSIT_MIN`, `reclaimStagingOutputs` kept), `toolboxConfig` (`vaultEnabled`, `isVaultEnabled`), `devMock` (`setMockPresentKey`, `getMockPresentKey`), `core/index.ts` barrel changes, `CHANGELOG` 0.5.0 heading and package version bump.

**Decisions this plan made where the spec or contract left room (each is stated at its task):**
- `depositToVault` takes no reason string (contract), so `vault_deposit_reason` is dead and deleted in Task 10.
- `VaultError` carries `code`, `message`, `retriesLeft`, plus an optional structured `details` object per the DECISION (`serial-mismatch` → `{ tapped, chosen }`, `key-already-enrolled` → `{ serial }`, `key-cannot-cover` → `{ reachable, total }`). Task 6 reads the duplicate serial from `details.serial`, Task 9 reads the tapped serial from `details.tapped` (when it equals an enrolled serial) and `reachable`/`total` from `details`; all read `details` structurally (no import of a Plan 2 type), and all degrade to the param-free copy Task 2 pins when a service omits `details`.
- `VaultKeyCoverage` has no per-key counts — the not-yet-open badge still shows `stale` as its count with the missing keys' nicknames — but Remove no longer approximates from it: `orphanedIfRemoved(w, adminOriginator, key.pubkey)` (Plan 2 Task 11) checks the removal exactly, against each output's real committed-key set, and Remove is refused with `relock-required` only when that count is > 0.
- `EnrollWizard.onDone` carries no payload (contract), so the add-key done step has one CTA ("Re-lock now"), and `VaultScreen` diffs meta before/after to find the new key and opens the re-lock sheet only when the vault holds something.
- An enrolled vault with the flag off keeps the enrolled view with the creating actions inert (spec §5.5 "withdrawals of pre-existing outputs are never gated") rather than the not-enrolled hero.
- The deposit fee line uses `estimateRelockFee(0, R1C_LOCK_LEN(n))` (≈ 3,080 sat for two keys) — the toolbox's own arithmetic per §4.3 — not a literal 2,900.
- The DEV present-key selector's label is a DEV-only literal, following the existing hard-coded "Debugging" row in `WalletConfigScreen`; no i18n key was invented.
- The lazy wallet-creation path is repeated inside `VaultScreen` (from `WalletHomeScreen.tsx:268–298`) rather than lifted into a shared hook, which would have added a file outside this plan's file structure; a follow-up may lift it.

**No placeholders:** every step names its file, its exact edit or its complete file contents, the command to run and the expected result; every i18n key used is either pre-existing in `translations.tsx` (verified by grep) or added by Task 1; every imported symbol is in the Interface Contract, in Tasks 2–5 of this plan, or in a cited existing file.
