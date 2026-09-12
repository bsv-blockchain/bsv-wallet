# R1C Vault — future-only v6 security handoff

**Date:** 2026-09-11
**Branch:** `codex/r1c-vault-security-fix`
**Release state:** Not production-ready. Keep Vault output creation disabled until the blockers
below are implemented, independently reviewed, and exercised on real nodes and hardware.
**Compatibility decision:** There are no released Vault outputs. Version 6 is the only accepted
Vault metadata and output-instruction format; do not add Vault migration or legacy fallbacks.

The normative design is
`docs/superpowers/specs/2026-09-09-r1-comb-vault-design.md`. This handoff distinguishes code
present on the branch from work still required for release.

## Current design

- The product enrolls two through five YubiKeys. Each holds a fresh P-256 key in PIV retired
  slot `0x82`; any one committed key can spend. There is no seed, phrase, passphrase, K1, or
  service spending leg.
- A lock commits to `HASH160(salt || canonicalTable(Q))` for every enrolled key. The 32-byte
  public salt is baked into the lock.
- Exact lock sizes are 45,221 bytes for N = 1 and `45,197 + 25N` for N = 2..5: 45,247,
  45,272, 45,297, and 45,322 bytes. Product output creation requires N >= 2.
- The unlock has exactly 70 pushes, a measured maximum of 2,506 bytes, and a declared
  `R1C_UNLOCK_LEN` of 2,560.
- Vault spends use transaction version 1 with strict `MINIMALDATA`, `UTXO_AFTER_CHRONICLE`,
  `SIGHASH_FORKID`, `STRICTENC`, `CLEANSTACK`, `SIGPUSHONLY`, and `LOW_S` verification.
- The complete mixed-add wrapper handles infinity, equality/doubling, inverse points, and
  ordinary addition. The OP_PUSH_TX tail has a deterministic second-key branch for the one
  digest that makes the first constructed scalar zero.
- Each output carries exact `customInstructions` v6 with the salt, salt public key, numeric salt
  key ID, chain, vault identity/revision, and full ordered YubiKey records. The exact lock authenticates
  the salt and reconstructed P-256 commitments. It does not authenticate the BRC-42 origin of
  `saltKeyId`, serials, nicknames, or timestamps.
- Local Vault authority is scoped by wallet identity and chain and stored in
  this-device-only SecureStore. Recovery metadata is accepted only after byte-exact
  authentication against a real R1C lock.

## Security work present on this branch

### Script and comb verifier

`core/services/vault/r1comb.ts` contains the hardened exact template:

- exact witness depth and transaction-version checks;
- canonical `r`, low-S `s`, canonical inverse, and inverse equality checks that close the
  cross-modulus/CRT forgery;
- complete mixed Jacobian-plus-affine addition;
- deterministic two-branch covenant signature construction;
- lock-baked salt and byte-exact lock regeneration;
- exact v6 instructions and strict local Spend flags;
- golden lengths/hashes, malformed-script cases, exceptional arithmetic cases, and randomized
  version-1 spend tests.

The local `scripts/run-r1c-crt-forgery.cjs` regression imports the production verifier and
confirms that the old signature-free witness is rejected. It is useful regression evidence but
is not an independent verifier or consensus oracle.

### Numeric HD salt allocation

`core/services/vault/transfers.ts` derives each salt public key with:

```text
protocolID   = [2, "vault salt"]
keyID        = "1", "2", ...
counterparty = "self"
forSelf      = true
saltKey      = compressed derived public key
salt         = SHA256(utf8("R1C vault salt v1\0" || chain || "\0") || saltKey)
```

Before allocation, the service scans authenticated current outputs and complete Vault action
history, including pending, spent, failed, and completed rows. It tracks salt, key-ID, script
hash, and script-to-key-ID ownership. Every recorded numeric key ID is rederived through the
wallet and its public key must match the record before that ID can advance the high-water mark.
The next candidate is rejected if its ID, salt, or script hash has already been used. The
canonical chain is included in the public salt hash, preventing the same mnemonic, numeric ID,
and ordered YubiKey set from reproducing one script hash across networks.

Current-output scans consume 64-output BEEF pages immediately. Script-bearing action history
uses 8-row pages and lightweight history uses 200-row pages. A provider total must remain stable
and be fully consumed. Without a total, a short or empty page terminates the scan. Oversized,
repeated, and non-advancing pages are rejected. Withdrawal retains full proofs only for its at
most 32 selected inputs.

The process FIFO prevents duplicate allocation by simultaneous calls in one app process. It is
not a distributed allocator. Two disconnected devices sharing one mnemonic can both see N and
broadcast N+1; if they use the same ordered YubiKey set, they create the same script hash. Before
release, either all such devices must use an authoritative compare-and-swap/on-chain allocator,
or the product must enforce one synchronized Vault writer.

