# Security Review — Future-Only R1C YubiKey Vault

**Review date:** 2026-09-11

**Reviewed revision:** `fe03adfaa7cb35a6f7c8205349fdf64068cbb760`

**Reviewed source:** repository source at the reviewed revision

**Scope:** R1C locking and unlocking script, comb arithmetic, one-of-N membership, output salt
derivation, YubiKey setup and recovery, deposits, withdrawals, re-lock, key removal, crash
boundaries, and external wallet capabilities.

## Executive verdict

**The known critical script forgery is fixed. The current code is substantially safer, but Vault
output creation should remain disabled for production.**

The reviewed R1C template rejects the previously working signature-free Chinese Remainder
Theorem witness. It constrains the full affine x-coordinate, enforces canonical scalar ranges
and the modular inverse relation, uses complete mixed point addition, pins spends to transaction
version 1, and runs strict local interpreter flags. The one-of-N commitment logic accepts each
committed key and rejects nonmembers for N = 1 through 5 in the reviewed tests.

Salt generation now uses wallet `createHmac` under protocol `[2, "vault salt"]` with canonical
decimal key IDs `"1"`, `"2"`, and so on, counterparty `self`, and a canonically framed ordered
YubiKey serial list as data. Output-producing transfers require a configured private-backup
endpoint and enabled encrypted backup push. The current asynchronous backup system does not
provide an authenticated receipt for the exact new action. Transfers retain the safer staged
transaction flow: build as `noSend`, inspect the unsigned plan, sign as `noSend`,
inspect the exact signed bytes and txid, then release only that txid with `sendWith`.

One release-critical availability property remains incomplete:

1. The mnemonic does not by itself reproduce a salt or infer and discover the exact R1C lock.
   Salt derivation also needs the numeric ID and complete ordered serial list, while the lock
   additionally depends on independently generated P-256 YubiKey public keys. Current recovery
   depends on authenticated wallet history and `customInstructions`; it has no clean-database
   chain/overlay discovery path.

Two stale devices sharing a mnemonic can choose the same index and, with the same ordered key
set, create the same locking script. The same can occur across networks because chain is not HMAC
data. This loses script-hash separation but does not combine the UTXOs or weaken their spending
conditions, so it is treated as an accepted privacy residual rather than a release blocker.

There are no production Vault outputs, so this review treats v6 as the only supported format.
Older experimental metadata is deliberately rejected and no migration or compatibility spend
path should be added.

The requested “always unlocks” and “never to anyone else” statements cannot be unconditional.
Under the stated cryptographic, hardware, software, and network assumptions, an accepted witness
requires a valid P-256 signature from one public key committed by that output. Availability also
requires the card and PIN, the source transaction/locking script, compatible software, and node
policy that accepts the roughly 45 KB script.

## Findings and disposition

