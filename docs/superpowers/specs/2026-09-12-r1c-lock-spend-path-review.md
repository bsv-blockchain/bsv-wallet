# R1C Locking Script — Final Spend-Path Review

**Review date:** 2026-09-12 (analysis performed 2026-09-11/12)

**Reviewed revision:** `674a1dd168cbd8a476791636d9d51d57edaff8ee` (the committed tree; `r1comb.ts` last
changed in `fe03adf`). See §5 for uncommitted working-tree changes present when this was written.

**Method:** manual opcode-level trace of the script emitted by
`packages/expo-wallet-toolbox/core/services/vault/r1comb.ts`; read of the transfer, store, recovery,
backup, and UI gating paths; Jest at the reviewed revision; web check of Chronicle activation. No
source changes. Companion to `2026-09-11-r1c-vault-security-review.md`, which covers the wider
system; this document answers two narrower questions.

**Questions asked**

1. Are there any spend paths possible without having one of the registered YubiKeys?
2. Is there any situation in which the user has the wallet mnemonic, the backup wallet database, and
   one of the registered YubiKeys and still cannot spend their vault funds?

## Verdict

**Question 1: No.** Every accepting execution of the lock requires a valid P-256 ECDSA signature,
over the exact spending transaction, from a public key whose salted table hash is baked into that
output. The wallet mnemonic has no path; neither do the two public OP_PUSH_TX constants.

**Question 2: Yes.** Seven situations, none of them cryptographic. The most direct is that the
YubiKey PIN is a fourth secret that is never stored anywhere. The rest are recovery, state, and
release-gating limits of the app, several already listed as release blockers in the handoff.

## 1. Spend paths without a committed YubiKey

### 1.1 What the lock executes

The unlocking script at the reviewed revision is exactly 70 minimal pushes, bottom to top:
`r`, `recode(u2)`, `recode(u1)`, the 64 coordinates of `table(Q)`, `s`, `s⁻¹`, and the 158-byte
BIP143 preimage. The lock then runs one straight-line program. Every stage ends in a VERIFY or
feeds a later one; there is no OP_IF that skips a check.

| Stage | What runs | What it pins down |
| --- | --- | --- |
| Shape | `OP_DEPTH 70 OP_NUMEQUALVERIFY` | Exactly 70 items. The alt stack is fresh per script by interpreter rule, so `n` and `p` cannot be preloaded. |
| H0 | `preimage[0..4] == 01000000`; `e = BIN2NUM(HASH256(preimage) ‖ 00)`; preimage → alt | Transaction version 1. `e` is derived in-script from the same bytes OP_PUSH_TX will bind. |
| H1 | `1 ≤ s ≤ (n−1)/2`; `1 ≤ s⁻¹ < n`; `1 ≤ r < p`; `r ≠ n`; `s·s⁻¹ ≡ 1 (mod n)`; `u1 = e·s⁻¹`; `u2 = r·s⁻¹` | Canonical scalars. With `p < 2n`, `r = n` is the only in-range value with `r ≡ 0 (mod n)`; rejecting it, together with `r < p`, closes the CRT forgery (one residue for the scalar multiply, another for the x check). |
| H2/H3 | Recode `u2`, `u1` to 258 signed digits; `OP_NUMEQUALVERIFY` against the pushed recodings | The comb digits are a deterministic function of `(preimage, r, s⁻¹)`. The pushed copies exist only so the loop can reach them by depth. |
| H4 | Lock pushes its baked 32-byte salt; 64 × `OP_PICK 33 OP_NUM2BIN OP_CAT`; `OP_HASH160` | `HASH160(salt ‖ le33(x₀) ‖ le33(y₀) ‖ … ‖ le33(y₃₁))`. `OP_NUM2BIN` normalises encodings, so the hash fixes the table's integer values, including sign. |
| H5 | N = 1: `<C> OP_EQUALVERIFY`; N ≥ 2: `(OP_DUP <Cᵢ> OP_EQUAL OP_SWAP)×(N−1) <C_last> OP_EQUAL OP_BOOLOR×(N−1) OP_VERIFY` | The hash must equal one of the N baked commitments. Correct OR over N booleans. |
| Suffix | 64 baked `G`-table coordinates; push `p`, swap it for `n` on alt; accumulator `(1, 1, 0)` | The `G` table is part of the lock, not the witness. `parseBakedLock` regenerates the whole suffix byte for byte. |
| Comb | 43 columns of `DOUBLE`, then complete mixed add of `TQ[j₂]·±1`, then `TG[j₁]·±1` | Digit extraction by `OP_RSHIFTNUM 2 OP_MOD`, sign row XNOR'd into a 5-bit index, `y := p − y` for negative digits. The wrapper handles infinity, unequal add, equal (double), and inverse (infinity) explicitly. |
| Tail | `Z ≠ 0`; `X ≡ r·Z² (mod p)`; clear 135 items; OP_PUSH_TX; `OP_CODESEPARATOR OP_CHECKSIG` | Exact affine x equality: `r ∈ [1, p)` and `X ∈ [0, p)` are both reduced. OP_PUSH_TX builds `(Gx, lowS(e_k1 + C1))` for dummy key `d1 = C1·Gx⁻¹`, or `(Gx, 1)` for `d2 = C2·Gx⁻¹` when the first scalar is zero, appends `0x41`, and CHECKSIGs against scriptCode `ac`. |

