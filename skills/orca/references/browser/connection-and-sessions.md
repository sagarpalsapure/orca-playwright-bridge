# Connection & session management

## Preconditions

1. Orca running: `orca status --json` → `result.app.running === true` (and `result.runtime.reachable`). If not, stop and tell the user to open Orca.
2. The CDP proxy is **tab-scoped and ephemeral** — it only exists while a tab is open, on a new port each launch. `orca-cdp` discovers it (exit `1` = Orca not running, `2` = no tab open).
3. Resolve the package:

```js
let bridge, connect;
try {
  bridge = require('orca-playwright-bridge');
  connect = require('orca-playwright-bridge/connect');
} catch {
  bridge = require(process.env.HOME + '/.local/lib/orca-pw-bridge.js');   // install.sh layout
  connect = require(process.env.HOME + '/.local/lib/orca-connect.js');
}
```

## The three entry points

| Entry point | Returns | Use for |
| --- | --- | --- |
| `openOrcaTab(url, { focus?, profile? })` | Playwright `page` on a **new** tab | Default. `close()` closes the tab too. |
| `connectOrcaPlaywright({ tab: /regex/ })` | Playwright `page` on an **existing** tab | Driving the user's open tab. `close()` detaches only. |
| `connectOrca({ cdpUrl? })` (from `/connect`) | Raw-CDP driver | Power tools: network capture, emulation, tracing, storage, capture. |

`openOrcaTab` focuses the new tab so the user can watch; pass `{ focus: false }` for background work.

## Endpoints: one per tab

Every open Orca tab exposes **its own CDP endpoint on its own port**. That's why:

- You can bridge multiple tabs at once — a Playwright connection per tab, truly concurrent.
- `connectOrcaPlaywright()` with **no `tab` option throws with the tab list when >1 tab is open** (deliberate — it will not silently grab the active tab). Always pass `{ tab: /url-substring/ }`.

Discover endpoints yourself: `orca-cdp --all` (one `<cdpUrl> <pageUrl>` line per tab), `orca-cdp --match <regex>`, or in JS `discoverAllCdpEndpoints()` / `findCdpUrlForTab(match)`.

## Multi-session safety: pin your tab

Two independent drivers (e.g. two Claude sessions) must not steal each other's tabs. The safe pattern:

```js
const t = await openOrcaTab('https://example.com');
const myTab = t.browserPageId;          // keep this — it is YOUR handle
// ... later, or after a disconnect, re-attach to that exact tab:
const t2 = await attachOrcaTab(myTab);  // lands on that tab no matter which is focused
await t2.page.title();
await t2.close();                       // detaches the bridge, leaves the tab open
```

`attachOrcaTab(pageId)` resolves the endpoint by `browserPageId` (`findEndpointForPageId(pageId)` is the exported helper). Never target "the active tab" in a flow that another session might also be running.

## ONE client per tab — last attach wins (verified)

A tab's CDP endpoint serves **one automation client at a time**. Attaching anything new — a raw `connectOrca()`, another Playwright bridge, or even a single native `orcaTabs()` verb — **silently disconnects the previous client on that tab** (verified both directions on Orca 1.4.120). Other tabs are unaffected. Symptoms of getting this wrong: `Target page, context or browser has been closed` (Playwright) or `WebSocket connection closed` (raw).

Rules that follow:

- **Never interleave two live clients on one tab.** Sequence them, and re-attach when you switch back:

```js
const t = await openOrcaTab('https://example.com');
await t.page.click('#load');                       // Playwright phase
const ep = findEndpointForPageId(t.browserPageId);
const orca = await connectOrca({ cdpUrl: ep.cdpUrl });   // kicks the bridge — PW phase is OVER
await orca.fullPageScreenshot('page.png');         // raw phase; drive via orca.evaluate()/goto() only
await orca.close();
const t2 = await attachOrcaTab(t.browserPageId);   // back to Playwright: re-attach
```

- **While a raw client is capturing** (network, console, screencast, tracing), drive the page through that same client (`orca.evaluate()`, `orca.goto()`) — a Playwright call or native verb on that tab kills the capture mid-flight.
- **Native `orcaTabs()` verbs are safe with each other** (each is a one-shot attach→act→detach), and safe as the *last* actor — but each one kicks whatever long-lived client was attached.
- Native emulation (`orcaTabs().set*`) additionally **reloads the tab** to apply — see `references/browser/emulation.md`.

## What you can NOT do

- `browser.newPage()` / `browser.newContext()` — proxy rejects `Target.createTarget`. Use `openOrcaTab()`.
- `context.newCDPSession()` — proxy rejects `Target.attachToBrowserTarget`. Use `connectOrca()` instead; it reaches the same domains directly.
- `page.reload()` on Orca **< 1.4.120** closed the tab (fixed in 1.4.120). The connection's `reload()` helper works on every version.

## Cleanup contract

Every `close()` (bridge, raw CDP, tab driver) detaches/stops the local side — **none of them ever quits Orca**. If you navigated the user's live tab, remember its original URL first and restore it when done.
