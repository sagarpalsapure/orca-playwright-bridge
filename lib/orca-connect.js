'use strict';
/*
 * orca-connect — drive Orca's embedded Chromium over RAW CDP.
 *
 * Global, project-agnostic. The Orca CDP port is ephemeral (fresh each launch),
 * so we discover it at call time via the `orca-cdp` CLI (falling back to an
 * inline scan). Orca exposes a single browser-level proxy target that does NOT
 * support Playwright's page-attach model, so we talk to it directly with
 * `chrome-remote-interface` instead — connecting straight to the target's
 * webSocket and using the bundled protocol descriptor (`local: true`) so CRI
 * never makes the side HTTP requests the minimal proxy can't serve.
 *
 * Dependency resolution: caller's node_modules first, then global npm root.
 *
 * --- Use as a module ---------------------------------------------------------
 *   const { connectOrca } = require('orca-playwright-bridge/connect');
 *   const orca = await connectOrca();          // { client, cdpUrl, evaluate, goto, screenshot, close }
 *   console.log(await orca.evaluate('document.title'));
 *   await orca.goto('http://localhost:3003/');
 *   await orca.screenshot('/tmp/orca.png');
 *   await orca.close();                        // detaches; does NOT quit Orca
 *
 *   // raw access: orca.client is the chrome-remote-interface client, with
 *   // orca.client.Runtime / .Page / .DOM / .Network domains enabled.
 *
 * --- Use as a CLI ------------------------------------------------------------
 *   node orca-connect.js                       # print active tab url + title
 *   node orca-connect.js --eval "1+1"          # evaluate JS in the tab
 *   node orca-connect.js --goto http://x       # navigate the tab
 *   node orca-connect.js --shot /tmp/o.png     # screenshot the tab
 */

const { execSync } = require('child_process');
const fs = require('fs');

/** Discover Orca's CDP base URL (e.g. http://127.0.0.1:65279). Throws if none. */
function discoverCdpUrl() {
  if (process.env.ORCA_CDP_URL) return process.env.ORCA_CDP_URL.trim();
  try {
    const out = execSync('orca-cdp -q', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out;
  } catch (_) { /* fall through */ }
  const url = scanForCdp();
  if (url) return url;
  throw new Error(
    'Could not find an Orca CDP endpoint. Is Orca running? ' +
    'Try `orca status` / `orca-cdp`, or set ORCA_CDP_URL manually.'
  );
}

function scanForCdp() {
  let pids = '';
  try { pids = execSync('pgrep -x Orca', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_) { /* not running */ }
  if (!pids) return null;
  const ports = new Set();
  for (const pid of pids.split(/\s+/)) {
    let lsof = '';
    try {
      lsof = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`,
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch (_) { continue; }
    for (const line of lsof.split('\n')) {
      const m = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (m) ports.add(m[1]);
    }
  }
  for (const port of ports) {
    try {
      const body = execSync(`curl -fs --max-time 2 http://127.0.0.1:${port}/json/version`,
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      if (body.includes('webSocketDebuggerUrl')) return `http://127.0.0.1:${port}`;
    } catch (_) { /* keep scanning */ }
  }
  return null;
}

/** Resolve chrome-remote-interface from local or global install. */
function loadCRI() {
  try { return require('chrome-remote-interface'); } catch (_) { /* try global */ }
  try {
    const globalRoot = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return require(`${globalRoot}/chrome-remote-interface`);
  } catch (_) { /* not found */ }
  throw new Error(
    'chrome-remote-interface not found. Install it in your project ' +
    '(`npm i chrome-remote-interface`) or globally (`npm i -g chrome-remote-interface`).'
  );
}

/**
 * Connect to Orca's embedded browser over raw CDP.
 * @param {object} [opts]
 * @param {string} [opts.cdpUrl]      override discovery
 * @param {RegExp|string} [opts.match] pick a target whose url matches (default: first)
 * @param {string[]} [opts.domains]   extra CDP domains to enable (Page/Runtime/DOM always on)
 * @returns {Promise<{client, cdpUrl, target, evaluate, goto, screenshot, close}>}
 */
async function connectOrca(opts = {}) {
  const cdpUrl = opts.cdpUrl || discoverCdpUrl();
  const port = Number(cdpUrl.split(':').pop());
  const CDP = loadCRI();

  const targets = await CDP.List({ port });
  if (!targets.length) throw new Error(`Orca CDP at ${cdpUrl} exposes no targets.`);
  let target = targets[0];
  if (opts.match) {
    const re = opts.match instanceof RegExp ? opts.match : new RegExp(opts.match);
    target = targets.find((t) => re.test(t.url)) || target;
  }

  // local:true avoids fetching /json/protocol; connect straight to the target ws.
  const client = await CDP({ target: target.webSocketDebuggerUrl, local: true });
  const { Runtime, Page, DOM } = client;
  await Promise.all([Runtime.enable(), Page.enable(), DOM.enable()]);
  for (const d of (opts.domains || [])) {
    if (client[d] && client[d].enable) await client[d].enable();
  }

  async function evaluate(expression) {
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'evaluate failed');
    }
    return result.value;
  }

  async function goto(url, { waitMs = 30000 } = {}) {
    const loaded = new Promise((res) => {
      const t = setTimeout(res, waitMs);
      Page.loadEventFired(() => { clearTimeout(t); res(); });
    });
    await Page.navigate({ url });
    await loaded;
  }

  async function screenshot(path, { format = 'png' } = {}) {
    const { data } = await Page.captureScreenshot({ format });
    const buf = Buffer.from(data, 'base64');
    if (path) fs.writeFileSync(path, buf);
    return buf;
  }

  async function close() { try { await client.close(); } catch (_) { /* already gone */ } }

  return { client, cdpUrl, target, evaluate, goto, screenshot, close };
}

module.exports = { connectOrca, discoverCdpUrl, scanForCdp, loadCRI };

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
    const orca = await connectOrca();
    console.error(`orca-connect: attached to ${orca.cdpUrl} (${orca.target.url})`);

    const evalExpr = flag('--eval');
    const gotoUrl = flag('--goto');
    const shotPath = flag('--shot');

    if (gotoUrl) { await orca.goto(gotoUrl); console.error(`navigated to ${gotoUrl}`); }
    if (evalExpr) { console.log(JSON.stringify(await orca.evaluate(evalExpr))); }
    if (shotPath) { await orca.screenshot(shotPath); console.error(`screenshot -> ${shotPath}`); }
    if (!evalExpr && !shotPath) {
      console.log(JSON.stringify({
        url: await orca.evaluate('location.href'),
        title: await orca.evaluate('document.title'),
      }, null, 2));
    }
    await orca.close();
  })().catch((e) => { console.error('orca-connect:', e.message); process.exit(1); });
}
