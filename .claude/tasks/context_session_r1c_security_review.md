# R1C vault locking-script security review

Date: 2026-09-11
Scope: read-only review of `packages/expo-wallet-toolbox/core/services/vault/r1comb.ts`, `transfers.ts` spend path, `__tests__/vault/r1comb.test.ts`, `scripts/r1c-spend-proof.ts`. No source changes.

## Findings

Consensus authorization is: (1) 70-push witness, (2) tx version 1 in H0, (3) canonical r in [1,p)\{n}, low-S s, s*sInv≡1 mod n, recoded u1/u2, (4) HASH160(salt‖table(Q)) ∈ baked commitments, (5) complete comb of u1·G+u2·Q with Jacobian mixed-add, (6) affine X = r·Z², (7) OP_PUSH_TX CHECKSIG with SIGHASH_ALL|FORKID (0x41) on secp256k1 dummy keys.

No anyone-can-spend, no row/col table bypass, no CRT r-forgery (explicit tests). 1-of-N is by design. Output amounts and mixed-input policy are wallet-enforced only (SIGHASH_ALL still binds whatever outputs the signer approved).

pushTxDerCheck is now unconditionally `{ok:true}`; sequence retry in transfers is dead. HASH160 commitments inherit 2^80 collision bound (same as P2PKH).
