# Mobile — devices & setup

Drive native mobile apps with **Maestro**, pointed at the device Orca manages. The mobile analogue of the browser bridge: Orca boots/owns the device (iOS Simulator via its `serve-sim` helper; Android mirrored over scrcpy + adb), and Maestro — a separate JVM CLI — drives that *same* device by id. `orca-playwright-bridge/maestro` wires the two together and adds a cross-platform flow builder.

Verified live on Orca 1.4.120: iOS Simulator (iPhone 17, iOS 26.5) and Android emulator (Pixel 8 Pro) — 5/5 checks each (hierarchy dump, screenshot, launch app, foreground assertion, openLink).

## Preconditions

1. **Maestro + a JDK.** `curl -Ls "https://get.maestro.mobile.dev" | bash` and `brew install openjdk@17`. The JDK need **not** be on PATH — the driver auto-discovers Homebrew/macOS/SDKMAN JDKs and injects `JAVA_HOME` for the Maestro child process.
2. **iOS:** a simulator booted through Orca — `orca emulator attach "iPhone 17"` (so serve-sim and Maestro share one device). Needs Xcode.
3. **Android:** a booted emulator visible to `adb` — `$ANDROID_HOME/emulator/emulator -avd <name>`. The driver finds `adb` under `ANDROID_HOME` / `~/Library/Android/sdk` / PATH.

`node lib/orca-maestro.js` prints a discovery report (maestro path, JDK, adb, booted iOS udid, Android serials) — run it first when something's off.

## Creating a driver

```js
const { iosMaestro, androidMaestro } = require('orca-playwright-bridge/maestro');

const ios = await iosMaestro();                 // Orca's booted sim; or iosMaestro({ device: 'iPhone 17' }) to attach one
const and = await androidMaestro();             // first booted emulator; or androidMaestro({ serial: 'emulator-5554' })
```

Both return the same driver shape (see `references/mobile/flows.md`). `driver.device` is the resolved UDID (iOS) or adb serial (Android); `driver.platform` is `'ios'` or `'android'`.

## The driver opens the device in Orca automatically

By default, creating a driver **attaches the device in Orca** so it appears in the Orca app — you don't call `orca emulator attach` yourself:

- **iOS** — `iosMaestro()` resolves (or attaches, given `{ device }`) Orca's simulator via serve-sim (`backend: ios`); a resolved Orca sim is already mirrored.
- **Android** — `androidMaestro()` resolves the booted serial, looks up its AVD name (`adb -s <serial> emu avd name`), and runs `orca emulator attach "<AVD>"` → scrcpy mirror (`backend: android`).

`driver.orcaMirrored` reports the attach info (`{ deviceUdid, backend, streamUrl? }`) or `null` if it wasn't attempted/failed. The attach is **best-effort**: if Orca is unreachable the driver still works over its own transport (adb / serve-sim). Opt out with `{ attachToOrca: false }` for headless/CI runs where no Orca UI is needed.

```js
const and = await androidMaestro();             // opens in Orca automatically
and.orcaMirrored;                               // { deviceUdid:'emulator-5554', backend:'android', streamUrl:'scrcpy://…' }
const ci = await androidMaestro({ attachToOrca: false });   // adb only, no Orca mirror
```

**Caveat:** `orca emulator list` only reports the iOS serve-sim helper, so it shows `running: false` for an attached Android device even while scrcpy is live. Confirm Android via the running `scrcpy` process (or `adb devices`), not that flag.

## Device resolution helpers

The package resolves *which* device Orca is driving so you (or the Maestro MCP — see `references/mobile/maestro-mcp.md`) can pin to it:

```js
const M = require('orca-playwright-bridge/maestro');
M.orcaSimulatorUdid();     // iOS UDID Orca has booted, or null
M.listAndroidDevices();    // [{ platform:'android', serial, state }] booted per adb
M.listSimulators();        // all simctl iOS simulators
M.resolveJavaHome();       // discovered JDK (or null)
M.resolveAdb();            // discovered adb (or null)
```

## When to use this vs. the browser bridge

| Target | Use |
| --- | --- |
| Web page inside Orca's desktop browser | `openOrcaTab()` / `connectOrca()` (the browser references) |
| **Native iOS/Android app UI** (tap, type, assert, screenshot) | `iosMaestro()` / `androidMaestro()` (these references) |
| Mobile web (Safari/Chrome *content* in the simulator) | Maestro drives the browser **app UI** here; there is no verified CDP bridge into simulator web content yet |
