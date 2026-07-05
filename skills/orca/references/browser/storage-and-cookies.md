# Cookies & storage

## Cookies — raw CDP (the whole jar)

```js
const { connectOrca } = require('orca-playwright-bridge/connect');
const orca = await connectOrca();

await orca.cookies();                          // all cookies
await orca.cookies('https://example.com');     // scoped to URL(s)
await orca.setCookie({ name: 'session', value: 'abc', url: 'https://example.com' });
await orca.clearCookies();
```

## Cookies — through the Playwright bridge (verified)

`context.cookies()` / `context.addCookies()` tunnel through fine:

```js
const t = await connectOrcaPlaywright({ tab: /example/ });
await t.context.addCookies([{ name: 'session', value: 'abc', url: 'https://example.com' }]);
```

## localStorage / sessionStorage

Raw CDP (whole store as an object):

```js
await orca.storage('local');                   // { key: value, ... }
await orca.storage('session');
await orca.clearStorage('local');              // 'local' | 'session' | 'all'
```

Native per-tab (Orca ≥ 1.4.117):

```js
const t = orcaTabs().byId(pageId);
t.getStorage('theme');                          // localStorage
t.setStorage('theme', 'dark');
t.getStorage('step', { session: true });        // sessionStorage
t.clearWebStorage();
```

## Reusable auth state (storage-state pattern)

There is no `context.storageState()` through the bridge (no real contexts). Save/restore by hand:

```js
// save after logging in
const state = {
  cookies: await orca.cookies(url),
  local: await orca.storage('local'),
};
require('fs').writeFileSync('auth.json', JSON.stringify(state));

// restore in a later run
const s = JSON.parse(require('fs').readFileSync('auth.json'));
for (const c of s.cookies) await orca.setCookie(c);
await orca.evaluate(`(() => { const s = ${JSON.stringify(s.local)}; for (const k in s) localStorage.setItem(k, s[k]); })()`);
await orca.goto(url);   // reload so the app picks the state up
```

## Profile isolation (fixed in Orca 1.4.123)

Orca profiles (`orca tab profile create --scope isolated`) get their own partition string **and** their own storage. localStorage and cookies are now isolated per profile — a tab on an isolated profile no longer sees the default profile's keys or cookies (stablyai/orca#6923, **fixed in 1.4.123**; verified by `node repro/profile-isolation.js` → PASS).

On **older Orca (≤ 1.4.120)** storage was still shared across profiles — the flag assigned a partition but leaked state. If you're stuck on an older build, don't rely on profile isolation: log out/switch in-page, or serialize (run one state, save+clear, run the other).

## Quota / usage

`Storage.getUsageAndQuota` answers through the proxy if you need origin storage stats:

```js
await orca.client.send('Storage.getUsageAndQuota', { origin: 'https://example.com' });
```
