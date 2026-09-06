# Changelog

## 0.2.2

### Fixes

- `AppLogo`'s rotation now sets `isInteraction: false`. `Animated.timing`
  registers an InteractionManager handle for the duration of the animation, and
  `Animated.loop` means that duration never ends — so the handle was held for
  as long as the component stayed mounted, and while any handle is held
  `InteractionManager.runAfterInteractions` never fires for *anyone* in the
  process. `Balance` renders `<AppLogo rotate />` whenever a balance is loading,
  so this was reachable in normal use: `PayScreen`'s deferred proof sweep never
  ran, and a host that defers real work the same way could hang indefinitely
  with no error and no timeout. Long-standing; found by the bsv-browser session,
  where a dApp's `listOutputs` hung forever behind a loading spinner.

## 0.2.1

### Payments

- The corrupt-pending-queue notice now has a body. `readUnprocessedPending`
  quarantines an unparseable `localpay_pending` blob under a timestamped
  `localpay_pending_corrupt_*` key and clears the live queue, but the card only
  rendered a title ("Damaged payment data was found on this device"), so a user
  carrying incoming payments was told nothing about what happened to them. The
  new `pay_offline_kv_corrupt_body` (all twelve locales) says the payments were
  set aside rather than deleted, and that a sender should be asked to send again
  only if their payment is still missing — a quarantined entry may already have
  been credited, and a blind re-send is the failure worth steering away from.

## 0.2.0

Released from bsv-wallet master, tag `expo-wallet-toolbox-v0.2.0`. Contains
everything merged since 0.1.3, not only the API change below.

### Breaking / API

- **`dismissTo` props are now typed `DismissTarget` (expo-router's `Href`)**
  instead of `string`, on `PayScreen`, `PaymentSuccessOverlay`, `NearbyFlow`,
  `AddressReceive`, `HandleReceive` and `UniversalSend`. A host with
  `experiments.typedRoutes` enabled narrows `Href` globally to its own route
  union, which made a `string` prop unassignable inside this package's own
  files (TS2345); `skipLibCheck` cannot suppress it, because the package ships
  raw `.ts`. Typed-routes hosts now get their route strings checked at the call
  site; hosts without it see `Href` ~ `string`. `Href` also admits the object
  form `{ pathname, params }`, so the accepted type widens — hence the minor
  bump. `DismissTarget` is exported from the `ui` barrel.
  - Note: the props still default to `'/'`. A typed-routes host with no `/`
    route must pass its own value.

### Wallet build and restore

- `WalletContext` destroys an unpublished `StorageExpoSQLite` when a backup
  restore fails, so a retry does not open a second connection to the same
  database file.
- The `SimpleWalletManager` builder rejects instead of resolving `null` on
  failure. The manager authenticates on any resolution, so a failed restore
  could previously mark a wallet built.
- A failed mnemonic build no longer falls back to a stored recovered key: only
  genuinely missing mnemonic material allows the WIF path, so a partial replay
  stays failed and retryable instead of being built over.
- `restoreFromBackup` intent is preserved across an automatic build (only an
  explicit options object now overwrites it).
- `restoreOnImport` passes the device manifest through to the restore.
- `reconcileRestoredProofs` runs after a restore, so a replayed unsent request
  cannot rebroadcast an already-completed transaction. It calls
  `storage.findProvenTxReqs` and `storage.findProvenTxs` — a real widening of
  what the `StorageExpoSQLite` argument must implement. Hosts passing a test
  double or a narrower shim through a cast will need both.
- `RemoteSyncReader` pages the backup index (the server caps a page at 500
  entries) and fails when the index ends before its advertised head, instead of
  treating a truncated wallet as a successful restore. It publishes only a
  fully verified index, advances only after both download and decryption
  succeed, and prefetches at most one small (<= 1 MiB) chunk ahead, storing
  failures as values so a stopped replay leaves no unhandled rejection.
- Backup client requests are bounded by a single deadline covering both the
  request and the body read (React Native's XHR fetch resolves before its
  Blob/FileReader conversion finishes), so a stalled transfer cannot strand the
  monitor.

### Payments

- `creditInboxOnce` rechecks the in-flight slot after each wait, so several
  manual retries queue behind one pass rather than racing.
- The peerpay outbox serializes each storage's whole read-modify-write, not
  just the final write, so a send and the background retry/prune task cannot
  overwrite each other's checkpoints and tokens. Mutations fail closed on an
  unreadable queue rather than treating it as empty, and payment IDs are chosen
  against the live queue so same-millisecond sends stay distinct.
- localpay BLE transport wraps native calls in a promise helper; socket
  transport reliability fixes.

### Storage and UI

- `getLabelsForTransactionId` and `getTagsForOutputId` resolve their
  associations in a single joined query instead of one bridge round trip per
  row.
- `ActivityRow` compares every prop when memoizing, so a retained row cannot
  invoke a previous network's handler or show a stale busy label.
- `useSpendableBalance` / `useVaultBalance` serialize reads and retain the
  latest invalidation, never read or cache a previous chain's storage during a
  network rebuild, and hide the old figure immediately on switch.

## 0.1.3 and earlier

Not recorded here; see git history.
