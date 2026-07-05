---
description: Do anything in Orca's browser — open, click, fill, read, screenshot, test. Just describe it.
argument-hint: [what to do]
allowed-tools: Bash, Read
---

Drive my **Orca** app's browser to: **$ARGUMENTS**

Use `orca-playwright-bridge`. Quick path (the `orca-automation` skill has the full playbook + gotchas):

```js
const { openOrcaTab } = require('orca-playwright-bridge');   // or: ~/.local/lib/orca-pw-bridge.js
const t = await openOrcaTab('<url>');                        // opens focused; for the current tab use connectOrcaPlaywright({ tab: /substr/ })
try {
  // ...do the task with t.page and real locators...
  await t.page.screenshot({ path: '/tmp/orca.png' });
} finally { await t.close(); }
```

1. Precheck `orca status --json`. If Orca isn't running, stop and tell me.
2. Do the task; report each result pass/fail with the actual value + the screenshot path.
3. If you drove my live tab, restore its URL when done.

Gotchas: `click` before `fill`; popups → `waitForNewTab`; iframes read-only via `frameLocator` (`page.reload()` closed the tab on Orca < 1.4.120 — use `t.reload()` there). For the rest, lean on the `orca-automation` skill.
