# Now-mode native app: illustrations, animation and transitions

Date: 9 October 2026. Companion to the [handover](2026-10-09-now-app-handover.md) and [matrix](2026-10-09-now-app-matrix.md).

**Goal:** the app's illustrated animations and transitions must look and feel the same as the designer's prototype (`bitcoinsv-wallet-proto` at `e25ea8e`) on iOS and Android, and must run smoothly. Where they conflict, fidelity comes first.

## Findings

From an inventory of the prototype's Now screens:

- **No WebGL, shaders or 3D engine are used on any Now screen.**
  - `three` / `@react-three/fiber` are never imported.
  - `react-bits/star-burst.tsx` and `react-bits/globe.tsx` have no importers.
  - `onboarding-art.tsx` and its `wf-*` keyframes are dead code.
- **Motion is CSS.**
  - 37 `@keyframes` in `app/globals.css` are used by Now screens.
  - There are ~40 Tailwind `animate-[…]` call sites and ~110 `animate-in/out` entrances.
  - A few `setInterval`/`setTimeout` stage sequences, five `requestAnimationFrame` loops and four Web Animations API calls make up the rest.
- **The "3D" illustrations are CSS 3D:** a perspective plus `rotateX/Y/Z`, with thickness faked by stacked `translateZ(-k px)` layers under `preserve-3d`. Nine scenes use this, including the tilted phone family, seed paper, vault key, recovery cards, and the egg box on Welcome.
- **Blur is decoration:** `blur-2xl/3xl` glows and floor shadows, the drifting blob backdrops on dark cards, and `backdrop-blur` bars and sheets.
- **canvas-confetti** is fired at five success moments.

## Technique (Reanimated 4 first)

