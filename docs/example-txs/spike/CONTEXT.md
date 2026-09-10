# R1 comb-verifier locking script — shared context for analysis agents

Repo: /Users/personal/git/bsv-wallet (run node from this dir, or from the scratchpad — a `node_modules` symlink exists in the scratchpad so `import ... from '@bsv/sdk'` and `'@noble/curves/nist.js'` resolve from both).
Scratchpad (write ALL new files here, never into the repo): /private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad
Set `S=/private/tmp/claude-502/-Users-personal-git-bsv-wallet/a954ef08-e7c5-49e3-8a72-1cd73ad1d771/scratchpad` in shells; existing probe scripts read `process.env.S` for output paths.

## Fixtures (testnet, both mined in block 1755177)
- Locking script of deposit output 0 (29,584 bytes, 23,067 chunks): `docs/example-txs/51c53430fe63108a2a1ddd231253df069fb424cc6f1bb0ee60b4b07792d3579a_0.hex` (hex of the raw script). Output value 4600 sat.
- Spend tx (231 bytes): `docs/example-txs/476611a431172df767a73349522536fa78d63a83b560efbb695b853bf60b4b80.hex`. 1 input (the above, sequence ffffffff), 1 output (4500 sat, `OP_1`), version 1, locktime 0.
- `@bsv/sdk` `Spend.validate()` on unlock+lock returns TRUE in ~49 ms (23,071 steps). Everything below was verified against that interpreter.

## Existing scratchpad files (read, reuse)
- `lock.asm.txt` — one chunk per line: `chunkIndex @byteOffset <hexdata>|OP_NAME`.
- `trace.full.txt` — full step trace (6.4 MB, 23,071 lines): `L #<chunkIdx> <op> depth=.. alt=.. top: <last 6 stack items as [hex-prefix..suffix lenN n=<scriptnum hex prefix>]>`. Lines starting with `U` are unlocking-script pushes. Use grep/awk/sed with line ranges; do not cat the whole file.
- `trace.mjs` — step tracer (uses `Spend.step()`); `FULL=1` writes full trace. Copy/adapt it to dump specific stack items in full hex at chosen chunk indices.
- `disasm.mjs`, `consts.mjs`, `recoverQ.mjs`, `comb.mjs`, `blocks.mjs`, `api.mjs` — probes used to establish the facts below.
- `preloop.body.txt` (chunks 216–332), `col1.body.txt` (chunks 869–1389, one comb column), `tail.body.txt` (chunks 22751–23066) — op listings with chunk indices.

## Established facts (verified; do not re-derive, do build on)
Curve: NIST P-256 (secp256r1). p = ffffffff00000001000000000000000000000000ffffffffffffffffffffffff, n = ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551, a = p-3, b = 5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b.
Script numbers are little-endian sign-magnitude (BSV); constants ≥ 2^255 carry a trailing 0x00 sign byte (33-byte pushes).

Unlocking script (5 pushes, bottom→top): `r` (33B scriptnum), `s` (32B), `sInv = s^-1 mod n` (32B), `hashOutputs` (32B), `outpoint` (36B = txid‖vout LE).
Recovered signer pubkey Q = 03f4d667712d8825372cd616b0b1b1a818e5eeb3681dd45c5bdd59fed9f21d5a7d (compressed P-256).

