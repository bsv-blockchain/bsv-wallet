# 1-of-N YubiKey Vault on the P-256 Comb Verifier — future-only v6 design

**Date:** 2026-09-09
**Revised:** 2026-09-11 after the Vault security review
**Status:** Unreleased implementation candidate. The release blockers in §1 remain open.
**Compatibility:** This design starts at Vault metadata and output-instruction version 6. No
earlier Vault output or metadata format will be read, migrated, or preserved.

## 1. Scope and release decision

Vault outputs use a Bitcoin locking script that verifies a NIST P-256 ECDSA signature from any
one of up to five enrolled YubiKeys. The product requires at least two enrolled keys before it
creates an output. A deposit requires no YubiKey; a withdrawal requires one enrolled YubiKey,
its PIN, and its touch policy.

The private P-256 keys are generated in PIV retired slot `0x82` and never cross the YubiKey
boundary. There is no seed-derived spending path, recovery phrase path, passphrase path, K1
spending leg, or hidden maintenance key. If every enrolled YubiKey is lost or unusable, the
output is intentionally unspendable.

The current script closes the known arithmetic and covenant liveness exceptions: mixed point
addition handles every exceptional case and the OP_PUSH_TX covenant has a deterministic
second-key fallback. Subject to the stated trust assumptions, an accepted witness therefore
requires a valid signature from one of the committed P-256 public keys, and every valid
low-S signature from one of those keys has a canonical witness that the script accepts.

This statement does not replace the release gate. Keep Vault output creation disabled until all
of these items are complete:

1. **Exact-template network proof.** Broadcast token-value spends of the exact current
   `r1comb.ts` output on the supported network and node policy. Cover N = 2 through N = 5,
   every key position, mixed wallet and Vault inputs, multiple Vault inputs, re-lock, remainder,
   and the deterministic covenant fallback branch. Pin the raw transactions and txids.
2. **Production hardware proof.** Generated bindings currently pass the Android Gradle native
   and JVM checks, an unsigned iOS build against YubiKit 4.4.1, and the Swift pinned-certificate
   smoke. These are compile and synthetic-fixture evidence, not a physical token or APDU test.
   Run enrollment, attestation, deposit, withdrawal by each key, interrupted NFC/USB sessions,
   add/remove/re-lock, backup, clean-device restore, and post-restore spend with production
   YubiKeys.
3. **Recovery and allocation design.** Implement and test clean-device discovery of the exact
   ordered YubiKey descriptor and numeric salt-index high-water. Either serialize all devices
   sharing a mnemonic through an authoritative allocator or explicitly constrain Vault to one
   synchronized writer; two disconnected devices can otherwise select the same next index.
4. **Independent review.** Re-review the exact generated script bytes, the wallet-toolbox patch,
   native attestation verifiers and trust bundle, external-wallet guard, storage backstop, and
   final recovery/allocation protocol. The feature flag must remain off in distributable builds until the
   evidence is recorded.

## 2. Security model

### 2.1 Protected assets

- Vault satoshis must move only under a valid signature from a public key committed by that
  output.
- The wallet must never create two Vault outputs with the same locking-script hash.
- The wallet must preserve or publicly recover enough authenticated metadata to identify every
  ordered YubiKey public key and rebuild each exact lock after device loss.
- External origins must not discover, reserve, sign, abort, release, or internalize Vault
  actions or outputs through the general wallet interface.
- Interrupted enrollment, signing, and broadcast must fail closed without silently
  discarding the last known authoritative state.

### 2.2 Adversaries considered

The design considers a caller that controls all BRC-100 arguments, lies about basket names and
labels, supplies malformed BEEF or custom instructions, races an external request against an
admin request, interrupts any async boundary, or presents a modified or counterfeit PIV token.

### 2.3 Trusted boundaries

The following remain trusted:

- P-256, secp256k1, SHA-256, HASH160, and the SDK's correctly implemented Script and BIP143
  semantics;
- the supported network enforcing the required post-Chronicle opcodes and transaction policy;
- the app's authenticated internal origin, patched wallet core, SQLite provider, platform
  SecureStore, and native YubiKey bridge;
