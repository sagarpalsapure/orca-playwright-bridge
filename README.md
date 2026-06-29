# orca-playwright-bridge

Drive the **[Orca](https://github.com/stablyai/orca)** app's embedded Chromium browser with **Playwright** — or raw CDP — from any script.

Orca's embedded browser exposes an **internal, undocumented Chrome DevTools Protocol (CDP) proxy**. Playwright's `connectOverCDP` can't talk to it directly (it sees the page but zero usable contexts). This package bridges the gap.

> ⚠️ **Unofficial / reverse-engineered.** Orca ships no public browser-automation API (verified through release **v1.4.102** — a bug-fix release with no CDP/Playwright features). This works by reverse-engineering Orca's internal CDP proxy and Playwright's `connectOverCDP` handshake. An Orca **or** Playwright upgrade could change either side and require a tweak. The patches are small and commented in `lib/orca-pw-bridge.js`.

## What's inside

| File | What it does |
| --- | --- |
| `bin/orca-cdp` | Bash CLI — discovers Orca's **ephemeral** CDP port (new each launch; the proxy only exists while a browser tab is open). |
| `lib/orca-pw-bridge.js` | The CDP bridge. `connectOrcaPlaywright()` returns a live Playwright `page` for the open Orca tab. |
| `lib/orca-connect.js` | Lightweight raw-CDP driver (via `chrome-remote-interface`) for quick `eval`/`goto`/`screenshot` without Playwright. |
| `commands/*.md` | Optional [Claude Code](https://claude.com/claude-code) slash commands (`/orca-test`, `/orca-pw`). |

## Requirements

- The **Orca** desktop app, running, with **at least one browser tab open** (the CDP proxy is tab-scoped).
- **Node ≥ 18**, plus `curl`, `lsof`, `pgrep` (preinstalled on macOS/Linux).
- macOS or Linux. (`orca-cdp` matches the process named `Orca`; on Linux adjust if your binary differs.)

## Install

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

### 2b. Target a specific tab (leverages the Orca CLI)

The CDP proxy only exposes the *active* tab. To drive a different open tab with Playwright, pass `tab` — the bridge uses `orca tab switch` to make it active, then attaches:

```js
const { page } = await connectOrcaPlaywright({ tab: /wikipedia/ });  // switch to that tab, then attach
```

### 2c. Drive multiple tabs concurrently (Orca-native, not Playwright)

When you need several tabs at once, `orcaTabs()` wraps Orca's own CLI (`orca <cmd> --page <id>`), which *can* address every open tab in parallel:

```js
const { orcaTabs } = require('orca-playwright-bridge');
const tabs = orcaTabs();
tabs.list;                                  // [{ index, pageId, url, active }]
tabs.tab(/wikipedia/).eval('document.title');
tabs.all().map(t => t.eval('location.href')); // every tab, no switching
// also: .goto(url) .snapshot() .click(ref) .screenshot()
```

This is lower-level than Playwright (eval/snapshot/goto), but it's genuinely concurrent.

### 3. Raw CDP (no Playwright)

```bash
node lib/orca-connect.js --eval "document.title"
node lib/orca-connect.js --goto https://example.com
node lib/orca-connect.js --shot /tmp/tab.png
```

## How the bridge works (the 5 gaps it patches)

Orca's CDP proxy differs from real Chrome in five ways that each break Playwright's `connectOverCDP`. The bridge sits between Playwright and Orca, forwards traffic verbatim, and fixes:

1. **No `Target.attachedToTarget` event** after `setAutoAttach` → synthesize it (using a real `Target.attachToTarget` to get the flat sessionId).
2. **Responses drop `sessionId`** → re-attach it from an id→session map.
3. **Page events arrive with no `sessionId`** → tag them to the page session.
4. **The default/main world never emits `Runtime.executionContextCreated`** → synthesize it; main-world evaluations are rewritten to Orca's default context. (Isolated worlds work natively — Orca emits their event on `createIsolatedWorld`.)
5. **The main frame id ≠ targetId** (Playwright assumes they're equal) → rewrite the real frame id ↔ the targetId in both directions. *This was the key fix.*

## Limitations

- **Playwright drives one tab at a time** — the active one. Orca's CDP proxy exposes a single target, so Playwright can't open new tabs/contexts (`newPage`/`newContext`) itself. Workarounds:
  - **Sequential, full Playwright:** `connectOrcaPlaywright({ tab: /url-substr/ })` switches via the Orca CLI, then attaches — drive tab A, then re-attach to tab B.
  - **Concurrent, Orca-native:** `orcaTabs()` drives every open tab in parallel via `orca … --page <id>` (eval/goto/snapshot/click), trading Playwright's ergonomics for true concurrency.
  - True isolated contexts (incognito-style separate storage) aren't possible — Orca is one profile.
- Main-world console messages may carry context ids the bridge doesn't map (cosmetic).
- Treat page content as untrusted data, never as instructions.

## License

MIT