| ID | Finding | Status | Effect |
| --- | --- | --- | --- |
| R1C-01 | Signature-free CRT forgery | **Fixed** | The script enforces `1 <= rFull < p` and `rFull != n`, preventing one integer from carrying independently chosen residues into the group-order and field-prime checks. |
| COMB-01 | Incomplete mixed addition | **Fixed** | Infinity, equality/doubling, inverse, and ordinary-add cases are handled explicitly. |
| AUTHZ-01 | Incorrect one-of-N membership logic | **No bug found after hardening** | Exact commitment equality is OR-combined across one through five unique commitments; every position and outsider cases are tested. |
| TX-01 | Transaction-version and witness malleability | **Fixed in template** | Version 1 is checked on-chain; local verification enables MINIMALDATA, CLEANSTACK, SIGPUSHONLY, STRICTENC, LOW_S, FORKID, and post-Chronicle behavior. |
| SALT-01 | Simultaneous in-process index reuse | **Fixed locally** | Current and historical state choose the next index, and one FIFO serializes simultaneous output creation in the process. |
| SALT-02 | Same-mnemonic disconnected writers | **Accepted privacy residual** | Two devices can select the same decimal ID and reproduce the same script when the ordered key set also matches. Both UTXOs retain the same one-of-N authorization. |
| SALT-03 | Forged derivation metadata poisoning the high-water mark or recovery | **Fixed** | Each recorded numeric ID, ordered serial list, and HMAC is rederived before the ID may advance allocation or metadata recovery. |
| SALT-04 | Cross-network script reuse | **Accepted privacy residual** | Chain scopes metadata but is not HMAC data, so otherwise identical inputs can reproduce a lock on another network without granting authority. |
| REC-01 | Mnemonic-only exact-lock recovery claim | **Not implemented** | Salt derivation also needs the numeric ID and ordered serial list, while the ordered P-256 descriptor and transaction discovery remain separate inputs. |
| META-01 | Shallow or unauthenticated metadata | **Fixed locally** | Exact v6 decoding, wallet HMAC rederivation, and byte-exact lock regeneration bind the recorded salt and ordered P-256 commitments to the real source output. |
| STATE-01 | Wallet/network state crossover | **Fixed** | Vault metadata, drafts, quarantine state, and async commits are scoped by wallet identity and chain. |
| EXT-01 | External wallet API bypass | **Fixed in reviewed boundaries** | The guard, authenticated-origin admin marker, shared mutation FIFO, and SQLite source-script backstop deny external Vault discovery and mutation paths. |
| PIV-01 | Default credentials and unverified hardware | **Fixed in code; hardware evidence open** | Enrollment verifies pinned manufacturer/slot attestation, changes a default PIN, rotates the PUK, replaces the management key, and proves possession. Physical-device coverage is still required. |
| FLOW-01 | Signing before exact transaction approval | **Fixed** | Inputs, source outputs, values, output order, fee, version, and lock instructions are checked before and after signing. |
| CRASH-01 | Aborting or silently resubmitting an ambiguous signed action | **Fail closed; manual workflow open** | Authenticated unsigned reservations may be aborted. Signed held actions are neither aborted nor resubmitted by Vault recovery code. |
| BACKUP-01 | Private backup configuration gate | **Implemented** | Deposits, re-locks, and withdrawal remainders require an endpoint and enabled encrypted push. Full withdrawal remains available. |
| BACKUP-02 | Exact-record backup receipt | **Not implemented** | Configuration does not prove that the exact new action reached the backup host before broadcast; the backup monitor exposes no such authenticated receipt. |
| PERF-01 | Full history/output materialization | **Mitigated** | Pages are authenticated and reduced as they arrive, with bounded selected ancestry. Total work and compact maps remain linear in history size. |

## R1C script and comb review

### Signature equation

For an enrolled P-256 public key `Q`, an output commits to:

```text
HASH160(salt || canonicalTableBytes(Q))
```

The unlocking witness supplies one canonical Q table, the P-256 signature values, scalar
recodings, and the BIP143 preimage. The old exploit used one unbounded integer as `r` in two
different modular domains. An attacker chose its residue modulo the P-256 group order for scalar
multiplication and a different residue modulo the field prime for the final x-coordinate check,
then combined the two with CRT.

The current header enforces:

- exactly 71 witness items, with the final item a minimally pushed 32-byte salt;
- transaction version 1 in the preimage;
- `1 <= rFull < p` and `rFull != n`;
- `1 <= s <= (n - 1) / 2`;
- `1 <= sInv < n` and `s * sInv mod n == 1`;
- equality between supplied scalar recodings and values recomputed from the preimage, `rFull`,
  and `sInv`;
- `HASH160(salt || canonicalTable(Q))` equal to one baked commitment.

Because P-256 has `p < 2n`, the permitted `rFull` interval has only one value whose residue
modulo `n` is zero: `n` itself, which is explicitly rejected. The script computes
`R = u1*G + u2*Q`, rejects infinity, and verifies `R.x = rFull`. This closes the known CRT
forgery without relying on host-side validation.

### Complete mixed addition

Each of 43 comb columns doubles the Jacobian accumulator and adds selected affine points from
the Q and G tables. The wrapper handles:

- accumulator at infinity;
- unequal-point addition;
- equal-point doubling;
- inverse points producing infinity.

Tests compare these cases with the noble P-256 implementation. This removes the prior
data-dependent failure where a valid signer could hit an exceptional intermediate point that the
incomplete formula did not support.

### One-of-N membership