- the bundled Yubico production attestation roots and the correctness of YubiKey firmware.

A compromised phone can ask a present, unlocked YubiKey to sign an attacker-selected digest.
PIN and touch provide physical authorization, but the phone UI is still trusted to describe the
transaction honestly.

## 3. On-chain authorization

### 3.1 Keys, table, and commitment

The curve is NIST P-256. For a public point `Q`, the verifier uses a 6-row, 43-column signed
comb and a 32-entry affine table. The canonical table encoding is:

```text
canonicalTable(Q) =
  le33(x_0) || le33(y_0) || ... || le33(x_31) || le33(y_31)
                                                    64 * 33 = 2,112 bytes

commitment(Q, salt) = HASH160(salt || canonicalTable(Q))
```

`le33` is exactly the 33-byte little-endian value produced by `OP_NUM2BIN 33`. Fixed-width
encoding prevents two integer sequences from sharing an ambiguous byte serialization.
`salt` is exactly 32 public bytes and is embedded in the locking script. H5 accepts the hash
for any one committed key.

The salt does not add spending authority and need not be secret. Distinct salts change the
commitments and exact script bytes for otherwise identical key tables, giving different script
hashes under the assumed collision resistance of SHA-256.

### 3.2 Exact locking-script format

`buildLock({ commitments, saltHex64 })` accepts one through five distinct 20-byte commitments
and one 32-byte salt. Product flows pass two through five commitments.

| Region | Purpose | Exact bytes |
|---|---|---:|
| H0-H4, including salt | Exact witness depth; version-1 preimage; scalar checks and recoding; canonical Q-table hash | 811 |
| H5, N = 1 | One commitment equality | 22 |
| H5, N >= 2 | OR chain over N commitments | `25N - 2` |
| Shared suffix | G table, pre-loop, complete 43-column comb, projective result check, total covenant tail | 44,388 |

The exact total is:

| Committed keys | Lock bytes |
|---:|---:|
| 1 | 45,221 |
| 2 | 45,247 |
| 3 | 45,272 |
| 4 | 45,297 |
| 5 | 45,322 |

For N >= 2, `R1C_LOCK_LEN(N) = 45,197 + 25N`. Exact parsing first checks one of these
lengths, extracts the baked salt and commitments, and then regenerates and compares the entire
template byte for byte. A matching length or basket label alone never identifies an R1C output.

### 3.3 Canonical signature witness

The unlocking script contains exactly 70 minimal pushes, bottom to top:

```text
0        full affine x-coordinate r of R = u1*G + u2*Q
1        recode(u2)
2        recode(u1)
3..66    x_0, y_0, ... x_31, y_31 of table(Q)
67       low-S P-256 s
68       s^-1 mod n
69       158-byte BIP143 preimage
```

The salt is already in the lock and is not a witness item. The measured hard witness maximum is
2,506 bytes; `R1C_UNLOCK_LEN = 2,560` is the declared upper bound.

The header enforces:

- exactly 70 witness items, with no extra bottom-stack values;
- transaction version 1, by comparing the first four preimage bytes with `01000000`;
- `1 <= r < p` and `r != n`;
- `1 <= s <= (n - 1) / 2`;
- `1 <= sInv < n` and `s * sInv = 1 mod n`;
- equality between the supplied recoded scalars and the values recomputed from the preimage,
  `r`, and `sInv`;
- a canonical table hash equal to one of the baked commitments.

The `r` checks are consensus-critical. Without them, Chinese-remainder representations can
carry one residue modulo the P-256 group order into scalar multiplication and another modulo the
field prime into the final x-coordinate comparison. Low-S and the exact stack shape remove
otherwise valid witness variants.

The local `scripts/run-r1c-crt-forgery.cjs` regression harness currently reports
`accepted: false`, `oldCrtForgeryRejected: true`, `usedYubiKey: false`, and
`validP256Signature: false` for a 65-byte forged `r` and a 2,437-byte unlocking script. It imports
the production `r1comb.ts` builder and verifier, so it is regression evidence rather than an
independent verifier or oracle. Its generic `OP_VERIFY` failure also does not, by itself, identify
the exact failing opcode.

