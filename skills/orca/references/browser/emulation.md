# Emulation: device, timezone, locale, media, and more

Two paths with different trade-offs. **Pick the raw-CDP path when a Playwright bridge is attached** — the native path reloads the tab and kills the bridge.

## Raw CDP — instant, no reload (preferred)

```js
const { connectOrca } = require('orca-playwright-bridge/connect');
const orca = await connectOrca();
await orca.emulate({
  device: 'iPhone 12',          // DEVICES preset, or { width, height, dpr, mobile, ua }
  timezone: 'Asia/Tokyo',
  locale: 'de-DE',
  cpu: 4,                       // 4x CPU slowdown
  colorScheme: 'dark',
});
await orca.clearEmulation();    // undo everything (viewport, UA, timezone, locale, CPU, media — bridge ≥ 1.3.0)
```

Verification gotchas (both bit a real test run):
- On a page **without `<meta name="viewport">`**, mobile emulation makes `innerWidth` report the 980px layout viewport, not the device width — that's standard Chromium behavior, not a failed override. Check `devicePixelRatio`/UA instead, or test on a page with a viewport meta.
- After clearing, `prefers-color-scheme` returns to the **system** setting — on a dark-mode machine, `matchMedia('(prefers-color-scheme: dark)')` is `true` again by design.

Also: `orca.throttle('slow-3g')` and `orca.offline(true)` (see `references/browser/network.md`).

## Native (`orcaTabs()`) — per tab, RELOADS the tab to apply

```js
const t = orcaTabs().byId(pageId);
t.setDevice('iPhone 12');                        // mobile viewport + UA
t.setMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
t.setOffline(true);
t.setHeaders({ 'X-Debug': '1' });
t.setCredentials('user', 'pass');                // HTTP basic auth
```

⚠️ Because `orca set …` reloads the tab, apply native emulation **before** attaching Playwright, or drive the emulated tab natively.

## Through the Playwright bridge (verified)

`page.emulateMedia({ colorScheme: 'dark' })` tunnels through fine. Viewport/device emulation does **not** go through Playwright (no `newContext`); use one of the paths above.

## Beyond the wrapped API — verified raw domains

These `Emulation.*` methods were probed against the live proxy (re-verified on Orca 1.4.123) and all answer; use `orca.client.send()` directly:

```js
await orca.client.send('Emulation.setGeolocationOverride', { latitude: 18.52, longitude: 73.85, accuracy: 10 });
await orca.client.send('Emulation.setUserAgentOverride', { userAgent: 'MyBot/1.0' });
await orca.client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await orca.client.send('Emulation.setEmulatedVisionDeficiency', { type: 'deuteranopia' });  // a11y checks
await orca.client.send('Emulation.setIdleOverride', { isUserActive: false, isScreenUnlocked: true });
```

(Geolocation grant: there's no `Browser.grantPermissions` context path — if the page prompts, the override still answers `getCurrentPosition` once permission is granted in-page or the site doesn't gate on the Permissions API.)

## Cleanup

Emulation state sticks to the tab after you disconnect. Always `clearEmulation()` (or per-override `Emulation.clear*` / `setDevice('')` equivalents) when done — especially on the user's live tab.
