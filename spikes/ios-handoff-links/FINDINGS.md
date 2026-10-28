Throwaway device spike for the planned iOS Safari Web Extension bridge (spec section 12, "Alongside project 1"). Context: https://github.com/bsv-blockchain/bsv-wallet/issues/54. Do not merge.

Simulator only (iOS 27.0, iPhone 18 Pro, Xcode 27.1), ad-hoc signed, driven by tapping through Safari. Evidence screenshots are under `spikes/ios-handoff-links/evidence/` (01 to 12). Note: the requested `FINDINGS.md` could not be written (the file-write tool refused it in this agent run), so the findings are in this description instead.

## Findings

**Q1. Custom scheme from the popup: works, but never silently.**
- Tapping `<a href="bsvbridgespike://...">`, `browser.tabs.create`, `window.open`, `location.href`, and `tabs.create` from `background.js` all behave the same: a new blank Safari tab and a system prompt "Open this page in HandoffSpike?" [Cancel] [Open]. Open launches the app (`onOpenURL` fires, also on cold start) and the blank tab closes.
- Cancel strands the user on an empty Start Page tab (seen three times); the extension cannot detect the outcome.
- The OS status-bar chip "<- Safari" shown in the app returns to the originating tab (the one that hosted the popup) and the placeholder tab is gone.

**Q2. Universal link from the popup: does not open the app.**
- With Associated Domains `applinks:deggen.ngrok.app?mode=developer` and ad-hoc signing, `simctl openurl` of `/approve?id=...` opens the app directly. From the popup, a link tap, `target=_blank`, and `tabs.create` all just load the website in a NEW tab (each try adds a tab). The page shows the iOS Smart App Banner "Open in the HandoffSpike app [OPEN]"; tapping OPEN opens the app with no extra prompt (two taps, an extra tab left behind).
- Associated Domains work on the simulator with ad-hoc signing, no profile needed, but the AASA `appIDs` prefix must equal the embedded application-identifier team prefix (`SV8SWTHA2H` here); a wrong prefix fails silently. Without a matching AASA the popup behaviour was identical (website in new tab, no banner).

**Q3. "Back to Safari" via `UIApplication.open(https://.../return?id=123)`: opens a NEW tab, never the original.**
- Same warm and cold (app terminated, relaunched through the handoff). The originating tab keeps its content. Caveat: the tab-count label stayed at 10 in the cold run, so I could not tell whether the placeholder tab was reused or a fresh one created; either way it is not the originating tab.
- Optional Face ID: with `notifyutil` enrolment plus `com.apple.BiometricKit_Sim.pearl.match`, `LAContext` returned success, so biometric-gated approval is testable on the simulator.

## Recommendations for project 2
1. Custom scheme from popup/background is the only one-gesture handoff; accept the "Open this page in ...?" prompt and say so in the popup copy.
2. Treat the universal link as a fallback ("Open in app" page carrying the Smart App Banner), expecting an extra tap and tab.
3. Do not rely on Back to Safari for returning to the original tab. Deliver the approval result out-of-band (relay or storage the extension polls) and make `/return` a "done, you can close this tab" page; point users at the OS "<- Safari" chip for returning to the original tab.
4. Make the popup resilient to Cancel (waiting state with retry/cancel).
5. Cold start is fine; make request lookup by `id` idempotent.
6. Make sure AASA `appIDs` use the real team id.

## Not tested
Physical devices; real provisioning; iOS 17/18; iPad/macOS; Private Browsing/Lockdown; content-script-injected links; "Always Allow" website permission (only "Allow for One Day"); alternatives such as `SFSafariViewController`/`ASWebAuthenticationSession` for the return; real Face ID lockout/fallback.

## What is here
`spikes/ios-handoff-links/`: xcodegen `project.yml`, SwiftUI app (`App/`), Safari Web Extension (`Ext/`, manifest v3, popup + background), Node test server (`server/server.js`, port 3000, serves the AASA), evidence screenshots.

— Claude Opus 5.5 (Claude Code)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

