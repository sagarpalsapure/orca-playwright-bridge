'use strict';
/*
 * Enhancement tests — lock in the features added for the Orca 1.4.144 re-verify:
 *   - version helpers (pure unit — no Orca needed)
 *   - concurrent, curl-free CDP discovery
 *   - isolated-profile tabs (openOrcaTab({ isolated }))
 *   - reattach() (the "one client per tab" remedy)
 *   - orcaTabs().list surfaces profileId/worktreeId
 *   - recordNetwork({ bodies:true }) fills HAR content.text
 *   - recordScreencast().toGif() via ffmpeg (skipped if ffmpeg absent)
 *
 * Same skip-gate as the other suites: a no-op when Orca isn't reachable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  openOrcaTab, attachOrcaTab, orcaTabs, discoverAllCdpEndpoints,
  orcaVersion, versionGte, resolveEndpointForPageId,
} = require('..');
const { connectOrca } = require('../lib/orca-connect.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function orcaReachable() {
  try {
    const out = execFileSync('orca', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(out)?.result?.runtime?.reachable === true;
  } catch (_) { return false; }
}
const SKIP = orcaReachable() ? false : 'Orca not running/reachable — open Orca to run enhancement tests';
function ffmpegPresent() { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } }

// --- pure unit: version helpers (no Orca) -----------------------------------

test('versionGte compares dotted versions', () => {
  assert.equal(versionGte('1.4.144', '1.4.120'), true);
  assert.equal(versionGte('1.4.120', '1.4.120'), true);
  assert.equal(versionGte('1.4.119', '1.4.120'), false);
  assert.equal(versionGte('1.5.0', '1.4.999'), true);
  assert.equal(versionGte('2.0', '1.9.9'), true);
});

test('orcaVersion honors the ORCA_VERSION override', () => {
  const prev = process.env.ORCA_VERSION;
  try {
    // orcaVersion caches per-process; the override path is exercised in a child.
    const out = execFileSync(process.execPath, ['-e',
      "process.env.ORCA_VERSION='9.9.9'; console.log(require('.').orcaVersion())"],
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    assert.equal(out, '9.9.9');
  } finally { if (prev === undefined) delete process.env.ORCA_VERSION; else process.env.ORCA_VERSION = prev; }
});

// --- discovery is concurrent + curl-free ------------------------------------

test('discoverAllCdpEndpoints() is async and returns an array', { skip: SKIP }, async () => {
  const eps = await discoverAllCdpEndpoints();
  assert.ok(Array.isArray(eps), 'should resolve to an array (Promise, not sync value)');
});

// --- isolated profile + reattach --------------------------------------------

test('openOrcaTab({ isolated }) opens in a fresh isolated profile and cleans it up on close', { skip: SKIP }, async () => {
  const listProfiles = () => JSON.parse(execFileSync('orca', ['tab', 'profile', 'list', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).result.profiles;
  const before = listProfiles().length;

  const t = await openOrcaTab('data:text/html,<title>iso</title>', { isolated: true, focus: false });
  try {
    assert.ok(t.profileId && t.profileId !== 'default', 'tab should report a non-default profile id');
    const tab = orcaTabs().list.find((x) => x.pageId === t.browserPageId);
    assert.ok(tab, 'isolated tab should be listed');
    assert.equal(tab.profileId, t.profileId, 'orcaTabs().list should surface the tab profileId');
  } finally { await t.close(); }

  // close() deletes the profile we created for the tab.
  await sleep(300);
  assert.equal(listProfiles().length, before, 'isolated profile should be removed on close');
});

test('reattach() re-establishes a live connection to the same tab', { skip: SKIP }, async () => {
  const t = await openOrcaTab('data:text/html,<title>REATTACH</title>', { focus: false });
  const pageId = t.browserPageId;
  let revived;
  try {
    // Attaching a second client to the same tab kills the first (the documented
    // "one client per tab" trap) — reattach() is the sanctioned recovery.
    const second = await attachOrcaTab(pageId);
    await second.close();

    // reattach() frees t's old bridge/browser and returns a fresh connection.
    revived = await t.reattach();
    assert.equal(revived.browserPageId, pageId, 'reattach should pin to the same tab');
    assert.equal(await revived.page.title(), 'REATTACH');
  } finally {
    if (revived) await revived.close();           // revived owns the tab (close closes it)
    else { try { await t.close(); } catch (_) { /* best effort */ } }
  }
});

