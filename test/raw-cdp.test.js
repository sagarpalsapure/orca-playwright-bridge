'use strict';
/*
 * Raw-CDP driver helpers (connectOrca). These reach capabilities that Playwright's
 * blocked newCDPSession can't — verified against Orca's page-socket CDP proxy.
 * Same skip-gate: a no-op when Orca isn't reachable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { discoverAllCdpEndpoints } = require('..');
const { connectOrca } = require('../lib/orca-connect.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function orcaReachable() {
  try {
    const out = execFileSync('orca', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(out)?.result?.runtime?.reachable === true;
  } catch (_) { return false; }
}
const SKIP = orcaReachable() ? false : 'Orca not running/reachable — open Orca to run raw-CDP tests';

/** Open a tab and resolve the CDP endpoint it spawned (so connectOrca targets it exactly). */
async function openRawTab(url) {
  const before = new Set(discoverAllCdpEndpoints().map((e) => e.port));
  const out = execFileSync('orca', ['tab', 'create', '--url', url, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const pageId = JSON.parse(out).result.browserPageId;
  let ep = null;
  for (let i = 0; i < 40 && !ep; i++) { await sleep(300); ep = discoverAllCdpEndpoints().find((e) => !before.has(e.port)); }
  assert.ok(ep, 'new tab never exposed a CDP endpoint');
  return { pageId, cdpUrl: ep.cdpUrl, close() { try { execFileSync('orca', ['tab', 'close', '--page', pageId, '--json'], { stdio: 'ignore' }); } catch (_) {} } };
}

test('captureConsole() collects logs and uncaught errors', { skip: SKIP }, async () => {
  const tab = await openRawTab('data:text/html,<title>c</title>');
  const o = await connectOrca({ cdpUrl: tab.cdpUrl });
  try {
    const cap = o.captureConsole();
    await o.evaluate("console.log('hi'); console.error('oops'); 1");
    await sleep(300);
    assert.ok(cap.messages.some((m) => m.type === 'log' && m.text === 'hi'));
    assert.ok(cap.messages.some((m) => m.type === 'error'));
    cap.stop();
  } finally { await o.close(); tab.close(); }
});

test('emulate() applies device metrics and timezone (instant, no reload)', { skip: SKIP }, async () => {
  // Needs a viewport meta, else mobile emulation uses the 980px default layout viewport.
  const tab = await openRawTab('data:text/html,<meta name="viewport" content="width=device-width,initial-scale=1"><title>e</title>');
  const o = await connectOrca({ cdpUrl: tab.cdpUrl });
  try {
    await o.emulate({ device: 'iPhone 12', timezone: 'Asia/Tokyo' });
    assert.equal(await o.evaluate('innerWidth'), 390);
    assert.equal(await o.evaluate('devicePixelRatio'), 3);
    assert.equal(await o.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'Asia/Tokyo');
    await o.clearEmulation();
  } finally { await o.close(); tab.close(); }
});

test('cookies() / setCookie() round-trip', { skip: SKIP }, async () => {
  const tab = await openRawTab('data:text/html,<title>ck</title>');
  const o = await connectOrca({ cdpUrl: tab.cdpUrl });
  try {
    await o.setCookie({ name: 'raw_probe', value: 'v1', url: 'https://example.com' });
    const forUrl = await o.cookies('https://example.com');
    assert.ok(Array.isArray(await o.cookies()));                    // getAllCookies
    assert.ok(forUrl.some((c) => c.name === 'raw_probe' && c.value === 'v1'));
  } finally { await o.close(); tab.close(); }
});

test('audits + capture: metrics(), axTree(), captureMHTML(), fullPageScreenshot()', { skip: SKIP }, async () => {
  const tab = await openRawTab('data:text/html,<title>a</title><h1>hi</h1><div style="height:2500px"></div>');
  const o = await connectOrca({ cdpUrl: tab.cdpUrl });
  try {
    const m = await o.metrics();
    assert.equal(typeof m.Nodes, 'number');
    assert.ok((await o.axTree()).length > 0);
    assert.match(await o.captureMHTML(), /Content-Type|MIME|multipart/i);
    const shot = await o.fullPageScreenshot();          // page is 2500px tall — beyond viewport
    assert.ok(shot.length > 1000);
  } finally { await o.close(); tab.close(); }
});

test('fullPageScreenshot() caps huge pages instead of returning empty', { skip: SKIP }, async () => {
  // 20000px tall — beyond Chrome's 16384 limit, where captureScreenshot returns
  // empty data unless the clip is capped.
  const tab = await openRawTab('data:text/html,<title>tall</title><div style="height:20000px;background:linear-gradient(#fff,#000)"></div>');
  const o = await connectOrca({ cdpUrl: tab.cdpUrl });
  try {
    const shot = await o.fullPageScreenshot(undefined, { format: 'jpeg' });
    assert.ok(shot.length > 1000, 'should return a valid image, not 0 bytes');
  } finally { await o.close(); tab.close(); }
});

test('storage() / clearStorage() round-trip', { skip: SKIP }, async () => {
  const tab = await openRawTab('data:text/html,<title>st</title>');
  const o = await connectOrca({ cdpUrl: tab.cdpUrl });
  try {
    await o.goto('https://example.com');   // real origin — data: URLs are opaque and have no localStorage
    await o.evaluate("localStorage.setItem('k', 'v'); 1");
    assert.equal((await o.storage('local')).k, 'v');
    await o.clearStorage('local');
    assert.deepEqual(await o.storage('local'), {});
  } finally { await o.close(); tab.close(); }
});

test('recordNetwork() produces a valid HAR', { skip: SKIP }, async () => {
  const tab = await openRawTab('data:text/html,<title>h</title>');
  const o = await connectOrca({ cdpUrl: tab.cdpUrl });
  try {
    const net = await o.recordNetwork();
    await o.goto('https://example.com');            // real request so the HAR has an entry
    await sleep(1200);
    const har = net.har();
    assert.equal(har.log.version, '1.2');
    assert.ok(har.log.entries.length > 0);
    assert.ok(har.log.entries[0].request.url && typeof har.log.entries[0].time === 'number');
    net.stop();
  } finally { await o.close(); tab.close(); }
});
