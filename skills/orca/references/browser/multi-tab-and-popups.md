# Multi-tab workflows & popups

Two ways to drive many tabs: a **Playwright bridge per tab** (heavier, fully concurrent, auto-waiting) or the **native `orcaTabs()` driver** (no bridge, wraps `orca … --page <id>`, works on tabs Playwright can't reach — e.g. popups).

## Playwright per tab (concurrent)

```js
const hn   = await connectOrcaPlaywright({ tab: /ycombinator/ });
const wiki = await connectOrcaPlaywright({ tab: /wikipedia/ });
const [title, heading] = await Promise.all([
  hn.page.locator('.titleline a').first().innerText(),
  wiki.page.locator('#firstHeading').innerText(),
]);
await hn.close(); await wiki.close();
```

## Native driver: `orcaTabs()`

```js
const tabs = orcaTabs();
tabs.list;                          // [{ index, pageId, url, active }]
const t = tabs.tab(/wikipedia/);    // or tabs.byId(pageId)
```

Per-tab verbs (each is a **synchronous** blocking `orca` call):

| Group | Methods |
| --- | --- |
| Read | `eval(js)` · `snapshot()` · `screenshot(format?)` · `get('text'\|'html'\|'value'\|'url'\|'title', ref?)` · `is('visible'\|'enabled'\|'checked', ref)` |
| Navigate | `goto(url)` · `back()` · `forward()` · `reload()` |
| Interact | `click` `dblclick` `hover` `focus` `fill` `clear` `select` `check` `uncheck` (by ref) · `type(text)` · `inserttext(text)` · `keypress(key)` · `scroll(dir, px?)` · `scrollIntoView(ref)` · `drag(from, to)` · `upload(ref, files)` · `wait(ms?)` |
| Locate | `find(locator, value, { action, text })` — see below |
| Mouse | `mouseMove(x,y)` · `mouseDown()` · `mouseUp()` · `mouseWheel(dy, dx?)` |
| Dialogs / storage / misc (Orca ≥ 1.4.117) | `acceptDialog(text?)` · `dismissDialog()` · `getStorage(k)` / `setStorage(k,v)` / `clearWebStorage()` · `highlight(sel)` · `download(sel, path)` · `exec(cmd)` |
| Focus | `activate()` — bring the tab to the foreground |

## Refs vs semantic locators

`snapshot()` returns `{ origin, refs: { e1: {name, role}, … }, snapshot }`. Refs (`e1`, `e2`, …) **go stale after navigation** — re-snapshot before interacting.

Semantic locators (Orca ≥ 1.4.114) skip refs and survive navigation — locate + act in one call:

```js
t.find('role',  'button', { action: 'click', text: 'Save' });   // getByRole('button', {name:'Save'}).click()
t.find('label', 'Email',  { action: 'fill',  text: 'a@b.co' }); // getByLabel('Email').fill(...)
t.find('text',  'Sign in', { action: 'click' });
```

## Concurrency

Native verbs are serial (`tabs.all().map(t => t.eval(…))` runs one at a time). For genuine wall-clock concurrency:

```js
await tabs.evalAll('document.title');   // async, Promise.all -> [{ pageId, url, value }]
```

…or bridge each tab with Playwright.

## Popups / `target=_blank`

A page-spawned popup opens as a new Orca tab with **no CDP endpoint** — Playwright cannot attach and no `popup` event fires. Capture it with `waitForNewTab`:

```js
const { pageId, url, tab, close } = await waitForNewTab(
  () => t.page.click('a[target=_blank]'),   // the action that spawns the tab
  { timeout: 10_000 }
);
tab.snapshot();                    // `tab` is a native TabDriver (the only way to drive it)
tab.find('role', 'button', { action: 'click', text: 'Accept' });
close();                           // closes the popup tab
```

The same applies to `window.open()` and OAuth popup flows: drive the popup natively, then continue with Playwright on the opener.

## Dialogs — verified behavior differs per type

Orca's embedded browser does NOT treat the three JS dialogs equally (verified on 1.4.120):

| Dialog | What actually happens | Handle it with |
| --- | --- | --- |
| `confirm()` | Real dialog, blocks the tab | `t.acceptDialog()` / `t.dismissDialog()` (native), or `page.on('dialog')` through the bridge — both verified |
| `alert()` | **Silently swallowed** — returns immediately, no dialog ever shows | Nothing to handle; `acceptDialog()` fails with "No dialog is showing" |
| `prompt()` | **Throws** `"prompt() is not supported."` in the page | Stub it *before* the action: `page.evaluate(() => { window.prompt = () => 'Jane'; })` |

```js
// confirm via native driver
t.acceptDialog();          // OK
t.dismissDialog();         // Cancel (no-ops if none open)

// confirm via Playwright (works through the bridge)
page.on('dialog', d => d.accept());
await page.click('#delete');

// prompt: stub, don't handle
await page.evaluate(() => { window.prompt = () => 'Jane'; });
await page.click('#rename');
```

Remember the one-client rule (`references/browser/connection-and-sessions.md`): calling a native dialog verb kicks a live Playwright bridge on that tab — pick one path per flow.
