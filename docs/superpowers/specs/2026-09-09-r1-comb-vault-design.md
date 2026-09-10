# 1-of-N YubiKey Vault on the P-256 Comb Verifier — Design

**Date:** 2026-09-09
**Status:** Approved in conversation; revised after a five-lens adversarial review (70 findings,
all resolved below); pending written sign-off.
**Supersedes:** `2026-08-21-k1-vault-design.md` (K1-only vault) and, transitively,
`2026-08-15-r1k1-vault-design.md` (the 960 KB R1-K1 template).
**Evidence:** `docs/example-txs/spike/ANALYSIS.md` — verification-tagged dissection of the
29,584-byte testnet script this design builds on, plus the throwaway generators (`gen2.mjs`,
`unlock2.mjs`) that prototype the exact on-chain format below.

## Summary

Vault outputs are locked by a ~28 KB script that verifies a **NIST P-256 ECDSA signature in
Script** and accepts a signature from **any one of N enrolled YubiKeys** (N = 2..5). The
YubiKeys' PIV keys sign on-chain directly; nothing about the vault key ever exists on the phone.
There is **no seed, no passphrase, no K1 leg**. Losing a YubiKey is recovered by using another
enrolled one. Losing all of them loses the funds. Deposits need no hardware; a withdrawal is one
YubiKey tap.

Per output the lock bakes N `hash160` commitments to (salt ‖ signer's comb table); the unlocking
script reveals the table of whichever key signs. Outputs are unlinkable on-chain until spent.

Recovery needs **two** things: any enrolled YubiKey **and** this wallet's database (this phone, or
its encrypted backup), because each output's salt lives only in the wallet. This is the same
dependency every other output in this wallet already has; the vault makes it explicit and gates
deposits on backup being on.

## 0. Release gate (before the feature flag is turned on)

The script is known to be accepted by real nodes through one testnet spend (`4766…4b80`, block
1,755,177, a **version-1** transaction with one input). Everything else — the generalized layout,
version-2 relaxation, multi-input spends, mixed vault + P2PKH inputs — is proven only against the
`@bsv/sdk` 2.4.1 `Spend` interpreter (its Chronicle model is the SDK's, not a node's). A vault
output whose spend the network refuses is a funds-lock trap, so:

1. Spend-proof the **exact shipped template** (the same `r1comb.ts` the app runs) on **testnet**,
   then on **mainnet** with token amounts, recording every txid in this spec's changelog:
   - N = 2 lock; one spend per enrolled key; one 3-input spend; one spend mixing ≥ 1 vault input
     with ≥ 1 wallet-funded P2PKH input (withdraw slightly more than the vault inputs cover);
   - all spends as **version-2** transactions;
   - one **deliberately constructed** spend whose OP_PUSH_TX `s` fails `pushTxDerCheck` (grind
     the vault input's sequence until the predicate is false), broadcast as version 2 — this is
     the only way to prove the version-2 MINIMALDATA relaxation the design relies on (§1 D4);
   - first with a software P-256 key (`scripts/r1c-spend-proof.ts`), then from a dev build with
     two real YubiKeys, including a 32-input withdrawal on iOS NFC to pin the per-tap batch size
     (§4.2).
2. Only then set `vaultEnabled` (§5.6). While it is off the Vault button is hidden and the
   route shows "Not available yet"; no enrollment, deposit, re-vault or re-lock can happen.

Facts this design takes from the analysis and treats as settled once step 1 passes on mainnet:
Chronicle (SV Node 1.2.0) mainnet activation 2026-04-07 at block 943,816 (opcodes
`OP_2MUL`/`OP_RSHIFTNUM` live); version > 1 relaxes MINIMALDATA (SDK model). Resource use vs
documented policy (ANALYSIS.md §10): lock 27,956 B at N = 5 vs arcade `MaxScriptSizePolicy`
500,000 (5.6 %); executed ops ≈ 15,300 vs 1,000,000; largest numeric operand 352 B vs
`MaxScriptNumLengthPolicy` 10,000; peak stack ≈ 6 KB vs 100 MB; spend tx ≈ 2.6 KB per input vs
10 MB.

## 1. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Commit-to-table 1-of-N** (approach A): Q comb tables live in the unlocking script; the lock bakes N `hash160(salt ‖ canonical table)` commitments | Lock size independent of the key; keys hidden until spend; 25 B per extra key instead of 2.1 KB (approach B) |
| D2 | **No seed, no passphrase, no K1 leg.** All seed machinery deleted | The YubiKey is the key. The K1 leg's on-phone xprv exposure was the reason to leave K1 |
| D3 | **2 ≤ N ≤ 5 keys**, sequential wizard, Finish only after key 2 | One key = no recovery. Five caps wizard length and lock growth |
| D4 | **Withdrawals are version-2 transactions** (`createAction` arg `version: 2`) | Chronicle relaxes MINIMALDATA, LOW_S, CLEANSTACK, SIGPUSHONLY and NULLDUMMY for version > 1 in the SDK model; strict DER and STRICTENC stay on and are always satisfied by the assembled OP_PUSH_TX signature (s = 0 excepted, 2⁻²⁵⁶). That removes the script's only non-negligible intrinsic failure, a 2⁻¹⁶ MINIMALDATA abort in the OP_PUSH_TX serialisation loop. Opcodes are height-activated, not version-gated (the v1 fixture proves it) |
| D4b | **Keep `pushTxDerCheck` as a fail-closed pre-sign screen until §0's constructed case has a mainnet txid**, then drop it | The relaxation is verified only in the SDK. The screen is one hash of the preimage; a hit (2⁻¹⁶) is cleared by re-creating the action with a different sequence on the vault input |
| D5 | **No range checks on r, s, s⁻¹** ("hardened" header rejected). Third-party unlock malleability is accepted | Under version 2 the malleability surface is broad regardless (junk pushes, non-minimal encodings, `r + k·p·n`); range checks would not restore txid stability. Funds cannot be redirected — the P-256 signature covers the preimage. Consequence documented in §6 |
| D6 | **Touch policy `cached`, PIN policy `once`**; keys are always freshly generated (no adoption of an existing slot key) | One touch covers a batch of signatures within the card's 15 s window. iOS cannot read retired-slot occupancy, and an adopted key may carry touch `always`/`never`, breaking the one-tap flow |
| D7 | **`VAULT_DEPOSIT_MIN = 100_000` sat** | A 28 KB output costs ≈ 2,800–2,900 sat to create at 100 sat/kB (spend ≈ 260 sat); 100 k keeps creation under 3 % |
| D8 | **Whole sighash preimage in the unlocking script** | Lock is amount/locktime/sequence-agnostic and multi-input capable |
| D9 | **Template code lives in the toolbox** (`core/services/vault/r1comb.ts`), no `@bsv/templates` | `@bsv/templates` 1.10.x has only the 960 KB `R1K1Wallet` |
| D10 | **Deposits are hardware-free** | Only public keys are needed to build a lock |
| D11 | **Per-output random 32-byte salt; commit to every key enrolled at deposit time** | Unlinkable outputs; a spend reveals only the signing key's table |
| D12 | **Encodings stay minimal and deterministic** even though v2 does not require it | One canonical unlock per (tx, key); keeps v1 viable if ever needed |
| D13 | **Deposits require the encrypted wallet backup to be enabled** | The per-output salt exists only in the wallet DB; phone loss + backup off = funds gone with every key in hand |
| D14 | **The signing key is chosen in-app before the tap; the tap only verifies serial + PIN and signs precomputed digests** | Keeps the NFC session short and network-free; avoids holding the card through `listOutputs`/`createAction` |
| D15 | **The whole feature sits behind one host-config flag `vaultEnabled`** (default off) | Closes the funds-lock trap for every path that creates a vault output, and never lets a user enrol into a feature that cannot deposit |

### Non-goals

- Migrating K1 (`v: 3`) or R1-K1 outputs. Neither shipped; dev-device funds are test funds.
- Database-at-rest encryption. Vault UTXOs (outpoints, amounts, salts) remain visible in SQLite.
- Changing the main wallet's key handling. Publishing to `@bsv/templates`.
- Threshold (2-of-N) signing and per-output key tweaking (the card cannot sign for a tweaked key).

## 2. On-chain format

Curve: NIST P-256. `p`, `n`, `a = p − 3`, `b`, `G` as in ANALYSIS.md §2. Script numbers are BSV
little-endian sign-magnitude; "minimal scriptnum" = `BigNumber.toSm('little')`.

### 2.1 Comb table

For a point `P`, `table(P) = [T_j·P for j = 0..31]` with
`T_j = 2^215 + Σ_{k=0}^{4} (bit_k(j) ? +1 : −1)·2^(43k)`. Each entry is an affine point;
coordinates are emitted as minimal scriptnums: 33 B iff ≥ 2^255, 32 B for [2^247, 2^255), 31 B
for [2^239, 2^247), shorter below (≈ 22 % of keys have at least one sub-32-byte coordinate). The
G table is a module constant computed at load; a key's Q table is computed once per key and cached
in memory for the ceremony's lifetime (32 scalar multiplications; ≈ 50–90 ms on a laptop, device
figure to be measured in §0). It is never persisted — it is derivable from the pubkey.