The OP_PUSH_TX branch is total: `lowS((e + 2²⁴⁸) mod n_k1)` is never zero and the fallback exists
only for the single digest where it would be, so no probabilistic retry is part of spend
availability. The DER assembly reverses at most 32 bytes because low-S guarantees `s < 2²⁵⁵`, and a
minimal little-endian scriptnum reversed is exactly the DER positive-integer encoding, pad byte
included.

### 1.2 Why there is no bypass

- **One program, no alternate branch.** The only `OP_IF`s are inside the complete-addition wrapper,
  the projective x check (whose else-branch pushes `0` and fails), the low-S normalisation, and the
  dummy-key selection. None can skip the signature equation.
- **Signature bound to the transaction.** `e` comes from the pushed preimage; OP_PUSH_TX proves that
  preimage is the real SIGHASH_ALL|FORKID preimage of the spending input. No other sighash mode is
  reachable because the lock appends `0x41` itself. The preimage contains the outpoint, so a
  signature cannot be replayed against another output, including a duplicate-script output.
- **Q fixed by the lock.** The witness table must hash, with the baked salt, to a baked commitment.
  A different table needs a second preimage of a 20-byte HASH160 target, the same class of
  assumption as P2PKH. The honest depositor fixes the commitments; the attacker never chooses them.
- **G fixed by the lock.** A witness-supplied generator table would allow trivial forgery; the
  reviewed lock bakes it and re-derives it during parsing.
- **Complete group law.** Exceptional inputs (infinity, doubling, inverse) are handled explicitly, so
  the accumulator is always `u1·G + u2·Q`. The result is checked against the full affine x pushed as
  `r`, which is stricter than standard ECDSA's `R.x mod n`.
- **OP_PUSH_TX keys are public and last.** Both dummy private scalars are constants. They bind the
  preimage; they cannot authorise anything because every P-256 check has already passed by the time
  they run.
- **No wallet-key leg.** The lock contains no secp256k1 check against any wallet-derived key. The
  K1/seed path was deleted before this template shipped, and `types.ts` documents that no
  seed-derived spending authority exists.

### 1.3 Test evidence at the reviewed revision

`npx jest packages/expo-wallet-toolbox/__tests__/vault/r1comb.test.ts` — 176 of 176 passed.
Negative cases exercised: signature-free CRT forgery; an `r` representative shifted by `p·n`;
outsider key with its own table and the right salt; wrong baked salt; non-canonical `s`, `s⁻¹`, and
script-number encodings; manually encoded high-S; extra bottom and top pushes; an unlocking-script
NOP; version-2 transaction; missing pushes; preimage of another input; all four mixed-add cases
against noble's P-256.

### 1.4 Assumptions

- Hardness of P-256 ECDSA and second-preimage resistance of SHA-256 and RIPEMD-160.
- Consensus semantics of `OP_MUL`, `OP_MOD`, `OP_DIV`, `OP_RSHIFTNUM`, `OP_2MUL`, `OP_NUM2BIN`,
  `OP_SPLIT`/`OP_CAT`, and `OP_CODESEPARATOR` match the `@bsv/sdk` `Spend` interpreter used
  locally. The exact hardened bytes have never been mined; only the earlier 29,584-byte spike lock
  was, on testnet.
