# Capture: screenshots, full-page, MHTML, screencast (video)

## Viewport screenshot

Any path works:

```js
await t.page.screenshot({ path: 'shot.png' });         // Playwright
await orca.screenshot('shot.png');                     // raw CDP
orcaTabs().byId(id).screenshot('png');                 // native -> { data (b64), format }
```

Playwright's `locator.screenshot()` (element shots) also works through the bridge.

## Full-page screenshot (beyond the viewport)

```js
const { connectOrca } = require('orca-playwright-bridge/connect');
const orca = await connectOrca();
await orca.fullPageScreenshot('page.png');             // stitches via Page.getLayoutMetrics
```

## PDF

```js
await orca.pdf('page.pdf');                            // Page.printToPDF; opts (landscape, scale, margin*) pass to CDP
```

`Page.printToPDF` was absent from the proxy on Orca ≤ 1.4.120 (stablyai/orca#7032) but is **fixed in 1.4.123** — both `orca.pdf()` and Playwright's `page.pdf()` return real PDF bytes now. On older Orca, fall back to:

- `fullPageScreenshot()` — visual record.
- `captureMHTML()` — faithful single-file archive (below).

## MHTML page archive

```js
await orca.captureMHTML('page.mhtml');                 // single-file snapshot, opens in Chrome
```

## Screencast → video/GIF

`recordScreencast()` streams frames while you drive the page; `save(dir)` writes numbered images for ffmpeg:

```js
const rec = await orca.recordScreencast({ format: 'jpeg', quality: 60, maxWidth: 1280 });
// ... drive the page via THIS client (orca.evaluate / orca.goto) — a Playwright call or
//     native verb on this tab would disconnect the recording (one client per tab) ...
await rec.stop();
rec.save('frames/');            // frames/0001.jpeg, 0002.jpeg, ...
```

```bash
ffmpeg -framerate 10 -pattern_type glob -i 'frames/*.jpeg' -vf scale=1280:-2 demo.mp4   # or .gif
```

Frames only arrive while the page visually changes (CDP screencast semantics) — idle pages produce few frames; that's normal.

## DOM snapshot (structured capture)

For layout/text extraction without screenshots, `DOMSnapshot.captureSnapshot` answers through the proxy:

```js
const snap = await orca.client.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
```

Prefer the native `orcaTabs().snapshot()` (accessibility tree + refs) when the goal is to *read or act on* the page — it's far smaller and comes with actionable refs.
