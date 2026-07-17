'use strict';
/*
 * Integration smoke tests for orca-playwright-bridge.
 *
 * These exercise the real bridge against a LIVE Orca app — there is no way to
 * unit-test a reverse-engineered CDP proxy without the proxy. So the suite:
 *
 *   - SKIPS cleanly (exit 0) when Orca is not running / not reachable, so
 *     `npm test` on a machine without Orca is a no-op, not a failure.
 *   - When Orca IS up, opens its own throwaway `data:` tabs (no network), runs
 *     every entry point, asserts, and closes the tabs it created.
 *
 * Run:  npm test        (node --test test/)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const {
  connectOrcaPlaywright, openOrcaTab, attachOrcaTab,
  orcaTabs, discoverAllCdpEndpoints, findEndpointForPageId,
} = require('..');
const { connectOrca } = require('../lib/orca-connect.js'); // raw-CDP driver lives in ./connect

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unique marker so we only ever match / clean up tabs THIS run created.
const MARKER = 'OrcaBridgeSelfTest';
const PAGE = `data:text/html,<title>${MARKER}</title>`
  + '<h1 id=h>Bridge OK</h1>'
  + '<input id=inp>'
  + '<button id=btn onclick="document.title=\'clicked\'">go</button>';

function orcaReachable() {
  try {
    const out = execFileSync('orca', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(out)?.result?.runtime?.reachable === true;
  } catch (_) { return false; }
}

const SKIP = orcaReachable() ? false : 'Orca not running/reachable — open Orca to run integration tests';

/** Open a fresh tab to `url`; resolve its pageId + the CDP endpoint it spawned. */
async function openTab(url) {
  const before_ = new Set((await discoverAllCdpEndpoints()).map((e) => e.port));
  const out = execFileSync('orca', ['tab', 'create', '--url', url, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const pageId = JSON.parse(out).result.browserPageId;
  let ep = null;
  for (let i = 0; i < 40 && !ep; i++) {
    await sleep(300);
    ep = (await discoverAllCdpEndpoints()).find((e) => !before_.has(e.port));
  }
  assert.ok(ep, 'new tab never exposed a CDP endpoint');
  return {
    pageId,
    cdpUrl: ep.cdpUrl,
    close() { try { execFileSync('orca', ['tab', 'close', '--page', pageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ } },
  };
}

test('Orca reachability gate', { skip: SKIP }, () => {
  assert.ok(orcaReachable());
});

test('raw CDP driver (connectOrca) reads the live page', { skip: SKIP }, async () => {
  const tab = await openTab(PAGE);
  try {
    const orca = await connectOrca({ cdpUrl: tab.cdpUrl });
    try {
      assert.equal(await orca.evaluate('document.title'), MARKER);
      assert.equal(await orca.evaluate("document.getElementById('h').textContent"), 'Bridge OK');
    } finally { await orca.close(); }
  } finally { tab.close(); }
});

test('orcaTabs() native driver: read + interact', { skip: SKIP }, async () => {
  const tab = await openTab(PAGE);
  try {
    const tabs = orcaTabs();
    const t = tabs.list.find((x) => x.pageId === tab.pageId);
    assert.ok(t, 'created tab should appear in orcaTabs().list');

    const d = tabs.byId(tab.pageId);
    assert.equal(d.get('title'), MARKER);
    assert.equal(d.eval('1 + 2'), 3);

    // snapshot -> ref-addressed reads
    const snap = d.snapshot();
    assert.ok(snap && snap.refs, 'snapshot should return refs');
    const headingRef = Object.keys(snap.refs).find((k) => snap.refs[k].role === 'heading');
    assert.ok(headingRef, 'heading ref present');
    assert.equal(d.get('text', headingRef), 'Bridge OK');
    assert.equal(d.is('visible', headingRef), true);

    // fill an input by ref, read the value back
    const inputRef = Object.keys(snap.refs).find((k) => snap.refs[k].role === 'textbox');
    if (inputRef) {
      d.fill(inputRef, 'hello orca');
      assert.equal(d.eval("document.getElementById('inp').value"), 'hello orca');
    }
  } finally { tab.close(); }
});

test('Playwright bridge (openOrcaTab) drives main-world DOM', { skip: SKIP }, async () => {
  const t = await openOrcaTab(PAGE);
  try {
    assert.ok(t.page, 'should resolve a Playwright page');
    assert.equal(await t.page.title(), MARKER);
    assert.equal(await t.page.locator('#h').innerText(), 'Bridge OK');

    // main-world read/write — exercises the synthesized default context (gap #4)
    await t.page.evaluate(() => { document.getElementById('inp').value = 'main-world'; });
    assert.equal(await t.page.inputValue('#inp'), 'main-world');

    // Text entry: Orca's proxy ignores programmatic .focus(), so a bare
    // page.fill() (focus + Input.insertText) is a no-op. A real click() gives
    // browser-level focus first, after which fill()/keyboard.type() land. This
    // is the documented input pattern for the bridge — see README "limits".
    await t.page.click('#inp');
    await t.page.fill('#inp', 'pw-value');
    assert.equal(await t.page.inputValue('#inp'), 'pw-value');

    // click that mutates the page — exercises frame-id rewrite (gap #5)
    await t.page.click('#btn');
    await t.page.waitForFunction("document.title === 'clicked'", null, { timeout: 5000 });
    assert.equal(await t.page.title(), 'clicked');
  } finally { await t.close(); } // closes the bridge AND the Orca tab
});

test('connectOrcaPlaywright({ tab }) targets a tab by URL match', { skip: SKIP }, async () => {
  const tab = await openTab(PAGE);
  try {
    const conn = await connectOrcaPlaywright({ tab: new RegExp(MARKER) });
    try {
      assert.equal(await conn.page.title(), MARKER);
    } finally { await conn.close(); }
  } finally { tab.close(); }
});

test('attachOrcaTab(pageId) pins to a specific tab, not the active one', { skip: SKIP }, async () => {
  // Two tabs open at once. The SECOND is active (most recently created), so any
  // "active/first" discovery would resolve to it. attachOrcaTab(tabA.pageId)
  // must still land on tab A — this is the multi-session anti-cross-drive fix.
  const A = `${PAGE.replace(MARKER, MARKER + 'A')}`;
  const B = `${PAGE.replace(MARKER, MARKER + 'B')}`;
  const tabA = await openTab(A);
  const tabB = await openTab(B);   // opened last → active
  try {
    // pin by the endpoint join, independent of which tab is active
    const epA = await findEndpointForPageId(tabA.pageId);
    assert.equal(epA.cdpUrl, tabA.cdpUrl, 'findEndpointForPageId should resolve tab A by its own pageId');

    const conn = await attachOrcaTab(tabA.pageId);
    try {
      assert.equal(await conn.page.title(), MARKER + 'A', 'attached page must be tab A, not the active tab B');
      assert.equal(conn.browserPageId, tabA.pageId);
    } finally { await conn.close(); }   // detaches only — must NOT close the tab
    // the tab we attached to is still open (attach ≠ create)
    assert.ok(orcaTabs().list.some((t) => t.pageId === tabA.pageId), 'attachOrcaTab.close() must leave the tab open');
  } finally { tabA.close(); tabB.close(); }
});

// Belt-and-suspenders: make sure we never leave self-test tabs behind.
after(async () => {
  if (SKIP) return;
  for (const ep of await discoverAllCdpEndpoints()) {
    if (typeof ep.pageUrl === 'string' && ep.pageUrl.includes(MARKER)) {
      try {
        const tabs = orcaTabs();
        const hit = tabs.list.find((x) => x.url && x.url.includes(MARKER));
        if (hit) execFileSync('orca', ['tab', 'close', '--page', hit.pageId, '--json'], { stdio: 'ignore' });
      } catch (_) { /* best effort */ }
    }
  }
});
