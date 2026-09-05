# Wallet stability and performance — 2026-09-05

Branch: `codex/wallet-stability-performance`. Base: `1297bde`.

## Simulator measurements

Measured on iPhone 17 Pro simulator, iOS 26.4, Expo development client, Hermes,
using the native build installed by the user. Metro runs on localhost:8081.
These are development/simulator timings, not release-build or physical-device claims.

| Workload | Before native routing | After native routing |
| --- | ---: | ---: |
| SDK decrypt, identical synthetic 1 KiB payload | 39.78 ms | 3.71 ms |
| SDK decrypt, identical synthetic 16 KiB payload | 551.03 ms | 10.81 ms |
| SDK decrypt, identical synthetic 128 KiB payload | 4,333.53 ms | 36.48 ms |
| Demo mnemonic PBKDF2 + BIP32 derivation | 1,385 ms | 5 ms |
| Original 12-chunk backup replay (timing scopes differ; see below) | 19.58 s summed reader/apply time (one initial run) | 2.33 / 2.37 / 2.75 s elapsed replay time (three isolated runs, including proof reconciliation) |

Cipher plaintext parity passed for every measured synthetic payload. The original
backup is 531,927 encrypted bytes. Each of the three isolated replays produced
43 transactions, 227 outputs, 24 proven transactions, 42 proof requests, one
output basket, and zero certificates. Temporary replay databases were closed and
deleted after each run, without replacing the live wallet. All final replays had
zero stale proof requests among transactions with restored proofs. The final
median elapsed replay time was **2.37 seconds**.

The replay runs use the same original input log, but their timing scopes are not
identical. The before number sums instrumented reader and SQLite apply durations;
the after numbers measure elapsed time for the whole replay with an already-read
manifest, including index lookup. Both exclude restore coin validation and wallet
initialization; the final replays additionally include the new proof reconciliation
pass. These figures show the observed improvement without establishing
an exact end-to-end speedup ratio. The initial measurement already included this
branch's reader/reliability changes, but preceded native crypto routing; it is not
an unmodified-HEAD baseline.

Initial full UI restore: 12 chunks, 24.83 seconds, including coin validation.
Repeat full UI import: 1 chunk, 5.78 seconds, including coin validation. The first
restored wallet subsequently wrote a consolidated backup, so these full-import
numbers cover different input logs and should not be presented as a controlled
speedup comparison. The original 12-chunk log was explicitly selected for the
three after-change replays above so their input log matches the initial run.

Initial JS stall watchdog: multi-second stalls up to 5,911 ms during restore.
The following requestAnimationFrame measurements use a different probe and should
not be treated as an exact before/after frame-gap ratio. After native routing,
the three original-log replays had maximum requestAnimationFrame
gaps of 230–236 ms and p95 gaps of 38–39 ms. Earlier runs without the final
proof reconciliation pass replayed in 2.12–2.27 seconds. The repeat UI import had a 225 ms
maximum gap and 16.88 ms p95. Residual JSON/byte conversion work can still cause
visible short stalls; this work does not claim every restore frame meets 16.7 ms.

## Changes

- **Native crypto initialization:** SDK 2.4.1 selected its native AES-GCM,
  hash/HMAC and PBKDF2 paths only through Node's `process.getBuiltinModule`,
  which Hermes lacks. The app now explicitly provides its already-installed
  QuickCrypto backend before loading SDK consumers. Existing SDK native
  algorithms are reused; CJS and ESM patch variants preserve fallback and
  authentication checks. Mobile empty-message rejection is preserved.
- **Complete backup replay:** follow the server's 500-entry index pages, verify
  continuity before replay, and reject indexes that end before the manifest head.
  Index validation is linear across pages. Reuse the import manifest to avoid
  a duplicate request.
- **Safe bounded read-ahead:** overlap one small ciphertext download with current
  SQLite replay; chunks over 1 MiB remain sequential. Failed downloads/decryption
  do not advance the reader. Failed prefetches cannot cause unhandled rejections.
- **Restore lifecycle:** automatic rebuilds retain requested restore intent;
  failed restoration does not become an authenticated/built wallet, cannot
  fall back to another stored key, and closes its unpublished storage connection.
- **Restored proof requests:** the toolbox merge applied transaction completion
  but left old broadcast requests unsent. Reconcile requests using the existing
  proof-completion method before publishing the wallet. This prevents rebroadcast
  attempts and completed-status downgrade errors for transactions already proven
  in the backup. Read one request at a time to bound expanded transaction memory.
- **Backup transport:** a single deadline covers fetch plus JSON/arrayBuffer body
  reads; expiry aborts the transport. No response cloning or additional full-body
  buffering. Streaming bodies are outside this timeout wrapper's expanded scope.
- **Payment outbox:** serialize mutations per storage instance and fail writes on
  unreadable/corrupt queue data instead of overwriting it with an empty queue.
  Resolve same-millisecond recipient ID collisions inside that lock, keeping
  each payment independently addressable while preserving existing IDs.
