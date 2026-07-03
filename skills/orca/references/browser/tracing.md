# Performance tracing (Chrome trace files)

The proxy's `Tracing` domain **works end-to-end** (verified live on Orca 1.4.120: start → drive → end → `tracingComplete` → `IO.read` stream; 300 KB+ of real `devtools.timeline` events including `performance.mark` entries). It is not wrapped by the driver — use `orca.client` directly.

## Recipe: record a trace while driving the page

```js
const { connectOrca } = require('orca-playwright-bridge/connect');
const fs = require('fs');

const orca = await connectOrca();          // or { cdpUrl } to pin a tab
const client = orca.client;

const complete = new Promise(res => client.on('Tracing.tracingComplete', res));
await client.send('Tracing.start', {
  categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute,loading',
  transferMode: 'ReturnAsStream',
});

// ... drive the page via THIS client only (orca.evaluate / orca.goto) — attaching
//     Playwright or running a native verb on this tab would kill the trace client ...

await client.send('Tracing.end', {});
const { stream } = await complete;

let data = '', eof = false;
while (!eof) {
  const r = await client.send('IO.read', { handle: stream, size: 262144 });
  data += r.data; eof = r.eof;
}
await client.send('IO.close', { handle: stream });
fs.writeFileSync('trace.json', data);
await orca.close();
```

## Reading the result

- Open `trace.json` in **Chrome DevTools → Performance → load profile**, or https://ui.perfetto.dev.
- Programmatic: `JSON.parse(data).traceEvents` — filter by `name` (`EvaluateScript`, `Layout`, `Paint`, your `performance.mark()` names via `blink.user_timing`).
- This is a **Chrome trace**, not a Playwright trace — `npx playwright show-trace` won't open it.

## Useful category sets

| Goal | `categories` |
| --- | --- |
| General timeline (default) | `devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute,loading` |
| JS/CPU focus | `v8,v8.execute,disabled-by-default-v8.cpu_profiler` |
| Rendering/jank | `devtools.timeline,disabled-by-default-devtools.timeline.frame,benchmark,rail` |

## Notes

- One trace at a time per browser — `Tracing.start` fails if another trace is running.
- Prefer `transferMode: 'ReturnAsStream'`; without it, listen for `Tracing.dataCollected` chunks instead.
- For quick numbers without a trace, `orca.metrics()` (Performance domain) is much cheaper — see `references/browser/debugging.md`.