### 3.4 Complete comb arithmetic

Each of 43 columns doubles the Jacobian accumulator, adds the selected affine Q-table point, and
adds the selected affine G-table point. The mixed-add wrapper handles all cases explicitly:

- accumulator at infinity;
- ordinary unequal-point addition;
- equal-point doubling;
- inverse points, producing infinity.

The final check requires a non-infinity result and verifies `X = r * Z^2 mod p`. Valid P-256
ECDSA gives `R = u1*G + u2*Q`; the table commitment determines Q, and the final equality binds
the full affine x-coordinate used by the header.

### 3.5 Preimage and local verification

The only supported transaction version is 1. The BIP143 scriptCode is the byte `ac`, the
subscript after the lock's `OP_CODESEPARATOR`, and the sighash scope is `0x41`
(ALL | FORKID). The card signs `reverse(hash256(preimage))` as a raw 32-byte P-256 digest.
The app parses strict DER, normalizes high-S to low-S, builds the witness, and verifies each input
locally before `signAction`.

Local `Spend` validation explicitly enables:

```text
MINIMALDATA
UTXO_AFTER_CHRONICLE
SIGHASH_FORKID
STRICTENC
CLEANSTACK
SIGPUSHONLY
LOW_S
```

The transaction bytes used for all preimages come from the signable AtomicBEEF. Version,
locktime, every input, sequence, output, source value, and source script are rechecked before
the card signs and again where the held signed transaction is inspected.

### 3.6 Deterministic OP_PUSH_TX covenant

The tail constructs a secp256k1 signature for the same preimage and checks it after
`OP_CODESEPARATOR`. Both covenant private scalars are public constants; this leg binds the
preimage to the transaction and is not an alternate secret spending path.

Let `C1 = 2^248` and `C2 = C1 + 1`. The normal branch uses the public key corresponding to
`C1` and:

```text
s = lowS((e + C1) mod n_k1)
```

For the one digest that makes the first scalar zero, the script selects the second public key.
Then `(e + C2) mod n_k1 = 1`, so the signature is defined. Two distinct constants cannot both
produce zero for one digest. The tail serializes every positive low-S scalar safely, so
`pushTxDerCheck` now always returns `ok: true`; the retained retry loop is dead defensive
scaffolding and is not part of availability.

## 4. Output instructions and local authority

Every new output carries exact JSON `customInstructions`:

```ts
interface VaultInstructionsV6 {
  v: 6
  type: 'R1C'
  salt: string
  saltPublicKey: string
  saltKeyId: string
  chain: 'main' | 'test' | 'teratest'
  vaultId: string
  revision: number
  createdAt: number
  keys: Array<{
    serial: string
    slot: 0x82
    pubkey: string
    nickname: string
    enrolledAt: number
  }>
}
```

`salt` must equal the chain-domain-separated SHA-256 of the canonical compressed
secp256k1 `saltPublicKey` and the 32 bytes baked into the lock. `chain` is
part of that domain and must match the active wallet network. `saltKeyId` must be a
canonical positive decimal integer (`"1"`, `"2"`, ...) within the JavaScript safe-integer
range. Key records are in
commitment order. The decoder requires the exact field set, canonical lowercase encodings,
valid curve points, valid ranges, unique serials and public keys, and at most 4,096 characters.
Unknown fields, older versions, and partially valid records are rejected.

Local authoritative metadata is version 6:

```ts
interface VaultMetaV6 {
  v: 6
  vaultId: string
  revision: number
  createdAt: number
  lastUsedAt?: number
  lastUsedSerial?: string
  pendingRemoval?: VaultPendingRemoval
  recovery?: { required: true; adoptedSerials: string[] }
  keys: VaultKeyRecord[]
}
```

It is stored under a wallet-identity-and-chain-scoped `vault_meta_v6` key in platform
SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. A scope generation token prevents an async
operation that began for one wallet or chain from committing into another.