- **React rendering:** derive amount text directly rather than setting state in an
  effect; its Profiler regression records one commit instead of two. Isolate
  activity rows from full wallet context updates while retaining currency, callback,
  and progress-label changes. Memoize send/nearby forms with stable props and the
  existing managers context.
- **Balance refresh:** retain the latest invalidation while a read is running,
  prevent stale network results/cache writes, and keep live reads working after
  cache failures.

## Validation

Focused checks completed:

- Backup reader/client/codec suites: 114 tests before the additional timeout cases.
- Payment outbox and affected rails/monitor: 101 tests, including frozen-clock ID collisions.
- Backup timeout: 22 tests, including stalled bodies, cancellation, and error preservation.
- Native routing, existing signing parity, backup codec/client: 81 tests.
- UI: 44 tests, plus 36 affected tests rerun after final memo changes.
- Wallet build context: 8 tests, including actual SimpleWalletManager authentication behavior.
- Final restore suites: 29 tests, including real SQLite/toolbox proof-merge integration.

These focused totals overlap and must not be added together.

Final regression and static checks:

- Full Jest run: **154 suites passed, 1 skipped; 1,907 tests passed, 1 skipped;
  zero failures**, in 46.001 seconds. Roots were restricted to `__tests__` and
  `packages/expo-wallet-toolbox/__tests__`, using `--runInBand --watchman=false`.
  `RESTORE_REPRO=0` explicitly disabled the optional production-server restore
  harness; the full regression run did not invoke that manual network test.
- TypeScript: **31 diagnostics**, exactly matching the saved pre-change baseline
  after ignoring line/column movement. No introduced or resolved diagnostics;
  the repository-wide check remains unsuccessful because of those existing errors.
- ESLint on **25 changed/new JavaScript and TypeScript files**: **zero errors**,
  121 warnings versus 108 for their HEAD versions. Fourteen new warnings concern
  test mock `require` usage/import order, and one existing entrypoint warning was
  removed. No new warnings were introduced in application source.
- `git diff --check`: passed.

Sanitized simulator evidence and validation counts:
[stability measurements](../../scripts/perf/2026-09-05-stability-measurements.json).

## Reproduction notes

Start Metro with IPv4-first resolution: the simulator requests its bundle at
127.0.0.1, while this host initially bound `--localhost` only to IPv6 ::1.

```sh
NODE_OPTIONS=--dns-result-order=ipv4first EXPO_PUBLIC_BACKUP_URL=https://backup.bsvblockchain.tech npm start -- --localhost --port 8081
RESTORE_REPRO=0 npm test -- --runInBand --watchman=false --roots ./__tests__ ./packages/expo-wallet-toolbox/__tests__
```

Temporary debugger probes recorded method durations, byte counts and frame gaps.
They were removed after measurement.
No mnemonic, private keys, decrypted backup contents, or payment tokens are included
in the saved measurement artifacts.

## Remaining limitations

The backup protocol does not currently mark a newly rotated generation as a
complete initial snapshot. Selecting the newest generation can therefore select
an interrupted initial upload. Fixing that safely requires coordinated client/server
protocol work and is outside these behavior-preserving local changes.

## Payment test

The user confirmed one 100-satoshi payment to this demo wallet's own receive
address. The local address rail returned in **127.61 ms** (`createAction`
126.25 ms). The short four-frame measurement had a 34.53 ms maximum gap; it is
not a general scrolling/FPS benchmark. The UI displayed “Payment sent”.

The background monitor posted the transaction at +11.38 s and received HTTP 202
`RECEIVED` 95.57 ms later. This was broadcaster acknowledgement, not confirmed
delivery. A later read of the broadcaster's transaction status returned
**REJECTED / 466 / UTXO_SPENT**: an input restored from the demo backup was
already spent by another transaction. The receiving indexer returned no UTXO
and a 404 transaction lookup, so **no successful inbound latency is reported**.
The visible local debit was 147 sats (100 plus the transaction's 47-sat fee),
not evidence of a settled payment. Existing Troubleshooting was run afterward;
it reported **two stuck coins freed and zero payments recovered**. The activity
row still displayed “Accepted” afterward despite the broadcaster rejection;
this is an unresolved status-reporting issue, not a successful transfer.

No payment to `deggen` was submitted: name lookup returned two distinct certified
identities and the recipient-selection question was unanswered. These payment
observations have no before-change latency baseline.

Additional static findings left for follow-up: the toolbox WoC parser ignores
an explicit `isSpentInMempoolTx` flag, and restore's spendable-output query runs
before the spec-op releases some stale reservations. Neither was established
as the cause of this particular rejection; the rejected input's live WoC
script query was already empty. Provider failures also remain “unknown” and
must not be interpreted as permission to discard funds.
