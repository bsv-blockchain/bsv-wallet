# R1 comb-verifier locking script — engineering analysis

Consolidated from the map / reproduce / verify / variant phases of the 2026-09-09 analysis. Every claim carries a
verification tag:

- **[E:file]** verified by execution — the `@bsv/sdk` 2.4.1 `Spend` interpreter (JS path, `validateJavaScript`) and/or
  `@noble/curves` 2.3.0 `p256` were the oracles; `file` is the scratchpad script that produced the evidence.
- **[B]** verified by decoding the fixture bytes (chunk listing `lock.asm.txt`, or programmatic chunk decoding in
  `consolidate-verify.mjs`).
- **[S]** verified by reading source (`@bsv/sdk` `Spend.js`, repo spec files).
- **[I]** inferred (algebra, probability, or reasoning) — not exercised end-to-end.

Environment: node v24.15.0, `@bsv/sdk` 2.4.1, `@noble/curves` 2.3.0, macOS (Darwin 25.6.0). All scripts live in the
scratchpad `/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad`
(referred to as `$S` below); the repo was not modified.

---

## 1. Executive summary

**What the script is.** A 29,584-byte BSV locking script (23,067 chunks) that verifies a **NIST P-256 (secp256r1)
ECDSA signature** entirely in Script and binds it to the spending transaction with an **OP_PUSH_TX** trick. The
unlocker pushes `(r, s, s⁻¹ mod n, hashOutputs, outpoint)`. The script rebuilds the 158-byte BIP143 sighash
preimage from those two fields plus baked constants (version 1, one input with sequence `ffffffff`, amount 4600 sat,
locktime 0, sighash `0x41`), hashes it to `e`, computes `u1 = e·s⁻¹`, `u2 = r·s⁻¹ (mod n)`, evaluates
`R = u1·G + u2·Q` with a **6-row × 43-column fixed-base comb** over both bases simultaneously (Shamir), using
**Jacobian coordinates with lazy reduction mod p** (1,419 big-number multiplications, 387 reductions), then checks
`Z ≠ 0 ∧ X ≡ r·Z² (mod p)`. Finally it turns the same preimage into a **secp256k1 signature with nonce k = 1** for a
public dummy key and runs `OP_CODESEPARATOR OP_CHECKSIG`, which forces the in-script preimage to equal the real one
(OP_PUSH_TX). It relies on the Chronicle opcodes `OP_RSHIFTNUM` (0xb7) and `OP_2MUL` (0x8d). It replaces the
previous ~960 KB R1K1 vault template (`@bsv/templates` `R1K1Wallet`, see `old-r1k1.ts`) — 32× smaller.

**Sizes.** Lock 29,584 B / 23,067 chunks (sha256 `a4864c04…a55654`); unlock 170 B (5 pushes); the fixture spend tx
is 231 B. [E:consolidate-verify.mjs]

**Validation time.** `Spend.validate()` in the SDK's JS interpreter: 23,071 steps; median 37.7 ms (min 33.6, mean
38.7, n = 15, first call 50.7 ms) on this machine today [E:consolidate-verify.mjs]; 33.6–33.8 ms mean over 700 runs
in `fuzz.mjs` [E:fuzz.mjs]; CONTEXT.md quoted ~49 ms. The gen2 variant validates in the same time (34–40 ms).
Node C++ validation time was not measured [I].

**What was proven (by execution).**
1. The fixture validates; every intermediate (preimage, `e`, `u1`, `u2`, the recoded scalars, every Jacobian
   intermediate in a doubling and a mixed addition, the accumulator at 17 column boundaries, the final `X ≡ r·Z²`
   test, and the exact 71-byte signature handed to `OP_CHECKSIG`) matches an independent JS/noble model.
2. `gen.mjs` regenerates the fixture **byte-for-byte** from `(Q, satoshis)` with no literal hex regions (three
   structural literals only: `00`, `01ac`, `30`); other `(Q, satoshis)` change exactly chunk 12 and chunks 151–214.
3. Fresh random keys / amounts / outputs / locktimes spend successfully in every fuzz run: 700 randomized spends
   [E:fuzz.mjs], 94 rounds [E:unlock.mjs], 42 hand-picked encoding classes out of 400,000 genuine signatures
   [E:review3-encodings.mjs], 3 constructed `R.x ≥ n` signatures [E:review4-rgen.mjs], 250 + 270 preimage-class
   representatives [E:edge.mjs, edge_sweep.mjs]; 27 negative cases fail at the predicted program counter.
4. The only intrinsic failure mode of an honest spend is a **2⁻¹⁶-probability MINIMALDATA abort at pc 22986** inside
   the OP_PUSH_TX `s`-serialisation loop; it is a pure function of the preimage, screened by `pushTxDerCheck` before
   signing, and cleared by perturbing an output.
5. A generalized **1-of-N commit-to-table variant** (`gen2.mjs`) with a 27,855 B lock (N = 1), amount/sequence/
   locktime-agnostic, multi-input capable, byte-identical comb core, validated in 600+ randomized spends and 52
   negative/positive checks.
6. Security review: no authorization bypass found; one MEDIUM finding (third-party txid malleability of the P-256 leg,
   present in the original and in gen2; a +116 B fix was verified), one LOW finding (version-2 spends lose MINIMALDATA
   protection in gen2), plus an unfixed app-side defect (external signer is called before the pre-sign screen in both
   async unlockers).

---

## 2. Fixture facts

Both fixtures are testnet, mined in block 1,755,177 (per CONTEXT.md; not re-verified against a node).

| Item | Value | Tag |
|---|---|---|
| Deposit tx / output | `51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a` : 0, 4600 sat | [B] |
| Locking script file | `docs/example-txs/51c5…579a_0.hex` (59,168 hex chars = 29,584 B) | [E] |
| Locking script | 29,584 B, 23,067 chunks, sha256 `a4864c048ff95df1aaf10d0bf50ab1e5c3de97fbe6bfffaf045fcd0bfca55654` | [E:consolidate-verify.mjs] |
| Spend tx | `476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80`, 231 B, version 1, locktime 0, 1 input (seq `ffffffff`), 1 output (4500 sat, script `51` = `OP_1`) | [E] |
| Unlocking script | 170 B, 5 pushes of 33/32/32/32/36 B | [E] |
| `r` | `e3c4329684a494d2db1c99234f136d9b941c4274f40befe976b546c130f9f7c7` (≥ 2²⁵⁵ → 33-B push with trailing `00`) | [E] |
| `s` | `401a6223caf9c7b57188e354044d52687ed2c69f975bc4c075369d44199d67e9` (low-S) | [E] |
| `sInv` | `6aac6ed7578a70ca6158d0615898724d4a0752126d86e5adb4aacbc064d0a7ae` = `s^(n−2) mod n` | [E] |
| `hashOutputs` | `b52efb4a0c9d8c5d18f340eed513757e3fe2c9b5973a67474bfbbe5a326b199b` | [E] |
| `outpoint` | `9a57d392…3034c551` `00000000` (byte-reversed txid ‖ vout LE32) | [E] |
| Signer key Q | `03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d` (compressed P-256) — recovered from the Q comb table; chunks 151–214 equal `combTable(Q)` | [E:recoverQ.mjs, consolidate-verify.mjs] |
| Preimage (158 B) | equals `TransactionSignature.format({subscript: Script('ac'), scope: 0x41, …})` byte-for-byte (stack top at pc 22) | [E:map-header.mjs, consolidate-verify.mjs] |
| `hash256(preimage)` | `0bd94d7d0883ed0e47d4bbc903845542857cb072a85b45c7a6484f7ff532620e` | [E] |
| `e` (P-256 leg, LE view) | `0e6232f57f4f48a6c7455ba872b07c8542558403c9bbd4470eed83087d4dd90b` (< n; 32-B scriptnum since byte 31 = 0x0e) | [E] |
| `e_k1` (PUSH_TX leg, BE view) | `0bd94d7d0883ed0e47d4bbc903845542857cb072a85b45c7a6484f7ff532620e` | [E] |
| `u1 = e·sInv mod n` | `051fd0dba16ab0f7a8ba9127e52a45c1316ab230f807d243ec88788eb1d8d2e6` (even → +n branch) | [E] |
| `u2 = r·sInv mod n` | `2acbe6a3c42ed3d10500ba4a2843f40c1f5aaa0c965e3521f88cac4f5cb8679e` (even → +n branch) | [E] |
| Comb digits used | col0 +TG[8] +TQ[14]; col1 −TG[15] −TQ[16]; col2 +TG[23] +TQ[23]; col42 +TG[1] −TQ[12]; 45 of 86 adds negate | [E:map-column.mjs] |
| PUSH_TX signature | `3044 0220 79be…1798 0220 0cd94d7d…620e 41` (71 B incl. sighash); `s_k1 = e_k1 + 2²⁴⁸` (no wrap, below n/2) | [E:map-tail.mjs, consolidate-verify.mjs] |
| Curve constants | p = `ffffffff00000001 0000000000000000 00000000ffffffff ffffffffffffffff`, n = `ffffffff00000000 ffffffffffffffff bce6faada7179e84 f3b9cac2fc632551`, a = p − 3 | [B] |