`buildLock` rejects duplicate commitments and accepts one through five. For N = 1 it checks
direct equality. For N = 2 through 5 it preserves each equality result, combines all results with
`OP_BOOLOR`, and then executes `OP_VERIFY`. The test matrix exercises every committed
position and rejects outsider tables, altered/reordered table data, duplicate commitments,
missing pushes, and extra pushes. No alternate membership path was found.

### Transaction covenant and limits

The OP_PUSH_TX tail uses public secp256k1 constants `C1 = 2^248` and `C2 = C1 + 1`. The
normal branch constructs a signature with `C1`; for the sole digest that makes its scalar zero,
the second branch produces scalar one. The two public branches add transaction binding, not
secret spending authority.

Current exact lock sizes are 45,199 bytes for N = 1 and `45,175 + 25N` for N = 2 through 5,
ending at 45,300 bytes. The measured largest witness is 2,539 bytes under a declared 2,560-byte
maximum. The current one- and two-key golden SHA-256 hashes are:

- N = 1: `9a1ed4f8ed6c91fb0d40eb3e2bc00dc30d4148c0546bbd067ae822717a4fbd85`
- N = 2: `17f01ea134c1663b8601fe1b91a6e99eea6412dd727928bed5e1518b3c248cec`

Local SDK interpretation is strong regression evidence. It does not certify consensus,
standardness, propagation, fee policy, or future miner policy. Exact-byte spends must be tested
against the target node/miner stack before release.

## Salt process

The implemented derivation is:

```text
protocolID   = [2, "vault salt"]
keyID        = canonicalDecimal(index)  // "1", "2", ...
counterparty = "self"
data         = count || len(serial[0]) || serial[0] || ...
salt         = wallet.createHmac(protocolID, keyID, counterparty, data)
```

The serial count and each ASCII serial's one-byte length make the concatenation unambiguous while
preserving commitment order. The decoder accepts only canonical positive decimal IDs without
leading zeroes and within `Number.MAX_SAFE_INTEGER`, a supported canonical chain, and exactly 32
lowercase hexadecimal salt bytes. The transfer service then rederives the HMAC from the ID and
ordered serial list. The HMAC is one-way: its output binds those serials but does not contain or
recover them. Chain scopes the metadata and is deliberately not part of the HMAC data.

Before an output is created, the transfer service authenticates current Vault outputs and full
Vault action history, including spent, pending, failed, and completed records. Every recorded
HMAC claim is rederived from its ID and ordered serial list before that ID may advance the
maximum. The next output uses `max + 1`. The same derivation check runs before recovered metadata
is persisted.

Every current or historical Vault output record used as provenance or mutation evidence has its
instructions checked against the real lock and its HMAC rederived before allocation, recovery,
held-action cleanup, key-removal finalization, or metadata deletion may proceed. Input-only
input-only action records carry no salt claim, so lifecycle mutation cross-references each input
outpoint and source script with its authenticated historical v6 output record.

This normally separates sequential outputs and handles simultaneous calls in one process because
the Vault mutation FIFO encloses scan, allocation, action creation, and release. It does not
provide global uniqueness. Disconnected writers with the same mnemonic, index, and ordered key
set, or the same inputs on another network, can reproduce a script. Duplicate scripts remain
valid and independently spendable; the consequence is reduced privacy.

Burning unused indices is harmless to cryptographic security, but a recovery scanner still needs
a defined gap or authoritative high-water rule.

## Recovery truth

The HMAC change makes a salt reproducible when the wallet root, numeric ID, and complete ordered
serial list are all available. The HMAC cannot recover its input. It does not make the full lock
a function of the mnemonic. The exact lock also commits to the complete ordered historical set
of P-256 YubiKey public keys, and those keys are generated independently inside the tokens.

The raw Bitcoin transaction contains the exact lock, so someone who already locates that
transaction can recover the script bytes directly. The mnemonic alone does not tell the wallet
which transaction to fetch. Nor can one surviving key reveal the public keys or order of missing
keys from their salted HASH160 commitments.

One committed YubiKey can authorize a known output: its witness supplies only its own table.
The current software still requires exact v6 `customInstructions` to classify, reconstruct,
and manage outputs. Those instructions live in wallet database/history metadata, not raw
transaction bytes. Current recovery therefore needs that authenticated history. New Vault output
creation requires private-backup configuration, although the current gate does not prove upload
of the exact record.

