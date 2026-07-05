# Debugging: console, metrics, a11y, coverage, raw CDP

```js
const { connectOrca } = require('orca-playwright-bridge/connect');
const orca = await connectOrca();
```

## Console (logs + JS errors)

```js
const cap = orca.captureConsole();       // { messages, stop }
// ... drive the page ...
cap.messages;                            // [{ type: 'log'|'warning'|'error'|..., text }]
cap.stop();
```

Start the capture **before** the action you're debugging — it only sees messages emitted while attached. (Main-world messages may carry unmapped context ids; cosmetic only.)

## Performance metrics & leak checks

```js
await orca.metrics();        // { Nodes, JSEventListeners, JSHeapUsedSize, LayoutCount, ... }
await orca.domCounters();    // DOM node / listener counts — diff before/after for leak checks
```

Leak-check pattern: snapshot `domCounters()`, run the suspect flow N times, snapshot again — monotonically growing nodes/listeners = leak.

## Accessibility tree

```js
const nodes = await orca.axTree();       // full AX tree (Accessibility.getFullAXTree)
```

For an *actionable* snapshot (with refs you can click/fill), prefer the native `orcaTabs().snapshot()`.

## JS & CSS coverage (verified available)

Not wrapped — raw domains answer:

```js
// JS coverage
await orca.client.send('Profiler.enable', {});
await orca.client.send('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
// ... drive ...
const { result } = await orca.client.send('Profiler.takePreciseCoverage', {});

// CSS coverage
await orca.client.send('DOM.enable', {}); await orca.client.send('CSS.enable', {});
await orca.client.send('CSS.startRuleUsageTracking', {});
// ... drive ...
const { ruleUsage } = await orca.client.send('CSS.stopRuleUsageTracking', {});
```

## The escape hatch: `orca.client.send()`

Anything the proxy answers is one call away — `await orca.client.send('Domain.method', params)` — and events via `orca.client.on('Domain.event', cb)`. See `references/browser/cdp-availability.md` for the live-probed matrix of what answers (as of Orca 1.4.123, effectively everything the driver needs — `Page.printToPDF` was the last gap and is now fixed).

Verified-available extras worth knowing:

```js
await orca.client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__hook = 1' }); // init scripts
await orca.client.send('Page.setBypassCSP', { enabled: true });                                    // CSP bypass for injected code
await orca.client.send('WebAuthn.enable', {});                                                     // virtual authenticators
await orca.client.send('Page.setInterceptFileChooserDialog', { enabled: true });                   // file-chooser interception
```

## Playwright-side debugging

`page.on('console')` / `page.on('pageerror')` also work through the bridge; use them when you already hold a Playwright page and don't need pre-attach history.
