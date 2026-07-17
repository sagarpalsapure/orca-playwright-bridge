#!/usr/bin/env node
'use strict';
/*
 * orca-playwright-bridge CLI. Main use:
 *
 *   npx orca-playwright-bridge setup
 *
 * `setup` does the whole install in one command: installs the package (with its
 * deps) into a persistent home (~/.orca-playwright-bridge), symlinks the
 * `orca-cdp` CLI + libs into ~/.local, and installs the /orca Claude Code
 * command. Re-run any time to update.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function link(target, linkPath) {
  try { fs.unlinkSync(linkPath); } catch (_) { /* not there */ }
  fs.symlinkSync(target, linkPath);
}

function setup() {
  const version = require('../package.json').version;
  const home = process.env.ORCA_PW_DIR || path.join(os.homedir(), '.orca-playwright-bridge');
  fs.mkdirSync(home, { recursive: true });

  // Install into a persistent dir so its node_modules (ws, playwright-core, …)
  // resolve — copying a hoisted npx cache would lose them.
  console.log(`==> installing orca-playwright-bridge@${version} into ${home}`);
  execSync(`npm install orca-playwright-bridge@${version} --prefix "${home}" --no-fund --no-audit --loglevel=error`, { stdio: 'inherit' });
  const pkg = path.join(home, 'node_modules', 'orca-playwright-bridge');

  const localBin = path.join(os.homedir(), '.local', 'bin');
  const localLib = path.join(os.homedir(), '.local', 'lib');
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(localLib, { recursive: true });
  link(path.join(pkg, 'bin', 'orca-cdp'), path.join(localBin, 'orca-cdp'));
  link(path.join(pkg, 'lib', 'orca-pw-bridge.js'), path.join(localLib, 'orca-pw-bridge.js'));
  link(path.join(pkg, 'lib', 'orca-connect.js'), path.join(localLib, 'orca-connect.js'));
  console.log('==> linked orca-cdp + libs into ~/.local');

  const claude = path.join(os.homedir(), '.claude');
  if (fs.existsSync(claude)) {
    const cmds = path.join(claude, 'commands');
    fs.mkdirSync(cmds, { recursive: true });
    for (const f of fs.readdirSync(path.join(pkg, 'commands')).filter((f) => f.endsWith('.md'))) {
      fs.copyFileSync(path.join(pkg, 'commands', f), path.join(cmds, f));
    }
    console.log('==> installed the /orca command into ~/.claude/commands');
  }

  if (!(process.env.PATH || '').split(path.delimiter).includes(localBin)) {
    console.log(`\nNOTE: add ~/.local/bin to your PATH:  export PATH="$HOME/.local/bin:$PATH"`);
  }
  console.log('\n==> done. Open a tab in Orca, then use  /orca <task>  in Claude Code (or run  orca-cdp).');
}

// A preflight health check: verifies everything the bridge needs is in place
// and prints a checklist, so a failing run has an obvious cause.
function doctor() {
  let ok = true;
  const pass = (m) => console.log(`  ✓ ${m}`);
  const warn = (m) => console.log(`  ! ${m}`);
  const fail = (m) => { ok = false; console.log(`  ✗ ${m}`); };
  const has = (bin, args = ['--version']) => {
    try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; }
    catch (_) { try { require('child_process').execFileSync(bin, args, { stdio: 'ignore' }); return true; } catch (_2) { return false; } }
  };
  const canReq = (name) => { try { require(name); return true; } catch (_) { return false; } };

  console.log('orca-playwright-bridge doctor\n');

  // Orca runtime + version.
  let reachable = false;
  try {
    const st = JSON.parse(require('child_process').execFileSync('orca', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    reachable = st?.result?.runtime?.reachable === true;
  } catch (_) { /* orca CLI missing or not running */ }
  reachable ? pass('Orca runtime reachable (orca status)') : fail('Orca not reachable — run `orca open` (or `orca status` to diagnose)');

  let version = null;
  try { version = require('../lib/orca-pw-bridge.js').orcaVersion(); } catch (_) { /* ignore */ }
  version ? pass(`Orca version ${version}`) : warn('Orca version unknown (set ORCA_VERSION to enable version-gated behavior)');

  // Open tabs (the CDP proxy is tab-scoped).
  try {
    const tabs = JSON.parse(require('child_process').execFileSync('orca', ['tab', 'list', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())?.result?.tabs || [];
    tabs.length ? pass(`${tabs.length} browser tab(s) open`) : warn('No browser tab open — open one (a tab is required to attach)');
  } catch (_) { warn('Could not list tabs (is Orca running?)'); }

  // Discovery tooling.
  has('lsof', ['-v']) ? pass('lsof present (port discovery)') : fail('lsof not found — needed to discover Orca CDP ports');

  // Dependencies.
  (canReq('ws')) ? pass('ws resolvable') : fail('ws not found — npm i ws (needed by the Playwright bridge)');
  (canReq('playwright') || canReq('playwright-core')) ? pass('playwright resolvable') : warn('playwright/playwright-core not found — needed only for the Playwright API');
  (canReq('chrome-remote-interface')) ? pass('chrome-remote-interface resolvable') : warn('chrome-remote-interface not found — needed only for the raw-CDP driver');

  // Optional: ffmpeg for screencast → video/gif.
  has('ffmpeg') ? pass('ffmpeg present (screencast toVideo/toGif)') : warn('ffmpeg not found — optional, only for recordScreencast().toVideo/toGif');

  console.log(`\n${ok ? '✓ ready' : '✗ not ready — resolve the ✗ items above'}`);
  if (!ok) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'setup') {
  try { setup(); }
  catch (e) { console.error('setup failed:', e.message); process.exit(1); }
} else if (cmd === 'doctor') {
  try { doctor(); }
  catch (e) { console.error('doctor failed:', e.message); process.exit(1); }
} else {
  console.log(`orca-playwright-bridge — drive Orca's embedded browser with Playwright or raw CDP.

Usage:
  npx orca-playwright-bridge setup     Install the orca-cdp CLI + libs (~/.local) and the /orca command.
  npx orca-playwright-bridge doctor    Preflight health check (Orca, deps, tabs, tooling).

Library:  npm install orca-playwright-bridge   then  require('orca-playwright-bridge')
Docs:     https://github.com/sagarpalsapure/orca-playwright-bridge`);
}
