'use strict';
/*
 * Capability tests — lock in the advanced features verified to tunnel through
 * the bridge (so an Orca/Playwright upgrade that breaks them turns this red),
 * plus the native `orca set` emulation primitives exposed on orcaTabs().
 *
 * Same skip-gate as bridge.test.js: a no-op when Orca isn't reachable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { openOrcaTab, orcaTabs } = require('..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function orcaReachable() {
  try {
    const out = execFileSync('orca', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(out)?.result?.runtime?.reachable === true;
  } catch (_) { return false; }
}
const SKIP = orcaReachable() ? false : 'Orca not running/reachable — open Orca to run capability tests';

/**
 * Open a tab WITHOUT attaching Playwright. Emulation (`orca set …`) reloads the
 * tab to apply, which would tear down a Playwright bridge — so the emulation
 * tests drive and read purely over Orca's native CLI via orcaTabs().
 */
async function openNativeTab(url) {
  const out = execFileSync('orca', ['tab', 'create', '--url', url, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const pageId = JSON.parse(out).result.browserPageId;
  await sleep(1500);
  return { pageId, close() { try { execFileSync('orca', ['tab', 'close', '--page', pageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ } } };
}

// --- Playwright features that tunnel through the bridge ----------------------

test('page.route() intercepts and mocks responses', { skip: SKIP }, async () => {
  const t = await openOrcaTab('data:text/html,<title>start</title>');
  try {
    await t.page.route('**/mock/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>MOCKED</title>ok' }));
    await t.page.goto('https://example.com/mock/x', { waitUntil: 'load', timeout: 8000 });
    assert.equal(await t.page.title(), 'MOCKED'); // served from the route, not the network
  } finally { await t.close(); }
});

test('context cookies API (addCookies / cookies)', { skip: SKIP }, async () => {
  const t = await openOrcaTab('data:text/html,<title>ck</title>');
  try {
    await t.context.addCookies([{ name: 'probe', value: 'v1', url: 'https://example.com' }]);
    const cookies = await t.context.cookies('https://example.com');
    assert.ok(cookies.some((c) => c.name === 'probe' && c.value === 'v1'));
  } finally { await t.close(); }
});

test('page.emulateMedia({ colorScheme }) reflects in matchMedia', { skip: SKIP }, async () => {
  const t = await openOrcaTab('data:text/html,<title>media</title>');
  try {
    await t.page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await t.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
    await t.page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await t.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), false);
  } finally { await t.close(); }
});

test('page.routeWebSocket() mocks a WebSocket server', { skip: SKIP }, async () => {
  const html = "<title>ws</title><script>window.__m=[];const w=new WebSocket('wss://example.com/sock');"
    + "w.onopen=()=>w.send('hello');w.onmessage=e=>window.__m.push(e.data);</script>";
  const url = 'data:text/html,' + encodeURIComponent(html);
  const t = await openOrcaTab('data:text/html,<title>blank</title>');
  try {
    await t.page.routeWebSocket(/example\.com/, (ws) => ws.onMessage((m) => ws.send('echo:' + m)));
    await t.page.goto(url, { waitUntil: 'load', timeout: 8000 });
    await t.page.waitForFunction('window.__m && window.__m.length>0', null, { timeout: 6000 });
    assert.deepEqual(await t.page.evaluate(() => window.__m), ['echo:hello']); // served by the mock, no real server
  } finally { await t.close(); }
});

// --- orcaTabs() native emulation primitives ----------------------------------

test('orcaTabs().setDevice() applies a mobile UA', { skip: SKIP }, async () => {
  const tab = await openNativeTab('data:text/html,<title>dev</title>');
  try {
    const d = orcaTabs().byId(tab.pageId);
    d.setDevice('iPhone 12');
    assert.equal(d.eval('/iPhone|Mobile/.test(navigator.userAgent)'), true);
  } finally { tab.close(); }
});

test('orcaTabs().setMedia() flips prefers-color-scheme', { skip: SKIP }, async () => {
  const tab = await openNativeTab('data:text/html,<title>m2</title>');
  try {
    const d = orcaTabs().byId(tab.pageId);
    d.setMedia({ colorScheme: 'dark' });
    assert.equal(d.eval("matchMedia('(prefers-color-scheme: dark)').matches"), true);
  } finally { tab.close(); }
});

test('orcaTabs().setOffline() takes the tab offline', { skip: SKIP }, async () => {
  const tab = await openNativeTab('data:text/html,<title>off</title>');
  try {
    const d = orcaTabs().byId(tab.pageId);
    d.setOffline(true);
    assert.equal(d.eval('navigator.onLine'), false);
    d.setOffline(false);
    assert.equal(d.eval('navigator.onLine'), true);
  } finally { tab.close(); }
});
