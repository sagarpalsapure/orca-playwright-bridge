# Network: capture, HAR, mocking, blocking, throttling

All of this runs on the raw-CDP driver — Playwright's `page.route()` is only safe for **pure mocks** (see the trap at the bottom).

```js
const { connectOrca } = require('orca-playwright-bridge/connect');
const orca = await connectOrca();          // or { cdpUrl } to pin a tab
```

⚠️ One client per tab: while this raw client is capturing/intercepting, drive the page through it (`orca.evaluate()`, `orca.goto()`) — a Playwright call or native `orcaTabs()` verb on the same tab disconnects it (see `references/browser/connection-and-sessions.md`).

## Record traffic / export HAR

```js
const net = await orca.recordNetwork();    // { events, har(), stop }
await orca.goto('https://example.com');
// events grow live: [{ phase: 'request'|'response'|'failed', id, method, url, status, mimeType, error }]
const failed = net.events.filter(e => e.phase === 'failed');
require('fs').writeFileSync('trace.har', JSON.stringify(net.har()));   // HAR 1.2
net.stop();
```

Note: response **bodies** are not in the HAR — `Network.getResponseBody` is unreliable through the proxy (returns `No resource with given identifier found`), verified and intentionally left out. To capture a response body, mock it, or read it from the page (`fetch` in `evaluate`).

## Block requests (real interception)

CDP `Fetch`-based; works on real requests:

```js
const blk = await orca.blockRequests(['.css', /analytics/, (u) => u.endsWith('.png')]);
await orca.goto('https://example.com');
blk.counts;            // { blocked, allowed }
await blk.stop();
```

## Mock responses

Matched requests get the canned response; everything else passes through untouched:

```js
const mck = await orca.mockResponse(/\/api\/user/, {
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ name: 'Ada' }),
});
// ... drive the page ...
mck.counts;            // { mocked, passed }
await mck.stop();
```

One `blockRequests` OR `mockResponse` at a time per connection (both own the `Fetch` domain).

## Throttle / offline

```js
await orca.throttle('slow-3g');    // 'fast-3g' | 'offline' | { latency, download, upload }
await orca.throttle();             // reset
await orca.offline(true);          // navigator.onLine -> false; offline(false) restores
```

## Extra headers / HTTP auth (native, per tab)

```js
const t = orcaTabs().byId(pageId);
t.setHeaders({ 'X-Debug': '1' });        // extra request headers
t.setCredentials('user', 'pass');        // HTTP basic auth
```

⚠️ These reload the tab — don't use them on a tab with a live Playwright bridge (attach after).

## What works through the Playwright bridge (verified)

- `page.route()` + **`route.fulfill()`** — pure mocking, fine.
- `page.routeWebSocket()` — WebSocket mocking, fine.

## Trap: `route.continue()` / `route.abort()` HANG

Playwright's Network↔Fetch correlation breaks across the bridge's session/frame rewriting, so any `page.route()` handler that lets a **real** request proceed (or aborts it) hangs the request. Rules:

- Mock → `route.fulfill()` (Playwright) or `orca.mockResponse()` (raw).
- Block → `orca.blockRequests()` (raw). Never `route.abort()`.
- Observe → `orca.recordNetwork()` (raw). Don't add a route just to watch traffic.
