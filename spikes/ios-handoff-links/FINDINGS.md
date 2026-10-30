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


## Page-triggered handoff (no popup tap)

Question: can the extension open `bsvbridgespike://` when the trigger is a web page request, with no tap on the extension popup? Same simulator setup (iPhone 18 Pro, iOS 27.0). Added `Ext/Resources/content.js` (content script, matches `http://localhost/*` and the ngrok host), a `/t` test page in `server/server.js`, and a `tabs.create` / `tabs.update` handler in `background.js`. Page to content script is `window.postMessage`, content script to background is `runtime.sendMessage`. Evidence is `evidence/13` to `20`.

| Variant | Trigger path | System prompt | App opened (`onOpenURL`) | Tabs afterwards | Errors |
|---|---|---|---|---|---|
| A | page click, postMessage, content script, sendMessage, background `tabs.create(scheme)` | Yes: "Open this page in HandoffSpike?" on a new blank tab | Yes, on Open | Original page tab survives; the blank tab closes after Open; Cancel strands a blank Start Page tab | None |
| B | same as A, fired from a 3 s `setTimeout` armed by a tap | Yes, same prompt | Yes (not clicked through in this run; run B0 did) | same as A | None. `navigator.userActivation.isActive` was still true (sticky activation from the arming tap), so this is not a clean no-gesture test |
| B0 | same as A, auto-fired 3 s after load, no touch at all | Yes, same prompt (`userActivation.isActive=false` in the content script) | Yes, on Open | same as A | None |
| C1 | content script sets `location.href = scheme` inside the message event | Yes, but a different one: "Open in HandoffSpike?" over the existing page | Yes, on Open | No new tab; page and tab stay | None |
| C2 | content script creates and clicks `<a href=scheme>` | Yes, same "Open in HandoffSpike?" prompt | Cancel tested: page intact | No new tab | None |
| D | background `tabs.update(sender.tab.id, {url: scheme})` | Yes: "Open this page in HandoffSpike?", shown over the original page | Yes, on Open | No extra tab at all; original page survives, also after Cancel | None |

Other notes:
- Nothing is silent. Every variant shows an OS confirmation, whatever the gesture state. Absence of a user gesture does not block it (B0), so the prompt is the only guard.
- Every variant tried (A, C1, C2, D) was triggered by a trusted tap on the page. Only B0 had no gesture.
- D and C1/C2 are the cleanest. Neither creates a blank tab, and Cancel leaves the user on the original page instead of a stranded Start Page tab. After Open, the OS "Safari" status-bar chip returns to the same page.
- Permissions: the content script did not run until the user granted site access. In Safari the "aA" menu then the extension entry gives: "Handoff Spike would like to access localhost" with "Allow for One Day", "Always Allow...", "Cancel" (evidence/13). I picked "Allow for One Day"; I did not test "Always Allow" or "Allow on Every Website". `host_permissions` in the manifest does not skip this prompt. Messaging worked as soon as the content script was injected, with no extra permission for `runtime.sendMessage` or `tabs.update` on the sender tab (the manifest has the `tabs` permission).
- Not tested: iPhone physical device, `Always Allow`, B0 with C1 or D, iOS 17/18, Private Browsing.

Recommendation: for a page-initiated approval, use a content script that relays to background `tabs.update(sender.tab.id, {url: scheme})` (D), or set `location.href` from the content script (C1). Both avoid the blank-tab leftovers of `tabs.create`; accept one "Open in ..." confirmation and ask users for "Always Allow" on the site.

— Claude Opus 5.5 (Claude Code)