| Prototype technique                                                            | Native implementation                                                                                                                                                                                                                                                                                                                              | Status                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| CSS `@keyframes`, `animation-*`                                                | Reanimated 4 CSS animations (`css.keyframes`, `animationName`, `animationDuration`, `animationTimingFunction`, `cubicBezier`). Keyframes, durations and curves are copied verbatim into `src/ui/motion.ts` ([bsv-blockchain/bitcoin-sv-wallet](https://github.com/bsv-blockchain/bitcoin-sv-wallet)). They run on the UI thread on both platforms. | In use on Home                                        |
| CSS transitions                                                                | Reanimated 4 CSS transitions (`transitionProperty`, `transitionDuration`, `transitionTimingFunction`)                                                                                                                                                                                                                                              | In use (card stack, checklist progress, pager, press) |
| CSS 3D poses (`perspective` + `rotateX/Y/Z`)                                   | RN `transform: [{perspective}, {rotateX}, {rotateY}, {rotateZ}]`, the same values                                                                                                                                                                                                                                                                  | In use (tour phone, seed paper)                       |
| `preserve-3d` + `translateZ` thickness layers                                  | RN has neither. `edgeOffset()` in `src/ui/Soft.tsx` projects each `translateZ(-k)` through the same rotation matrix and draws the layer flat at that offset inside the rotated view, so it lands where CSS puts it.                                                                                                                                | In use                                                |
| Positions measured after a 3D transform (seed sparks, coin flight, tour holes) | Computed analytically with `project()` (same matrix plus perspective), or `measureInWindow` for real elements                                                                                                                                                                                                                                      | In use (seed sparks)                                  |
| `blur-*` glows, floor shadows, drifting blobs                                  | SVG radial gradients over the blurred extent (`SoftEllipse`, `Backdrop`), animated with the prototype's keyframes. Same falloff, no per-frame blur.                                                                                                                                                                                                | In use                                                |
| `box-shadow`, `ring-*`                                                         | RN `boxShadow` (CSS syntax, multiple shadows, spread). Rings are spread shadows, so they take no layout space, as in CSS.                                                                                                                                                                                                                          | In use                                                |
| `filter: brightness()` on stacked cards                                        | A black overlay with transitioned opacity (RN `filter` is partial on iOS)                                                                                                                                                                                                                                                                          | In use                                                |
| `text-shadow` (triple)                                                         | A single RN text shadow                                                                                                                                                                                                                                                                                                                            | In use (hero)                                         |
| Press ripple (`lib/ripple.ts`)                                                 | `PressFeedback`: a disc from the touch point, 0.9× the button height, 900 ms cubic-bezier(0.2,0.6,0.3,1), plus the press-down                                                                                                                                                                                                                      | In use (quick actions)                                |
| Gestures (card swipe, tour swipe, sheets, toast dismiss, hold-to-reveal)       | react-native-gesture-handler with Reanimated                                                                                                                                                                                                                                                                                                       | Card swipe in use                                     |
| SVG stroke draw-ins (`pathLength`, tour arrows, ring fill)                     | react-native-svg with computed path lengths (dash offset on the UI thread)                                                                                                                                                                                                                                                                         | In use (tour arrows)                                  |
| canvas-confetti                                                                | Skia particle system (`@shopify/react-native-skia`, app-only dependency)                                                                                                                                                                                                                                                                           | Planned (first success screen)                        |
| `backdrop-blur` bars and sheet overlays                                        | `expo-blur` BlurView on iOS; a solid translucent fill on Android, where blur is experimental                                                                                                                                                                                                                                                       | Planned                                               |
| Phrase "blurred until revealed"                                                | Masked placeholders, not a blur: safer for secrets, and consistent across platforms                                                                                                                                                                                                                                                                | Planned (backup)                                      |
| Egg box (Welcome screen 2): nested `preserve-3d`, 112° hinged lid, Z-hops      | No View-transform equivalent. Rebuilt as 2.5D: tray as a perspective-rotated view, upright eggs at projected cup centres, lid as an affine-projected SVG group driven through the prototype's easing.                                                                                                                                              | In use                                                |
| `prefers-reduced-motion`                                                       | `useReducedMotion()` (OS setting). Every looping or decorative animation stops, as the prototype's `motion-reduce:` variants do.                                                                                                                                                                                                                   | In use                                                |

New dependencies are app-only workspace dependencies, so they never link into the existing app. Skia is added only when the first confetti or egg-box screen needs it.

## How fidelity is checked

Each screen is compared side by side with the prototype at the same viewport (412×915, Playwright screenshots of the prototype in the Now phase, light and dark) on the Android emulator and the iOS simulator. Animated pieces are checked mid-cycle as well as at rest. Known platform differences found so far:

- **Android text measures slightly wider than Chrome**, so a balanced paragraph can wrap one line sooner. Shrink-wrapped centred text with negative tracking can clip, so card titles use a full-width text box.
- **The prototype's seed-card key sits at the top right:** its `coin-bob` animates `top` from 0, which overrides `bottom-6`. The port keeps that.
- **iOS intersects 3D layers with their siblings.** Core Animation depth-sorts a perspective-rotated layer against the flat layers next to it: a glow draws over half the phone, and the phone cuts through the chips. Every 3D element sits in `Flat3D` (`src/ui/Soft.tsx`), a non-collapsable container that is rasterised on iOS and drawn to a hardware texture on Android, so it composites flat in document order, as in the browser.
- **Android `filter` hangs the UI thread.** `filter: [{ saturate: 0.4 }]` (the prototype's `.glass-btn:disabled`) on a pressable, rounded, shadowed view froze the main thread until Android reported the app not responding. Disabled buttons use opacity 0.55 alone. Don't use `filter` on Android.
- **Android can't blur text.** A transparent text shadow stays legible there. The stand-in words under the reveal gate are drawn as soft halo bars the length of each word, the same on both platforms; the real words aren't rendered until the hold completes.
- **Confetti runs in closed form.** canvas-confetti steps each particle per frame. `src/ui/Confetti.tsx` computes the same motion (0.9 velocity decay, 3 px gravity, wobble, tilt, fade over the particle's ticks) from one shared clock on the UI thread.
- **The simulator can't be tapped.** In development builds, `bitcoinsv-wallet://dev-art?brief=0..6` and `?done=1` show a single backup scene without a wallet, and `/?backup=<n>` opens the backup sheet on a briefing screen.
- **Development-only crash on JavaScript reload (Android).** Reloading the JS bundle a few times in a row (Fast Refresh after an edit, `R R`) can crash natively inside Reanimated 4.5.1's teardown (`MountingCoordinator::pullTransaction` / `libreanimated.so`). Reproduced with 5 reloads. Neither the app nor the shared wallet ever reloads JavaScript at runtime, so release builds don't take this path. The existing app shares the same Reanimated version. Revisit when Expo SDK 57's Reanimated is updated.

## Inventory (Now screens)

The complete list, with file and line references, technique and risk per item, was produced on 9 October 2026 and is summarised here:

- **Home:** enter-stagger, hero count-up, quick-action ripple, card stack (tour phone, seed paper and sparks, sync ring), blob backdrops, checklist progress. **Done.**
- **Welcome:** EasyArt (cross-fades, pop and mini-confetti, ring fill, facepile), EggsArt (tray as a real 3D view, upright eggs at projected cup positions with the Z hop converted to screen movement, lid as an affine-projected quad on the prototype's easing), NoDataArt chips, staggered rises, fee bars. **Done.**
- **Backup:** key briefing scenes (coins away, SCAM stamp, writing bars, phone drop, play pulse), filling buttons, hold-to-reveal, keep-safe hints carousel, writing mode, backup-done art (avatars drop in, check, confetti), slices puzzle (pieces slide together, gold fills cross-fade). **Done.**
- **Restore:** recovery visuals (words, key, slices converge, lock), slice scanner sweep, transfer timeline.
- **Sync:** SyncArt, SyncPhoneArt loop.
- **Send / Pay / Request / Receive:**
  - amount caret
  - recipient chips
  - flip card
  - transfer timeline
  - confetti
  - nearby radio pings
  - counter loading
  - scanner sweep
  - QR flip-in
- **Vault:** hardware key art (two poses with extrusion), approval pulse, coin flight.
- **Tour:** dim with holes (one even-odd path), arrow draw-in, handwritten labels; tour video full ↔ corner player (one player, layout transition), word-lit subtitles, review stars. **Done.** Still to do: the tap hint, and the coin-tube loader (a spinner over the poster for now; the bundled video loads at once).
- **System:** toasts (sonner) with swipe-dismiss, bottom sheets (vaul), page fade-up transition, list row entrances.