Output instructions hold the full public recovery record in the wallet database. Current
recovery accepts them only after the
real source value and exact lock authenticate the baked salt and the ordered P-256 public-key
commitments reconstructed from the record. The lock does not authenticate `saltKeyId` or its
BRC-42 provenance, serials, nicknames, or enrollment timestamps; those remain wallet recovery
metadata. Recovery refuses a different `vaultId`, conflicting `createdAt`, stale revisions, or
divergent key sets at the same revision. A clean-device restore marks recovered keys as
unadopted. The user must prove live possession of at least two recorded YubiKeys before
`depositToVault` accepts net-new funds. A withdrawal remainder or re-lock may create a
replacement output with one adopted signing key that the source output already authorizes.

## 5. Per-output salt and script-hash uniqueness

Every output uses a wallet-derived public key under BRC-42 protocol:

```text
protocolID = [2, "vault salt"]
keyID      = canonicalDecimal(index)  // "1", "2", ...
saltKey    = compressed getPublicKey(protocolID, keyID, self)
salt       = SHA256(utf8("R1C vault salt v1\0" || chain || "\0") || saltKey)
```

The exact key ID is the canonical decimal `index`. It is one greater than the greatest
authenticated index found in current Vault outputs and the full Vault action history, across
all enrollments for the wallet and chain. The derived compressed secp256k1 public key, key ID,
chain, salt, and full v6 record are retained in the output instructions; the salt is also
embedded in the lock. The same wallet root, protocol, self-counterparty setting, decimal ID,
and chain therefore rederive the same public key and salt. Chain domain separation prevents the
same mnemonic, index, and ordered YubiKey set from reproducing a script hash on another network.

Before choosing the next salt, the transfer service builds an authenticated inventory from
current outputs and all Vault actions, including spent, pending, completed, and failed history.
It tracks salt owners, key ID owners, exact script hashes, and the script-to-key-ID binding. It
also rederives every recorded salt public key before allowing that record to advance the
high-water mark, so forged metadata cannot force an arbitrary next index. The one next candidate
is accepted only if its key ID, salt, and script hash are all new; any collision fails closed.

The process-wide FIFO serializes simultaneous calls in one running app, and complete visible
history prevents sequential reuse. This is not a distributed allocator. Two disconnected or
stale devices sharing one mnemonic can both observe N and broadcast N+1; with the same ordered
key set they would create the same locking-script hash. A release must therefore add a shared
compare-and-swap/on-chain allocator or enforce a single synchronized Vault writer. Local
history can reject a collision only after the other action becomes visible.

The deterministic salt sequence is only one recovery input. The exact lock also depends on the
complete ordered P-256 YubiKey public-key set, which the mnemonic cannot derive, and
`customInstructions` are wallet metadata rather than transaction bytes. Numeric salt IDs do not
by themselves implement clean-device output discovery or mnemonic-plus-one-YubiKey recovery.

## 6. YubiKey enrollment and custody

Enrollment is allowed only after the user acknowledges that the whole PIV application is
factory-reset and dedicated to Vault. PIV PIN, PUK, management credentials, and several checks
are application-wide, so sharing that PIV application with unrelated credentials is unsafe.

Before the first mutating APDU, native code must:

1. bind the live session to the expected serial and reject a blocked or invalid PIN;
2. prove that Vault slot `0x82` and every user slot the platform supports inspecting are empty;
3. verify the device's factory F9 certificate offline through the bundled, pinned production
   Yubico trust graph;
4. enforce certificate validity, basic constraints, CA and key-usage rules, supported signature
   algorithms, critical extensions, certificate signatures, and the device serial;
5. authenticate the factory-default management key.

Failure, absence, ambiguity, an unknown issuer, or a custom management key is
`attestation-invalid` and stops enrollment. The verifier does not use AIA fetching, system
trust, or remote roots.

PIV attestation support starts at YubiKey firmware 4.3. Earlier firmware, a missing or
overwritten F9 certificate, and preview or otherwise unknown certificate chains fail closed.
Certificate validity is evaluated against the handset clock, so a materially incorrect clock
can reject a genuine device.

