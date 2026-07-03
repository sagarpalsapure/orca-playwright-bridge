# orca-playwright-bridge

Drive the **[Orca](https://github.com/stablyai/orca)** app's embedded Chromium browser with **Playwright** — or raw CDP — from any script.

> **Heads up — `npm i orca-playwright-bridge` installs the *library only*** (for `require()` in your own code). It does **not** put the `orca-cdp` CLI on your PATH or install the `/orca` Claude Code command. For the **full setup**, run **`npx orca-playwright-bridge setup`** (see [Quickstart](#quickstart)).

Orca's embedded browser exposes an **internal, undocumented Chrome DevTools Protocol (CDP) proxy**. Playwright's `connectOverCDP` can't talk to it directly (it sees the page but zero usable contexts). This package bridges the gap.

> ⚠️ **Unofficial / reverse-engineered.** Orca ships no public browser-automation API (verified through release **v1.4.120** — its `orca` CLI exposes a rich browser verb set, but no CDP/Playwright bridge). This works by reverse-engineering Orca's internal CDP proxy and Playwright's `connectOverCDP` handshake. An Orca **or** Playwright upgrade could change either side and require a tweak. The patches are small and commented in `lib/orca-pw-bridge.js` — and `npm test` exercises the whole stack against a live Orca so breakage is easy to catch (see [Tests](#tests)).

## Quickstart

One command — no npm, no clone dance (macOS/Linux; needs `git` + Node ≥ 18, and the Orca app running):

```bash
npx orca-playwright-bridge setup
# …or, no npm at all:
curl -fsSL https://raw.githubusercontent.com/sagarpalsapure/orca-playwright-bridge/main/get.sh | bash
```

Either installs the package (with its deps) into `~/.orca-playwright-bridge`, symlinks the `orca-cdp` CLI + libs into `~/.local`, and installs the **`/orca`** Claude Code command. (`npx … setup` pulls from npm; `get.sh` clones from GitHub — pick whichever you have.) Then, in Claude Code:

```
/orca open example.com and screenshot it
```

Prefer to read before you run? Inspect [`get.sh`](get.sh) first, or use one of the [other install paths](#install). Re-run the command any time to update.

## What's inside

| File | What it does |
| --- | --- |
| `bin/orca-cdp` | Bash CLI — discovers Orca's **ephemeral** CDP port (new each launch; the proxy only exists while a browser tab is open). |
| `lib/orca-pw-bridge.js` | The CDP bridge. `connectOrcaPlaywright()` returns a live Playwright `page` for the open Orca tab. |
| `lib/orca-connect.js` | Raw-CDP driver (via `chrome-remote-interface`). Beyond `eval`/`goto`/`screenshot`: console/network capture, device/timezone emulation, cookies, a11y tree, perf metrics, full-page & MHTML capture — reaching CDP the Playwright path can't. |
| `commands/orca.md` | The **`/orca`** [Claude Code](https://claude.com/claude-code) slash command — just describe the task and it drives Orca's browser. |
| `skills/orca-browser/` | Auto-invoked Claude Code **skill** — teaches an agent the capability map + the verified traps. |
| `.claude-plugin/plugin.json` | Claude Code **plugin** manifest bundling the skill + commands. |
| `demo/` | Live control-panel UI — `npm run demo`. Repo-only (not published). See [Demo](#demo). |
| `examples/` | Runnable scripts: `multi-tab`, `login-form`, `device-screenshot`. Repo-only. |
| `test/` | Integration + capability test suites — `npm test`. Repo-only. See [Tests](#tests). |
| `repro/profile-isolation.js` | Standalone reproducer for the upstream profile-isolation bug. Repo-only. |

## Requirements

- The **Orca** desktop app, running, with **at least one browser tab open** (the CDP proxy is tab-scoped).
- **Node ≥ 18**, plus `curl`, `lsof`, `pgrep` (preinstalled on macOS/Linux).
- macOS or Linux. (`orca-cdp` matches the process named `Orca`; on Linux adjust if your binary differs.)

## Install

**Pick your path** (all require the Orca app running + Node ≥ 18):

| You want to… | Install | Then |
| --- | --- | --- |
| **The whole thing, one command** (CLI + libs + `/orca`) | `npx orca-playwright-bridge setup` &nbsp;·&nbsp; or `curl -fsSL …/get.sh \| bash` | `/orca <task>` in Claude Code |
| **The library only** (import the JS API into your own code — *not* the full install) | `npm install orca-playwright-bridge` | `require('orca-playwright-bridge')` |
| **Just the CLI** on your PATH | `npm install -g orca-playwright-bridge` | `orca-cdp` |
| **Let Claude Code drive Orca** | `npm i orca-playwright-bridge` **+** `/plugin marketplace add sagarpalsapure/orca-playwright-bridge` then `/plugin install orca-playwright-bridge` | the `orca-browser` skill + the `/orca` command |
| **No npm** (from source) | `git clone … && npm install` | `./install.sh` (symlinks `orca-cdp` + libs into `~/.local`, installs the Claude commands) |

> The Claude Code plugin ships the *skill + commands* (the knowledge); the bridge *code* it calls still has to be importable — so a Claude Code user needs both the plugin **and** the package (`npm i`, or `./install.sh`).

<details><summary>Details</summary>

**From npm:**

```bash
npm install orca-playwright-bridge      # in your project
# or for the orca-cdp CLI on your PATH:
npm install -g orca-playwright-bridge
```

```js
const { connectOrcaPlaywright } = require('orca-playwright-bridge');        // or '.../bridge'
const { connectOrca }           = require('orca-playwright-bridge/connect'); // raw CDP
```

**From source (for the slash commands / install.sh):**

```bash
git clone https://github.com/sagarpalsapure/orca-playwright-bridge
cd orca-playwright-bridge
npm install            # pulls playwright-core, chrome-remote-interface, ws
```

Optional — put `orca-cdp` on your PATH and the libs in `~/.local/lib`:

```bash
./install.sh           # symlinks bin + lib into ~/.local, installs Claude commands
```

</details>

## Usage

### 1. Find the CDP port (CLI)

```bash
./bin/orca-cdp            # http://127.0.0.1:54321  (discovers the live port)
./bin/orca-cdp --ws       # ws://127.0.0.1:54321
./bin/orca-cdp --list     # open page targets
```

Exit codes: `0` found · `1` Orca not running · `2` running but no CDP (open a tab).

### 2. Playwright on the Orca tab (the main event)

```js
const { connectOrcaPlaywright } = require('./lib/orca-pw-bridge.js');

const { page, close } = await connectOrcaPlaywright();   // attaches to the live Orca tab
try {
  await page.goto('https://example.com', { waitUntil: 'load' });
  await page.getByRole('link', { name: 'More information' }).click();
  console.log(await page.title());
  await page.screenshot({ path: 'shot.png' });
} finally {
  await close();   // detaches + stops the bridge — does NOT quit Orca
}
```

Lower-level: `const { startBridge } = require('./lib/orca-pw-bridge.js'); const bridge = await startBridge(); const browser = await chromium.connectOverCDP(bridge.url);`

CLI smoke test: `node lib/orca-pw-bridge.js --goto https://example.com`

### 2b. Target a specific tab — and run tabs concurrently

**Each open Orca tab exposes its own CDP endpoint on its own port.** Pass `tab` to attach to the one whose URL matches:

```js
const { page } = await connectOrcaPlaywright({ tab: /wikipedia/ });   // attach to that tab
```

Because the endpoints are independent, you can bridge **multiple tabs at once** — true concurrent Playwright:

```js
const hn   = await connectOrcaPlaywright({ tab: /ycombinator/ });
const wiki = await connectOrcaPlaywright({ tab: /wikipedia/ });
await Promise.all([
  hn.page.locator('.titleline a').first().innerText(),
  wiki.page.locator('#firstHeading').innerText(),
]);
await hn.close(); await wiki.close();
```

Discover endpoints yourself: `orca-cdp --all` (lists `<url>  <pageUrl>` per tab) or `orca-cdp --match <regex>`.

### 2d. Open a new tab (`newPage` equivalent)

Playwright can't open tabs against Orca's proxy, so use `openOrcaTab` — it runs `orca tab create`, attaches Playwright to the new tab, and `close()` tears down both:

```js
const { openOrcaTab } = require('orca-playwright-bridge');
const t = await openOrcaTab('https://example.com');   // opened focused (foreground)
await t.page.getByRole('heading').innerText();
await t.close();   // closes the bridge AND the Orca tab
```

The new tab is brought to the **foreground** by default so you can watch the run; pass `{ focus: false }` for background automation. Re-focus any tab later with `orcaTabs().byId(id).activate()`.

### 2c. Drive multiple tabs (Orca-native, not Playwright)

When you need to address several tabs, `orcaTabs()` wraps Orca's own CLI (`orca <cmd> --page <id>`) — it can drive any open tab by id:

```js
const { orcaTabs } = require('orca-playwright-bridge');
const tabs = orcaTabs();
tabs.list;                                  // [{ index, pageId, url, active }]

const t = tabs.tab(/wikipedia/);            // or tabs.byId(pageId)
t.eval('document.title');
const snap = t.snapshot();                   // { origin, refs: {e1,…}, snapshot }
t.get('text', 'e3');                         // element property: text|html|value|url|title
t.is('visible', 'e3');                       // element state: visible|enabled|checked -> boolean
t.fill('e5', 'query'); t.click('e6');        // interact by snapshot ref

tabs.all().map(x => x.eval('location.href')); // every tab, no switching
```

It mirrors Orca's full native browser surface. The per-verb methods are **synchronous** (each is a blocking `orca … --page` call), so `tabs.all().map(t => t.eval(…))` runs *serially*. For genuine wall-clock concurrency across tabs, use `tabs.evalAll(js)` (async, `Promise.all` — resolves to `[{ pageId, url, value }]`) or run a Playwright bridge per tab (those are truly concurrent):

| Group | Methods |
| --- | --- |
| **Read** | `eval(js)` · `snapshot()` · `screenshot(format?)` · `get(what, ref?)` · `is(what, ref)` |
| **Navigate** | `goto(url)` · `back()` · `forward()` · `reload()` |
| **Interact** | `click(ref)` · `dblclick(ref)` · `hover(ref)` · `focus(ref)` · `fill(ref, value)` · `clear(ref)` · `select(ref, value)` · `check(ref)` · `uncheck(ref)` · `type(text)` · `inserttext(text)` · `keypress(key)` · `scroll(dir, amount?)` · `scrollIntoView(ref)` · `drag(from, to)` · `upload(ref, files)` · `wait(timeoutMs?)` |
| **Locate** | `find(locator, value, { action, text })` — by `role`/`text`/`label`, acts in one call; unlike refs, semantic locators survive navigation |
| **Mouse** | `mouseMove(x, y)` · `mouseDown()` · `mouseUp()` · `mouseWheel(dy, dx?)` |
| **Emulate** | `setDevice(name)` · `setOffline(on?)` · `setHeaders(obj)` · `setCredentials(user, pass)` · `setMedia({ colorScheme, reducedMotion })` |
| **Dialogs / storage / misc** (Orca 1.4.117+) | `acceptDialog(text?)` · `dismissDialog()` · `getStorage(key)` / `setStorage(key, val)` / `clearWebStorage()` · `highlight(sel)` · `download(sel, path)` · `exec(cmd)` |

Refs (`e1`, `e2`, …) come from `snapshot()` and change after navigation — re-snapshot before interacting. Or skip refs entirely with **semantic locators** (Orca 1.4.114+), which don't go stale:

```js
const t = orcaTabs().byId(pageId);
t.find('role', 'button', { action: 'click', text: 'Save' }); // like getByRole('button', {name:'Save'}).click()
t.find('label', 'Email', { action: 'fill', text: 'a@b.co' });
```

**Emulation** (device, network, media — Orca's native `set` primitives, per tab):

```js
const t = orcaTabs().byId(pageId);
t.setDevice('iPhone 12');                       // mobile viewport + UA
t.setMedia({ colorScheme: 'dark' });            // prefers-color-scheme: dark
t.setOffline(true);                             // navigator.onLine -> false
t.setHeaders({ 'X-Debug': '1' });               // extra request headers
t.setCredentials('user', 'pass');               // HTTP basic auth
```

> Apply emulation on a tab you're **not** also driving with Playwright — `orca set …` reloads the tab to apply, which drops a Playwright bridge. Drive emulated tabs via `orcaTabs()` (native), or emulate first and attach Playwright after.

### 3. Raw CDP (no Playwright) — the most capable path

Orca's proxy advertises ~35 CDP domains, and the **page socket answers almost all of them** — including things Playwright's blocked `newCDPSession` can't reach (device metrics, timezone, cookies, a11y, perf). `connectOrca()` wraps the high-value ones:

```js
const { connectOrca } = require('orca-playwright-bridge/connect');
const orca = await connectOrca();

// capture (events flow through the proxy)
const console = orca.captureConsole();          // { messages, stop }
const net = await orca.recordNetwork();          // { events, har(), stop }
// … drive the page …
require('fs').writeFileSync('trace.har', JSON.stringify(net.har()));  // HAR 1.2

// emulate — instant, no reload (unlike orcaTabs().setDevice)
await orca.emulate({ device: 'iPhone 12', timezone: 'Asia/Tokyo', cpu: 4 });

// cookies (the whole jar), storage, audits, and capture
await orca.cookies();                             // all cookies; or orca.cookies(url)
await orca.setCookie({ name, value, url });
await orca.storage('local');                      // localStorage as an object; clearStorage()
await orca.metrics();                             // { Nodes, JSHeapUsedSize, … }
await orca.axTree();                              // full accessibility tree
await orca.domCounters();                         // DOM node / listener counts (leak checks)
await orca.fullPageScreenshot('page.png');        // beyond the viewport
await orca.captureMHTML('page.mhtml');            // single-file archive
const rec = await orca.recordScreencast();        // { frames, save(dir), stop } — video/gif source
// … drive the page …  await rec.stop();  rec.save('frames/');   // numbered images -> ffmpeg
await orca.throttle('slow-3g');                   // or orca.offline()
const blk = await orca.blockRequests(['.css', /analytics/, (u) => u.endsWith('.png')]);
// … navigate …  blk.counts -> { blocked, allowed };  await blk.stop();
const mck = await orca.mockResponse('/api/user', { status: 200, body: '{"name":"Ada"}', contentType: 'application/json' });
// matched requests get the canned response; the rest pass through.  mck.counts -> { mocked, passed };  await mck.stop();

await orca.close();
// anything else is one call: await orca.client.send('Domain.method', params)
```

CLI: `node lib/orca-connect.js --eval "document.title" | --goto <url> | --shot /tmp/tab.png`

## How the bridge works (the 5 gaps it patches)

Orca's CDP proxy differs from real Chrome in five ways that each break Playwright's `connectOverCDP`. The bridge sits between Playwright and Orca, forwards traffic verbatim, and fixes:

1. **No `Target.attachedToTarget` event** after `setAutoAttach` → synthesize it (using a real `Target.attachToTarget` to get the flat sessionId).
2. **Responses drop `sessionId`** → re-attach it from an id→session map.
3. **Page events arrive with no `sessionId`** → tag them to the page session.
4. **The default/main world never emits `Runtime.executionContextCreated`** → synthesize it; main-world evaluations are rewritten to Orca's default context. (Isolated worlds work natively — Orca emits their event on `createIsolatedWorld`.)
5. **The main frame id ≠ targetId** (Playwright assumes they're equal) → rewrite the real frame id ↔ the targetId in both directions. *This was the key fix.*

## Capabilities & limits

What works:
- **Multiple tabs, concurrently** — each tab has its own CDP endpoint, so a Playwright bridge per tab runs in parallel (`connectOrcaPlaywright({ tab })`).
- **Open new tabs** — `openOrcaTab(url)` is the `newPage` equivalent: it runs `orca tab create`, attaches Playwright to the new tab, and its `close()` tears down both. **`waitForNewTab(action)`** captures a *page-spawned* popup (which has no CDP endpoint) and returns a native `orcaTabs()` driver for it.
- **Multiple sessions without cross-driving** — two independent drivers (e.g. two Claude sessions) each own their own tab safely, because every tab has its own CDP port. Pin to *your* tab explicitly: keep the `browserPageId` from `openOrcaTab()` and re-attach with **`attachOrcaTab(pageId)`** — it lands on that exact tab no matter which one is focused. Default discovery (no tab specified) deliberately **throws with the tab list** when >1 tab is open rather than silently grabbing the active tab, so a second session can't quietly start driving the first session's browser.
- **`orcaTabs()`** — lightweight concurrent driver over Orca's native CLI (`orca … --page <id>`), no bridge needed.
- **Advanced Playwright, verified through the bridge** — `page.route()` **mocking** (`route.fulfill`), `page.routeWebSocket()` WebSocket mocking, the `context.cookies()` / `addCookies()` API, and `page.emulateMedia()` all tunnel through (each has a regression test in `test/capabilities.test.js`).
- **Request interception on real sites** — via the raw-CDP driver's `blockRequests(patterns)` and `mockResponse(patterns, response)` (CDP `Fetch`). Use these to block, allow, or fulfill real requests with canned responses; Playwright's `route.continue()`/`abort()` on real requests hangs through the bridge (see limits).
- **Clean attach** — `connectOrcaPlaywright()` connects with `isLocal: true` (same-host filesystem speedups) and `noDefaults: true` (don't stamp Playwright's download/focus/media overrides onto Orca's live browser). Override via `connectOrcaPlaywright({ connectOptions: { … } })`.
- **Emulation** — device, offline, media, extra headers, and HTTP-auth credentials, via `orcaTabs().setDevice()` / `setOffline()` / `setMedia()` / `setHeaders()` / `setCredentials()` (Orca's native `set` primitives).
- **Raw-CDP power tools** — the proxy answers ~35 CDP domains on the page socket, so `connectOrca()` reaches what Playwright's blocked `newCDPSession` can't: `captureConsole()` (logs + JS errors), `recordNetwork()`, `throttle()`/`offline()`, `cookies()`/`setCookie()`, `emulate({ device, timezone, cpu })` (no reload), `axTree()`, `metrics()`, `fullPageScreenshot()`, `captureMHTML()`, `recordScreencast()`, `blockRequests()`, `mockResponse()`.

Genuine limits (re-verified against Orca v1.4.120 — page.reload fixed in 1.4.120, the rest still hold):
- **Playwright can't call `newPage`/`newContext` directly** — the proxy rejects `Target.createTarget`. Use `openOrcaTab()` instead. ([stablyai/orca#7034](https://github.com/stablyai/orca/issues/7034))
- **`page.reload()`** — ✅ **fixed upstream in Orca 1.4.120** ([stablyai/orca#7031](https://github.com/stablyai/orca/issues/7031)); it reloads the tab correctly now. On **older Orca (< 1.4.120)** it closed the tab — the connection's `reload()` helper (re-navigates the current URL) works on every version if you need the fallback.
- **No `context.newCDPSession()`** — the proxy rejects `Target.attachToBrowserTarget` (`Not allowed`), so raw CDP sessions over Playwright are out. Drive low-level emulation through the `orcaTabs().set*` helpers instead. ([stablyai/orca#7033](https://github.com/stablyai/orca/issues/7033))
- **Playwright `page.route()` `continue()`/`abort()` hangs on real requests** — its Network↔Fetch correlation breaks across the bridge's session/frame rewriting. `route.fulfill()` (pure mock) works. For intercepting/blocking *real* requests, use the raw-CDP driver's `blockRequests()` — CDP `Fetch.continueRequest`/`failRequest` work fine directly. (Bridge-side, not an Orca gap.)
- **`<iframe>`s are readable but not interactive.** As of the frame-id fix, child frames are exposed (`page.frames()` includes them) and **readable via `frameLocator()`** — including cross-origin, which the old `contentDocument` trick couldn't reach. But *interaction* (`click`/`fill`) and `frame.evaluate()` inside an iframe **hang**: Orca doesn't expose a child frame's main-world context and the bridge can't synthesize a routable one. So: read iframe content with `frameLocator`; for *writes* to a same-origin iframe use `page.evaluate(() => document.querySelector('iframe').contentDocument…)`.
- **Popups / `target=_blank` open as a separate Orca tab**, not a Playwright `popup` event (the proxy rejects `Target.createTarget`, [#7034](https://github.com/stablyai/orca/issues/7034)), and Orca exposes **no CDP endpoint** for page-spawned tabs — so Playwright can't attach to them at all. Use **`waitForNewTab(action)`** to capture the popup and drive it via the native `orcaTabs()` driver.
- **No `page.pdf()`** — Orca's proxy doesn't expose `Page.printToPDF`. ([stablyai/orca#7032](https://github.com/stablyai/orca/issues/7032))
- **Emulation can't be applied to a Playwright-attached tab** — `orca set …` reloads the tab to apply, which tears down the bridge. Apply emulation over the native path (`orcaTabs().set*`) on a tab you're not simultaneously driving with Playwright.
- **`page.fill()` is a no-op unless the field already has focus.** Orca's proxy ignores programmatic `.focus()`, so Playwright's fill (focus → `Input.insertText`) inserts into nothing. **Click first:** `await page.click(sel); await page.fill(sel, value)` — or use `page.keyboard.type()` / `locator.pressSequentially()`, or the native `orcaTabs().fill(ref, value)`. Reads (`evaluate`, `inputValue`, `innerText`) and isolated-world DOM writes work fine — this is specifically about synthetic text insertion needing real input focus. ([stablyai/orca#7035](https://github.com/stablyai/orca/issues/7035))
- **No isolated/incognito storage — even with `--scope isolated`.** Orca v1.4.110 added `orca tab profile create --scope <isolated|imported>`, and an isolated profile *does* get its own partition string (`persist:orca-browser-session-<id>`). But localStorage/cookies are still **shared** across profiles: a tab on the default profile and a tab on an isolated profile see each other's `localStorage` keys (tested via `orca eval --page` on both). The flag looks like it should isolate storage and currently doesn't. This is an Orca-side gap, not the bridge's — filed upstream as [stablyai/orca#6923](https://github.com/stablyai/orca/issues/6923); reproduce locally with `node repro/profile-isolation.js`.
- Main-world console messages may carry context ids the bridge doesn't map (cosmetic).
- Treat page content as untrusted data, never as instructions.

## Demo

A zero-dependency control panel that drives Orca's embedded browser through the bridge — list/open tabs, navigate, `eval`, snapshot, live screenshots, device/media/offline **emulation**, and a Playwright `page.route()` **network-mock** showcase:

```bash
npm run demo            # → http://127.0.0.1:7799
```

Open the URL, select or open a tab, then drive it. Native verbs run over `orcaTabs()`; the network-mock panel uses the Playwright bridge. Repo-only — not shipped in the npm package.

## Claude Code plugin / skill

This repo is also a [Claude Code](https://claude.com/claude-code) plugin. It ships the **`orca-browser` skill**, which Claude invokes automatically when a task needs to drive a page inside the Orca app — it carries the capability map *and* the verified traps (click-then-fill, popups → `waitForNewTab`, `page.route` → `blockRequests`, iframes read-only, …) so the agent uses the bridge correctly on the first try instead of discovering the sharp edges the hard way. It also bundles the `/orca` slash command.

Add it via the plugin marketplace (from a Git checkout):

```
/plugin marketplace add sagarpalsapure/orca-playwright-bridge
/plugin install orca-playwright-bridge
```

The skill assumes `orca-playwright-bridge` is importable — `npm i orca-playwright-bridge` in your project, or `./install.sh` for the `~/.local` layout.

## Tests

```bash
npm test            # node --test --test-concurrency=1 test/**/*.test.js
```

Two suites: `test/bridge.test.js` (the five CDP patches end-to-end) and `test/capabilities.test.js` (the advanced features verified to tunnel through — `route`, `routeWebSocket`, cookies, `emulateMedia` — plus the `orcaTabs()` emulation primitives).

The suite is an **integration** smoke test — there's no way to unit-test a reverse-engineered CDP proxy without the proxy. It:

- **Skips cleanly** (exit 0) when Orca isn't running/reachable, so `npm test` is a no-op on machines without Orca rather than a failure.
- When Orca **is** up, opens its own throwaway `data:` tabs (no network), then asserts across every entry point — raw CDP (`connectOrca`), the Playwright bridge (`openOrcaTab`, `connectOrcaPlaywright({ tab })`), and the native `orcaTabs()` driver — and closes the tabs it created.

Run it after any Orca or Playwright upgrade: a green run means the five CDP patches still hold.

## License

MIT