Interpreter behaviour relied on (SDK 2.4.1, verified [E:map-header.mjs] / [S]): `OP_DIV` truncates toward zero;
`OP_MOD` takes the dividend's sign; `OP_BIN2NUM` minimal-encodes; `OP_NUM2BIN` minimal-encodes its input before
padding; `castToBool` for `OP_NOTIF` treats `0x81` as true; MINIMALIF is not enforced. With no explicit
`verifyFlags`, `shouldEnforceMinimalData()` (and CLEANSTACK, SIGPUSHONLY, LOW_S, strict DER) return
`!isRelaxed()`, `isRelaxed() = isRelaxedOverride || transactionVersion > 1` [S: Spend.js; E:consolidate-verify.mjs §9].

---

## 3. Unlocking script format

Five data pushes, push-only, bottom → top [E:map-header.mjs]:

```
21 ‖ r (33 B)   20 ‖ s (32 B)   20 ‖ sInv (32 B)   20 ‖ hashOutputs (32 B)   24 ‖ outpoint (36 B)     = 170 B (fixture)
```

Rules (each verified by execution unless tagged):

| Field | Semantics | Encoding rule |
|---|---|---|
| `r` | **Full affine x of R = u1·G + u2·Q as an integer in [0, p)** — not the signer's `r mod n`. The script enforces both `r ≡ r_sig (mod n)` (through `u2`) and `X ≡ r·Z² (mod p)` (tail). Verified with 3 constructed signatures whose `R.x ≥ n`: pushing `x` validates, pushing `x mod n` fails at pc 22665 [E:review4-rgen.mjs]. | Minimal script number `BigNumber(v).toSm('little')`: LE magnitude, strip high zero bytes, append `00` iff top bit set → 33 B iff v ≥ 2²⁵⁵, 32 B for [2²⁴⁷, 2²⁵⁵), 31 B for [2²³⁹, 2²⁴⁷) etc. Sizes 30–33 B all validated [E:review3-encodings.mjs]. |
| `s` | Signature `s`; any value ≢ 0 (mod n). **High-S is accepted** (no low-S rule on the P-256 leg) [E:edge.mjs, adv-review.mjs]. | Minimal script number (32 B typical; 31/30 B when small; 33 B for high-S ≥ 2²⁵⁵). |
| `sInv` | Must satisfy `s·sInv ≡ 1 (mod n)` (checked at chunk 41). Canonical: `s^(n−2) mod n`. | Minimal script number. |
| `hashOutputs` | `hash256(⨁ outputs: value LE64 ‖ varint(len) ‖ script)` — raw 32 bytes, only concatenated, never read as a number. | `20 ‖ 32 B`. |
| `outpoint` | Raw 36 bytes: txid as it appears in the raw tx (display txid reversed) ‖ vout LE32. | `24 ‖ 36 B`. |

Rejections observed [E:map-header.mjs, review3-encodings.mjs]: zero-padded (non-minimal) `r`/`s`/`sInv` →
`non-minimally encoded script number` at the first numeric read (pc 35 for `s`/`sInv`, pc 52 for `r`); `r ≥ 2²⁵⁵`
pushed without its `00` sign byte → read as negative, fails at pc 22665; PUSHDATA1 push opcode → rejected at pc 0
(`not minimally-encoded`); `s ≡ 0` or wrong `sInv` → pc 41 `OP_NUMEQUALVERIFY`; wrong `hashOutputs`/`outpoint` with
the original signature → pc 22665; a signature *over* a wrong preimage (wrong outpoint, wrong outputs, wrong
sequence, second input, other locktime, other amount, version 2) → P-256 leg passes, final `OP_CHECKSIG` false at
pc 23067 (this is the OP_PUSH_TX binding) [E:fuzz.mjs].

Accepted-but-non-canonical (malleability, §10): `s + k·n`, `sInv + k·n`, `(n − s, n − sInv)`, `(−s, −sInv)`,
`(s − n, sInv − n)`, `r + k·p·n` (65-B push) all validate [E:map-header.mjs, adv-review.mjs].

Spending-transaction constraints imposed by the **baked** preimage fields (enforced only by the final CHECKSIG):
version 1, exactly one input (hashPrevouts = hash256(outpoint), hashSequence = hash256(`ffffffff`)), sequence
`ffffffff`, input value exactly 4600 sat, locktime 0, sighash `0x41`; outputs free (bound through `hashOutputs`).

---

## 4. Locking script region map

Chunk indices are 0-based; byte offsets are of the serialized script. Table produced by
`consolidate-verify.mjs` §3 [E]; region semantics from the map phase [E:map-header.mjs, map-column.mjs, map-tail.mjs].

| Region | Chunks (count) | Bytes (size) | Purpose |
|---|---|---|---|
| A preimage rebuild | 0–21 (22) | 0–51 (52 B) | `DUP HASH256` (hashPrevouts) `<01000000> SWAP CAT <ffffffff> HASH256 CAT SWAP CAT <01ac> CAT <f811000000000000> CAT <ffffffff> CAT SWAP CAT <00000000> CAT <41000000> CAT` → 158-B preimage |
| B e = LE(hash256) | 22–28 (7) | 52–59 (8 B) | `DUP HASH256 <00> CAT BIN2NUM SWAP TOALTSTACK` — e as unsigned LE scriptnum; preimage → alt |
| C n, s·sInv ≡ 1 | 29–41 (13) | 60–105 (46 B) | `<n> TOALTSTACK 2 PICK 2 PICK MUL MODP 1 NUMEQUALVERIFY` |
| D u1, u2 | 42–56 (15) | 106–120 (15 B) | `OVER MUL MODP` (u1) `3 PICK 2 PICK MUL MODP` (u2); modulus fetched with `FROMALTSTACK DUP TOALTSTACK` |
| E drop s, sInv | 57–62 (6) | 121–126 (6 B) | `2 ROLL DROP 2 ROLL DROP` → `[r u1 u2]` |
| F recode u2 | 63–74 (12) | 127–204 (78 B) | `DUP 2 MOD NOTIF <n> ADD ENDIF <2²⁵⁸−1> ADD 2 DIV SWAP` |
| G recode u1 | 75–86 (12) | 205–282 (78 B) | same; ends `SWAP` → `[r u1' u2']` |
| H G comb table | 87–150 (64) | 283–2418 (2136 B) | `TG[j].x, TG[j].y` for j = 0..31 (chunks 87+2j, 88+2j) |
| I Q comb table | 151–214 (64) | 2419–4559 (2141 B) | `TQ[j].x, TQ[j].y` (chunks 151+2j, 152+2j) — the per-key region |
| J push p | 215 (1) | 4560–4593 (34 B) | `<p>` (33-B scriptnum) |
| K pre-loop | 216–221 (6) | 4594–4599 (6 B) | `FROMALTSTACK DROP` (discard n) `TOALTSTACK` (p → alt) `1 1 0` (acc = Jacobian ∞) |
| L col0 DOUBLE | 222–332 (111) | 4600–4710 (111 B) | doubles (1,1,0) → (1,1,0) |
| M col0 ADD_G (guarded) | 333–552 (220) | 4711–4956 (246 B) | includes the 15-chunk identity guard (chunks 415–428 + ENDIF 552) |
| N col0 ADD_Q | 553–757 (205) | 4957–5185 (229 B) | |
| O col1 | 758–1278 (521) | 5186–5754 (569 B) | `DOUBLE ADD_G ADD_Q` |
| P cols 2..41 | 1279–22118 (20840) | 5755–28482 (22728 B) | 40 columns; 569 B each for c ≤ 25, 567 B for c ≥ 26 |
| Q col42 DOUBLE | 22119–22229 (111) | 28483–28593 (111 B) | 43rd and last doubling |
| R col42 ADD_G | 22230–22434 (205) | 28594–28822 (229 B) | |
| S col42 ADD_Q | 22435–22639 (205) | 28823–29049 (227 B) | loop ends at 22639 (`2 ROLL 2 ROLL 2 ROLL`) |
| T tail: r-check | 22640–22665 (26) | 29050–29077 (28 B) | `DUP 0 NUMEQUAL NOTIF DUP DUP MUL MODP <134> PICK OVER MUL MODP 4 PICK NUMEQUAL ELSE 0 ENDIF VERIFY` |
| U drop p | 22666–22667 (2) | 29078–29079 (2 B) | `FROMALTSTACK DROP` |
| V clear | 22668–22735 (68) | 29080–29147 (68 B) | 67 × `OP_2DROP` + `OP_DROP` → 135 items removed, depth 0 |
| W PUSH_TX hash/reverse | 22736–22863 (128) | 29148–29276 (129 B) | `FROMALTSTACK <41> TOALTSTACK HASH256`, 31 × `1 SPLIT`, 31 × `SWAP CAT` |
| X PUSH_TX scalar | 22864–22894 (31) | 29277–29342 (66 B) | `<00> CAT BIN2NUM  0 <1f> NUM2BIN 1 CAT ADD  <n_k1> TUCK 2 DIV OVER LESSTHAN IF OVER MOD OVER 2 DIV OVER LESSTHAN IF SUB ELSE NIP ENDIF ELSE NIP ENDIF` |
| Y PUSH_TX s → BE bytes | 22895–23049 (155) | 29343–29497 (155 B) | 31 × `DUP 0NOTEQUAL SPLIT`, 31 × `SWAP CAT` |
| Z DER assembly | 23050–23063 (14) | 29498–29547 (50 B) | `SIZE SWAP CAT <02 20 Gx 02> SWAP CAT SIZE SWAP CAT <30> SWAP CAT FROMALTSTACK CAT` |
| AA verify | 23064–23066 (3) | 29548–29583 (36 B) | `<pubkey 02b405…83b0> OP_CODESEPARATOR OP_CHECKSIG` |

