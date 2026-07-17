# Changelog

All notable changes to `orca-playwright-bridge`. Verified against the Orca release noted per entry.

## [1.6.0] — Orca v1.4.144

Re-verify against Orca 1.4.144 (was 1.4.123) plus a batch of smoothness enhancements. The three upstream fixes this project tracks (`page.reload()`, `page.pdf()`, profile isolation) all remain fixed on 1.4.144.

### Added
- **`openOrcaTab(url, { isolated })`** — opens the tab in a fresh isolated browser profile (its own cookies/localStorage; isolation fixed upstream in 1.4.123, [#6923](https://github.com/stablyai/orca/issues/6923)) and **deletes that profile on `close()`**. Pass a string to name it, or `{ profile: '<id>' }` to reuse an existing profile. `conn.profileId` reports the profile in use.
- **`conn.reattach()`** on `openOrcaTab()`/`attachOrcaTab()` connections — the one-call remedy for the "one client per tab" trap: `conn = await conn.reattach()` frees the dead bridge/browser and returns a fresh connection pinned to the same tab.
- **`orcaVersion()` / `versionGte(a, b)`** exports — best-effort Orca app version (override with `ORCA_VERSION`) and a dotted-version comparator. `connectOrcaPlaywright().reload()` is now **version-aware**: native `page.reload()` on Orca ≥ 1.4.120, re-navigate fallback on older builds.
- **`recordNetwork({ bodies: true })`** — captures response bodies (`Network.getResponseBody`) into HAR `content.text` for a fully replayable archive. Off by default (adds a round-trip per request).
- **`recordScreencast().toVideo(path)` / `.toGif(path)`** — encode captured frames to MP4/GIF via `ffmpeg` (clear error if ffmpeg is absent; `save(dir)` unchanged).
- **`npx orca-playwright-bridge doctor`** — preflight health check: Orca reachable, detected Orca version, tab open, deps (`ws`/`playwright`/`chrome-remote-interface`) and tooling (`lsof`, optional `ffmpeg`) resolvable.
- **`orcaTabs({ worktree })` + tab fields** — `orcaTabs()` and `orcaTabList()` accept a worktree selector (or `'all'`), and `orcaTabs().list` now surfaces `profileId`, `profileLabel`, and `worktreeId`.

### Changed
- **CDP discovery no longer shells out to `curl`.** `discoverAllCdpEndpoints()` (and `orca-connect.js`'s `scanForCdp()`) now probe candidate ports with Node's core `http`, **concurrently** (`Promise.all`) — no `curl` dependency (portable to minimal containers) and a faster connect. `bin/orca-cdp` (a shell tool) still uses curl by design.
- **Faster tab open/switch** — fixed `sleep()` polling replaced with exponential backoff (fast when ready, patient when not).
- **BREAKING (low-level helpers only):** the discovery helpers are now **async** — `discoverAllCdpEndpoints()`, `discoverCdpUrl()`, `findCdpUrlForTab()`, `findEndpointForPageId()` (main entry) and `discoverCdpUrl()`/`scanForCdp()` (`./connect`) return Promises. The headline API (`connectOrcaPlaywright`, `openOrcaTab`, `attachOrcaTab`, `orcaTabs`, `startBridge`, `connectOrca`) is unchanged. Type defs updated in `index.d.ts` / `connect.d.ts`.

### Test run (live, Orca 1.4.144)
- Full suite **45 tests: 40 pass, 0 fail, 5 skipped** (popup activation-gating + no simulator/emulator booted), clean process exit. New `test/enhancements.test.js` locks in isolated profiles, `reattach()`, HAR bodies, screencast→GIF, and the version helpers.

## [1.5.2] — Orca v1.4.123

### Fixed
- **`/orca` command pointed at a skill that no longer exists.** The command template told the agent to "lean on the `orca-browser` skill" — but that skill was renamed to **`orca-automation`** in 1.5.0. Both references in `commands/orca.md` corrected so the shipped command resolves to the right skill. (Docs-only; no code/API changes.)

## [1.5.1] — Orca v1.4.123

### Two upstream limitations fixed by Orca — re-verified live against 1.4.123
- **`page.pdf()` / `Page.printToPDF` now works** ([stablyai/orca#7032](https://github.com/stablyai/orca/issues/7032)). The proxy answered `Page.printToPDF` on 1.4.123 where it was absent on ≤ 1.4.120 ("the one gap"). Verified end-to-end: raw CDP returns valid `%PDF-` bytes, and Playwright's `page.pdf()` tunnels through the bridge cleanly.
  - **Added `orca.pdf(path?, opts?)`** to the raw-CDP driver (`connectOrca()`) — wraps `Page.printToPDF` (`printBackground` on by default; opts pass straight to CDP). Types in `connect.d.ts`; new capability test in `test/raw-cdp.test.js`.
- **Profile storage isolation now works** ([stablyai/orca#6923](https://github.com/stablyai/orca/issues/6923)). `tab profile create --scope isolated` now gives a tab its own storage, not just a partition string — an isolated-profile tab no longer sees the default profile's localStorage/cookies. `repro/profile-isolation.js` (once a bug reproducer) now **PASSES** and serves as a regression guard.

### Still holds on 1.4.123 (re-probed)
- `context.newCDPSession()` still blocked — `Target.attachToBrowserTarget` → `Not allowed` ([#7033](https://github.com/stablyai/orca/issues/7033)).
- `page.fill()` still no-ops without focus — click first ([#7035](https://github.com/stablyai/orca/issues/7035)).
- `page.reload()` remains fixed (since 1.4.120, [#7031](https://github.com/stablyai/orca/issues/7031)).

### Changed
- **Re-stamped docs 1.4.120 → 1.4.123** where re-verified: README limitations + capability list, `SKILL.md` traps table (dropped the now-fixed pdf/profile-isolation rows), `cdp-availability.md` (flipped `Page.printToPDF` to ✅, probe date 2026-07-05), `emulation.md`, `capture.md`, `debugging.md`, `storage-and-cookies.md`.
- **`window.open()` popups are activation-gated on 1.4.123.** A page-spawned popup only opens when the page holds transient user activation / foreground focus — under pure automation that activation often isn't present, so the handler fires but no tab opens (an Orca-side popup behavior, not a bridge defect). The `waitForNewTab()` capability test now **skips gracefully** when Orca declines to spawn the popup, and still asserts detection correctness when one does open. Documented in `multi-tab-and-popups.md`. `waitForNewTab()` itself is unchanged.

### Test run (live, Orca 1.4.123)
- Full browser suite: **all pass**, plus the popup test which self-skips when the activation-gated popup doesn't open. Mobile tests skip (no simulator/emulator booted). Mobile, `Tracing`, and dialog reference docs retain their 1.4.120 stamp — not re-run this pass (no device booted).

## [1.5.0] — Orca v1.4.120

### Changed — one package, two surfaces (skill reorganization)
- **Unified the skill around Orca as the host, not the browser.** The `orca-browser` skill is now **`orca-automation`** (`skills/orca/`), with a routing `SKILL.md` that sends browser tasks to `references/browser/*` and mobile tasks to `references/mobile/*`.
  - `skills/orca-browser/references/*.md` (the 9 browser deep-dives) → `skills/orca/references/browser/`.
  - `mobile-maestro.md` split into `skills/orca/references/mobile/`: `devices-and-setup.md`, `flows.md`, and a new **`maestro-mcp.md`** (Maestro MCP vs. the programmatic driver, and pinning the MCP to Orca's device via `orca-playwright-bridge/maestro`'s resolvers).
- **No API changes** — the JS surface (`.`, `./connect`, `./maestro`) is untouched; this is a docs/skill layout change plus manifest/README rewording to tell the unified "browser + mobile from one package" story.
- Reframed `plugin.json` / `marketplace.json` descriptions and added `maestro` / `mobile-automation` / `ios-simulator` / `android-emulator` keywords.

## [1.4.0] — Orca v1.4.120

### Added — native mobile automation (iOS + Android) via Maestro
- **`orca-playwright-bridge/maestro`** — a new entry point that drives native mobile apps with [Maestro](https://maestro.mobile.dev), pointed at the device Orca boots. The mobile analogue of the browser bridge: Orca manages the iOS simulator through its `serve-sim` helper, and Maestro drives the *same* device by id.
  - **`iosMaestro(opts)`** — driver bound to Orca's booted iOS simulator (or attaches one via `orca emulator attach` when `{ device }` is given).
  - **`androidMaestro(opts)`** — driver bound to a booted Android emulator/device (resolved through `adb`).
  - **Opens the device in Orca automatically.** Creating a driver attaches the device in Orca by default so it appears in the app — iOS via serve-sim, Android via scrcpy (the driver resolves the AVD name from the serial and runs `orca emulator attach`). Best-effort (never blocks driving if Orca is down); opt out with `{ attachToOrca: false }`. `driver.orcaMirrored` reports the attach info.
  - **`flow(appId)`** — a fluent `Flow` builder that emits Maestro YAML: `launchApp`/`tapOn`/`inputText`/`pressKey`/`swipe`/`assertVisible`/`openLink`/`takeScreenshot`/… plus `raw()` for any un-wrapped command.
  - Driver methods: `runFlow()` (returns `{ ok, stdout, stderr, yaml }` — never rejects), `hierarchy()` (JSON view-tree snapshot, the DOM/AX analogue), `screenshot()` (via `simctl` on iOS, `adb exec-out screencap` on Android), and one-command helpers `launchApp`/`tapOn`/`inputText`/`openLink`.
  - **JDK auto-discovery** — Maestro is JVM-based; the driver finds a Homebrew keg-only / macOS / SDKMAN JDK and injects `JAVA_HOME` for the Maestro child process, so no shell PATH setup is required.
  - Types in `maestro.d.ts`; skill playbook in `skills/orca/references/mobile/`.

### Verified (live, Orca 1.4.120)
- Ran the driver against a live **iOS Simulator** (iPhone 17, iOS 26.5) and **Android emulator** (Pixel 8 Pro): **5/5 checks each** — `hierarchy()` view-tree, `screenshot()` PNG (iOS 152 KB via simctl, Android 1.8 MB via adb — confirmed a real Pixel home screen), launch Settings, foreground assertion, and `openLink`.
- Mapped Orca's `serve-sim` control surface while evaluating approaches: `orca emulator tap/type/button/rotate/gesture` (gesture takes a JSON **array** of `{type:begin|move|end, x, y}` normalized 0..1 points), `/ax` accessibility tree (frames in points; screen = root frame), screenshot via `simctl`. serve-sim also embeds a CDP/WebInspector bridge, but its `/json` endpoints are empty on the control port — no verified path into simulator web content yet.
- **Orca's emulator is cross-platform** (verified live): `orca emulator attach "<name>"` makes a device Orca's active emulator — iOS via serve-sim (`backend: ios`) or **Android mirrored over scrcpy + adb** (`backend: android`, `streamUrl: scrcpy://<serial>`). Orca boots the iOS sim itself; for Android it attaches to an already-running AVD. `orca emulator list` reports only the iOS serve-sim helper (`running: false` even when Android is attached and scrcpy is live). The `androidMaestro()` driver drives over `adb` independently of Orca's mirroring.

## [1.3.0] — Orca v1.4.120

### Added
- **Skill references** (playwright-cli-style): the `orca-browser` skill now ships a `references/` directory with task-focused deep dives — connection & multi-session safety, multi-tab & popups, network (HAR/mock/block), emulation, cookies & storage, capture, tracing, debugging, and a live-probed CDP availability matrix. `SKILL.md` stays lean and links out per task.

### Fixed
- **`clearEmulation()` now clears everything `emulate()` sets.** It previously reset only device metrics + CPU rate, leaving the user-agent, timezone, locale, and `prefers-color-scheme` overrides stuck on the tab after disconnect. (Caught by validating the skill's emulation recipe against live Orca.)

### Discovered & documented (recipe validation against live Orca 1.4.120)
- **One CDP client per tab — last attach wins.** Attaching raw CDP, a second Playwright bridge, or even a one-shot native `orca … --page` verb silently disconnects the tab's current client (verified in every direction; other tabs unaffected). Docs previously implied Playwright + raw CDP could share a tab concurrently — they cannot. Safe sequencing patterns documented in the skill + README.
- **JS dialogs: only `confirm()` is real.** Orca swallows `alert()` silently and `prompt()` throws `"prompt() is not supported."` in-page. `confirm()` verified working via both native `acceptDialog()`/`dismissDialog()` and Playwright `page.on('dialog')` through the bridge. The 1.2.0 note that `acceptDialog(text)` "answers a prompt" is moot — no prompt dialog can appear; stub `window.prompt` instead.

### Verified (live CDP probe, Orca 1.4.120)
- **`Tracing` works end-to-end** — `Tracing.start` → `tracingComplete` → `IO.read` stream returns real Chrome trace files (`devtools.timeline`, `blink.user_timing` marks included). Previously undocumented; recipe in `skills/orca/references/browser/tracing.md`.
- ~50 methods probed across Page/Network/Fetch/Emulation/diagnostics domains: everything answers **except `Page.printToPDF`** (the known #7032 gap). Newly confirmed available: `Emulation.setGeolocationOverride`/`setUserAgentOverride`/`setTouchEmulationEnabled`/`setEmulatedVisionDeficiency`/`setIdleOverride`, `Profiler` (JS coverage), `CSS.startRuleUsageTracking` (CSS coverage), `DOMSnapshot.captureSnapshot`, `Page.addScriptToEvaluateOnNewDocument`, `Page.setBypassCSP`, `Page.setDownloadBehavior`, `Page.setInterceptFileChooserDialog`, `Page.getNavigationHistory`, `WebAuthn`, `IndexedDB`, `ServiceWorker`, `Storage.getUsageAndQuota`. Full matrix: `skills/orca/references/browser/cdp-availability.md`.

## [1.2.3] — Orca v1.4.120

### Fixed
- **Multi-session cross-driving** — when two independent drivers ran against Orca, one could start driving the other's tab. Root cause: default discovery fell back to "the first/active endpoint," which flips whenever any session opens or focuses a tab.
  - `discoverCdpUrl()` now **throws with the full tab list** when >1 tab is open and no tab was specified, instead of silently picking the active one.
  - `openOrcaTab()` resolves its tab's CDP port by the created `browserPageId` (URL join, diff as tiebreaker) rather than a bare port-set diff — closing a race when two sessions open tabs at once.

### Added
- **`attachOrcaTab(pageId)`** — re-attach Playwright to a tab you already own by its `browserPageId`, regardless of which tab is focused. The multi-session-safe way to reconnect. `close()` detaches the bridge but leaves the tab open.
- **`findEndpointForPageId(pageId, preferNotIn?)`** — resolve the CDP endpoint serving a given `browserPageId` (exported helper).

## [1.2.2] — Orca v1.4.120

### Added
- **`mockResponse(patterns, response)`** on the raw-CDP driver (`connectOrca()`) — fulfill matching requests with a canned response (status/headers/body) via CDP `Fetch.fulfillRequest` while letting the rest pass through. The reliable alternative to Playwright's `route.continue()`, which hangs on real requests through the bridge. Returns `{ counts: { mocked, passed }, stop() }`.

### Verified / not added
- Probed `Network.getResponseBody` for HAR-with-bodies: unreliable through the proxy (`No resource with given identifier found`), so it's intentionally left out.

## [1.2.1] — Orca v1.4.120

### Fixed upstream (docs updated)
- **`page.reload()` now works** — Orca **1.4.120** fixed it (it previously closed the tab; [stablyai/orca#7031](https://github.com/stablyai/orca/issues/7031)). Verified: reload keeps the tab and re-executes the document. The `reload()` helper remains as a fallback for Orca < 1.4.120. README/skill/command traps updated.

### Verified
- Re-ran the rest against **Orca 1.4.120** — still hold: profile isolation (#6923), `page.pdf` (#7032), `newCDPSession` (#7033), `page.fill`-focus (#7035). No new browser verbs since 1.4.117.

## [1.2.0] — Orca v1.4.117

### Added (new `orcaTabs()` verbs from Orca 1.4.117)
- **Dialog handling** — `acceptDialog(text?)` / `dismissDialog()` for JS `alert`/`confirm`/`prompt` (previously an unavoidable blocker).
- **Web storage** — `getStorage(key)` / `setStorage(key, value)` / `clearWebStorage()` (native, `{ session: true }` for sessionStorage).
- `highlight(selector)` — outline an element (demos/debugging).
- `download(selector, path)` — download a file by selector.
- `exec(command)` — escape hatch to run any raw agent-browser command.

### Verified
- Re-ran every documented limitation against **Orca 1.4.117**: **none fixed** — profile isolation (#6923), `page.reload` (#7031), `page.pdf` (#7032), `newCDPSession` (#7033), `page.fill`-focus (#7035) all still hold. README re-stamped to 1.4.117. (Clipboard verbs exist in 1.4.117 but are permission-gated, so not wrapped.)

## [1.1.1]

### Docs
- Blunt install messaging: the README now states up front (and in the install table) that `npm i orca-playwright-bridge` is the **library only** — the full setup (CLI + `/orca` command) is `npx orca-playwright-bridge setup`. (npm's auto-generated "Install" box isn't editable, so the README, which npm renders below it, carries the correction.)

## [1.1.0] — Orca v1.4.114

### Added
- **One-command install:** `npx orca-playwright-bridge setup` — installs the package (with deps) into `~/.orca-playwright-bridge`, symlinks the `orca-cdp` CLI + libs into `~/.local`, and installs the `/orca` command. (`get.sh` does the same from GitHub, no npm.)
- `get.sh` — `curl … | bash` bootstrap for the npm-free path.

### Changed
- **Commands simplified to a single `/orca`.** Removed `/orca-pw` and `/orca-test` in favor of one plain-language command; the detailed playbook + traps live in the `orca-browser` skill and README.

## [1.0.7] — Orca v1.4.114

### Added
- **Claude Code plugin** — `.claude-plugin/plugin.json` bundling the auto-invoked **`orca-browser` skill** (`skills/orca-browser/SKILL.md`) plus the upgraded `/orca-pw` and `/orca-test` commands. The skill teaches an agent the capability map *and* the verified traps (click-then-fill, reload-closes-tab, popups→`waitForNewTab`, `route`→`blockRequests`, iframes read-only, etc.) so it uses the bridge correctly without trial and error.
- `waitForNewTab(action)` — capture a page-spawned popup / `target=_blank` tab and drive it via the native `orcaTabs()` driver (page-spawned tabs have no CDP endpoint).
- `orcaTabs().byId(id).activate()` — bring a tab to the foreground.
- `connectOrca().blockRequests(patterns)` — intercept/block real requests via CDP `Fetch` (strings, RegExps, or predicates). The working alternative to Playwright's `route.continue()/abort()`, which hangs through the bridge.
- `connectOrca().recordScreencast(opts)` — record the page as a stream of frames (`Page.startScreencast`); `save(dir)` writes numbered images to assemble into a GIF/MP4.

### Changed
- `openOrcaTab()` now **focuses** the new tab by default (Orca opened it in the background), so you can watch the run. Pass `{ focus: false }` to keep it backgrounded.

### Fixed
- `fullPageScreenshot()` returned 0 bytes on pages taller than Chrome's 16384px limit; the clip is now capped so ultra-tall pages capture the top 16384px.
- **Child `<iframe>`s now surface to Playwright.** `swapFrameIds` didn't rewrite the parent-reference keys (`parentId` / `parentFrameId`), so child frames referenced the main frame by Orca's real id (which Playwright knows as the targetId) and were orphaned/dropped. Rewriting those keys means `page.frames()` includes iframes and `frameLocator()` reads work (incl. cross-origin). Interaction / `frame.evaluate()` inside iframes still don't work (no child main-world context).

### Documented (found via exhaustive live testing on Wikipedia + the-internet.herokuapp.com)
- Playwright `page.route()` `continue()/abort()` hangs on real requests (`route.fulfill()` works) — use `blockRequests()`.
- Popups / `target=_blank` open as a separate Orca tab with no CDP endpoint (Playwright can't attach); use `waitForNewTab()`.
- Stress-tested: 12 tabs + 4× concurrent `evalAll` + 3 concurrent bridges — no races, no port exhaustion.
- Verified working live: login/auth, checkboxes/dropdown, file upload, hovers, key presses, dynamic DOM add/remove, dynamic control state, redirects, HTTP status via HAR, infinite scroll, HTML5 drag-and-drop, large DOM, range slider, Shadow DOM piercing, HTTP basic auth, concurrent multi-tab.

## [1.0.6] — Orca v1.4.114

### Added
- **TypeScript types** — `index.d.ts` (main / `./bridge`) and `connect.d.ts` (`./connect`), wired via `types` + per-subpath `exports`. Type-checked under `--strict` in CI.
- **`connectOrca()` raw-CDP power tools** — the proxy answers ~35 CDP domains on the page socket, so the raw driver now wraps: `captureConsole()` (console + JS errors), `recordNetwork()` with `.har()` (HAR 1.2), `throttle()`/`offline()`, `cookies()`/`setCookie()`/`clearCookies()`, `storage()`/`clearStorage()`, `emulate({ device, timezone, cpu, colorScheme })` (instant, no reload), `fullPageScreenshot()`, `captureMHTML()`, `axTree()`, `domCounters()`, `metrics()`.
- **`orcaTabs().evalAll(js)`** — evaluates in every open tab with genuine wall-clock concurrency (async + `Promise.all`).
- **Safe `reload()`** on the Playwright connection — re-navigates the current URL instead of `page.reload()` (which closes the tab through Orca's proxy).
- **CI** — GitHub Actions (Node 20/22): module-load smoke, `npm test` (auto-skips without Orca), and a `.d.ts` type-check job.
- `examples/` — runnable multi-tab, login-form, and device-screenshot scripts.

### Changed
- `switchToOrcaTab()` polls for the tab to become active instead of a fixed 700 ms sleep.
- README no longer describes the synchronous `orcaTabs()` driver as "concurrent"; points to `evalAll()` / per-tab bridges for true concurrency.

## [1.0.5] — Orca v1.4.114

### Added
- `orcaTabs().find(locator, value, { action, text })` — semantic role/text/label find-and-act (survives navigation).
- `orcaTabs()` low-level mouse: `mouseMove`/`mouseDown`/`mouseUp`/`mouseWheel`.

### Changed
- `playwright-core` floor → `^1.61.1`.
- Re-verified all documented limitations against Orca 1.4.114 (none fixed) and filed them upstream: stablyai/orca #7031–#7035 (plus #6923 for profile isolation).

## [1.0.4]

### Fixed
- `ENOBUFS` on large screenshots — `orcaCli()` `execFileSync` buffer raised to 64 MB.

## [1.0.3] — Orca v1.4.110

### Added
- Integration + capability test suites (`npm test`), skip-cleanly without Orca.
- Expanded `orcaTabs()` driver (full read/navigate/interact set) + emulation primitives (`setDevice`/`setOffline`/`setMedia`/`setHeaders`/`setCredentials`).
- Verified advanced Playwright features tunnel through the bridge: `page.route()`, `page.routeWebSocket()`, `context.cookies`, `page.emulateMedia()`.
- Modernized attach: `connectOverCDP({ isLocal: true, noDefaults: true })`.

### Documented
- Limitations characterized empirically: `page.fill()` needs a prior click, `page.reload()` closes the tab, no `newPage`/`newContext`, no `newCDPSession`, no `page.pdf()`, `--scope isolated` profiles still share storage.
