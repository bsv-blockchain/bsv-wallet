# End-to-end flows (Maestro)

UI flows for the development build, run on the Android emulator and the iOS
simulator with [Maestro](https://maestro.mobile.dev) (`brew install
mobile-dev-inc/tap/maestro`; it needs Java 17: `JAVA_HOME=$(brew --prefix
openjdk@17)/libexec/openjdk.jdk/Contents/Home`). Metro must be running
(`npm start` in apps/bitcoinsv, never with `CI=1`).

A clean Android install without touching the emulator's own wallet: a
second Android user (`adb shell pm create-user e2e`, then
`pm install-existing --user <id> org.bsvblockchain.wallet` and
`am switch-user <id>`). Turn its keyboard's stylus handwriting off
(`settings --user <id> put secure stylus_handwriting_enabled 0`) or its
first-run tutorial takes the typed text. Its dev client also needs its floating Tools button off (dev
menu → Tools button), which sits over Home's Settings button.

```sh
maestro --device <simulator-udid|emulator-5554> test _launch-ios.yaml onboarding.yaml
```

- `_launch-ios.yaml`: cold-starts the iOS development build (it reloads the
  last Metro bundle; the dev-client link is only opened from the launcher).
- `onboarding.yaml`: Welcome, then the first wallet with a free @handle, on a
  fresh install. A clean simulator is the reliable fresh install: iOS keeps
  keychain items across reinstalls, and the core finds a stored wallet there.
- `home-fresh.yaml`: Home for a just-made wallet (0 of 3, not backed up).
- `backup-phrase.yaml` → device check → `backup-phrase-reveal.yaml`: the
  phrase backup. Maestro can't answer the system's Face ID or passcode
  prompt, so it's two flows: on iOS, enrol Face ID once
  (`xcrun simctl spawn <udid> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`
  then `notifyutil -p com.apple.BiometricKit.enrollmentChanged`) and send a
  match between them
  (`xcrun simctl spawn <udid> notifyutil -p com.apple.BiometricKit_Sim.pearl.match`).
  The Android emulator has no screen lock, so the check passes straight on.
  The quiz's right answers carry `quiz-<n>-right` test IDs in development
  builds only.
- `restore.yaml`: Sign in on a new phone with the public BIP39 test phrase,
  on a fresh install, through to Home's set-up card. The field is matched by
  its label with `.*`: on iOS its accessibility text also carries the
  placeholder.
- `notify.yaml`: the payment-arrived toast on the development sample rows
  (`dev-art?notify=1|2`), tapped through to the payment. A real incoming
  payment needs a funded wallet.
- `settings.yaml`: Settings from Home: dark mode, the display currency
  (pounds on Home, then back to dollars), payment alerts, the why sheet, the
  forget check (cancelled), the tour.
- `forget.yaml` → `restore.yaml`: forget a test wallet from Settings to
  Welcome, and bring it back. Only on a test wallet.
- `vault.yaml` (with `_vault-key.yaml`): development builds, on a backed-up
  wallet with no vault: Settings' Vault button, Vault's setup, then the
  core's enrolment wizard with its simulated YubiKeys (Vault's development
  switch; two keys, a PIN each) to the overview and key management. Moving
  money needs a funded wallet.
- `encrypt-sync.yaml`: Settings → Backups → Encrypt & sync through to its
  plain "not available yet" (decision 2: the prototype's steps, the save a
  placeholder). Test passwords avoid a double "r": two R key presses reload
  an Android development build.
- `coins.yaml`: BitcoinSV's coin page from Home, its empty state and on to
  Get paid.
- `wallets.yaml`: Home's wallet switcher, a new wallet with its own free
  @handle (a new profile of the same phrase), and back. Each run adds a
  wallet.
- `help.yaml`: Help & support's quick answers from Home, and Import
  wallet's backup-file placeholder (decision 2).
- `profile.yaml`: your profile from Settings, a new picture.
- `activity-extras.yaml`: Activity's search finding a setting, the filter
  sheet and its count, the header's menu on to help.
- `sync.yaml`: Sync from Settings → Backups, its status and its plan (free;
  the paid plan a placeholder, decision 6).
- `tour-again.yaml`: the tour from Settings, its video closed, then where the
  tour lives: its row lit, a tap shown on Back, Home's Settings button
  glowing.
- `_launch-android.yaml`: brings the Android build to Home.
- `activity-empty.yaml`: Activity from Home's search bar on a wallet with
  no payments (the empty state, filters, on to Get paid and back).
- `activity-detail.yaml` → `contacts.yaml`: the development sample rows
  (`dev-art?activity=1`), a payment's detail and its menu, adding the other
  side as a contact; then Contacts: star into Favourites, delete with Undo,
  rename, the contact's page.

iOS notes: tap the app's own Back (`back` is Android's hardware key); every
deep link raises a system "Open in Bitcoin SV Wallet?" alert outside the
app's tree, tapped by position; a tappable row is one accessibility element
("Ana Silva, +0.0015 BSV, …"), so match rows with `.*`; and turn off the dev
client's floating Tools button, which sits over the header's right button
(`xcrun simctl spawn <udid> defaults write org.bsvblockchain.wallet EXDevMenuShowFloatingActionButton -bool NO`).
- `requests-ask.yaml` + `requests-decline.yaml`: a payment request between
  two wallets on two devices (both on Metro), no funds needed. Start the ask
  on one with the other's handle and display name (`-e HANDLE=@name -e
  NAME="Their Name"`; the asked wallet needs a handle, and must be the open
  wallet on its phone: only the open one reads its requests), and once it is
  waiting for the decline, run the decline on the other.
- `requests-pay.yaml`: paying a request with real (testnet) coins, after the
  other wallet has asked this one for 0.0001 BSV with the note "Testnet
  coffee". Passed between the funded testnet wallets: the iOS simulator
  "BitcoinSV E2E Restore" paying the Android emulator's user 10.
- `sign-in.yaml`: Scan to sign in's intro and its explainer, and Settings →
  Sign-ins.
- `handles.yaml`: Settings → Handles, and a search that opens Settings on
  its row, lit.
- `settings.yaml` runs on a testnet wallet too: its totals stay in BSV, so
  the currency steps are for mainnet wallets.
- `push-routing.yaml`: where a tapped push lands, with pushes played by the
  simulator (`EXPO_PUBLIC_PUSH_SIMULATE=true` in `.env.local`, Metro
  restarted with `--clear`), so it runs before Firebase exists.