Column start formula: `colStart(c) = 222 + (c == 0 ? 0 : 536 + 521·(c − 1))`; col0 = 536 chunks (586 B), cols 1–25 =
521 chunks (569 B), cols 26–42 = 521 chunks (567 B, one shift constant is `OP_n`/`OP_0` instead of a 1-byte push)
[E]. Byte accounting by generator region [E:map-uniformity.mjs]: header 0–86 = 283 B; tables 4277 B; p 34 B; pre-loop
6 B; loop 22418 chunks / 24,450 B; tail 427 chunks / 534 B; total 23,067 chunks / 29,584 B.

Static census [E:consolidate-verify.mjs §4]: 1,320 data pushes (largest 35 B; no PUSHDATA1/2/4; size histogram
1 B × 313, 2 B × 864, 4 B × 5, 8 B × 1, 32 B × 75, 33 B × 61, 35 B × 1); opcodes: ROLL 2797, DUP 1849, PICK 1813,
MUL 1424, SUB 947, MOD 911, TO/FROMALTSTACK 871 each, OVER 780, ADD 779, 2MUL 688, RSHIFTNUM 516, ENDIF 479,
NUMEQUAL 433, IF 390, LESSTHAN 389, SWAP 330, DROP 94, NOTIF 89, CAT 79, 2DROP 67, SPLIT 62, 0NOTEQUAL 31,
HASH256 4, DIV 4 (chunks 73, 85, 22876, 22884), ELSE 4, BIN2NUM 2, NIP 2, SIZE 2, NUMEQUALVERIFY 1, VERIFY 1,
NUM2BIN 1, TUCK 1, CODESEPARATOR 1, CHECKSIG 1. Non-push opcodes above `OP_16`: 16,712 (upper bound on the
MaxOpsPerScript count).

Dynamic [E:consolidate-verify.mjs §2, map-column-stats.mjs]: 23,071 interpreter steps; peak main-stack depth 140
(inside MADD), peak alt depth 4 (col0 guard); largest stack item 352 B (first at pc 1026, `R·(I − X3)` in MADD);
384 normalisations executed in the loop, 128 of which added p (fixture-specific).

---

## 5. Algorithm: ECDSA verification via a fixed-base comb

### 5.1 Mathematics

Standard ECDSA verification of `(r, s)` on message hash `e` under key `Q`:
`u1 = e·s⁻¹ mod n`, `u2 = r·s⁻¹ mod n`, `R = u1·G + u2·Q`, accept iff `R ≠ O` and `R.x ≡ r (mod n)`.

Script variant [E:map-header.mjs, map-tail.mjs]:
- `s⁻¹` is supplied by the unlocker and checked: `(s·sInv) mod n == 1` (chunk 41). `e` is **not** reduced mod n
  (harmless: `(e·sInv) mod n` absorbs it).
- The comparison is projective and exact in F_p: `Z ≠ 0 ∧ X ≡ r·Z² (mod p)` where `x(R) = X/Z²`. Hence the pushed `r`
  must be the full affine x. Because `u2` uses `r mod n`, `r` and `r + n` yield the same `R`; the tail then requires
  `r ≡ x(R) (mod p)` — for `x(R) ≥ n` (probability `(p − n)/p ≈ 2⁻¹²⁹`, `p − n = 0x4319055358e8617b0c46353d039cdaae`)
  the unlocker pushes `x(R)` itself. Verified by construction [E:review4-rgen.mjs].

### 5.2 Scalar recoding (chunks 63–86)

For `u ∈ [0, n−1]`: `uOdd = u + n·[u even]` (odd, in `[1, 2n−1]`); `u' = (uOdd + 2²⁵⁸ − 1) / 2` (exact division).
Then `uOdd = 2u' − (2²⁵⁸ − 1) = Σ_{i=0}^{257} d_i·2^i` with `d_i = 2·bit_i(u') − 1 ∈ {−1, +1}` — 258 signed
non-zero digits. Since `n·P = O`, the comb computes `uOdd·P = u·P`. Bounds: `u'(u=1) = 2²⁵⁷`, `u'(u=n−1) = n + 2²⁵⁷ − 1
< 2²⁵⁷ + 2²⁵⁶`, so bit 257 is always 1, `u' < 2²⁵⁸`, and `u'` is always a 33-byte scriptnum with top byte `0x02`
(fits 6 × 43 = 258 digits). The constant at chunks 70 and 82 is `2²⁵⁸ − 1` (`ff`×32 `03`), **not** `2²⁵⁴ − 1` as
CONTEXT.md line 29 states. [E:map-header.mjs (26 parity/edge cases), consolidate-verify.mjs; B]

### 5.3 Comb tables (chunks 87–214)

Column `c ∈ [0, 42]` consumes the six digits at positions `43k + 42 − c`, `k = 0..5`:
`d_{42−c}, d_{85−c}, d_{128−c}, d_{171−c}, d_{214−c}, d_{257−c}`. Their contribution to `u·P` is
`2^{42−c} · (Σ_k d_{43k+42−c}·2^{43k}) · P = 2^{42−c} · σ · T_j · P` where `σ = d_{257−c}` (sign digit, k = 5) and
`j`'s bit k (k < 5) is 1 iff `d_{43k+42−c} = σ` (XNOR with the sign). Table entry
`T_j = 2²¹⁵ + Σ_{k<5} (bit_k(j) ? +1 : −1)·2^{43k}`, `j = 0..31`; the script stores the 32 affine points `T_j·G`
(chunks 87+2j x, 88+2j y) and `T_j·Q` (151+2j, 152+2j), each coordinate as a minimal scriptnum (32 B, 33 B with `00`
iff ≥ 2²⁵⁵, 31 B iff < 2²⁴⁸; fixture: 75 × 32 B, 53 × 33 B, none short). All 64 points match noble
[E:comb.mjs, map-uniformity.mjs, consolidate-verify.mjs]. Horner over c = 0..42, `acc ← 2·acc + σ₁·TG[j₁] + σ₂·TQ[j₂]`,
yields `u1·G + u2·Q` (verified at 17 column boundaries against noble partial sums [E:map-column.mjs]). Column 0's sign
digits are always +1 (bit 257).

### 5.4 Stack layout and per-column operations

Main stack at loop entry (chunk 222) and at every block boundary, bottom → top (134 items) [E:layout probes]:
`[r, u1', u2', C[0..127], X, Y, Z]` where `C[2j], C[2j+1] = TG[j].x, y` and `C[64+2j], C[65+2j] = TQ[j].x, y`.
Altstack `[preimage, p]`; `p` is only ever read with `FROMALTSTACK DUP TOALTSTACK` ("MODP" = that + `OP_MOD`).
Accumulator initialised to `(1, 1, 0)` = Jacobian infinity (chunks 219–221); the first DOUBLE maps it to itself.

Per column, DOUBLE-first: `DOUBLE (111 chunks); ADD(u1', TG) (205 chunks; 220 in col0); ADD(u2', TQ) (205 chunks)`.
There is **no** doubling after column 42 — chunk 22640 starts the tail. (CONTEXT.md's grouping with the DOUBLE at the
*end* of each column is the same byte stream shifted by one DOUBLE; under it "column 42" is only 410 chunks and the
tail starts at 22640, not 22751.) [E:coldiff.mjs, map-uniformity.mjs]

