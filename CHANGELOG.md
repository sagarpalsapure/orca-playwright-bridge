# Changelog

All notable changes to `orca-playwright-bridge`. Verified against the Orca release noted per entry.

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
