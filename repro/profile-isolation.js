'use strict';
/*
 * Reproducer: Orca browser profiles do NOT isolate web storage.
 *
 * The docs say profiles "isolate tab session state ... different cookies, local
 * storage, and logged-in identities" (https://www.onorca.dev/docs/cli/overview),
 * and `tab profile create --scope isolated` even assigns a distinct partition
 * string. But a default-profile tab and an isolated-profile tab on the same
 * origin still read each other's localStorage AND cookies.
 *
 * Depends only on the `orca` CLI (no extra packages). Run:  node repro/profile-isolation.js
 * Exit code: 0 if storage is isolated (bug fixed), 1 if it leaks (bug present).
 */

const { execFileSync } = require('node:child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function orca(args) {
  const out = execFileSync('orca', [...args, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  try { return JSON.parse(out); } catch (_) { return out; }
}
function evalOn(pageId, expr) {
  const r = orca(['eval', '--expression', expr, '--page', pageId]);
  return r?.result?.result ?? r?.result;
}

(async () => {
  const ORIGIN = 'https://example.com';
  let isoProfileId, defPage, isoPage;
  const created = [];
  try {
    isoProfileId = orca(['tab', 'profile', 'create', '--label', 'repro-isolated', '--scope', 'isolated']).result.profile.id;

    // 1. Default-profile tab: write a localStorage key and a cookie.
    defPage = orca(['tab', 'create', '--url', ORIGIN]).result.browserPageId; created.push(defPage);
    await sleep(2000);
    evalOn(defPage, "localStorage.setItem('leak_ls','from_default'); document.cookie='leak_ck=from_default;path=/'; 1");

    // 2. Isolated-profile tab on the SAME origin.
    isoPage = orca(['tab', 'create', '--url', ORIGIN, '--profile', isoProfileId]).result.browserPageId; created.push(isoPage);
    await sleep(2000);

    // 3. The isolated tab should see NEITHER value if profiles truly isolate.
    const seenLs = evalOn(isoPage, "localStorage.getItem('leak_ls')");
    const seenCk = evalOn(isoPage, "document.cookie.includes('leak_ck')");

    const part = orca(['tab', 'profile', 'list']).result.profiles.find((p) => p.id === isoProfileId)?.partition;
    console.log(`isolated profile partition : ${part}`);
    console.log(`isolated tab localStorage  : ${JSON.stringify(seenLs)}   (expected: null)`);
    console.log(`isolated tab sees cookie   : ${seenCk}   (expected: false)`);

    const leaked = seenLs === 'from_default' || seenCk === true;
    console.log(`\n${leaked ? 'FAIL — storage LEAKS across profiles (bug present)' : 'PASS — storage is isolated'}`);
    process.exitCode = leaked ? 1 : 0;
  } finally {
    for (const p of created) { try { orca(['tab', 'close', '--page', p]); } catch (_) { /* ignore */ } }
    if (isoProfileId) { try { orca(['tab', 'profile', 'delete', '--profile', isoProfileId]); } catch (_) { /* ignore */ } }
    // tidy the probe key left on the default partition
    // (best-effort; the default tab is already closed)
  }
})().catch((e) => { console.error('reproducer error:', e.message); process.exit(2); });
