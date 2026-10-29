# Vendored from fast.brc.dev

Test tool only (the demo is not in the package's published files, the extension bundle or the host app).

- Source repo: `fast-wallet-client-docs` (https://fast.brc.dev), a local clone at `/Users/personal/git/demos/fast-wallet-client-docs`
- Commit: `63bd8c4`
- Licence: the repository has no LICENSE file and its `package.json` has no `license` field (`"private": true`). It is a
  bsv-blockchain organisation project (`github.com/bsv-blockchain/fast-wallet-client-docs`), the same organisation that
  owns this repository, and is vendored here as org-owned code. Re-check upstream for a licence before this directory
  is ever published outside the organisation.

## Files copied (byte-identical except the one-line edit below)

- `snippets/conformance/*.ts`: all 29 files (the 28 `WalletInterface` method cards and `support.ts`), from `src/snippets/conformance/`
- `snippets/branches/{actions,certificates,crypto,internalize,lists,metadata,support}.ts`, from `src/snippets/branches/`
  (`branches.test.ts` is a vitest file and is not copied)
- `snippets/reliability/support.ts`, from `src/snippets/reliability/` (the `check`, `checkBytes`, `sameBytes` and
  `expectWalletError` helpers the branch files import; the reliability cards themselves are not ported)
- `lib/snippet-runner.ts`, from `src/lib/`

## Local edits

1. Every vendored file starts with the line `// @ts-nocheck`. Fast compiles non-strict; this repo's `tsc` is strict and
   would otherwise report about 44 errors in the vendored files. No other byte of any vendored file is changed.
   To compare with upstream: `diff <(tail -n +2 <local>) <upstream>`.

## Local files in this directory (not vendored)

- `snippets/wallet.ts`: REPLACES fast's `src/snippets/wallet.ts`. `createWalletClient(originator?)` returns an
  `@bsv/sdk` `WalletClient` over `createBridgeWallet` for the connection the demo currently holds, and throws
  `not connected: press connect first` before that. The originator is ignored (BRC-185 supplies the real page origin).
  Fast's React Native and `window.CWI` paths are dropped.
- `shims/walletToolboxClient.ts`: bundle-time alias for `@bsv/wallet-toolbox-client` (build.mjs). The only vendored use
  is `brc29ProtocolID` in `branches/internalize.ts`; the shim exports the toolbox's own constant `[2, '3241645161d8']`
  so the demo does not bundle the full toolbox client.
- `registry.ts`: the 41 cards (28 methods + 13 branch cases) with ids, titles and explanations taken from fast's
  `src/snippets/_data.ts`, plus our group and spending split (see below).
- `controller.ts` and `ui.ts`: the runner state machine and the plain-DOM panel (fast's React UI is not ported).
- `../bridgeWallet.ts`, `../main.ts`: the BRC-185 adapter and the bundle entry.

## Run all safe versus per-card Run

Run all safe runs 28 - 4 = 24 conformance cards plus the 6 non-funded branch matrices (30 cards). Fast's own "Run
conformance" also runs the four conformance cards that spend or may cost fees; here those only run from their own
button, after a confirmation: `internalizeAction` (network fee), `relinquishOutput` (broadcasts 1 sat then stops
tracking it), `acquireCertificate` and `relinquishCertificate` (external certifier `certify.bsvb.tech`, possible fees;
`relinquishCertificate` acquires one if none exists). The seven funded or certificate-workflow branch cards
(noSend, explicit inputs, broadcast, sendWith batches, internalize, direct and issued certificates) are per-card too.
`createAction`, `signAction` and `abortAction` are noSend then abort (no broadcast) and stay in Run all safe; they
need a spendable output and may raise a wallet prompt. `proveCertificate` is in Run all safe and fails with fast's own
"Run acquireCertificate first" message when no conformance certificate exists.

## Not ported

- The 19 guided BRC-116 scenarios (`src/snippets/permissions`, `src/lib/permission-guide.ts`, `public/manifest.json`):
  they need fast's served manifest and a human confirming the wallet UI.
- Reliability cards (key stability, byte boundaries, HMAC and signature integrity, pagination) and the two Permissions
  cards: not requested; the data is in fast's `src/snippets/reliability` and `permissions` if wanted later.
- MessageBox, overlays, tokens, identity, payments, distributed data and certificate-snippet categories (non-BRC-100).
- Fast's vitest files (`branches.test.ts`, `wallet.test.ts`): this repo has its own jest tests in `__tests__/`.
