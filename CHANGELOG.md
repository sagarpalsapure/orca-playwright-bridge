# Changelog

All notable changes to `orca-playwright-bridge`. Verified against the Orca release noted per entry.

## [Unreleased]

### Added
- `connectOrca().blockRequests(patterns)` — intercept/block real requests via CDP `Fetch` (strings, RegExps, or predicates). The working alternative to Playwright's `route.continue()/abort()`, which hangs through the bridge.
- `connectOrca().recordScreencast(opts)` — record the page as a stream of frames (`Page.startScreencast`); `save(dir)` writes numbered images to assemble into a GIF/MP4.
- `waitForNewTab(action)` — run an action that opens a popup / `target=_blank` tab and drive it via the native `orcaTabs()` driver (page-spawned tabs have no CDP endpoint, so Playwright can't attach).
- `orcaTabs().byId(id).activate()` — bring a tab to the foreground (active + focused).

### Changed
- `openOrcaTab()` now **focuses** the new tab by default (Orca opened it in the background), so you can watch the run. Pass `{ focus: false }` to keep it backgrounded.

### Fixed
- `fullPageScreenshot()` returned 0 bytes on pages taller than Chrome's 16384px limit; the clip is now capped so ultra-tall pages capture the top 16384px.

### Documented (found via exhaustive live testing on Wikipedia + the-internet.herokuapp.com)
- Playwright `page.route()` `continue()/abort()` hangs on real requests (`route.fulfill()` works) — use `blockRequests()`.
- Child `<iframe>`s aren't exposed to Playwright (`page.frames()` = main only); same-origin workaround via `contentDocument` in a main-world `evaluate`.
- Popups / `target=_blank` open as a separate Orca tab with no CDP endpoint (Playwright can't attach); use `waitForNewTab()`.
- Investigated iframe support: Orca *does* emit the child frame tree + `frameAttached` + child execution contexts, so exposing iframes to Playwright is a feasible (if deep) bridge fix — not an Orca gap. Deferred to avoid destabilizing the core.
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