// --- attach auto-activate ----------------------------------------------------
// The true idle-reclaim wake path (Orca drops a dormant tab's debug port, attach
// re-focuses to revive it) can't be forced deterministically in a unit test —
// it's validated manually. Here we cover the surrounding contract: the fast path
// (endpoint already live → no focus steal) and the { activate:false } opt-out.

test('attachOrcaTab attaches to a background tab (fast path — endpoint already live)', { skip: SKIP }, async () => {
  const bg = await openOrcaTab('data:text/html,<title>BGATTACH</title>', { focus: false });
  const pageId = bg.browserPageId;
  try {
    // resolveEndpointForPageId should find the live endpoint without activating.
    const ep = await resolveEndpointForPageId(pageId, { activate: false });
    assert.ok(ep && ep.cdpUrl, 'a freshly-created background tab still exposes its endpoint');
    const conn = await attachOrcaTab(pageId, { activate: false });
    try { assert.equal(await conn.page.title(), 'BGATTACH'); }
    finally { await conn.close(); }
  } finally { await bg.close(); }
});

// --- HAR response bodies -----------------------------------------------------

test('recordNetwork({ bodies:true }) captures response bodies into the HAR', { skip: SKIP }, async () => {
  const out = execFileSync('orca', ['tab', 'create', '--url', 'data:text/html,<title>h2</title>', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const pageId = JSON.parse(out).result.browserPageId;
  await sleep(800);
  const ep = (await discoverAllCdpEndpoints()).find((e) => e.pageUrl && e.pageUrl.includes('h2'));
  assert.ok(ep, 'created tab should expose a CDP endpoint');
  const o = await connectOrca({ cdpUrl: ep.cdpUrl });
  try {
    const net = await o.recordNetwork({ bodies: true });
    await o.goto('https://example.com');
    await sleep(1500);
    const har = net.har();
    net.stop();
    const withBody = har.log.entries.find((e) => e.response && e.response.content && typeof e.response.content.text === 'string' && e.response.content.text.length > 0);
    assert.ok(withBody, 'at least one HAR entry should carry response body text');
  } finally {
    await o.close();
    try { execFileSync('orca', ['tab', 'close', '--page', pageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ }
  }
});

// --- screencast → gif via ffmpeg --------------------------------------------

test('recordScreencast().toGif() encodes a real GIF', { skip: SKIP || (ffmpegPresent() ? false : 'ffmpeg not installed') }, async () => {
  const out = execFileSync('orca', ['tab', 'create', '--url', 'data:text/html,<title>gif</title><div style="height:2000px;background:linear-gradient(#f00,#00f)"></div>', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const pageId = JSON.parse(out).result.browserPageId;
  await sleep(800);
  const ep = (await discoverAllCdpEndpoints()).find((e) => e.pageUrl && e.pageUrl.includes('gif'));
  assert.ok(ep, 'created tab should expose a CDP endpoint');
  const o = await connectOrca({ cdpUrl: ep.cdpUrl });
  const gifPath = path.join(os.tmpdir(), `orca-test-${process.pid}.gif`);
  try {
    const rec = await o.recordScreencast({ format: 'jpeg', quality: 40 });
    for (let i = 0; i < 4; i++) { await o.evaluate(`scrollTo(0, ${i * 500})`); await sleep(300); }
    await rec.stop();
    rec.toGif(gifPath, { fps: 8 });
    const buf = fs.readFileSync(gifPath);
    assert.ok(buf.length > 100, 'gif should have bytes');
    assert.equal(buf.slice(0, 3).toString('latin1'), 'GIF', 'should carry the GIF magic header');
  } finally {
    await o.close();
    try { fs.rmSync(gifPath, { force: true }); } catch (_) { /* best effort */ }
    try { execFileSync('orca', ['tab', 'close', '--page', pageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ }
  }
});
