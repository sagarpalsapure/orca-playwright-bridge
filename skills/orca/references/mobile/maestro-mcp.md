# Mobile — Maestro MCP vs. the programmatic driver

Maestro ships an **MCP server** (`maestro mcp`) that exposes its device/automation commands as Model Context Protocol tools. It and the package's `./maestro` JS driver are **two front-ends to the same `maestro` binary** — pick by consumer, not by capability.

| | **Maestro MCP** (`maestro mcp`) | **`orca-playwright-bridge/maestro`** (JS) |
| --- | --- | --- |
| Consumer | The agent, interactively (tool calls) | Program code — scripts, CI, the package API |
| How you drive | agent calls `run` / `inspect_screen` / `take_screenshot` / `list_devices` | `await drv.runFlow(drv.flow(...))`, `hierarchy()`, `screenshot()` |
| Best for | ad-hoc "open Settings, tap X, show me" | deterministic, repeatable, embeddable automation |
| Device targeting | picks a device itself (ambiguous with >1 booted) | pins Orca's exact device (UDID / adb serial) |

They **coexist** on the same device — Maestro invocations are stateless per run, so there's no one-client contention (unlike the browser CDP proxy). Neither imports the other; they just both shell out to `maestro`.

## MCP tools (from Maestro docs)

`list_devices` · `inspect_screen` (compact-JSON view hierarchy) · `take_screenshot` · `run` (execute a flow from inline YAML/file/dir) · `cheat_sheet` · `list_cloud_devices` · `run_on_cloud` · `get_cloud_run_status` · `open_maestro_viewer`.

## Install into Claude Code

```bash
claude mcp add maestro -- maestro mcp
```

## Pin the MCP to Orca's device (the integration seam)

With more than one device booted (e.g. an iOS sim *and* an Android emulator), the MCP may pick the wrong one — its tools don't take a UDID. Start the server pinned instead (verified: the global `--udid` flag is honored before the `mcp` subcommand):

```bash
maestro --udid "<id>" mcp            # e.g. emulator-5554, or the iOS UDID
```

The package tells you which id to pin — this is exactly what the JS resolver is for:

```js
const M = require('orca-playwright-bridge/maestro');
M.orcaSimulatorUdid();               // iOS UDID Orca booted
M.listAndroidDevices()[0]?.serial;   // Android serial
```

So the division of labor is clean: the JS package answers **"which device is Orca driving,"** the MCP consumes that id for interactive work, and the JS driver handles programmatic/CI runs against the same device.

## Recommendation

- Add the MCP when you want the agent to drive a device **interactively** — lowest friction, one-line install.
- Keep the JS driver for **programmatic/CI** use and Orca device pinning; the MCP doesn't replace it there.