Native code generates a fresh P-256 key in slot `0x82` with PIN policy once and touch policy
cached. In the same native session it verifies a slot attestation that binds the exact returned
point, slot, serial, PIN/touch policies, device F9 certificate, and pinned production root. It
then replaces the default management key with native CSPRNG material that never crosses the JS
bridge. A factory-default PIN must be changed, and the PUK is rotated.

Durable quarantine or draft state is written before each irreversible PIN, PUK, generation, and
management-key transition. An uncertain outcome is never retried as though the slot were empty.
After management-key protection, the key signs a fresh random challenge and the app verifies the
signature against the attested public key. Only that manufacturer-attested, protected,
possession-proven record can enter authoritative Vault metadata.

Signing is serial-bound. The ceremony verifies the presented serial and public key, checks PIN,
then asks slot `0x82` to sign each precomputed digest. The signer is scoped to one operation and
released in a `finally` block.

Current native evidence consists of passing Android Gradle native/JVM checks, an unsigned iOS
build against YubiKit 4.4.1, and the Swift pinned-certificate smoke. Android JVM tests use
synthetic F9/slot graphs and cover negative key, serial, policy, root, and DER cases. The iOS
smoke exercises pinned-bundle loading and mutation rejection while compilation checks the native
call sites. None of this exercises a physical YubiKey or real NFC/USB APDUs.

## 7. Transfer state machines

All Vault metadata changes and output mutations run through one process-wide FIFO and a captured
wallet/chain scope token. Current-output scans request at most 64 outputs per page and consume
each page's BEEF immediately. Action-history scans use 8-row pages when source scripts are
included and 200-row pages for lightweight metadata. If a provider supplies a total, it must
remain stable and scanning continues to that total; without a total, a short or empty page ends
the scan. Scanners reject oversized, repeated, or non-advancing pages and authenticate
instructions against real source scripts. Withdrawal keeps full proof material only for its at
most 32 selected inputs. No hard total-history cap may hide valid outputs. Compact identity,
salt, and seen sets still grow with history, recovered current-output metadata grows with the
live output set, scan time remains linear, and a single page's BEEF size is still
provider-sensitive.

### 7.1 Deposit

1. Require the feature flag, online state, valid v6 metadata with two to five keys, no pending
   removal, and recovered-key adoption.
2. Scan current and historical Vault state and allocate a unique salt as in §5.
3. Build one exact R1C output at index zero. The wallet may add at most one standard P2PKH change
   output.
4. Create a version-1 action with `noSend: true` and `signAndProcess: false`.
5. Inspect the unsigned plan, call `signAction({ options: { noSend: true } })`, parse the exact
   signed AtomicBEEF, recompute its txid, and inspect value, inputs, outputs, fee, script, and
   instructions again.
6. Release only that txid with `sendWith`. Success requires exactly one case-insensitive txid
   match and status `sending` or `unproven`.

A missing, duplicate, unrelated, failed, or unknown `sendWithResults` entry is an ambiguous
failure. The held action remains reserved. Before `sendWith` starts, a locally detected error in
the explicitly `noSend` deposit may abort its reservation. Once `sendWith` begins, cleanup must
never call `abortAction`.

### 7.2 Withdrawal

The user selects an enrolled key before the card tap. The service selects only outputs whose
exact lock commits to that key, supplies authenticated source transactions in BEEF, caps the
input count, and validates the complete proposed version-1 transaction before requesting any
signature. It signs in bounded hardware batches, builds the 70-push witness per input, and runs
strict local Script verification.

A withdrawal that creates only ordinary wallet output has no new Vault recovery record and may
go directly through the wallet broadcaster. If the selected inputs leave a Vault remainder, the
replacement is a new v6 output with a new §5 salt; the held-sign and `sendWith` rules apply.

### 7.3 Re-lock, add, and remove

Adding a key increments the metadata revision. Existing outputs do not authorize it until they
are re-locked. Re-lock spends authenticated outputs with one currently authorized key and makes
one replacement output committed to the current key list with a new salt.

