# CDP availability matrix (live-probed)

Every method below was sent to Orca's CDP proxy on a throwaway tab and classified by its actual response. Probed **2026-07-05 against Orca 1.4.123**. Re-probe after an Orca upgrade if something here matters to your task.

**Legend:** ✅ answers correctly · ❌ method absent from the proxy.

## Page

| Method | | Notes |
| --- | --- | --- |
| `Page.captureScreenshot` | ✅ | wrapped: `screenshot()` |
| `Page.getLayoutMetrics` | ✅ | enables `fullPageScreenshot()` |
| `Page.captureSnapshot` (MHTML) | ✅ | wrapped: `captureMHTML()` |
| `Page.startScreencast` | ✅ | wrapped: `recordScreencast()` |
| `Page.printToPDF` | ✅ | wrapped: `pdf()`; `page.pdf()` works too — **fixed in Orca 1.4.123** (was absent ≤ 1.4.120; stablyai/orca#7032) |
| `Page.getNavigationHistory` | ✅ | back/forward programmatically |
| `Page.handleJavaScriptDialog` | ✅ | but only `confirm()` ever shows a dialog — `alert()` is swallowed, `prompt()` throws (see multi-tab-and-popups.md) |
| `Page.setDownloadBehavior` | ✅ | route downloads to a directory |
| `Page.addScriptToEvaluateOnNewDocument` | ✅ | init scripts |
| `Page.setBypassCSP` | ✅ | |
| `Page.setInterceptFileChooserDialog` | ✅ | |
| `Page.getFrameTree`, `Page.setLifecycleEventsEnabled` | ✅ | |

## Network / Fetch

| Method | | Notes |
| --- | --- | --- |
| `Fetch.enable` (interception) | ✅ | wrapped: `blockRequests()`, `mockResponse()` |
| `Network.getCookies` / `setCookie` / `clearBrowserCookies` | ✅ | wrapped: `cookies()` etc. |
| `Network.emulateNetworkConditions` | ✅ | wrapped: `throttle()`, `offline()` |
| `Network.setBlockedURLs`, `Network.setExtraHTTPHeaders` | ✅ | |
| `Network.getResponseBody` | ⚠️ | *exists but unreliable* — `No resource with given identifier found`; don't build on it |

## Emulation

All probed methods answer: `setDeviceMetricsOverride`/`clear…` ✅, `setTimezoneOverride` ✅, `setLocaleOverride` ✅, `setCPUThrottlingRate` ✅, `setEmulatedMedia` ✅, `setTouchEmulationEnabled` ✅, `setGeolocationOverride` ✅, `setUserAgentOverride` ✅, `setIdleOverride` ✅, `setEmulatedVisionDeficiency` ✅. Wrapped high-level: `emulate()` / `clearEmulation()`.

## Diagnostics & profiling

| Method | | Notes |
| --- | --- | --- |
| `Tracing.start` / `end` + `IO.read` | ✅ | **verified end-to-end** — real trace files; see `references/browser/tracing.md` |
| `Performance.getMetrics` | ✅ | wrapped: `metrics()` (0 metrics until the domain warms up after enable) |
| `Memory.getDOMCounters` | ✅ | wrapped: `domCounters()` |
| `Runtime.getHeapUsage` | ✅ | |
| `Accessibility.getFullAXTree` | ✅ | wrapped: `axTree()` |
| `Profiler.*` (JS coverage) | ✅ | |
| `CSS.startRuleUsageTracking` (CSS coverage) | ✅ | |
| `DOMSnapshot.captureSnapshot` | ✅ | |
| `Log.enable`, `Console.enable` | ✅ | wrapped: `captureConsole()` |

## Misc domains that answer

`DOMStorage` ✅ · `IndexedDB` ✅ · `ServiceWorker` ✅ · `WebAuthn` ✅ · `Security` ✅ · `Animation` ✅ · `Overlay` ✅ · `Storage.getUsageAndQuota` ✅ · `Input.insertText` / `Input.dispatchDragEvent` ✅.

## Blocked at the Target level (unchanged)

- `Target.createTarget` → no `newPage`/`newContext`; use `openOrcaTab()`.
- `Target.attachToBrowserTarget` → no `context.newCDPSession()`; use `connectOrca()`.

## Proxy connection behavior (verified)

The endpoint accepts **one client at a time — last attach wins**. Any new attachment (Playwright bridge, raw CDP, or a one-shot native `orca` verb) silently disconnects the tab's previous client. See `references/browser/connection-and-sessions.md` for the safe sequencing patterns.

## Re-probing

A ready-made probe pattern: connect raw, `orca.client.send(method, params)` in a try/catch, and classify — "method wasn't found" = absent; a parameter/state error (e.g. "No dialog is showing") = the method **exists**.
