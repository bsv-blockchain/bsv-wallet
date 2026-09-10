# Spike: reverse-engineered P-256 comb verifier (throwaway analysis code)

Status: **spike output, not production code.** Everything here was produced on 2026-09-09 while
reverse-engineering the 29,584-byte testnet locking script in `../51c53430…579a_0.hex` and its
231-byte spend `../476611a4…4b80.hex`. Read `ANALYSIS.md` first — it is the consolidated,
verification-tagged engineering document. `CONTEXT.md` is the brief the analysis agents worked
from; its §"Established facts" contains errors that `ANALYSIS.md` §11.11 corrects.

Nothing in this directory is imported by the app. The production template, when written, lives in
`packages/expo-wallet-toolbox/core/services/vault/` and is covered by Jest tests; these scripts are
the evidence trail and a reference implementation to port from.

## Running

All scripts are plain Node ESM (`node …mjs`), import `@bsv/sdk` and `@noble/curves` from the repo's
`node_modules`, and read the fixtures by path relative to the **repo root**, so run them from there.
Several write outputs to `process.env.S`; point it anywhere writable:

```bash
S=/tmp/r1spike node docs/example-txs/spike/gen.mjs
```

| File | What it proves / does |
|---|---|
| `gen.mjs` | `buildLock({qCompressedHex, satoshis})` — regenerates the fixture lock **byte-for-byte**; `node gen.mjs` self-tests |
| `unlock.mjs` | preimage, signer digest (`reverse(hash256(preimage))`), `pushTxDerCheck` pre-sign screen, `buildUnlock[Async]` |
| `gen2.mjs` / `unlock2.mjs` | the generalized **1-of-N commit-to-table** variant (preimage in unlock, Q table in unlock, N hash160 commitments) |
| `gen2-hardened.mjs` / `hardened-test.mjs` | +116 B range checks that remove third-party txid malleability (ANALYSIS §10 #1) |
| `fuzz.mjs`, `fuzz2.mjs` | randomized positive/negative spends through the SDK `Spend` interpreter |
| `edge.mjs`, `edge-tests.mjs` | OP_PUSH_TX DER edge classes; the 2⁻¹⁶ peel-loop abort and its predicate |
| `adv-review.mjs` | adversarial security review harness (sections A–H) |
| `consolidate-verify.mjs` | re-derives every number quoted in ANALYSIS.md |
| `map-*.mjs`, `review*.mjs`, `layout2-probe.mjs`, `trace.mjs`, `recoverQ.mjs`, `comb.mjs` | dissection and independent verification probes |
| `lock.asm.txt` | one-chunk-per-line disassembly of the fixture (`idx @byteOffset op`) |
| `skeleton.json` | literal/template region skeleton of the fixture |