Removal is two phase. A durable `pendingRemoval` tombstone retains the removed public record
until every affected output has been re-locked and the broadcast outcome is known. Deposits and
other conflicting mutations remain blocked meanwhile. The tombstone prevents a crash from
forgetting a key that still has on-chain authority.

### 7.4 Crash and ambiguity handling

Unsigned, txid-less reservations that are authenticated as this feature's own actions may be
aborted. Signed `noSend` actions are never aborted based only on local status, because an
earlier `sendWith` call may have reached the network before the process died.

Vault recovery code deliberately never calls `sendWith` again for a signed transaction found
after a crash. Current code blocks Vault mutation and transfer flows on a signed held deposit
until a future, separately reviewed primitive can prove authoritative network state. Read-only
balance and preview operations remain available. This rule does not disable ordinary broadcaster
handling after the initial accepted `sendWith` call.

## 8. Recovery and optional backup

Vault transfer broadcasts do not depend on the encrypted-backup preference, a private backup
upload, a completion marker, or a host-supplied backup receipt. Ordinary wallet backup remains
available and advisable because the current recovery implementation reads the wallet database's
authenticated action history and `customInstructions`.

The numeric salt ID makes the secp256k1 salt public key and 32-byte salt reproducible from the
same wallet primary key:

```text
[2, "vault salt"], keyID "1", "2", ..., counterparty "self", forSelf true
```

That fact does not determine the exact R1C locking script. The script also commits to every
P-256 YubiKey public key in enrollment order. Those independent keys are not derived from the
mnemonic, and their full records are currently present only in wallet metadata. The raw Bitcoin
transaction contains the salt and opaque HASH160 table commitments, not `saltKeyId`, the
YubiKey public keys, or their order.

Consequently, the current clean-device recovery path still requires restored wallet history or
another authenticated descriptor/discovery source. A future claim that mnemonic plus one
surviving YubiKey is sufficient must first ship a public recovery path that:

1. locates candidate raw transactions without trusting local `customInstructions`;
2. obtains the complete ordered historical YubiKey public-key descriptor;
3. rederives the claimed numeric salt public key and verifies its chain-domain-separated SHA-256
   against the exact lock;
4. validates transaction bytes, proof, UTXO state, exact template, value, network, and the
   presented YubiKey commitment before internalization;
5. defines a safe high-water/gap rule and a cross-device allocation protocol.

A backup-free recovery test must begin with a clean database and retain only the mnemonic and
one output-authorized YubiKey. It must discover, internalize, and spend a real fixture. Until
that test exists, documentation and UI must not promise mnemonic-only or mnemonic-plus-one-key
Vault discovery.

## 9. External wallet and storage isolation

Every wallet object handed to an external origin is wrapped by `guardVaultAccess`. The host
accepts pairing origins only as canonical bare HTTPS origins and rejects credentials, path,
query, fragment, malformed ports, and the reserved admin origin.

The guard:

- scans and filters external `listActions` results so Vault labels, admin-basket outputs, R1C
  inputs, and related recovery identifiers are not returned;
- rejects external Vault protocol requests, `privileged` calls, known Vault outpoints,
  references, txids, and `sendWith` releases;
- rejects external creation or internalization of an exact R1C output;
- validates and caps external arguments before expensive serialization or history scans;
- serializes external inventory-scan/use and internal admin output mutations in one FIFO,
  closing the scan-to-mutation race. Admission is capped at 16 queued untrusted external calls;
  trusted admin work is not independently capped and can queue behind admitted external work.

The raw wallet is an internal trust boundary and must never be exposed. Admin authorization is
derived in patched wallet core from the authenticated `originator` and recorded only in the
internal `__bsvVaultAdminAuthorized` field. Caller-supplied action fields cannot grant it.

The SQLite provider supplies the final input backstop. After wallet core resolves the immutable
source locking script from authenticated local storage or verified BEEF, it calls
`validateResolvedActionInput`. Any exact R1C source is rejected unless the host-derived admin
marker is true. This closes the case where an output appears after the external history scan and
also prevents a caller from lying about the source script.

## 10. Security conclusions and residual risks