**ADD(s, c)** (s = 0 for u1'/TG with depth base D = 132 = 0x84 and table base T = 132; s = 1 for u2'/TQ with D = 131,
T = 68 = 0x44) [E:map-column.mjs, map-uniformity.mjs — regenerated byte-identical for all 43 columns]:

```
<D>   PICK <257−c> RSHIFTNUM 2 MOD                       → σ (sign digit as bit)
<D+1> PICK <214−c> RSHIFTNUM 2 MOD OVER NUMEQUAL 2MUL     → j = 2·(b4 == σ)
<D+2> PICK <171−c> RSHIFTNUM 2 MOD 2 PICK NUMEQUAL ADD 2MUL   (k = 3)
<D+2> PICK <128−c> RSHIFTNUM 2 MOD 2 PICK NUMEQUAL ADD 2MUL   (k = 2)
<D+2> PICK <85−c>  RSHIFTNUM 2 MOD 2 PICK NUMEQUAL ADD 2MUL   (k = 1)
<D+2> PICK <42−c>  RSHIFTNUM 2 MOD 2 PICK NUMEQUAL ADD        (k = 0)   → [.. X Y Z σ j]
DUP 2MUL <T> SWAP SUB PICK                                → x_j = C[64s + 2j]
OVER 2MUL <T> SWAP SUB PICK                               → y_j = C[64s + 2j + 1]   (same T: stack one deeper)
2 ROLL DROP 2 ROLL                                        → [.. X Y Z x y σ]
NOTIF FROMALTSTACK DUP TOALTSTACK SWAP SUB ENDIF          → y := p − y when σ = 0  (operand = σ·T_j·Base)
[col0, s=0 only: 2 PICK 0 NUMEQUAL IF TOALTSTACK TOALTSTACK DROP DROP DROP FROMALTSTACK FROMALTSTACK 1 ELSE]
MADD (123 chunks)
[col0, s=0 only: ENDIF]
```

The depth constants are column-invariant because every block is depth-neutral (134 → 134); `PICK` pops its operand
first, so the item that was k-th from top before the push is addressed by pushing `k`. The only per-column bytes are
the six shift constants `257 − c − 43k` (each emitted twice), minimal-encoded: 128..257 → 2-byte push (`xx 00` or
`00 01`/`01 01`), 17..127 → 1-byte push, 1..16 → `OP_1..OP_16`, 0 → `OP_0` (census over 516 constants: PUSH2 260,
PUSH1 222, OP_N 32, OP_0 2) [E:map-uniformity.mjs].

**Column-0 identity guard**: only the first mixed addition is guarded (if `Z == 0`, `acc := (x, y, 1)`); the DOUBLE of
`(1,1,0)` is `(1,1,0)` so needs no guard, and after col0's G-add the accumulator is never infinity again except in the
negligible `acc = ±T` cases (§11). Verified: IF branch taken at chunk 419; acc = `(TG[8].x, TG[8].y, 1)` at 552
[E:map-column.mjs].

### 5.5 Point representation and formulas