- The enrolled public keys are the YubiKeys' keys. Enrollment verifies Yubico attestation; a
  deliberately compromised app build is out of scope.

### 1.5 What "registered" means on-chain

- **Each output is 1-of-N over the key set at its creation.** A key added later cannot open earlier
  outputs until a re-lock. A removed key keeps on-chain authority over every output that committed to
  it until those outputs are re-locked; `transfers.ts` says so at the `relockVault` docstring
  ("the re-lock IS the revocation"). Removing a key in the app is metadata, not revocation.
- **YubiKey plus PIN is the whole credential.** Anyone holding both can spend from any software;
  the phone, the wallet database, and the mnemonic are not factors on-chain. A compromised phone can
  still have a presented, unlocked, display-less token sign an attacker-chosen digest.
- **The salt grants nothing.** It is public in the lock and provides script-hash separation only.

## 2. Mnemonic + backup database + one registered key, still cannot spend

Ordered by how directly the app refuses.

1. **PIN unknown or blocked.** PIN and PUK are chosen by the user in the enrollment wizard and are
   never persisted (`ui/components/vault/EnrollWizard.tsx` header; `VaultKeyService.ts`). The PIN
   is a fourth secret the mnemonic cannot derive. Three wrong attempts block it; the driver exposes
   `changePuk` but no unblock, so recovery needs the PUK plus external Yubico tooling.
   *Class: inherent to hardware-key custody; UX must say so.*
2. **Backup lacks the deposit.** Discovery is database-only. Metadata comes from output
   `customInstructions`; the source transaction must already sit in `proven_txs` or `proven_tx_reqs`
   (`core/storage/StorageExpoSQLite.ts`, `getProvenOrRawTx`, which does not consult
   `transactions.rawTx`). There is no network fallback; `core/storage/methods/listOutputsSql.ts`
   silently skips a transaction it cannot assemble, and the vault then throws `no-transaction`. The
   deposit gate checks that backup is *configured*, not that the record was uploaded (BACKUP-02).
   A phone lost before the push lands leaves an output the restored app cannot see.
   *Class: release blocker (handoff §Recovery).*