- **Unauthorized spend:** The script's only accepting path combines an authenticated committed
  Q table, strict P-256 scalar relations, complete point arithmetic, final x-coordinate equality,
  and transaction-bound OP_PUSH_TX. No alternate K1 or recovery path exists.
- **One-key availability:** A valid signature from any committed key is sufficient. Complete
  mixed addition, low-S normalization, byte-safe DER assembly, and the second covenant branch
  remove the known data-dependent failures.
- **Script-hash separation:** A fresh public salt changes every commitment and the exact script
  bytes, giving computational script-hash separation under SHA-256 collision resistance. The
  salt is public and the R1C template remains recognizable. Once an output is spent, its Q table
  and the signing public key become public; the private key remains inside the YubiKey. This is
  privacy, not access control.
- **Recovery:** The wallet can deterministically rederive each numeric salt, but safe recovery
  also needs the complete ordered YubiKey public-key descriptor and a way to discover the raw
  transactions. Current recovery obtains those from authenticated wallet history. Two live
  adopted keys are required before accepting a net-new deposit after recovery. One adopted key
  already authorized by an output can spend it and create a replacement remainder or re-lock
  output.
- **Metadata integrity:** Strict v6 parsing and lock regeneration prevent a basket label or
  database field from changing on-chain authority. Historical salt public keys are rederived
  before their numeric IDs may advance the allocation high-water mark.
- **Hardware authenticity:** Manufacturer attestation narrows enrollment to genuine supported
  YubiKeys in the required state. The bundled roots, native parsers, firmware, and platform NFC
  or USB stacks remain high-value review targets.
- **Network policy:** SDK interpretation is necessary but insufficient evidence. The exact
  45,247-45,322-byte production locks require real-node proof before release.
- **Operational denial of service:** An attacker or broken wallet provider can make services
  unavailable. Fail-closed behavior protects funds from unauthorized release but cannot
  guarantee service availability. Streaming avoids retaining cumulative scripts and
  full BEEF, but compact history maps, linear scan time, recovered live-output records, and the
  byte size of one provider page remain mobile resource risks that require stress testing.

## 11. Validation matrix

Before release, automated and device tests must cover:

- exact lock lengths and golden hashes for every N, byte-exact parser rejection, commitment
  order, salt binding, and all mixed-add exceptional branches;
- valid spends across random keys, inputs, outputs, sequences, and locktimes under the exact
  strict flags; malformed depth, version, r, s, inverse, tables, commitments, preimage, and
  covenant branch failures;
- independent CRT-forgery and valid-witness vectors evaluated by a verifier or oracle that does
  not import the production builder/verifier; the current script is a local regression harness;
- deterministic exercise of both OP_PUSH_TX public-key branches;
- exact v6 decoder rejection of missing, extra, legacy, noncanonical, duplicate, mismatched,
  stale, and conflicting records;
- salt uniqueness across live, spent, failed, pending, restored, and concurrent output histories,
  canonical decimal-index boundaries, same-process simultaneous deposits, cross-network domain
  separation, derivation-metadata poisoning, re-enrollment continuity, and the
  disconnected-device collision limitation;
- hostile external calls, pagination changes, TOCTOU schedules, malformed BEEF, forged basket
  names, references, txids, and storage-level R1C input rejection;
- fake, expired, wrong-root, wrong-serial, wrong-slot, wrong-policy, wrong-key, unsupported
  critical-extension, and custom-management-key attestation cases on both native platforms;
- crashes at every enrollment mutation and every transfer phase;
- missing, duplicate, unrelated, failed, and ambiguous `sendWithResults`;
- clean-database recovery from only the mnemonic and one output-authorized YubiKey, including
  historical key-set changes, index gaps, malicious discovery results, and exact chain-state
  validation.

No positive pre-v6 fixture, migration branch, decoder fallback, or compatibility allowance
belongs in the release implementation. Explicit negative fixtures that prove earlier Vault
versions are rejected remain required. Test devices using older experimental Vault data must
start with a clean Vault state. This does not permit deletion or incompatibility of ordinary
wallet state or encrypted backup logs.