A defensible mnemonic-plus-one-YubiKey recovery claim requires:

1. deterministic or indexed discovery of candidate transactions;
2. an authenticated exact ordered historical YubiKey descriptor, or a recovery design that
   safely operates from the raw lock and one presented key without that descriptor;
3. verification of raw transaction bytes, proof, UTXO state, exact template, value, network,
   derived salt, and presented-key membership before internalization;
4. a safe numeric gap/high-water rule;
5. a clean-database integration test that retains only the mnemonic and one output-authorized
   YubiKey, discovers the output, and spends it.

Until those pieces exist, the UI and release notes should recommend preserving wallet history
and must not promise mnemonic-only exact-script recovery.

## Setup and key custody

New setup requires two through five distinct YubiKeys, while the script primitive supports one
through five for testing and transitional spends. Each token's whole PIV application must be
factory-reset and dedicated to Vault because PIN, PUK, management credentials, and slot
administration are application-wide.

Before mutation, the native layer binds the session to the expected serial, checks PIN state and
supported PIV slots, authenticates the default management key, and verifies the factory F9
certificate offline through bundled Yubico roots. It generates a fresh P-256 key in retired slot
`0x82` and verifies same-session slot attestation for the exact point, serial, slot, and
PIN-once/touch-cached policy. Setup changes a default PIN, rotates the PUK, replaces the default
management key with native CSPRNG material that never crosses the JS bridge, and verifies a fresh
possession signature.

Draft and quarantine state is written before irreversible APDUs. An uncertain mutation is not
blindly retried. Recovery never overwrites an occupied slot; it adopts a surviving recorded key
only after a live challenge matches its serial and public point.

Residual trust includes the phone UI and app binary, native bridge, OS/NFC/USB stack, pinned
attestation roots and parser, Yubico firmware and supply chain, and handset time used for
certificate validity. A compromised phone can ask a present unlocked display-less token to sign
an attacker-selected digest. Hardware non-exportability does not make the phone a trusted
transaction display.

## Deposit process

The reviewed deposit path:

1. requires the release flag, online state, configured and enabled private backup, valid scoped
   v6 metadata, two through five keys, no pending removal, and any required recovered-key adoption;
2. reconciles only provably unsigned stale reservations and blocks on signed ambiguous ones;
3. authenticates current and historical Vault state and derives the next wallet HMAC salt;
4. creates a version-1 action with one R1C output at index zero, `noSend: true`,
   `signAndProcess: false`, and nonrandomized output order;
5. validates the unsigned AtomicBEEF, allowed change shape, sources, values, fees, exact lock,
   and custom instructions;
6. signs while retaining `noSend`;
7. parses the exact signed AtomicBEEF, recomputes the txid, and repeats the material checks;
8. releases exactly that txid with `sendWith`, accepting only one matching result with status
   `sending` or `unproven`.

The private-backup check proves configuration, not that the exact action was uploaded. An error
detected before `sendWith` may abort the deposit's explicit local reservation. Once `sendWith`
begins, the code never aborts it. Vault recovery code does not call `sendWith` again for a signed held
transaction discovered after a crash. Ordinary broadcaster handling after the initial accepted
`sendWith` response is a separate wallet transport behavior.

## Withdrawal, remainder, re-lock, and removal

Withdrawal streams every current Vault output in authenticated pages and checks each listed row
against its real source transaction, value, exact lock, rederived salt, and v6 record. It selects
only outputs whose commitments include the chosen YubiKey, keeps a stable largest-first set of at
most 32 inputs, and retains BEEF ancestry only for selected inputs.

Before a hardware signature, the service validates input identities and source values, explicit
outputs, at most one ordinary P2PKH change output, transaction version, and fee ceiling. The
ceremony binds serial and public key, signs raw P-256 digests in bounded batches, releases the
hardware session in `finally`, builds each witness, and runs the full R1C script locally.

A full withdrawal with no new Vault output may use the normal wallet broadcast path after those
checks. A remainder and re-lock require private-backup configuration, use a fresh HMAC salt, and
follow the same held-sign, signed-byte-validation, exact-txid `sendWith` flow as a deposit.