Jacobian `(X, Y, Z)`, `x = X/Z²`, `y = Y/Z³`, infinity `(1, 1, 0)`; relation verified at 9 column boundaries
(standard-projective `X = x·Z` fails at all of them) [E:map-column.mjs]. All intermediates are unreduced
arbitrary-precision scriptnums; **only the three outputs** of each block are reduced, each by
`MODP` then `NORM = DUP 0 LESSTHAN IF FROMALTSTACK DUP TOALTSTACK ADD ENDIF` (BSV `OP_MOD` keeps the dividend's sign).
Every intermediate below was matched bit-exactly against the live stack in column 1 [E:map-column.mjs].

**DOUBLE** (a = −3, "dbl-2001-b" family; 111 chunks; 11 `OP_MUL`, 3 MODP+NORM):
```
Z² ; M = 3·(X − Z²)·(X + Z²) ; Y² ; S = 4·X·Y² ; M² ;
X3 = (M² − 2S) mod p ; Y3 = (M·(S − X3) − 8·Y⁴) mod p ; Z3 = (2·Y·Z) mod p
```
Sizes: M ≈ 129 B, S ≈ 97 B, M² ≈ 257 B, M·(S−X3) ≈ 225 B, 8Y⁴ ≈ 129 B. Contains two `1 ROLL 1 ROLL` no-op pairs and
a trailing `2 ROLL 2 ROLL 2 ROLL` (identity) that must be emitted for byte-exactness.

**MADD** (Jacobian + affine, no a-dependence, no H = 0 special case; 123 chunks; 11 `OP_MUL`, 3 MODP+NORM):
```
Z² ; U2 = x·Z² ; Z³ ; S2 = y·Z³ ; H = U2 − X ; R = S2 − Y ; H² ; H³ ; I = X·H² ; R² ;
X3 = (R² − H³ − 2I) mod p ; Y3 = (R·(I − X3) − Y·H³) mod p ; Z3 = (Z·H) mod p
```
Sizes: U2 96 B, S2 128 B, H² 192 B, H³ 288 B, I 224 B, R² 256 B, **R·(I − X3) 352 B (largest item in the script)**,
Y·H³ 320 B. If `acc = ±P` (H = 0) the result is garbage with Z3 = 0 and the tail's `Z ≠ 0` check fails [I].

Per column: 33 `OP_MUL` (11 + 11 + 11), 9 MODP reductions, 9 NORM conditionals, 12 `RSHIFTNUM` + 12 `2 MOD` digit
extractions, 2 table lookups, 2 conditional negations. Totals derived from the static census: MUL 1424 = 3 (header)
+ 43·11 + 86·11 + 2 (tail); MOD 911 = 2 (recode parity) + 3 (header) + 516 (digit parity) + 387 (MODP) + 2 (tail) + 1
(PUSH_TX mod n); IF 390 = 387 NORM + 1 guard + 2 tail [B, arithmetic].

### 5.6 Final check (chunks 22640–22665)

```
DUP 0 NUMEQUAL NOTIF                      ; Z ≠ 0 ?
  DUP DUP MUL MODP                        ; Z² mod p
  <134> PICK OVER MUL MODP                ; r·Z² mod p   (r is item 134 from the top = stack bottom)
  4 PICK NUMEQUAL                         ; X == r·Z² ?
ELSE 0 ENDIF VERIFY
```
No inversion (the four `OP_DIV` are the two `/2` in the recode and the two `/2` in the PUSH_TX low-S block) [B].
Leaves Z² on the stack (depth 135), then `FROMALTSTACK DROP` removes p and 67 × `OP_2DROP` + `OP_DROP` empties the
stack (depth 0 at pc 22736) [E:consolidate-verify.mjs].

---

## 6. OP_PUSH_TX tail (chunks 22736–23066)

### 6.1 Mechanism

```
FROMALTSTACK <41> TOALTSTACK HASH256               ; H = hash256(preimage); sighash byte parked on alt
(1 SPLIT)×31 (SWAP CAT)×31                         ; reverse H → big-endian
<00> CAT BIN2NUM                                   ; e_k1 = BE integer of H
0 <1f> NUM2BIN 1 CAT ADD                           ; m = e_k1 + 2^248
<n_k1> TUCK 2 DIV OVER LESSTHAN                    ; m > (n−1)/2 ?
IF OVER MOD OVER 2 DIV OVER LESSTHAN IF SUB ELSE NIP ENDIF ELSE NIP ENDIF     ; t = m mod n; s = t > (n−1)/2 ? n − t : t
(DUP 0NOTEQUAL SPLIT)×31 (SWAP CAT)×31            ; s → its scriptnum bytes reversed (= minimal BE with DER pad)
SIZE SWAP CAT <02 20 Gx 02> SWAP CAT SIZE SWAP CAT <30> SWAP CAT      ; DER: 30 len 02 20 Gx 02 len s
FROMALTSTACK CAT                                   ; ‖ 0x41
<02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0> OP_CODESEPARATOR OP_CHECKSIG
```

The pubkey is `d·G` on secp256k1 with `d = 2²⁴⁸ · Gx⁻¹ mod n_k1 = d475289d7db690543c1ecbd9ed0d6c9a2e5920ecebf361bdcca0d61f77af4839`
(public by construction); with nonce k = 1, `r = Gx` and `s = k⁻¹(e + r·d) = e + 2²⁴⁸ (mod n)`, so the assembled
signature is valid for the **in-script** preimage. `OP_CODESEPARATOR` makes the CHECKSIG subscript exactly `ac`, which
is why the in-script preimage bakes scriptCode `01 ac`. `OP_CHECKSIG` hashes the **real** preimage; the two agree iff
every baked field matches the spending tx. Verified: the stack item below the pubkey at pc 23066 equals
`pushTxSignature(preimage)` byte-for-byte (71 B), `PrivateKey(d).toPublicKey()` equals chunk 23064
[E:map-tail.mjs, consolidate-verify.mjs]; every baked-field mismatch fails at pc 23067 [E:fuzz.mjs].

### 6.2 Edge cases of the assembled DER (over uniform preimages)

The `s` INTEGER is `reverse(minimal LE scriptnum(s))`: the scriptnum's `00` sign byte becomes the DER `00` pad, so
the INTEGER is **always valid strict DER for s > 0** — including `s ∈ [2²⁴⁷, 2²⁴⁸)` (`02 20 00 …`, 3 constructed cases
validate). The map-phase prediction of a ~1/263 "negative-S" rejection was **wrong** and is superseded
[E:edge-tests.mjs, edge.mjs]. Strict DER + LOW_S are enforced by the SDK for v1 txs; LOW_S never bites (s ≤ (n−1)/2
by construction) [S, E:derprobe.mjs].

Classification over 8,000,000 Monte-Carlo preimages with each class run through `Spend.validate()` [E:edge.mjs]:

| Class | Condition (n = n_k1, m = e_k1 + 2²⁴⁸) | s | Validates | Frequency (MC) | Closed form |
|---|---|---|---|---|---|
| bulk | m ≤ (n−1)/2 | m ∈ [2²⁴⁸, (n−1)/2] | yes (pc 23067) | 49.6243 % | ½ − 2⁻⁸ |
| (a) low-S flip | (n−1)/2 < m < n | n − m | yes unless peel-fail | 49.9841 % | ≈ ½ |
| (d) wraparound | m ≥ n | m − n (< 2²⁴⁸) | yes unless peel-fail | 0.3917 % | 2⁻⁸ |
| (b) s < 2²⁴⁸ | subset of (a)+(d) | leading-zero region | yes unless peel-fail | 0.7823 % | 2⁻⁷ |
| (c) s ≥ 2²⁵⁵ | unreachable: (n−1)/2 < 2²⁵⁵ | — | — | 0 / 8e6 | 0 |
| **PEEL-NONMINIMAL** | scriptnum(s) ≤ 31 B **and** ends in a `00` sign byte ⇔ msb(s) ≥ 0x80 ∧ s < 2²⁴⁰ | s ∈ ⋃_{L=1..30} [2^{8L−1}, 2^{8L}) | **no — abort pc 22986 `non-minimally encoded script number`** | 0.0016 % (128 / 8e6 = 1/62,500) | 2⁻¹⁶ |
| s = 0 | e_k1 ≡ −2²⁴⁸ (mod n) | empty INTEGER | no | 0 | 2⁻²⁵⁶ |

Mechanism of the peel failure: `(DUP 0NOTEQUAL SPLIT)×31` reads the not-yet-peeled remainder as a *number* 31 times;
when the scriptnum has ≤ 31 bytes and ends in `00`, the k-th peel (k = its length − 1) inspects a lone `00`, which is
a non-minimal number under MINIMALDATA. The 32-byte case only peels 31 times and is safe. Reproduced deterministically
in the interpreter on 9 distinct preimages; 250 predicate-OK preimages all validate; predicate ↔ interpreter agreement
on 270+ cases [E:edge.mjs, edge_sweep.mjs, find-fail.mjs]. Boundary table of the pure model
[E:consolidate-verify.mjs §6]:

| s | scriptnum | peel verdict |
|---|---|---|
| 2²⁴⁸ − 1, 2²⁴⁷ | 32 B, sign byte | ok |
| 2²⁴⁷ − 1, 2²⁴⁰ | 31 B, no sign byte | ok |
| 2²⁴⁰ − 1, 2²³⁹ | 31 B, sign byte | REJECT (k = 30) |
| 2²³⁹ − 1, 2²³² | 30 B, no sign byte | ok |
| 2²³¹ | 30 B, sign byte | REJECT (k = 29) |
| 255, 128 | 2 B, sign byte | REJECT (k = 1) |
| 127, 1 | 1 B | ok |

### 6.3 App-side predicate (evaluate BEFORE requesting the hardware signature)

Pure function of the preimage; independent of the P-256 signature. Implemented as `pushTxDerCheck(preimage)` in
`unlock.mjs` (`peelLoopNonMinimalAt` models the loop exactly) [E]:

1. `preimage` = BIP143 preimage as the lock rebuilds it (subscript `ac`, scope `0x41`; for the original lock the only
   free field is `hashOutputs`).
2. `e = int_BE(hash256(preimage))`; `m = e + 2²⁴⁸`; `t = m mod n_k1`; `s = t > (n_k1−1)/2 ? n_k1 − t : t`.
3. SAFE ⇔ `s ≠ 0` ∧ ¬(`msb(minimalBE(s)) ≥ 0x80` ∧ `s < 2²⁴⁰`), equivalently `peelLoopNonMinimalAt(scriptNum(s)) == −1`.

**Perturbation strategy.** Original lock: version, input, sequence, amount and locktime are baked, so only outputs can
change — bump a change amount by 1 sat or add/rotate a small `OP_RETURN` nonce output; each change is an independent
2⁻¹⁶ draw (expected retries ≈ 1.00002; cap at 8 → residual 2⁻¹²⁸). gen2 lock: sequence and locktime are also free.
Re-run the predicate after each change; only then hand the signer `reverse(hash256(preimage))`. The retry loop in
`fuzz2.mjs buildSpend` (bump output 0 by −1 sat) was never triggered in 400 builds and is untested code [I].

No P-256-side perturbation is needed: the verifier accepts any `(r, s)` valid for Q (high-S included, any push size);
the unlocker recomputes `R` and pushes its full x; the only P-256 abort is `R = O` (≈ 2⁻²⁵⁶), caught before signing.

---

## 7. Signer digest convention

- P-256 leg: `e = unsigned-LE(hash256(preimage))` (chunks 22–26: `HASH256 <00> CAT BIN2NUM`). An ECDSA signer reads
  its 32-byte digest big-endian, so the app must pass **`reverse(hash256(preimage))`** (`signerDigest()` in
  `unlock.mjs`). Fixture: `hash256 = 0bd94d7d…620e`, `e = 0e6232f5…d90b` [E:map-header.mjs, consolidate-verify.mjs].
  A signer API that hashes the message internally cannot be used; the raw-digest signing path is required
  [I — device behaviour not tested here].
- OP_PUSH_TX leg: `e_k1 = BE(hash256(preimage))` — the opposite byte order (the script reverses the 32 bytes in
  chunks 22740–22863). Fixture `e_k1 = 0bd94d7d…620e` [E].
- `e` is never reduced mod n on the P-256 side; `(e·sInv) mod n` handles it. The recovered Q only matches under the
  LE convention [E:recoverQ.mjs].

---

## 8. Byte-exact generator (`gen.mjs`) and unlocker (`unlock.mjs`)

### 8.1 API

`buildLock({ qCompressedHex, satoshis, version = 1, sequence = 0xffffffff, lockTime = 0, sighash = 0x41 })` →
`LockingScript`. `bakedSatoshis(lock)`, `combTable(point)`, `combTableScalar(j)`, `shiftFor(c, k) = 257 − c − 43k`,
`encNum(v)` (minimal scriptnum push), `scriptNum(v)`, `pushData(bytes)`, a tiny `asm(text, params)` assembler.
`buildLock` rejects `version ≠ 1` (the SDK lifts MINIMALDATA for v > 1 and the script needs minimal encodings).

`unlock.mjs`: `sighashPreimage`, `signerDigest`, `pushTxSignature`, `pushTxDerCheck`, `peelLoopNonMinimalAt`,
`encodeUnlock/decodeUnlock`, `fullR({e, r, s, Q})` (recomputes `R` and its full x), `bakedParams(lock)`,
`buildUnlock({ tx, inputIndex, sourceSatoshis, lockingScript, p256PrivateKey })` (sync; screens **before** signing),
`buildUnlockAsync(a)` with `signDigest(digest32) → compact | DER` for external signers, `r1CombUnlockTemplate` (adapter
for `tx.sign()`).

### 8.2 Parameters and where they land

| Parameter | Chunk(s) | Encoding |
|---|---|---|
| Q (signer key) | 151+2j / 152+2j: `T_j·Q` x, y | minimal scriptnum per coordinate (31/32/33 B) |
| satoshis | 12 | raw 8-byte LE64 push (not `encNum`) |
| version | 2 | raw LE32 |
| sequence | 5 (hashSequence source) and 14 | raw LE32 |
| lockTime | 18 | raw LE32 |
| sighash | 20 (LE32) and 22737 (1 byte) | raw |
| Fixed: G table | 87+2j / 88+2j | computed with noble |
| Fixed: n (29, 67, 79), 2²⁵⁸−1 (70, 82), p (215), n_k1 (22873), `02 20 Gx 02` (23053), pubkey (23064) | | computed in code, not literal |
| Structural literals | `<00>` (24, 22864), `01ac` (10), `<30>` (23059) | raw |
| Shift/depth constants | 516 shifts, `132/133/134` (u1'), `131/132/133` (u2'), table bases `132/68`, tail `134` | `encNum` |

Depth arithmetic: with BELOW = 3 + 128 = 131 items under the accumulator, u1' depth = BELOW + 1 = 132, u2' = 131,
tail r-pick = BELOW + 3 = 134; 135 leftovers → 67 × `OP_2DROP` + `OP_DROP`.

### 8.3 Verification

- Byte-exact: `buildLock(fixture Q, 4600)` = fixture, 29,584 B / 23,067 chunks, sha256 identical, ~70–108 ms;
  fixture unlock validates against the generated lock (pc 23067); `sourceSatoshis 4601` fails at pc 23067
  [E:gen.mjs selfTest, review1-diff.mjs, consolidate-verify.mjs §5].
- No hidden fixture coupling: literal hex tokens in `gen.mjs` are `{00, 01ac, 30}`; 4 random keys × amounts
  {1, 123,456,789, 5·10⁹, 2.1·10¹⁵} change exactly chunk 12 and chunks 151–214; lengths differ from 29,584 by exactly
  the Q-table push-size delta; all spend [E:review2-otherQ.mjs].
- Encoding coverage: 400,000 genuine signatures bucketed by size class; 42 representatives (r/s/sInv in 30/31/32/33 B,
  high-S 33 B) all validate, bytes equal `BigNumber.toSm('little')`; non-minimal variants rejected
  [E:review3-encodings.mjs]. Short Q-table coordinate (< 2²⁴⁸ → 31 B push) locks spend [E:edge-tests.mjs].
- `R.x ≥ n`: 3 constructed signatures; full x accepted, `x mod n` rejected [E:review4-rgen.mjs].
- Non-default baked params (sequence `fffffffe`, lockTime 700,000) enforced; DER external-signer path (70/71 B)
  validates [E:review5-params.mjs].
- Fuzz: 700 randomized spends (random key, sats ≤ 2⁴⁰, 1–3 outputs of 7 script kinds incl. > 255 B, random
  lockTime baked, random vout), 700/700 valid, noble agreement 700/700; 27 negative rows fail at the predicted pc
  (41 / 22665 / 23067 / 0) [E:fuzz.mjs].
- Fixture re-derivation in `unlock.mjs`: 12 checks (preimage, e, sInv, byte-identical re-encoded unlock, `fullR().x ==
  r`, `buildUnlockAsync` with the fixture (r, s) reproduces the fixture unlock exactly) [E:unlock.mjs].

---

## 9. Generalized 1-of-N commit-to-table variant (`gen2.mjs`, `unlock2.mjs`)

### 9.1 Design

The Q comb table moves from the lock to the **unlocking script**; the lock bakes N `hash160` commitments to
`salt ‖ canonical(table)` and accepts any one of them. The unlocker also pushes the two recoded scalars (which the lock
recomputes and compares) and the whole 158-byte preimage (nothing about the tx is baked any more).

**Unlocking script** (71 pushes, bottom → top; ≈ 2,494–2,516 B, e.g. 2,503 B) [E:unlock-layout.mjs, consolidate-verify.mjs §7]:
```
#0 r (full affine x, 32/33 B)   #1 u2' = recode(r·sInv)  (33 B)   #2 u1' = recode(e·sInv) (33 B)
#3..#66  Qx0 Qy0 … Qx31 Qy31  (64 coords of T_j·Q, minimal scriptnums)
#67 salt (32 raw B)   #68 s   #69 sInv   #70 preimage (158 raw B, PUSHDATA1 → 160 B)
```

**Locking script** (N = 1: 27,855 B / 23,310 chunks) [E:layout2, consolidate-verify.mjs §7]:

| Region | Chunks (N=1) | Bytes | Content |
|---|---|---|---|
| H0 | 0–6 | 0–7 (8 B) | `DUP HASH256 <00> CAT BIN2NUM SWAP TOALTSTACK` → e; preimage → alt |
| H1 | 7–40 | 8–75 (68 B) | `<n> TOALTSTACK 2 PICK 2 PICK MUL MODP 1 NUMEQUALVERIFY OVER MUL MODP <70> PICK 2 PICK MUL MODP 2 ROLL DROP 2 ROLL DROP` (u1, u2; r is 70 deep) |
| H2 | 41–64 | 76–231 (156 B) | recode ×2 (byte-identical to gen.mjs region F/G) |
| H3 | 65–70 | 232–239 (8 B) | `<68> PICK NUMEQUALVERIFY <66> PICK NUMEQUALVERIFY` — pushed u2', u1' must equal the computed ones |
| H4 | 71–390 | 240–671 (432 B) | 64 × `<64−m> PICK <33> NUM2BIN CAT` (acc starts as salt) — canonical `salt ‖ le33(x0) ‖ … ‖ le33(y31)` (2,144 B) |
| H4' | 391 | 672 (1 B) | `OP_HASH160` |
| H5 | 392–393 | 673–694 (22 B) | N = 1: `<C0> EQUALVERIFY`; N ≥ 2: `(DUP <Ci> EQUAL SWAP)×(N−1) <C_{N−1}> EQUAL BOOLOR×(N−1) VERIFY` (25N − 2 B) |
| G table | 394–457 | 695–2830 (2136 B) | identical to fixture chunks 87–150 |
| pre-loop | 458–464 | 2831–2870 (40 B) | `<p> FROMALTSTACK DROP TOALTSTACK 1 1 0` |
| comb loop | 465–22882 | 2871–27320 (24,450 B) | **byte-identical** to the fixture loop |
| tail | 22883–23309 | 27321–27854 (534 B) | byte-identical to the fixture tail |

The region from the G table to the end (27,160 B) equals fixture chunks `[87..150] ++ [215..end]` byte-for-byte
[E:gen2 selfTest, consolidate-verify.mjs §7]. The loop is unchanged because (a) the unlocker's stack order
`[r u2' u1' Q0..Q63 | G0..G63 X Y Z]` keeps 131 items under the accumulator, and (b) the two halves swap roles
(index-1 scalar u2' with C[0..63] = Q; index-2 scalar u1' with C[64..127] = G) — the sum `u1·G + u2·Q` is the same
point, so no depth constant changes.

**Why each change.** Canonicalisation via `OP_NUM2BIN 33` (+3 B/coordinate) instead of hashing raw pushes: concatenated
variable-length scriptnums are not an injective serialisation (a genuine raw-concat alias was constructed and is
rejected by the canonical form [E:adv-review.mjs B4]). Unlocker-supplied recoded scalars (+66 B per input) avoid
burying r/u1'/u2' under 64 coordinates or changing loop bytes. The 1-of-N chain (25N − 2 B) needs no unlocker-chosen
index and no range check. `buildLock2` restricts sighash to `0x41` (fixes the ANYONECANPAY acceptance of `gen.mjs`);
`unlock2` parses DER when byte 0 = `0x30` and length ≠ 64 (fixes the length-only heuristic).

### 9.2 Sizes (measured) [E:unlock2.mjs, fuzz2.mjs, consolidate-verify.mjs §7]

| N | Lock B / chunks | Unlock B (1 input) | 1-in/1-out tx B | Formula |
|---|---|---|---|---|
| 1 | 27,855 / 23,310 | 2,494–2,516 | ≈ 2,581–2,603 | lock = 27,833 + 22 |
| 2 | 27,881 / 23,316 | 2,498–2,504 | 2,590–2,606 | lock = 27,831 + 25N; chunks = 23,306 + 5N (N ≥ 2) |
| 3 | 27,906 / 23,321 | 2,500–2,508 | 2,592–2,603 | |
| 4 | 27,931 / 23,326 | 2,500–2,508 | 2,587–2,611 | |
| 5 | 27,956 / 23,331 | 2,501–2,516 | 2,588–2,608 | |

Note: the VARIANT report's "27,830 + 25N" holds only at N = 1; the N = 1 → 2 step is +26 B / +6 chunks, thereafter
+25 B / +5 chunks (verified for N = 1..5). Multi-input: 2 inputs ≈ 5,136–5,157 B, 3 inputs 7,660–8,205 B. Versus the
original: lock −1,729 B (N = 1), unlock +2,330 B per input.

### 9.3 Timing [E]

`Spend.validate()` 33.6–34.2 ms mean (n = 149/137, `unlock2.mjs`), 37.97 ms mean over 400 (`fuzz2.mjs`), 40.0 ms in
today's single run — indistinguishable from the original (byte-identical loop; the header adds ~330 cheap ops); N has
no measurable effect. `buildLock2` 11–37 ms (mean 13.4); `buildUnlock2` 105–184 ms (mean 122; dominated by two
`combTable(Q)` evaluations = 64 scalar multiplications, `fullR`, and signing) [E:fuzz2.mjs].

### 9.4 Verification results [E:unlock2.mjs, fuzz2.mjs, layout2-probe.mjs, coord31.mjs, adv-review.mjs]

- Interpreter-stepped layout at loop entry (N = 1 and 5): exactly `[r u2' u1' Q0..Q63 G0..G63 1 1 0]`, alt
  `[preimage, p]`, every item byte-compared; tail entry depth 134 with item 0 = r.
- Positive: 100/100 random N = 2 cases (twice); 200/200 cases with 1–3 vault inputs each (393 inputs, N ∈ 1..5,
  version 1 or 2, locktime 0 / < 500M / ≥ 500M, final and non-final sequences, sats ≤ 2⁴⁰, any input index);
  N = 1..5 each member spends (15/15); SDK template path `tx.sign()` + `tx.verify('scripts only')` with 3 vault inputs.
- Negative (52 checks, each asserted at the predicted region): uncommitted key refused pre-sign (`NOT_COMMITTED`)
  and, when forced, rejected at H5 (pc 393 N = 1; 399/404/409/414 for N = 2..5); wrong/foreign/flipped salt → H5;
  table tampering (x↔y swap, entry swap, reversal, `−y`, `T_j·Q + G`, another member's entry, random point, off-curve,
  whole table of `Q + G`) → H5; A's table+salt with B's or an outsider's signature → tail r-check (pc 22919 for N = 3);
  "push r := comb output" forgery → H3 (pc 67); self-consistent re-derivation → tail; cross-input / cross-tx / other
  sighash-type preimages → pass everything and fail at the final CHECKSIG (pc = chunk count); r + 1, u1' ± 1, u2' ± 1 →
  H3; s + 1, n − s with stale sInv → H1 (pc 19); 31-B coordinate padded to 32 B → pc 16326 MINIMALDATA (commitment
  itself still matches because NUM2BIN minimal-encodes first); mixed P2PKH + vault tx signs and verifies; changing the
  other input's sequence or the locktime invalidates the vault input.
- Coordinate encodings: forced 31-B (< 2²⁴⁸) and 33-B (≥ 2²⁵⁵) coordinates validate; `le33` equals interpreter
  `OP_NUM2BIN(v, 33)` for 0/1/31/32/33-byte inputs.

---

## 10. Security review findings

Sources: `adv-review.mjs` (sections A–H), `hardened-test.mjs`, `fuzz.mjs`, `fuzz2.mjs`, review1–5, this consolidation.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **MEDIUM** | **Third-party unlocking-script (txid) malleability on the P-256 leg**, original and gen2 alike, under v1 + MINIMALDATA: `s → n − s` (no low-S rule), `s → s + k·n`, `sInv → sInv + k·n`, `(s, sInv) → (−s, −sInv)`, `(s − n, sInv − n)`, `r → r + k·p·n` (65-B push) all validate. Root cause: H1/chunk 41 only checks `s·sInv mod n = 1` with truncating `OP_MOD`; r is used only mod n and mod p; nothing bounds the values. Funds cannot be redirected (the P-256 signature covers the preimage); impact is txid instability of unconfirmed spends and unlock bloat. [E:map-header.mjs, adv-review.mjs C1–C9, hardened-test.mjs] | **Fix verified** (`gen2-hardened.mjs`, +116 B / +17 chunks): after `<n> TOALTSTACK` insert `2 PICK 1 <(n+1)/2> WITHIN VERIFY  OVER 1 <n> WITHIN VERIFY  <70> PICK 0 <p> WITHIN VERIFY` (s ∈ [1, (n−1)/2], sInv ∈ [1, n−1], r ∈ [0, p−1]); all 7 variants rejected at pc 14/19/25, honest low-S spends validate 12/12, high-S must be normalised by the unlocker (`lowSNormalize`). Not ported to `gen.mjs` (would need r at depth 3 after chunk 30) [I]. |
| 2 | LOW | **Version-2 spends are encoding-malleable and lose the PUSH_TX screen** in gen2 (tx version is no longer baked): under the SDK model `isRelaxed()` drops MINIMALDATA/CLEANSTACK/SIGPUSHONLY/LOW_S for `version > 1`; junk bottom push, PUSHDATA1 re-encoding, trailing `OP_NOP`, zero-padded coordinate/u2' and a peel-nonminimal preimage all validate as v2. A third party cannot flip the version (it is signed); the risk is the app signing v2. Original lock is immune (version 1 baked; v2 fails at pc 23067 [E:consolidate-verify.mjs §9]). [E:adv-review.mjs C16–C21] | Open: `buildUnlock2` should reject `tx.version !== 1` (`gen.mjs buildLock` does). Real-node treatment of v2 not verified [I]. |
| 3 | LOW (app) | **External signer called before the pre-sign screen** in both async paths: `unlock.mjs buildUnlockAsync` (line 178) and `unlock2.mjs buildUnlock2Async` (line 71) call `signDigest` first and only then run the key/commitment guards and `pushTxDerCheck`. A hardware signer would be asked to sign a doomed (2⁻¹⁶) or wrong-key preimage. Sync paths are correct. [E:consolidate-verify.mjs §8 — signer invoked, then throw] | Open: reorder (build preimage → screen → then sign). |
| 4 | LOW (fixed) | `gen.mjs buildLock` accepted `sighash = 0xc1` (ANYONECANPAY) although the structure cannot support it (spend fails at pc 22665). [E:review5-params.mjs] | Fixed in `buildLock2` (0x41 only); `gen.mjs` still accepts it [S]. |
| 5 | INFO (fixed) | `buildUnlockFromSigner` chose compact vs DER by `length === 64` (a 64-B DER is possible, ≈ 2⁻⁴⁸). | Fixed in `unlock2.mjs` (`sigBytes[0] === 0x30 && length !== 64`); `unlock.mjs` unchanged [S]. |
| 6 | INFO | **Privacy**: after one spend the table is public; `Q = table[0]·T_0⁻¹` recovers the key and `commitmentFor(Q, salt)` links every output baking the same commitment. Use a fresh salt per output. [E:adv-review.mjs H1–H2] | Design note. |
| 7 | INFO | Salt length is not enforced in-script (a 5-byte salt spends if committed as such); `commitmentFor`/`buildUnlock2` pin 32 B; fixed-width 33-B coordinate blocks prevent aliasing across the salt boundary. [E:adv-review.mjs A6–A7] | Acceptable. |
| 8 | INFO | The lock does not check that the pushed table is a comb table of one point — irrelevant, because only commitment holders control a table and they can spend anyway. Off-curve/foreign entries are stopped by H5. [E:adv-review.mjs B5] | Acceptable. |

Confirmed safe [E:adv-review.mjs, fuzz.mjs, fuzz2.mjs]: no spend without a committed key (H160 input is exactly the
canonical bytes, integer-valued so `x ± p` and zero-padding cannot alias, ≥ 2²⁶³ rejected); every VERIFY-family op
is at IF-depth 0 (no branch skips a check); the dummy key `d` gives no power (the PUSH_TX region reads only the
altstack preimage and the baked 0x41, has 0 deep-stack ops, and is reachable only after the P-256 leg); sighash
substitutions (0x01/0x42/0x43/0xc1/0xc2, upper dword bytes) fail at CHECKSIG; nothing depends on input index,
sequence or locktime in gen2 (ALL|FORKID commits them). Resource use vs documented policy (spec §0 numbers)
[E:adv-review.mjs G1–G8, S]: lock 27,956 B (N = 5) / 29,584 B (original) vs `MaxScriptSizePolicy` 500,000 (5.6–5.9 %);
peak stack+alt memory 6,012 B vs `MaxStackMemoryUsagePolicy` 104,857,600; executed ops 15,301 (gen2 N = 5; original
≤ 16,712 static) vs `MaxOpsPerScriptPolicy` 1,000,000; largest numeric operand 352 B and largest item 2,144 B vs
`MaxScriptNumLengthPolicy` 10,000; spend tx 2,610 B vs `MaxTxSizePolicy` 10,485,760; peak depth 142 (no post-genesis
limit).

---

## 11. Open questions and risks

1. **MINIMALDATA: consensus or policy on real nodes?** Every encoding conclusion (rejection of non-minimal numbers, the
   2⁻¹⁶ peel-loop abort at pc 22986) uses the SDK interpreter as the only oracle; SV Node / teranode / arcade behaviour
   was not tested. If nodes treat MINIMALDATA as standardness only, a peel-nonminimal spend would be non-standard
   (unrelayed) rather than invalid — the screen remains necessary either way. [I]
2. **Chronicle opcode semantics on nodes.** `OP_RSHIFTNUM`, `OP_2MUL`, big-number `OP_MUL/OP_MOD/OP_DIV` on 352-B
   operands, `OP_NUM2BIN/BIN2NUM`, `OP_SPLIT/CAT` are exercised only in the SDK. The single real-node data point is the
   testnet spend itself (block 1,755,177, accepted). Mainnet Chronicle activation (2026-04-07, block 943,816) is taken
   from CONTEXT.md, not verified. [I]
3. **Policy limits at the broadcaster.** Spec §0 documents arcade's hardcoded `MaxScriptSizePolicy: 500000` (the old
   960 KB script exceeded it; this one is 29,584 B ≈ 5.9 %, gen2 27,855–27,956 B), `MaxStackMemoryUsagePolicy`
   104,857,600, `MaxOpsPerScriptPolicy` 1,000,000, `MaxScriptNumLengthPolicy` 10,000, `MaxTxSizePolicy` 10,485,760;
   TAAL ARC limits unknown; SV Node `maxnonstdtxvalidationduration` default 1,000 ms vs 34–40 ms in JS (C++ expected
   faster). None measured against a deployed node. Whether `MaxScriptNumLengthPolicy` counts the 2,144-B H4 concat
   (it is a byte string, not a number) is unverified. [S, I]
