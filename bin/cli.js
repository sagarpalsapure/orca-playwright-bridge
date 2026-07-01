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

const cmd = process.argv[2];
if (cmd === 'setup') {
  try { setup(); }
  catch (e) { console.error('setup failed:', e.message); process.exit(1); }
} else {
  console.log(`orca-playwright-bridge — drive Orca's embedded browser with Playwright or raw CDP.

Usage:
  npx orca-playwright-bridge setup     Install the orca-cdp CLI + libs (~/.local) and the /orca command.

Library:  npm install orca-playwright-bridge   then  require('orca-playwright-bridge')
Docs:     https://github.com/sagarpalsapure/orca-playwright-bridge`);
}