Locking script layout (chunk indices; byte offsets in lock.asm.txt):
- 0–28: rebuild sighash preimage in-script from unlock data + baked constants: version 01000000, hashPrevouts = hash256(outpoint) (⇒ single-input tx only), hashSequence = hash256(ffffffff) (⇒ single input, seq ffffffff), outpoint, scriptCode `01 ac` (varint 1 + OP_CHECKSIG — works because the script ends `OP_CODESEPARATOR OP_CHECKSIG`), amount f811000000000000 (=4600 sat, baked), sequence ffffffff, hashOutputs (from unlock), locktime 00000000, sighash 41000000 (ALL|FORKID). Then `DUP HASH256 <00> CAT BIN2NUM` → e = LE-interpretation of hash256(preimage) as a scriptnum. Preimage (158 B) moved to altstack. Verified: SDK `TransactionSignature.format(..., subscript=Script('ac'), scope 0x41)` produces the identical 158-byte preimage.
- 29–62: push n; verify `s·sInv mod n == 1` (NUMEQUALVERIFY); u1 = e·sInv mod n; u2 = r·sInv mod n; drop s, sInv. Stack becomes [r, u1, u2].
- 63–86: recode each scalar u → u' : if u even then u += n; u' = (u + 2^254 − 1) / 2  (i.e. u = Σ_{i} d_i 2^i with all d_i ∈ {−1,+1}; bit i of u' = 1 ⇔ d_i = +1). Verified numerically for both scalars.
- 87–214: 128 constants = 64 affine points (x,y pairs). Points 0–31 = comb table for G, points 32–63 = comb table for Q. Table entry j (0..31): scalar = 2^(43·5) + Σ_{k=0}^{4} d_k·2^(43k), d_k = +1 if bit k of j is 1 else −1; entry j is pushed in order (pt_j = chunks 87+2j, 88+2j). Verified: all 64 match exactly.
- 215: push p. 216–332: pre-loop (accumulator init — pushes 1,1,0 — and a first "doubling" of the identity plus setup). 
- Comb loop: 43 columns. Column c (c = 0..42) starts at chunk 333 + (c==0 ? 0 : 536 + 521·(c−1)); col0 is 536 chunks, cols 1..42 are 521 chunks each. Column c extracts bits (257−c, 214−c, 171−c, 128−c, 85−c, 42−c) of each recoded scalar via `<depth> OP_PICK <shift> OP_RSHIFTNUM 2 MOD`. The 6 bits form: top bit = sign, low 5 bits (XNOR'd with the sign via `OVER NUMEQUAL`) = table index j; picks x,y of table entry (depth arithmetic `2j` from a base depth), negates y when sign says so, and adds the point to the accumulator; accumulator is doubled once per column. Cols 1..25 are byte-identical modulo the shift-constant pushes; cols ≥26 only differ by shift constants that encode as OP_0..OP_16 opcodes instead of PUSH1/PUSH2 (minimal-push rule). OP_RSHIFTNUM = 0xb7 (Chronicle numeric right shift). OP_2MUL = 0x8d (Chronicle). Multiplications are done lazily: intermediate stack items grow to 65/96/97/129/192/224/288 bytes before a single `OP_MOD p`.
- 22751–23066 (tail, 316 chunks): final check of the comb result against r (expect a projective comparison, e.g. X ≡ r·Z² mod p, possibly also handling r+n — there are 4 OP_DIV in the whole script, some here), then OP_PUSH_TX: byte-reverse hash256(preimage) into big-endian order (20 SWAP/CAT steps), `<00> CAT BIN2NUM`, add 2^248 (built as `OP_0 <1f> NUM2BIN OP_1 CAT`), push secp256k1 n (fffff…364141), reduce mod n and low-S normalize (the IF/ELSE block around chunks 22873–22894), convert s back to 32 big-endian bytes, DER-wrap: `<02 20 ‖ Gx_secp256k1 ‖ 02>` (r = Gx, i.e. nonce k = 1) then `SIZE SWAP CAT`, `<30> SWAP CAT`, `FROMALTSTACK CAT` (appends sighash byte 0x41), push pubkey 02b405d7f0322a89d0f9f3a98e6f938fdc1c969a8d1382a2bf66a71ae74a1e83b0, `OP_CODESEPARATOR OP_CHECKSIG`. Verified: that pubkey = d·G with d = 2^248 · Gx^-1 mod n_secp256k1, so s = e + Gx·d = e + 2^248 (mod n) is a valid k=1 signature. The private key d is public by construction — this is NOT a spend path, it is the OP_PUSH_TX mechanism that binds the in-script preimage to the actual spending transaction.

Digest convention for the P-256 signer: the script uses e = LE(hash256(preimage)). A YubiKey/any ECDSA signer interprets its 32-byte digest input as big-endian, so the app must hand the signer `reverse(hash256(preimage))` (32 bytes). (The recovered Q matches only under this convention.)

Chronicle (SV Node 1.2.0) activated on mainnet 2026-04-07 at block 943,816 — OP_2MUL, OP_2DIV, OP_RSHIFTNUM, OP_LSHIFTNUM etc. are live on mainnet and testnet.

## API cheat-sheet (verified in this environment)
- `@noble/curves` v2: `import { p256 } from '@noble/curves/nist.js'`; `p256.Point` (class; `.BASE`, `.ZERO`, `.fromAffine({x,y})`, `.fromBytes(u8)`, `.multiply(bigint)` — scalar must be in 1..n-1, reduce mod n first, `.add/.subtract/.double/.negate/.equals`, affine getters `.x/.y`, `.toHex(true)`, `.toBytes(true)`). `p256.utils.randomSecretKey()`; `p256.getPublicKey(priv, true)`; `p256.sign(msg32, priv, {prehash:false})` → 64-byte compact Uint8Array; `p256.Signature.fromBytes(bytes,'compact')` → `.r/.s` bigint, `.toBytes('der')`; `p256.verify(sig, msg, pub, {prehash:false, lowS:false})`.
- `@bsv/sdk`: `Script`, `LockingScript`, `UnlockingScript` (`.fromHex`, `.toHex`, `.chunks` [{op, data?}], `new Script().writeOpCode(OP.X).writeBin(number[]).writeNumber(n)` — writeBin auto-selects push size incl. PUSHDATA1/2), `OP` (name↔code map; `OP[0x99]==='OP_RSHIFT'`, `OP.OP_RSHIFTNUM===0xb7`, `OP.OP_2MUL===0x8d`), `BigNumber` (`new BigNumber(hex,16)`, `.toSm('little')` → minimal sign-magnitude LE bytes = script number encoding, `BigNumber.fromScriptNum(bytes,false,len)`), `Hash.hash256/sha256/hash160(number[])`, `Utils.toArray(hex,'hex')/toHex(bytes)`, `Transaction.fromHex`, `TransactionSignature.format({...})`, `Spend` (constructor params as in trace.mjs; `.validate()`, `.step()`, `.stack`, `.altStack`, `.programCounter`, `.context`).
- Script number encoding rule (minimal): 0 → OP_0 (empty), 1..16 → OP_1..OP_16, −1 → OP_1NEGATE, otherwise push of minimal LE sign-magnitude bytes (PUSH1 for 17..127 etc.).

## Ground rules
- Read files with sed/awk line ranges. Never cat trace.full.txt whole.
- Verify every claim by running code against the fixture/trace (the SDK interpreter is the oracle). Report what was verified vs inferred.
- Write new scripts/outputs only under the scratchpad path above. Do not modify the repo.
- Return raw findings (your final text is data for an orchestrator, not prose for a human).