4. **Testnet vs mainnet.** Fixture is testnet; mainnet policy (standardness of a 29.6 KB non-P2PKH output, `OP_1`
   outputs, dust) untested. [I]
5. **`R.x ≥ n` (≈ 2⁻¹²⁹).** The mechanics are verified with constructed signatures [E:review4-rgen.mjs]; the case was
   never produced by an honest signer. The unlocker always pushes the recomputed full x, so no special handling is
   needed at signing time.
6. **Degenerate comb intermediates.** `acc = ±T` (H = 0) in a mixed add gives Z3 = 0 → tail VERIFY fails; probability
   ≈ 2⁻²⁵⁰ per add; never exercised; a generator that changes tables/scalars must keep the guard semantics. [I]
7. **Txid malleability (finding 1).** Wallet must not rely on the spend txid before confirmation unless the hardened
   header is adopted (gen2) or an equivalent is added to the original layout. Design decision outside this analysis.
8. **Version-2 relaxation (finding 2)** and **async signer ordering (finding 3)** — unfixed code in the scratchpad.
9. **Malformed-length `hashOutputs`/`outpoint` pushes** (original lock) were not tested; they would malform the
   preimage and fail at CHECKSIG, exact pc unobserved. [I]
10. **Upstream generator** of the fixture is not in the scratchpad (`@bsv/templates` 1.10.1 contains the old
    `R1K1Wallet` only; no Chronicle/comb markers) — `gen.mjs` is a reverse-engineered byte-exact reproduction, and the
    original tool's handling of short (< 2²⁴⁸) coordinates is unobserved (fixture has none; ≈ 22 % of keys have one).
    `gen.mjs` emits the minimal (31-B) form, which the SDK requires.