3. **Held signed deposit in the snapshot.** `reconcileHeldVaultDeposits` runs before every
   withdrawal; a `nosend` deposit with a txid throws `relock-required` ("needs manual broadcast-state
   reconciliation"), and any pending or failed action holding a vault output blocks likewise. The
   manual workflow does not exist yet. A backup taken between `signAction` and the `sendWith`
   confirmation leaves the restored wallet unable to withdraw anything through the app.
   *Class: release blocker (handoff §Signed-action operations).*
4. **Key not committed to the output.** Outputs created before this key was added, never re-locked
   since, fail selection with `key-not-committed`; the transfer reports them as `unreachable`.
   *Class: design-inherent; see §1.5.*
5. **Stale device-local metadata.** `recoverVaultMetaFromOutputs` returns early when SecureStore
   already holds a record (`transfers.ts`, `if (existing) return existing`). Outputs carrying a
   higher revision then fail `requireOutputMetaConsistency` ("newer than the local enrollment").
   iOS Keychain survives app reinstall, and nothing clears the entry except disabling an empty
   vault, so reinstall-on-same-device or a second device that added or renamed a key can hit this
   with no repair path. *Class: code gap.*
6. **Release flag off.** Both `/vault` entry points are hidden when `EXPO_PUBLIC_VAULT_ENABLED` is
   not `true` (`ui/screens/WalletHomeScreen.tsx`, `ui/screens/SettingsScreen.tsx`). Withdrawal of
   existing outputs is not gated by `requireReleased`, and `VaultScreen` renders an enrolled vault
   with the flag off, but there is no route to reach it. A store build with the flag off strands
   TestFlight depositors. *Class: gating gap.*
7. **Mainnet policy unproven for the exact bytes.** Chronicle opcodes are live on mainnet since block
   943,816 (2026-04-07), so `OP_RSHIFTNUM` and `OP_2MUL` availability is not a concern. Acceptance
   of the 45 KB lock, the 2.5 KB witness, and a 32-input BEEF of roughly 1.5 MB by the target
   node/miner and ARC policy has not been exercised, and the production TestFlight profile has the
   vault switched on. *Class: release blocker (handoff §Node, hardware, and native proof).*

Steps that are required but not blockers when the key and PIN are present: online state; the
recovered key must pass the live possession challenge (`adoptVaultKey`: serial match, PIN, slot
public key match, random-challenge signature), which withdrawal requires only for the chosen key
(deposits require two); a partial withdrawal needs backup configured, a full withdrawal does not;
more than 32 inputs takes several passes.

At the reviewed revision none of the seven is cryptographic. The outpoint, value, and lock bytes are
on chain, `Q` is readable from the card (`readVaultPublicKey`), and the salt is in the lock, so a
standalone tool holding the YubiKey and PIN can always construct a valid spend. See §5 for how the
working-tree change alters this.

## 3. Not verified

- Any physical YubiKey behaviour: NFC touch policy `cached`, PIN and PUK flows, attestation on real
  cards, iOS and Android transports. The §0 device gate remains open.
- Any broadcast of the exact hardened template to a mainnet or testnet node.
- Independent third-party review of the generated script.

## 4. Recommended follow-ups

1. A raw-recovery CLI built on `scripts/r1c-spend-proof.ts`: inputs are outpoint, source lock,
   value, the card, and the salt; output is a signed version-1 transaction. Covers situations 2, 3,
   5, and 6 without waiting for full clean-database discovery.
2. Let `recoverVaultMetaFromOutputs` replace a lower-revision local record when the higher-revision
   outputs verify byte-exactly, or expose an explicit "refresh from outputs" action.
3. Keep a `/vault` entry point reachable whenever local metadata or vault outputs exist, independent
   of the release flag.
4. Surface in the UI that the PIN is not backed up anywhere and that a blocked PIN needs the PUK.
5. Close handoff blockers 1–3 before enabling deposits in any production distribution.

## 5. Breaking salt-revealing template implemented after this review

After the reviewed revision, the template was changed to move the salt out of the lock and into
the witness. There is no migration or dual-template spend path:

- The unlocking script becomes 71 pushes; the salt is the top item, moved to alt in H0 and pulled
  back in H4 with an `OP_SIZE 32 OP_NUMEQUALVERIFY` check before the `HASH160`.
- The lock no longer contains the salt. Exact sizes become 45,199 bytes for N = 1 and
  `45,175 + 25N` for N = 2..5; the measured witness maximum becomes 2,539 under the unchanged
  `R1C_UNLOCK_LEN` declaration of 2,560; `bakedSalt` is removed and `buildUnlock` takes
  `saltHex64`.
- `verifyInstructionsAgainstLock` now rebuilds the whole lock from `customInstructions` and compares
  bytes instead of reading the salt out of the lock.

Consequences for the two questions:

- **Question 1 is unchanged in substance.** The attacker now controls the salt as well as the table,
  but the target is still a fixed 20-byte commitment chosen by the depositor, so the requirement is
  still a HASH160 second preimage. The binding, range, comb, and OP_PUSH_TX stages are untouched.
  The byte-exact figures in §1 describe the reviewed revision, not the replacement template.
- **Question 2 gets one more dependency.** The salt is no longer on chain until that output is
  spent. Spending needs it from `customInstructions` in the wallet database, or re-derived with
  `createHmac` from the wallet root, the numeric salt key ID, and the complete ordered serial list
  of every key committed to that output. With only one YubiKey in hand and no database, the other
  serials are unknown, so the standalone-tool recovery described at the end of §2 becomes
  conditional on the backup, and situation 2 becomes strictly harder. The normative design,
  handoff, and security review have been updated for the replacement template.
- Validation after the change: all 13 Vault suites pass (598 tests at the time of this report),
  the dedicated CRT harness rejects the forgery, and the local proof accepts 19 authorized spends
  while rejecting 13 outsider or tamper cases, including wrong witness salts.

## Sources

- Chronicle release notes, BSV Skills Center:
  <https://docs.bsvblockchain.org/network-topology/nodes/sv-node/chronicle-release>