### Recovery boundary

The numeric HD sequence deterministically reproduces the secp256k1 salt public key and salt. It
does not determine the exact R1C lock. Each lock also depends on the complete ordered set of
independently generated P-256 YubiKey public keys. The raw transaction contains the salt and
opaque HASH160 table commitments, while `customInstructions` are wallet database metadata.

Current recovery therefore still depends on authenticated wallet history or backup for the
ordered descriptor and transaction discovery. A future backup-free claim requires a public,
authenticated descriptor/discovery path, exact transaction and UTXO validation, a safe numeric
index gap/high-water rule, and a clean-database test that starts with only the mnemonic and one
output-authorized YubiKey and ends with a valid spend.

### External and native boundaries

`core/services/vault/guard.ts` filters protected reads and denies external Vault protocols,
privileged arguments, known Vault outpoints, references, txids, `sendWith`, and exact R1C
creation/internalization. Admin mutations and external inventory scan/use share a FIFO to close
the scan-to-mutation race. The patched wallet core derives admin authority from the authenticated
originator; SQLite rejects an exact R1C source unless that host-derived marker is present.

Enrollment verifies factory and slot attestation through bundled Yubico roots, binds serial,
slot, point and PIN/touch policy, rotates the PUK, replaces the default management key with
native CSPRNG material, and proves possession. Durable draft/quarantine state precedes
irreversible APDUs. Current evidence is compile and synthetic-fixture evidence; no physical
YubiKey or real NFC/USB APDU flow was tested.

### Transfer and crash behavior

Deposits and spends that create a Vault output use `noSend`. The service checks the unsigned
plan, signs while retaining `noSend`, parses the exact signed AtomicBEEF, recomputes the txid,
and rechecks inputs, outputs, values, fees, locks, and instructions before calling `sendWith`.
Release succeeds only for exactly one case-insensitive matching txid with status `sending` or
`unproven`.

Private-backup configuration, a backup upload, and a host receipt are not broadcast gates.
Ordinary encrypted backup remains optional and advisable because current recovery uses wallet
history.

An authenticated unsigned, txid-less reservation may be aborted. Once `sendWith` begins, the
code never aborts the action. Vault recovery code neither calls `sendWith` again nor aborts a
signed held action found after a crash; it blocks mutating Vault flows for manual network-state
reconciliation. This does not disable ordinary broadcaster handling after the initial accepted
`sendWith` call. Keeping staged validation preserves inspection of the final signed bytes
before their initial broadcast.

## Release blockers

### 1. Recovery and cross-device allocation

- Provide authenticated discovery of raw transactions and the exact ordered historical YubiKey
  descriptor without assuming a local database.
- Verify transaction bytes, proof, UTXO state, exact v6 template, salt derivation, network, value,
  and presented-key membership before internalization.
- Define a safe numeric index high-water/gap rule.
- Add an authoritative multi-device allocator or enforce one synchronized writer.
- Pass clean-database recovery and disconnected-device collision tests.

### 2. Node, hardware, and native proof

- Spend the exact 45 KB template on supported node/miner policy with token values for N = 2..5,
  every key position, mixed and multiple inputs, remainder, re-lock, and the forced second
  covenant branch.
- Run enrollment and attestation rejection cases on supported production YubiKeys, iOS and
  Android, NFC and supported USB transports.
- Exercise interruption at every PIN, PUK, key-generation, management-key, challenge, signing,
  and broadcast boundary.
- Complete an independent review of the exact generated lock and native attestation code.

### 3. Signed-action operations

Automatic crash rebroadcast is intentionally absent. Define an operator/user workflow that can
resolve a signed held action from authoritative network state without aborting a transaction
that might have escaped or submitting altered bytes.

## Future-only policy

Retain explicit negative fixtures proving that pre-v6 records are rejected. Do not add v3, v4,
or v5 decoders, migration logic, compatibility spends, or a staging reclaim path. Development
devices must use clean Vault state when testing v6. This decision applies to Vault outputs and
does not authorize compatibility changes to ordinary wallet backup data.

## Maintainer cautions

- A public salt changes script bytes; it is not secret and grants no authority.
- Numeric HD salt derivation alone does not reconstruct an exact lock.
- `customInstructions` are metadata. Authenticate them against the real source lock and value.
- A basket or action label never proves Vault ownership.
- Do not expose the unwrapped raw wallet or infer admin authority from caller-controlled data.
- Do not abort a signed or possibly broadcast transaction to free a reservation.
- Do not claim distributed salt uniqueness until allocation is serialized across devices.
- Do not enable the feature in a production distribution until every release blocker is closed.