11. **Corrections to CONTEXT.md / earlier reports** (all [E]): recode constant is `2²⁵⁸ − 1`, not `2²⁵⁴ − 1`; the tail
    starts at chunk 22640 (427 chunks), not 22751 (316); column c = `222 + …` with `DOUBLE ADD_G ADD_Q`, col42 =
    22119–22639; largest lazy product is 352 B (not 288 B); the altstack item discarded at chunks 216–217 is `n`;
    OP_DIV chunks are 73, 85, 22876, 22884 (74/86/22877/22885 in one report were 1-based line numbers); the
    "negative-S 1/263 DER rejection" does not exist (sign byte becomes the DER pad); gen2 lock size is
    `27,831 + 25N` for N ≥ 2 (27,855 at N = 1), not `27,830 + 25N`; validate time here 34–40 ms vs CONTEXT's 49 ms
    (same 23,071 steps).

---

## 12. Scratchpad file inventory

`$S = /private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad`.
Inputs: `CONTEXT.md` (shared brief; corrections in §11.11), `node_modules → repo node_modules` (symlink).

**Deliverables / generators**
- `gen.mjs` — byte-exact generator `buildLock({qCompressedHex, satoshis, …})`; `node gen.mjs` self-test (byte diff + validate).
- `unlock.mjs` — unlocker: preimage, digest, `pushTxSignature`/`pushTxDerCheck`/`peelLoopNonMinimalAt`, `fullR`, `buildUnlock[Async]`, `r1CombUnlockTemplate`; `ROUNDS=n node unlock.mjs` self-test.
- `gen2.mjs` — 1-of-N commit-to-table lock `buildLock2({commitments})`, `commitmentFor`, `canonicalTableBytes`, `recode`, `le33`, `layout2`, `bakedCommitments`; `node gen2.mjs` self-test (`gen2.selftest.out.txt`).
- `unlock2.mjs` — `buildUnlock2[Async]`, `encodeUnlock2/decodeUnlock2`, `r1CombUnlock2Template`; self-tests i–v (`unlock2.run1.log`, `unlock2.run2.log`).
- `gen2-hardened.mjs` — prototype fix for finding 1 (`buildLock2Hardened`, `lowSNormalize`, `HALF_N`); `hardened-test.mjs` + `.out.txt`.
- `skeleton.json` — literal/template region skeleton of the fixture (regions, shift table, ADD/DOUBLE params).
- `ANALYSIS.md` — this document. `consolidate-verify.mjs` + `.out.txt` — re-verification of every number quoted here.

