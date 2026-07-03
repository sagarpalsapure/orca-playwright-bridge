'use strict';
/*
 * Maestro mobile-driver tests — exercise the iOS-simulator / Android-emulator
 * integration end to end. Skips cleanly (exit 0) when the toolchain or a device
 * isn't present, so `npm test` stays a no-op on machines without them.
 *
 * Preconditions to actually run:
 *   - maestro installed (curl -Ls "https://get.maestro.mobile.dev" | bash) + a JDK 11+
 *   - iOS: a simulator attached via Orca (orca emulator attach "iPhone 17")
 *   - Android: a booted emulator visible to adb
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../lib/orca-maestro.js');

const MAESTRO = M.resolveMaestro();
const IOS_UDID = MAESTRO ? M.orcaSimulatorUdid() : null;
const ANDROID = MAESTRO ? M.listAndroidDevices()[0] : null;

const SKIP_IOS = !MAESTRO ? 'maestro not installed' : (!IOS_UDID ? 'no iOS simulator booted via Orca' : false);
const SKIP_ANDROID = !MAESTRO ? 'maestro not installed' : (!ANDROID ? 'no Android emulator booted' : false);

const tmpPng = (name) => path.join(os.tmpdir(), `orca-maestro-test-${name}.png`);
function countNodes(tree) { let n = 0; (function w(x) { n++; (x.children || []).forEach(w); })(tree); return n; }
function isPng(p) { return fs.existsSync(p) && fs.readFileSync(p).subarray(1, 4).toString() === 'PNG'; }

// --- pure unit tests (no device) --------------------------------------------

test('flow builder emits valid Maestro YAML', () => {
  const yaml = M.flow('com.apple.Preferences')
    .launchApp()
    .tapOn({ text: 'General' })
    .inputText('hello: world')      // colon must be quoted
    .pressKey('Enter')
    .yaml();
  assert.match(yaml, /^appId: com\.apple\.Preferences\n---\n/);
  assert.match(yaml, /- launchApp/);
  assert.match(yaml, /- tapOn:\n {4}text: General/);
  assert.match(yaml, /- inputText: "hello: world"/);   // quoted because of the colon
  assert.match(yaml, /- pressKey: Enter/);
});

test('JDK discovery returns a usable java home when maestro is present', { skip: MAESTRO ? false : 'maestro not installed' }, () => {
  const jh = M.resolveJavaHome();
  assert.ok(jh && fs.existsSync(path.join(jh, 'bin', 'java')), `no java under ${jh}`);
});

// --- iOS ---------------------------------------------------------------------

test('iOS: hierarchy() returns a view tree', { skip: SKIP_IOS }, async () => {
  const drv = await M.iosMaestro();
  try { assert.ok(countNodes(await drv.hierarchy()) > 3); } finally { drv.cleanup(); }
});

test('iOS: launch Settings + screenshot PNG', { skip: SKIP_IOS }, async () => {
  const drv = await M.iosMaestro();
  try {
    const r = await drv.runFlow(drv.flow('com.apple.Preferences').launchApp().waitForAnimationToEnd(5000));
    assert.ok(r.ok, `flow failed: ${(r.stderr || r.stdout).slice(-160)}`);
    const p = tmpPng('ios');
    drv.screenshot(p);
    assert.ok(isPng(p), 'not a PNG');
  } finally { drv.cleanup(); }
});

// --- Android -----------------------------------------------------------------

test('Android: hierarchy() returns a view tree', { skip: SKIP_ANDROID }, async () => {
  const drv = await M.androidMaestro();
  try { assert.ok(countNodes(await drv.hierarchy()) > 3); } finally { drv.cleanup(); }
});

test('Android: launch Settings + screenshot PNG', { skip: SKIP_ANDROID }, async () => {
  const drv = await M.androidMaestro();
  try {
    const r = await drv.runFlow(drv.flow('com.android.settings').launchApp().waitForAnimationToEnd(5000));
    assert.ok(r.ok, `flow failed: ${(r.stderr || r.stdout).slice(-160)}`);
    const p = tmpPng('android');
    drv.screenshot(p);
    assert.ok(isPng(p), 'not a PNG');
  } finally { drv.cleanup(); }
});