### 2.2 Commitment

```
canonical(table) = le33(x_0) ‖ le33(y_0) ‖ … ‖ le33(x_31) ‖ le33(y_31)      (64 × 33 = 2,112 B)
commitment(Q, salt) = hash160(salt ‖ canonical(table(Q)))                      (20 B)
```

`le33(v)` = the value as exactly 33 little-endian bytes (what `OP_NUM2BIN 33` produces). Fixed
width makes the serialisation injective over integer values; hashing the raw variable-length
pushes does not (ANALYSIS.md §9.1 "Why each change", adv-review B4). `salt` is exactly 32 bytes
(app-enforced; the script hashes whatever length was committed).

### 2.3 Locking script

`buildLock({ commitments: hex20[] })`, 1 ≤ N ≤ 5, commitments in enrollment order (order is
informational — spending needs only the signer's salt and Q; the H5 chain accepts any match).
Layout (ANALYSIS.md §9.1):

| Region | Content | Bytes |
|---|---|---|
| H0 | `DUP HASH256 <00> CAT BIN2NUM SWAP TOALTSTACK` — e = LE(hash256(preimage)); preimage → alt | 8 |
| H1 | `<n> TOALTSTACK` · `s·s⁻¹ ≡ 1 (mod n)` NUMEQUALVERIFY · `u1 = e·s⁻¹`, `u2 = r·s⁻¹` · drop s, s⁻¹ | 68 |
| H2 | recode u2, u1: `DUP 2 MOD NOTIF <n> ADD ENDIF <2^258−1> ADD 2 DIV SWAP` ×2 | 156 |
| H3 | pushed `u2'`, `u1'` must equal the recomputed ones (`<68> PICK NUMEQUALVERIFY <66> PICK NUMEQUALVERIFY`) | 8 |
| H4 | 64 × `<64−m> PICK <33> NUM2BIN CAT` onto the salt → canonical bytes; `OP_HASH160` | 433 |
| H5 | N = 1: `<C0> EQUALVERIFY`. N ≥ 2: `(DUP <Ci> EQUAL SWAP)×(N−1) <C_{N−1}> EQUAL BOOLOR×(N−1) VERIFY` | 22 (N = 1); 25N − 2 (N ≥ 2) |
| G table | 64 pushes, `table(G)` | 2,136 |
| pre-loop | `<p> FROMALTSTACK DROP TOALTSTACK 1 1 0` (acc = Jacobian ∞; alt = [preimage, p]) | 40 |
| comb loop | 43 columns × (DOUBLE, ADD_Q, ADD_G) — **byte-identical to the fixture's loop** | 24,450 |
| tail | `Z ≠ 0 ∧ X ≡ r·Z² (mod p)` VERIFY; clear stack; OP_PUSH_TX: reverse hash → `e_k1`, `s = e_k1 + 2^248 mod n_k1`, low-S, DER with `r = Gx`, `‖ 41`, `<dummy pubkey> OP_CODESEPARATOR OP_CHECKSIG` | 534 |

Sizes: **27,855 B at N = 1; 27,831 + 25N B for N ≥ 2** → 27,881 / 27,906 / 27,931 / 27,956 for
N = 2..5. `R1C_LOCK_LEN(N)` is exact and asserted in tests. `bakedCommitments(lock)` parses H5
back into the N commitments (used at spend time, §4.2).

The dummy OP_PUSH_TX key is `d = 2^248·Gx⁻¹ mod n_k1` on secp256k1, public by construction; the
signature the script assembles is valid only for the in-script preimage, and `OP_CHECKSIG` over the
real preimage is what binds them. It is not a spend path.

### 2.4 Unlocking script

71 pushes, bottom → top, all minimal:

```
#0  r        full affine x of R = u1·G + u2·Q            (32/33 B; NOT the signature's r mod n)
#1  u2'      recode(r·s⁻¹ mod n)                          (33 B)
#2  u1'      recode(e·s⁻¹ mod n)                          (33 B)
#3..#66      x_0 y_0 … x_31 y_31 of table(Q)             (64 × ≤ 33 B)
#67 salt     32 raw bytes
#68 s, #69 s⁻¹ mod n                                      (32/33 B each)
#70 preimage 158 raw bytes (PUSHDATA1)
```

`recode(u) = ((u odd ? u : u + n) + 2^258 − 1) / 2`. Measured 2,494–2,516 B; hard maximum
2,539 B (every push at its largest encoding); **`R1C_UNLOCK_LEN = 2_560`** is the declared
`unlockingScriptLength` (the toolbox only rejects a spend longer than the declaration).

`r` is the full x-coordinate of `R` recomputed by the app from `(e, r_sig, s, Q)` (`x ≥ n` has
probability ≈ 2⁻¹²⁹; pushing `x mod n` would then fail the projective check).

### 2.5 Sighash preimage and signer digest

- Preimage = BIP143 preimage with **scriptCode = `01 ac`** (the subscript after the lock's
  `OP_CODESEPARATOR` is the single `OP_CHECKSIG`) and **scope `0x41`** (ALL | FORKID):
  `TransactionSignature.format({ …, subscript: Script.fromHex('ac'), scope: 0x41 })`.
- P-256 leg: the script uses `e = LE(hash256(preimage))`. An ECDSA signer reads its digest
  big-endian, so the app hands the YubiKey **`reverse(hash256(preimage))`** via `signEcdsa`
  (raw-digest signing on both platforms; the card returns DER, not low-S normalised).
- The app decodes `(r_sig, s)`, computes `s⁻¹ = s^(n−2) mod n`, recomputes `R`, and emits the
  pushes. High-S is accepted by the script; no normalisation.

### 2.6 Transaction rules and the version invariant

- **Withdrawals and re-locks pass `version: 2` in `createAction` args.** `@bsv/sdk` 2.4.1
  declares `CreateActionArgs.version` (default 1); the toolbox builds the signable transaction
  with `new Transaction(args.version, …)`, stores it, and later completes and broadcasts that same
  in-memory transaction — `signAction` accepts unlocking scripts only, never transaction bytes.
  Deposits stay at the default version 1.
- **Invariant the signatures depend on:** every preimage is computed from
  `Transaction.fromAtomicBEEF(created.signableTransaction.tx)` exactly as returned (version,
  locktime, inputs, sequences, outputs); the app asserts `tx.version === 2` **before** the first
  card signature (else `abortAction` + `VaultError('bad-version')`), and never sets
  `sequenceNumber` on a `spends[i]` entry. This holds because the toolbox serialises the same
  object for the signable BEEF and for broadcast, only inserting unlocking scripts in between.
- Sighash `0x41` only. Any sequence, any locktime, any input index, any number of inputs and
  outputs. Fee model unchanged (100 sat/kB); the 28 KB source script travels in `inputBEEF`/EF
  but is not fee-bearing.
- The toolbox re-runs `Spend` on every input **after** `processAction` has committed the
  transaction, so it is not a pre-commit gate; the app's own validation (§4.2 step 7) is.

### 2.7 customInstructions v4

Written on every vault output, read on every spend. JSON string (vault convention):

```json
{ "v": 4, "type": "R1C", "salt": "<64 hex>", "keys": ["<66 hex compressed P-256, lowercase>", "..."] }
```

`keys` = the pubkeys whose commitments the lock bakes, in commitment order (informational). Pubkeys
per output — not key IDs into meta — keep an output self-describing after keys are added, removed
or renamed. ≤ 4096 chars (5 keys ≈ 450). `decodeVaultInstructions` fails closed on anything else
(v3 `K1` records are rejected). Balance and coin selection count **only** decodable v4 outputs;
undecodable outputs in the basket are ignored everywhere, including the zero-balance check for
Disable.

## 3. Key material and custody

### 3.1 Per YubiKey

PIV slot `0x82`, P-256, **always freshly generated** with `generateVaultKey(0x82, 'cached',
'once')` (both native mappings accept these strings). Whatever the slot held before is replaced,
and the key step says so ("Anything already stored in this YubiKey's vault slot will be
replaced"). iOS cannot read retired-slot occupancy, so this is also the only behaviour both
platforms can deliver. The natives return a 65-byte SEC1 point; the app **compresses it**
(`p256.Point.fromHex(...).toHex(true)`, lowercase) before recording, and all comparisons use that
canonical form. `signEcdsa` is PIN- and touch-gated; both natives verify the PIN inside every call.

### 3.2 Vault meta v5

```ts
interface VaultKeyRecord { serial: string; slot: 0x82; pubkey: string /* 33 B hex, lowercase */; nickname: string; enrolledAt: number }
interface VaultMetaV5 { v: 5; createdAt: number; lastUsedAt?: number; lastUsedSerial?: string; keys: VaultKeyRecord[] }
```

AsyncStorage `vault_meta_v1` (key name unchanged; `getMeta` returns null unless `v === 5`, so a
device holding a v4 record shows "not enrolled"). `isEnrolled()` becomes meta-only. The SecureStore
`vault_seal_v1` entry is removed by an explicit `vaultStore.migrateLegacySeal()` called once from
`VaultProvider` mount; `getSeal` disappears from the ceremony store view.

### 3.3 Enrollment (sequential wizard)

Steps: `intro` → `key` (× k, with sub-states `pin`, `tap`, `name`, `error`) → `more` → `done`.
Nothing is persisted on the phone until Finish; cards are written as each key step completes.

1. **Intro.** Copy: what the vault is; "You need at least two YubiKeys"; "Keep them in
   different places — two keys stored together are one key"; "Keep the wallet's encrypted backup
   on — it holds the record of each deposit"; acknowledgement checkbox labelled *"I understand:
   only my YubiKeys open this vault. My recovery phrase does not. If I lose all of them, the money
   is gone."* Begin is enabled by the checkbox. If backup push is off, Begin routes to settings
   first (D13).
2. **Key k** (title "Key {{k}} of up to 5"). PIN entry (and default-PIN change when `123456`)
   **before** the tap. Then one card session: `getKeyInfo` → refuse if the serial is in
   `meta.keys` **or in this wizard's pending list** (`key-already-enrolled`: *"You've already
   added this YubiKey ({{nickname}}). Tap a different one."*; a pending duplicate additionally
   offers *"Set it up again"*, which regenerates and replaces the pending record) → refuse if
   `pinRetries === 0` (`pin-locked`) → `changePin`/`verifyPin` → `generateVaultKey` → compress
   the returned pubkey → pending record. On NFC a wrong PIN costs a full re-tap, so PIN errors
   return to the PIN sub-state with the retries count. Session faults (`session-failed`,
   `detached`, timeout) reject the step with **Cancel / Try again**; `withKeySession` is changed to
   reject on those events instead of waiting forever.
3. **Name** (optional): "Name this key", default "Key {{k}}", hint "e.g. Desk, Safe, Parents'
   house". Keys are shown everywhere as `{{nickname}} · …{{serialTail4}}`.
4. **More.** After key 2: "Add another key?" (up to 5) or **Finish**, which persists meta v5
   atomically.
5. **Leaving.** With ≥ 1 pending key, back/leave confirms: *"Leave set-up? The {{count}}
   YubiKey(s) you set up won't be saved yet. They keep their keys, so you can add them again in a
   minute."* Pending records (public data only) survive backgrounding within the session.
6. **PIN locked mid-wizard** (`pin-locked`): stay on key k, keep pending keys; copy *"This
   YubiKey's PIN is blocked. Unblock it with its PUK in Yubico Authenticator, or set up with a
   different YubiKey."* Buttons: Use a different YubiKey / Try again.

### 3.4 Managing keys (enrolled vault screen)

The screen loads `listOutputs({ basket, includeCustomInstructions: true, limit: 1000 })` and
compares each output's `keys` with the current `meta.keys` pubkeys. Whenever any output's set
differs (either direction) it shows a badge — *"{{count}} deposits not yet open to {{nickname}}"*
or *"{{count}} deposits still open to a removed key"* — and the **Re-lock** action (§4.3).

- **Add key** (disabled at 5; `addKey` throws `too-many-keys` defensively): the §3.3 key step,
  appended to `keys`. Done state: *"{{nickname}} can open deposits made from now on. Re-lock the
  vault so it can open everything."* [Re-lock now]. The re-lock sheet's reason line: *"Tap one of
  your existing keys ({{names}}) — not the one you just added."*
- **Remove key**: allowed only while ≥ 2 remain (`removeKey` at 2 throws `last-keys`) **and only
  if every vault output would still be committed to at least one remaining key**; otherwise
  refused with `relock-required` (*"Re-lock the vault first so your other keys can open every
  deposit."*). Confirmation: title *"Remove {{nickname}}?"*, body *"This stops the wallet using
  {{nickname}}. Money already in the vault stays openable by it until you re-lock (≈ {{fee}}
  sats)."*, buttons **Remove and re-lock now** (primary) / Remove only / Cancel. A removed serial
  is refused by the ceremony (`serial-mismatch`); on-chain the key can still spend the outputs it
  was committed to, which is why re-lock is the real revocation.
- **Rename**: nickname only.
- **Export wallet data**: replaces the old "Recover with phrase" row. Same action and label as
  the Settings row (`exportAllWalletDatabases(storage)` from `ui/exportDatabases.ts`, i18n
  `export_wallet_data`, `share-outline` icon, spinner while exporting) — the vault screen is where
  the user is thinking about recovery, so the export lives here too. Explainer beneath it:
  *"Every vault deposit carries a unique piece of data that is needed to open it, along with your
  YubiKeys. It is stored in this wallet's database. Keep the encrypted backup on, and export a copy
  of the wallet data after making deposits."*
- **Disable vault**: only when the decodable-v4 balance is zero; clears meta. Copy: *"This
  forgets the vault's key list on this phone. The keys stay on your YubiKeys."*
- Footnote under the key list, always visible: *"Only these keys open the vault. Your recovery
  phrase does not."*

### 3.5 Recovery model

Recovery needs **any enrolled YubiKey and this wallet's database** (this phone, its encrypted
backup — the backup log includes outputs and their `customInstructions`, hence the salts — or an
exported wallet database file). Neither alone recovers anything. There is no phrase, no
passphrase, no third path. The vault screen therefore offers **Export wallet data** in place of
the old phrase-recovery row (§3.4), and §7 includes restore-from-backup and import-exported-
database tests that end in a vault spend.

## 4. Flows

### 4.1 Deposit (no hardware)

1. `requireOnline`. Refuse unless `vaultEnabled` (`not-released`), unless backup push is on
   (`backup-off`: title *"Turn backup on first"*, body *"Each vault deposit has a one-time
   secret stored only in this wallet. If this phone is lost and backup is off, no YubiKey can open
   the vault."*, CTA *Open settings*), unless `meta.keys.length ≥ 2` (`not-enough-keys`,
   defensive — the wizard cannot persist fewer). The floor is rendered inline under the amount
   input in the display currency (*"Minimum deposit {{floorDisplay}} ({{floorSats}} sats).
   Creating a vault deposit costs about {{feeDisplay}}."*) with the CTA disabled below it;
   `below-dust` remains the defensive server-side error with the same copy.
2. First deposit into an empty vault confirms: *"First vault deposit — {{amount}} will be
   openable only with {{count}} YubiKeys ({{names}}). Your recovery phrase won't help."*
   [Deposit] / [Cancel].
3. `salt = randomBytes(32)`; `commitments = meta.keys.map(k => commitment(k.pubkey, salt))`;
   `lockingScript = buildLock({ commitments })`.
4. One `createAction`: output `{ satoshis, lockingScript, basket: 'admin vault', tags: ['vault'],
   customInstructions: v4 }`, labels `['vault', 'vault-deposit']` (the toolbox patch keys
   UTXO-pool suppression on that label), `randomizeOutputs: false`, `acceptDelayedBroadcast:
   false`. No staging transaction: the two-transaction deposit existed for a 960 KB script.
5. Deposits need a built wallet; the Vault screen itself does not. The Deposit button (not the
   Vault button) runs the lazy wallet-creation path (`ensureWalletExists`) when needed.

### 4.2 Withdraw (one tap per batch)

1. **Choose the key** in-app: a list of enrolled keys (default: `lastUsedSerial`). PIN entry.
2. `listOutputs({ basket: 'admin vault', include: 'entire transactions',
   includeCustomInstructions: true, limit: 1000 })`; decode v4; **filter** to outputs whose `keys`
   contain the chosen pubkey; **sort** largest first; **cap** at `VAULT_MAX_INPUTS` (32). For each
   selected output read its real lock from `list.BEEF` and require
   `commitment(chosenPubkey, salt) ∈ bakedCommitments(lock)` (else `key-not-committed`
   naming the outpoint — customInstructions are never trusted over the lock).
3. Amount checks against the chosen key's reachable total: none reachable → `key-not-committed`;
   `amount > reachable` while `reachable < total` → `key-cannot-cover` (*"{{nickname}} can open
   {{reachable}} of the {{total}} in the vault. Withdraw up to {{reachable}}, or use {{otherNames}}
   instead."*); `amount > selected` because of the cap → `too-many-inputs`.
4. Remainder rule is user-visible: if `0 < balance − amount < VAULT_DEPOSIT_MIN` the screen
   confirms before running: *"Withdrawing {{amount}} leaves {{remainder}}, which is below the
   100,000-sat vault minimum. The whole vault will move to your everyday balance."* [Withdraw
   everything] / [Change amount]. A remainder ≥ the floor is re-vaulted with a fresh salt committed
   to the **current** key set.
5. `createAction` with `version: 2`, `inputs: [{ outpoint, unlockingScriptLength: R1C_UNLOCK_LEN
   }]`, `inputBEEF`, `trustSelf: 'known'`, `acceptDelayedBroadcast: false`. Parse the signable
   transaction; assert version 2 (§2.6); compute every input's preimage and digest; run
   `pushTxDerCheck` on each (D4b) — on a hit, `abortAction` and re-create with `sequenceNumber`
   bumped on that vault input (loop bound 8).
6. **Tap** (ceremony `requestVaultSigner(reason, chosenSerial)`): `getKeyInfo` → serial must
   equal the chosen key (`serial-mismatch`: *"That's {{tappedName}}. You chose {{chosenName}} —
   tap it, or go back and choose {{tappedName}}."*; a tapped serial not in meta at all gets the
   same code with *"This YubiKey isn't one of this vault's keys ({{names}})."*) → `verifyPin` →
   `signEcdsa` for each digest of the batch. Batches: at most `VAULT_INPUTS_PER_TAP` digests per
   tap (provisional 16; pinned by the §0 device run against the 15 s touch cache and CoreNFC's
   60 s session), with the NFC alert text set per tap from JS (localised: *"Hold your YubiKey
   here to sign — batch {{b}} of {{n}}"*; enrollment passes *"Hold your YubiKey here to set it
   up"*). A mid-batch `touch-timeout` / `nfc-lost` / `key-removed-mid-op` keeps the
   `createAction` reservation and the signatures gathered so far, re-opens the session (serial
   and PIN re-checked) and **resumes at input k**; only a user cancel or a non-retryable error
   aborts (`abortAction`, release). Android USB is one session for the whole loop.
7. After the last batch, off-card: decode DER, `fullR`, build each 71-push unlock, validate every
   input locally with `Spend` **using explicit strict flags including MINIMALDATA** (honest unlocks
   are minimal, so this is strictly stronger than the node's v2 rules), then `signAction({
   reference, spends, options: { acceptDelayedBroadcast: true } })`. Past the point of no abort.
8. **Result**: `VaultSpendResult { txid, cappedInputs, unreachable: { count, satoshis, keys:
   {nickname, serialTail}[] } }`. The transfer screen shows an **alert after the transfer**, not a
   toast: *"Part of the vault needs another key — moved {{moved}}. {{count}} deposits holding
   {{amount}} can only be opened by {{names}}. Withdraw again with one of those keys."*; the cap
   case separately: *"{{count}} more deposits remain — withdraw again to move them."* The
   ceremony sheet shows per-input progress (`VaultProgress = { phase: 'preparing', signed?,
   total? }` — a conscious extension of the pinned `CeremonyState` key set) between batches and
   after the NFC sheet dismisses; it cannot render under the iOS system sheet.

### 4.3 Re-lock vault with all keys

A distinct spend mode, **not** `withdrawFromVault('all')` (whose remainder is zero and would sweep
the vault into the hot wallet): `relockVault(chosenSerial)` selects as in §4.2 steps 1–3
(`amount = 'all'`), then creates **one** output `{ satoshis: acc − feeEstimate, lockingScript:
buildLock(current keys, fresh salt), basket: 'admin vault', customInstructions: v4 }` and no
withdrawal. `feeEstimate` uses the toolbox's own arithmetic (`ceil(size / 1000) · 100` over
`R1C_UNLOCK_LEN` per input and the new lock) plus 10 %; any surplus becomes ordinary default-basket
change (folded into the fee when below dust). If `acc − feeEstimate < VAULT_DEPOSIT_MIN` the
re-lock is refused (`too-small-to-relock`: *"This vault holds less than 100,000 sats, which is too
small to re-lock. Withdraw it instead and deposit again."*). Runs one pass per tap while
`cappedInputs > 0`; stops and asks for another key when only `unreachable` outputs remain. Cost
≈ 2,900 sat per pass plus ≈ 260 sat per input. Test: default-basket balance changes by at most the
surplus.

### 4.4 Errors

New `VaultErrorCode`s: `not-released`, `backup-off`, `not-enough-keys` (defensive),
`key-already-enrolled`, `too-many-keys`, `last-keys`, `relock-required`, `key-not-committed`,
`key-cannot-cover`, `too-small-to-relock`, `bad-version`. Kept: `serial-mismatch` (card not the
chosen / not enrolled — copy can name keys), `wrong-key` (native fallback only, still reclassified
to `nfc-lost` on NFC dropouts), `mgmt-key-custom`, `pin-*`, `touch-timeout`, `nfc-lost`,
`key-removed-mid-op`, `too-many-inputs`, `below-dust` (now live), `requires-online`,
`user-cancelled`, `vault-empty`, `amount-exceeds-balance`, `template-invalid`. Removed:
`seal-corrupt`, `bad-passphrase`, `bad-mnemonic`, `bad-derivation-index`, `backup-required`,
`no-key` if unused after the driver change. The two copy tables (`VaultCeremonySheet`
`ERROR_COPY`, `translateVaultError`) merge into one `vaultErrorCopy(code, params)`.

Copy that must change with the model: `vault_hero_body` (needs two or more YubiKey 5 NFC),
`vault_deposit_sub` (*"From your everyday balance. No YubiKey needed."*), `vault_withdraw_sub`
(*"Back to your everyday balance. Tap any of your vault keys."*), `vault_key_section`
(*"Security keys ({{count}} of 5)"*), `vault_disable_message`, `vault_err_pin_locked` (withdraw:
*"This YubiKey's PIN is blocked. Use another of your vault keys, or unblock this one with its PUK
in Yubico Authenticator."*), `vault_err_wrong_key`.

## 5. Code changes

### 5.1 New

- `core/services/vault/r1comb.ts` — `combTable(P)`, `canonicalTableBytes`, `commitment`,
  `buildLock({commitments})`, `bakedCommitments(lock)`, `R1C_LOCK_LEN(n)`, `R1C_UNLOCK_LEN`,
  `sighashPreimage(tx, inputIndex, sourceSatoshis)` (subscript fixed to `ac`),
  `signerDigest(preimage)`, `pushTxDerCheck(preimage)` (D4b), `fullR(e, rSig, s, Q)`,
  `buildUnlock({ preimage, derSig, Q, salt })`, `encodeVaultInstructions` /
  `decodeVaultInstructions` (v4), `compressPubkey`. Pure; imports only `@bsv/sdk` and
  `@noble/curves`. Ported from `docs/example-txs/spike/gen2.mjs` + `unlock2.mjs`.
- `scripts/r1c-spend-proof.ts` — §0 proof with a software P-256 key (replaces
  `scripts/k1-spend-proof.ts`, which is deleted).

### 5.2 Modified

- `types.ts` — error codes (§4.4); `SealedBlob` removed.
- `vaultStore.ts` — meta v5; `isEnrolled` meta-only; `migrateLegacySeal`; `addKey`, `removeKey`,
  `renameKey`, `noteLastUsed`.
- `VaultKeyService.ts` — `enrollKey(pin, { pendingSerials }) → VaultKeyRecord` (one card, no
  persistence), `finalizeEnrollment(records[])`, `disableVault`. `recoverVaultHD`,
  `resealToNewKey`, the seed-zeroing choreography deleted.
- `session.ts` — `withKeySession` rejects on `session-failed` (→ `user-cancelled`/`no-key`),
  `detached` (→ `key-removed-mid-op`) and the attach timeout.
- `ceremony.ts` / `ceremonyHost.ts` — `VaultKeyHandle { hd }` becomes
  `VaultSigner { serial, pubkey, sign(digest32) → DER, release() }`; `requestVaultSigner(reason,
  chosenSerial)`; the serial check compares against the chosen key; the existing retryable-tap
  loop (`RETRYABLE_TAP_ERRORS`) is generalised to resume a signing batch; `VaultProgress` gains
  `signed`/`total`; `CeremonyState` pinned keys extended accordingly; `getSeal` removed from the
  store view. `VaultContext` is otherwise unchanged (`transfers.ts` obtains the signer from
  `ceremonyHost`, not the context).
- `driver.ts` — `generateVaultKey(slot)` passes `'cached', 'once'`; `start(message?)` forwards a
  localised NFC alert text; `ecdh` removed from `VaultDriver`. Native: `startDiscovery(message)`
  replaces the hardcoded English alert; optional `setSessionMessage(text)` if YubiKit exposes the
  active `NFCReaderSession.alertMessage` — otherwise the text is fixed per tap and progress is
  shown between taps only.
- `mockYubiKey.ts` / `devMock.ts` — per-serial records `{ priv, pub, pin, pinRetries,
  pinVerified, slotOccupied }` keyed by the current serial; `insertKey(serial)` switches; `ecdh`
  and the `softwareEcdh` import removed; a module-held instance with `setMockPresentKey(serial)`;
  the DEV wallet-config row gains a present-key selector (MOCK-DEV-1/2/3). Tests asserting
  `'always'` flip to `'cached'`; the ecdh/seal suites go.
- `transfers.ts` — deposit without ceremony (§4.1); withdraw with chosen key, filter → sort → cap,
  BEEF commitment check, batching, resume, strict local `Spend` (§4.2); `relockVault` (§4.3);
  `VAULT_DEPOSIT_MIN = 100_000`; `VAULT_INPUTS_PER_TAP`; `VaultSpendResult` extended; `VaultWallet`
  shrinks to `createAction / signAction / listOutputs / abortAction / listActions`.
  `sweepVaultWithHD` deleted. **`reclaimStagingOutputs`, `VAULT_STAGING_BASKET`, the staging codec
  and `StorageExpoSQLite.releaseVaultStagingStrandedByInvalidTx` are kept as legacy** (the code
  cites a 2026-08-21 production deposit failure and a 2026-08-22 device crash; whether any
  non-dev wallet ran the two-transaction deposit is unconfirmed) until the user confirms nothing
  is stranded, after which a follow-up removes them and `vault_reclaim_done`.
- `toolboxConfig.ts` — `vaultEnabled?: boolean` (default false) with `isVaultEnabled()`; read by
  the home screen, the vault route, deposit, re-vault and re-lock; injected via options in tests so
  `transfers.test.ts` stays config-free; host passes it from `EXPO_PUBLIC_VAULT_ENABLED` in
  `app/_layout.tsx` and `eas.json` profiles.
- `WalletHomeScreen.tsx` — the Vault button (already un-hidden in the working tree) renders only
  when `isVaultEnabled()`; it keeps plain `router.push('/vault')` (enrollment needs no wallet);
  `SettingsScreen`'s `/vault` row follows the same flag.
- Public barrels: `core/index.ts` drops `sealing`, `k1`, `vaultDerivation`, `vaultPassphrase`
  exports; `ui/index.ts` drops `PhraseBackupSheet`, `PassphraseField`, `VaultRecoverScreen`. This
  is a **breaking `@bsv/expo-wallet-toolbox` release (0.5.0)** with a changelog entry.

### 5.3 Deleted

`sealing.ts`, `vaultDerivation.ts`, `vaultPassphrase.ts`, `k1.ts`,
`ui/screens/VaultRecoverScreen.tsx`, `ui/components/vault/PassphraseField.tsx`,
`ui/components/vault/PhraseBackupSheet.tsx` (used only by the old wizard), `app/vault-recover.tsx`
and its `_layout` entry, `scripts/k1-spend-proof.ts`, the `backup-required` gate in
`transfers.ts` and its `VaultTransferScreen` branch, `EnrollWizard`'s attestation imports, and the
tests of the deleted modules. **`backupAttestation.ts` and its test stay** (used by
WalletHomeScreen, WalletCheckScreen, WalletContext, auth screens). Stale prose to fix: `guard.ts`
header, `WalletContext.tsx` vault comments, the Swift/Kotlin comments claiming `ALWAYS`.

### 5.4 UI

- `EnrollWizard` rewritten to §3.3.
- `VaultScreen`: keys list with badges, add / remove / rename / re-lock, balance, deposit /
  withdraw, **Export wallet data** row with its explainer (§3.4; the handler is lifted from
  `WalletConfigScreen.handleExportData` into a shared hook so both screens share it), footnote,
  disable. States: `vaultEnabled` off → hero with *"Not available yet — vault
  deposits are switched off in this release."* and a disabled CTA; driver unsupported → existing
  "Needs a YubiKey" notice; not enrolled → hero; enrolled → balance.
- `VaultTransferScreen`: key chooser (withdraw), floor/fee inline, remainder confirm,
  first-deposit confirm, `backup-off` alert, post-transfer alerts (§4.2 step 8).
- `VaultCeremonySheet`: per-batch progress; error copy via `vaultErrorCopy`.
- i18n: **all twelve locales** in `core/i18n/translations.tsx` (parity-tested). ≈ 65 new keys
  (≈ 780 strings) and ≈ 48 dead keys (backup/phrase steps, passphrase, recover screen, deposit
  gate, single-key strings) deleted in the same commit as the code they belong to; fix the
  `vault_enroll_phase_pin-check` key mismatch in passing.

### 5.5 Rollout switch

`vaultEnabled` (§5.2) gates the home button, the Settings row, the vault route's hero, deposit,
re-vault-on-withdraw and re-lock — every path that creates a vault output and every path that
enrols hardware. Withdrawals of pre-existing outputs are never gated. Default off; on for dev
builds; on in production only after §0.

## 6. Security model

**Kept / gained vs K1.** Signing keys never leave hardware; no key material in phone memory;
phone compromise cannot spend. No offline brute-force target. Every withdrawal needs PIN + physical
key presence; touch is cached for at most 15 s after a touch on the same card.

**Lost.** Losing every enrolled YubiKey loses the funds; the wallet phrase does not help. Losing
the wallet database with backup off loses the salts and therefore the funds even with the keys.
Both are stated on the intro screen, the vault screen and the first-deposit confirmation, and D13
refuses deposits while backup is off.

**On-chain.** No spend without a committed key: the commitment covers salt and all 64 coordinates
at fixed width; forging requires a `hash160` second preimage or an ECDSA forgery against Q. No
value of `r`, `s`, `s⁻¹` (zero, `n`, `p`, negatives, huge) passes without a valid signature
(ANALYSIS.md adv-review A–E; s = 0 fails H1, degenerate r fails the tail). Outputs are unlinkable
until spent; a spend reveals the signing key's table (hence Q); salts are per output so only the
spent output is linked. The dummy OP_PUSH_TX private key is public and grants nothing.

**Accepted (D5): third-party unlock malleability.** Under version 2 a relayer can rewrite a
valid unlock (sign flips, `s + k·n`, `r + k·p·n`, zero-padded numbers, junk pushes, trailing
no-ops) and the transaction confirms under a different txid. Funds go where the signer said; but
the wallet records the change output and any re-vaulted output under the original txid and has no
reconciliation for a confirmation under another — those outputs would be invisible to the wallet
until recovered by hand. This is accepted on the position that BSV relayers and miners do not
malleate in practice. If that position changes, the mitigation is the wallet-side reconciliation
(match confirmed transactions by input set and output scripts), not script range checks, which
cannot close the v2 surface.

**Residual risks.** (1) Node acceptance of the template, of version-2 relaxation and of
multi-input spends is proven only in the SDK until §0 runs — hence the flag and D4b. (2) The comb
loop has no special case for the accumulator hitting ±table point (Z becomes 0, spend fails);
≈ 2⁻²⁵⁰ per add; the app clears it by re-creating the action with a bumped sequence (fresh e,
fresh digits regardless of the card's nonce scheme). (3) A wrong `r` would fail on-chain; the app
validates every unlock locally before `signAction`. (4) Response-side `listOutputs` has no size
cap (known deferred item); 32 outputs ≈ 900 KB of BEEF.

## 7. Testing

Jest (`packages/expo-wallet-toolbox/__tests__/vault/`):

- **Golden**: `buildLock` for N = 1..5 → exact `R1C_LOCK_LEN(N)` and pinned sha256s; the shared
  suffix (G table → end) equals the fixture's chunks `[87..150] ++ [215..end]`
  (`docs/example-txs/51c5…_0.hex`); `bakedCommitments(buildLock(c)) == c`.
- **Round trip** through `Spend` (strict flags): random keys, N = 1..5, each member spends; 1–3
  vault inputs mixed with P2PKH inputs; version 2; random sequence / locktime / amounts; high-S
  and low-S; constructed `x ≥ n`; 31-byte coordinates; `pushTxDerCheck` agreement with the
  interpreter on constructed failing preimages under v1 strict flags.
- **Negative**: uncommitted key, wrong salt, tampered table, foreign signature, cross-input
  preimage, v1 transaction refused by `buildUnlock`, v3 customInstructions rejected.
- **Codec / store**: v4 encode/decode fail-closed; meta v5 round trip; v4 meta → not enrolled;
  `migrateLegacySeal` deletes the seal; balance ignores undecodable outputs.
- **Enrollment with the multi-key mock**: enrol 2 then 3 keys; same serial twice →
  `key-already-enrolled`; PIN lock mid-wizard keeps pending keys; session failure rejects the step;
  leave with pending keys persists nothing; Finish after 1 key impossible.
- **Transfers with the mock**: deposit commits to all keys; deposit refused when backup off /
  flag off / below floor; withdraw with key 2 selects only its outputs and reports `unreachable`;
  `key-cannot-cover`; filter-before-cap; BEEF commitment mismatch → `key-not-committed` before any
  signature; `version: 2` asserted on the signable tx; batch resume after a mocked `touch-timeout`
  at input k with the reservation kept; re-lock leaves default-basket balance unchanged (≤
  surplus), refuses below the floor, and after add/remove every output carries the current set;
  remove refused when it would orphan an output; remove refused at 2.
- **Restore**: restore a wallet from its backup log on a fresh store, then spend a vault output;
  import an exported wallet database file on a fresh install, then spend a vault output. The vault
  screen's export row renders and invokes `exportAllWalletDatabases`.

Device / network (§0): `scripts/r1c-spend-proof.ts` on testnet and mainnet including the
constructed peel-nonminimal v2 case and the mixed-input case; dev build with two YubiKeys; 32-input
withdrawal on iOS NFC to pin `VAULT_INPUTS_PER_TAP`. Record txids in the changelog.

## 8. Migration

None. K1 (`v: 3`) and R1-K1 outputs never reached production. A device with a v4 meta record shows
"not enrolled" and can enrol fresh; `migrateLegacySeal` removes the seal. **Sweep any dev device
holding K1 vault funds before installing this build** — the K1 sweep tooling is deleted with the
rest and the balance view will ignore v3 outputs.

## 9. Out of scope

Threshold (2-of-N) signing (two verifiers ≈ 55 KB; a later spec); per-output key tweaking;
response-side `listOutputs` caps; wallet-side reconciliation of malleated confirmations (§6).

## Changelog

- 2026-09-09 — initial version; D1–D12 approved in conversation.
- 2026-09-09 — revised after review: re-lock defined as its own spend mode; salt/backup dependency
  made explicit (D13); key chosen before the tap, batching and resume (D14); single feature flag
  (D15); no key adoption (D6); `pushTxDerCheck` kept until proven (D4b); version-2 mechanism and
  invariant pinned (§2.6); removal cannot orphan outputs; twelve locales; staging reclaim kept as
  legacy pending confirmation.
- 2026-09-09 — user review: vault screen gains an **Export wallet data** row (same action as
  Settings) with an explainer that each deposit carries unique data needed for recovery alongside
  the YubiKeys; replaces the old phrase-recovery row (§3.4, §3.5, §5.4, §7).