**Map phase (fixture dissection)**
- `lock.asm.txt` (one chunk per line `idx @byte op`), `lock.asm.flat.txt`, `trace.mjs` → `trace.txt` / `trace.full.txt` (6.4 MB full step trace), `disasm.mjs`, `consts.mjs`, `recoverQ.mjs` (Q recovery), `comb.mjs` (table model), `blocks.mjs`, `api.mjs`, `probe2.mjs`.
- `preloop.body.txt`, `col0.body.txt`, `col1.body.txt`, `col42.body.txt`, `tail.body.txt` — op listings.
- `map-header.mjs` + `.out.txt` — chunks 0–86 and unlock encoding (109 checks). `map-column.mjs` + `.out.txt`, `map-column-stats.mjs`, `coldiff.mjs` — comb columns, formulas, boundaries. `map-tail.mjs`, `dumpstack.mjs` → `tail.dump.txt`, `derprobe.mjs` — tail and DER model. `map-uniformity.mjs` + `.out.txt` — whole-script regeneration rules.

**Reproduce / verify phase**
- `edge-tests.mjs` (+ `edge-stress7.txt`), `find-fail.mjs` — short coordinates, DER pad, the pc-22986 failure.
- `review1-diff.mjs`, `review2-otherQ.mjs`, `review3-encodings.mjs` (+ `review3.400k.out.txt`), `review4-rgen.mjs`, `review5-params.mjs` — independent verification of the generator.
- `fuzz.mjs` → `fuzz.run1.log`, `fuzz.run2.log`, `fuzz-report.json`, `fuzz-failures.json` (`[]`).
- `edge.mjs` → `edge.out.txt` (8e6 MC classification), `edge_sweep.mjs`.

**Variant phase**
- `layout2-probe.mjs` + `.out.txt`, `coord31.mjs`, `unlock-layout.mjs`, `dbg-step.mjs`, `dbg-chunks.mjs`, `dbg-tail.mjs`, `dbg-tail-orig.mjs` (tail-boundary debugging), `maxitem-probe.mjs`.
- `fuzz2.mjs` → `fuzz2.run1.log`, `fuzz2-report.json`, `fuzz2-failures.json` (`[]`).
- `adv-review.mjs` → `adv-review.out.txt` (security review A–H).

**Reference copies (not produced here)**
- `old-r1k1.ts`, `old-r1k1-spend-proof.ts` — the repo's previous ~960 KB R1K1 vault module and its spend-proof script.
- `bsv-templates-1.10.1.tgz`, `package/` — `@bsv/templates` 1.10.1 (contains `R1K1Wallet`; no comb generator).
- `tsc-eslint.log` — unrelated repo typecheck output.