Key removal is two-phase. A durable tombstone retains the removed public record while old outputs
still authorize it. Metadata deletion occurs only after the replacement is proven or an
authenticated scan proves the Vault empty. Hidden reservations and all pages are included in
the decision.

## External wallet isolation

The wrapper around externally exposed wallets filters Vault outputs and action details, denies
the reserved Vault and salt protocols, and blocks privileged arguments, known Vault outpoints,
references, txids, `sendWith`, exact R1C creation, and exact R1C internalization. External
inventory scan/use and internal admin output mutations share a serialized FIFO, closing the
scan-to-mutation window.

The patched wallet core derives `__bsvVaultAdminAuthorized` from the authenticated originator;
caller arguments cannot grant it. After resolving an input source from local storage or verified
BEEF, the SQLite backstop rejects an exact R1C source without that host-derived marker. A basket
or action label is never treated as proof of authority.

## Crash and operational behavior

An authenticated unsigned, txid-less held deposit may be aborted and retried. A signed or
possibly broadcast action is never aborted merely to free its reservation. It is also not
silently resubmitted by Vault crash recovery. It blocks mutating Vault flows and requires a
manual workflow based on authoritative network state. Read-only balance and preview remain
available.

This protects against accidental double release or freeing inputs that may already be spent. It
can reduce availability after a crash. A production operating procedure should distinguish
confirmed, mempool, definitely absent, and indeterminate states without altering the signed
bytes.

## Verification evidence

Final checks after the salt-free lock-template change, HMAC-salt checks, lifecycle provenance,
and private-backup gate changes:

- Expo wallet toolbox TypeScript: passed.
- React Native YubiKey TypeScript: passed.
- ESLint on the changed Vault source and proof harness: passed with no errors.
- All 13 Vault suites: **597 of 597 tests passed**. The focused transfer suite accounts for
  **147 of 147**, including foreign-HMAC, wallet-scope-change, and record-salt/lock-commitment
  mismatch regressions before held-action cleanup or key-removal finalization.
- Offline exact-spend proof matrix: **19 authorized spends accepted and 13 outsider/tamper spends
  rejected**, covering N = 2 through 5, every signer position, wrong witness salts, re-lock,
  remainder, transaction tampering, and the deterministic OP_PUSH_TX fallback.
- The standalone CRT-forgery harness rejects the old 65-byte CRT integer witness.
- Strict standalone proof-harness TypeScript: passed.

Earlier review evidence on the same hardened branch includes rejection of the old 65-byte CRT
integer witness, exact script golden tests, Android Gradle/JVM synthetic attestation checks, an
unsigned iOS build against YubiKit 4.4.1, and a Swift pinned-bundle smoke test. No physical
YubiKey or real NFC/USB APDU flow was exercised, and no exact production transaction was
broadcast to a target node/miner during this review.

## Release criteria

Do not enable Vault output creation in a production distribution until:

1. clean-device recovery discovers and validates real outputs and their needed serial list and
   P-256 descriptor without assuming local `customInstructions`;
2. the exact generated script receives an independent cryptographic and Script review;
3. exact-byte N = 2 through 5 deposits and spends pass target node/miner policy tests, including
   multi-input, mixed-input, remainder, re-lock, and both covenant branches;
4. supported physical YubiKeys pass enrollment, attestation, PIN/PUK failure, interruption,
   signing, adoption, removal, and post-recovery spend tests on both platforms;
5. signed held actions have a documented authoritative manual resolution workflow;
6. large-history and many-output stress tests establish a mobile resource budget without
   truncating authenticated scans;
7. an output-producing transfer either obtains a verifiable durable backup checkpoint for its
   exact recovery record before `sendWith`, or clean-device discovery no longer depends on that
   private action metadata.

On 2026-09-12 the product owner authorized enabling `EXPO_PUBLIC_VAULT_ENABLED` in the EAS
production profile for TestFlight and production-build testing. The criteria above remain the
reviewer's record of the operational evidence still to collect; enabling the flag does not mark
those items complete.

The script-level authorization result is strong: no unauthorized accepting path was found after
the CRT, comb, transaction-binding, and one-of-N fixes. The remaining blockers are necessary to
make the recovery and operational promises true under device loss and real network policy.
