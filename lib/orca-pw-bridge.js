'use strict';
/*
 * orca-pw-bridge — make Playwright drive Orca's embedded browser over CDP.
 *
 * Orca exposes a single browser-level CDP *proxy* target. It answers the CDP
 * commands Playwright needs, but differs from real Chrome in five ways that
 * each break Playwright's connectOverCDP handshake. This bridge sits between
 * Playwright and Orca, forwards traffic verbatim, and patches the five gaps:
 *
 *   1. setAutoAttach never emits Target.attachedToTarget  -> we synthesize it
 *      (using a real Target.attachToTarget to obtain the flat sessionId).
 *   2. Responses drop the sessionId                       -> we re-attach it
 *      from an id->session map (Orca echoes neither sessionId on responses).
 *   3. Page-scoped events arrive with no sessionId         -> we tag them with
 *      the page session so Playwright routes them to the page.
 *   4. The default/main world never emits                  -> we synthesize one
 *      Runtime.executionContextCreated; main-world evaluations are rewritten to
 *      Orca's default context (no contextId). Isolated worlds work natively:
 *      Orca DOES emit their context event when createIsolatedWorld is called.
 *   5. The main frame id != targetId                        -> Playwright assumes
 *      they're equal (_sessionForFrame, _isMainFrame). We rewrite the real frame
 *      id to the targetId on the way down, and back on the way up.
 *
 * Usage:
 *   const { startBridge } = require('orca-playwright-bridge/bridge');
 *   const bridge = await startBridge();
 *   const { chromium } = require('playwright');         // or playwright-core
 *   const browser = await chromium.connectOverCDP(bridge.url);
 *   const page = browser.contexts()[0].pages()[0];      // the live Orca tab
 *   ...
 *   await browser.close(); await bridge.close();         // detaches; Orca stays up
 */

const http = require('http');
const { execSync, execFileSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gReq(name) { try { return require(name); } catch (_) { return null; } }

function loadWs() {
  let W = gReq('ws');
  if (W) return W;
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    W = gReq(`${root}/ws`) || gReq(`${root}/chrome-remote-interface/node_modules/ws`);
  } catch (_) { /* ignore */ }
  if (W) return W;
  throw new Error('`ws` not found. Install it: npm i -g ws (or in your project).');
}

function discoverCdpUrl() {
  if (process.env.ORCA_CDP_URL) return process.env.ORCA_CDP_URL.trim();
  return execSync('orca-cdp -q', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

// Each Orca tab exposes its OWN CDP endpoint on its own ephemeral port. Scan
// every Orca-owned listening port and keep the ones that answer the CDP probe,
// recording which page each serves — this is how we target a specific tab.
function discoverAllCdpEndpoints() {
  let lsofOut = '';
  try {
    lsofOut = execSync('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i orca || true',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (_) { /* ignore */ }
  const ports = new Set();
  for (const line of lsofOut.split('\n')) {
    const m = line.match(/:(\d+)\s*\(LISTEN\)/);
    if (m) ports.add(m[1]);
  }
  const eps = [];
  for (const port of ports) {
    try {
      const list = JSON.parse(
        execSync(`curl -fs --max-time 2 http://127.0.0.1:${port}/json/list`,
          { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      if (Array.isArray(list) && list[0] && list[0].webSocketDebuggerUrl) {
        eps.push({ cdpUrl: `http://127.0.0.1:${port}`, port: Number(port), pageUrl: list[0].url, target: list[0] });
      }
    } catch (_) { /* not a CDP port */ }
  }
  return eps;
}

/** Resolve the CDP endpoint whose open page URL matches `match`. */
function findCdpUrlForTab(match) {
  const re = match instanceof RegExp ? match : new RegExp(match);
  const eps = discoverAllCdpEndpoints();
  const hit = eps.find((e) => re.test(e.pageUrl));
  if (!hit) {
    const seen = eps.map((e) => e.pageUrl).join(', ') || '(none)';
    throw new Error(`No Orca tab matches ${match}. Open it first (orca tab create --url <url>). Tabs with a CDP endpoint: ${seen}`);
  }
  return hit.cdpUrl;
}

function httpJson(port, path) {
  return JSON.parse(
    execSync(`curl -fs --max-time 3 http://127.0.0.1:${port}${path}`,
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  );
}

// --- Orca CLI (multi-tab) --------------------------------------------------
// The CDP proxy only ever exposes the ACTIVE tab. Orca's own CLI, however, can
// list every open tab and address any of them by browserPageId. We leverage it
// to (a) switch which tab is active before attaching Playwright, and (b) drive
// multiple tabs concurrently via Orca's native browser commands (orcaTabs()).
function orcaCli(args) {
  const out = execFileSync('orca', [...args, '--json'],
    { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  try { return JSON.parse(out); } catch (_) { return out; }
}

/** List all open Orca browser tabs: [{index, browserPageId, url, active, ...}] */
function orcaTabList() {
  return orcaCli(['tab', 'list']).result.tabs;
}

/**
 * Make the Orca tab whose URL matches `match` the active one (so the CDP proxy
 * — and thus the Playwright bridge — points at it). No-op if already active.
 */
async function switchToOrcaTab(match) {
  const tabs = orcaTabList();
  const re = match instanceof RegExp ? match : new RegExp(match);
  const idx = tabs.findIndex((t) => re.test(t.url));
  if (idx === -1) {
    throw new Error(`No open Orca tab matches ${match}. Open it first: orca tab create --url <url>`);
  }
  if (!tabs[idx].active) {
    execFileSync('orca', ['tab', 'switch', '--index', String(idx), '--json'], { stdio: 'ignore' });
    await sleep(700); // let the CDP proxy re-point to the newly active tab
  }
  return tabs[idx];
}

/**
 * Concurrent multi-tab driver using Orca's NATIVE CLI (not Playwright). Each
 * tab is addressed by browserPageId via `orca <cmd> --page <id>`, so you can
 * drive several open tabs in parallel — the thing the single-target CDP proxy
 * cannot do. Lower-level than Playwright (eval/snapshot/goto), but concurrent.
 *
 *   const tabs = orcaTabs();
 *   tabs.list;                              // [{index, pageId, url, active}]
 *   tabs.tab(/wikipedia/).eval('document.title');
 *   tabs.all().map(t => t.eval('location.href'));   // every tab, no switching
 */
function orcaTabs() {
  const driver = (pageId, url) => ({
    pageId,
    url,
    eval(js) { const r = orcaCli(['eval', '--expression', js, '--page', pageId]); return r?.result?.result ?? r; },
    goto(u) { return orcaCli(['goto', '--url', u, '--page', pageId]); },
    snapshot() { const r = orcaCli(['snapshot', '--page', pageId]); return r?.result ?? r; },
    click(ref) { return orcaCli(['click', '--element', ref, '--page', pageId]); },
    screenshot() { return orcaCli(['screenshot', '--page', pageId]); },
  });
  const tabs = orcaTabList();
  return {
    list: tabs.map((t) => ({ index: t.index, pageId: t.browserPageId, url: t.url, active: !!t.active })),
    tab(match) {
      const re = match instanceof RegExp ? match : new RegExp(match);
      const t = tabs.find((x) => re.test(x.url));
      if (!t) throw new Error(`No open Orca tab matches ${match}`);
      return driver(t.browserPageId, t.url);
    },
    byId: (pageId) => driver(pageId),
    all: () => tabs.map((t) => driver(t.browserPageId, t.url)),
  };
}

/**
 * Start the bridge.
 * @param {object} [opts]
 * @param {RegExp|string} [opts.tab] target the open Orca tab whose URL matches.
 *   Each tab has its OWN CDP endpoint/port, so this picks the right one — and
 *   multiple bridges (one per tab) can run concurrently.
 * @param {string} [opts.cdpUrl] use an explicit CDP base url
 * @param {RegExp|string} [opts.match] pick among the single endpoint's targets
 *   by url (rarely needed — one endpoint = one tab = one target).
 * @returns {Promise<{url, bridgePort, target, close}>}
 */
async function startBridge(opts = {}) {
  const WebSocket = loadWs();
  const base = opts.cdpUrl || (opts.tab ? findCdpUrlForTab(opts.tab) : discoverCdpUrl());
  if (!base) throw new Error('No Orca CDP endpoint. Is a browser tab open in Orca?');
  const upstreamPort = Number(base.split(':').pop());

  const targets = httpJson(upstreamPort, '/json/list');
  if (!targets.length) throw new Error('Orca CDP exposes no targets (open a tab in Orca).');
  let target = targets[0];
  if (opts.match) {
    const re = opts.match instanceof RegExp ? opts.match : new RegExp(opts.match);
    target = targets.find((t) => re.test(t.url)) || target;
  }
  const upstreamWsUrl = target.webSocketDebuggerUrl;
  const proxyFrameId = target.id; // the targetId Playwright sees == the frame id it assumes

  let bridgePort;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const path = req.url.replace(/\/+$/, '') || '/'; // tolerate trailing slash
    if (path === '/json/version') {
      const v = httpJson(upstreamPort, '/json/version');
      v.webSocketDebuggerUrl = `ws://127.0.0.1:${bridgePort}/devtools/browser/orca`;
      return res.end(JSON.stringify(v));
    }
    if (path === '/json' || path === '/json/list') {
      return res.end(JSON.stringify([{
        ...target,
        webSocketDebuggerUrl: `ws://127.0.0.1:${bridgePort}/devtools/page/${target.id}`,
      }]));
    }
    res.statusCode = 404; res.end('not found');
  });

  const wss = new WebSocket.Server({ server });

  wss.on('connection', (down) => {
    const up = new WebSocket(upstreamWsUrl);
    let upReady = false;
    const upQueue = [];
    const sendUp = (obj) => {
      const s = JSON.stringify(obj);
      if (upReady) up.send(s); else upQueue.push(s);
    };
    up.on('open', () => { upReady = true; upQueue.splice(0).forEach((m) => up.send(m)); });
    const sendDown = (obj) => { if (down.readyState === WebSocket.OPEN) down.send(JSON.stringify(obj)); };

    let injectId = 1_000_000_000;
    const injected = new Map();      // bridge-issued id -> handler(resp)
    const idToSession = new Map();   // playwright id -> sessionId it was sent on
    const idToMethod = new Map();    // playwright id -> method (to spot responses)
    let pageSessionId = null;        // the single page session Orca exposes
    let realFrameId = null;          // Orca's actual main-frame id (!= targetId)

    const MAIN_CTX = 1;              // sentinel id for the synthesized main world
    const MAIN_UID = 'orca-ctx-main';
    let mainCtxEmitted = false;

    // Rewrite frame-id references between Orca's real id and the targetId that
    // Playwright assumes the main frame uses. Walks objects; only touches
    // `frameId` keys and the `id` of frame-shaped objects — never `targetId`.
    const swapFrameIds = (obj, fromId, toId) => {
      if (!fromId || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { for (const v of obj) swapFrameIds(v, fromId, toId); return; }
      const frameShaped = ('url' in obj) || ('loaderId' in obj) || ('mimeType' in obj);
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string') {
          if (k === 'frameId' && v === fromId) obj[k] = toId;
          else if (k === 'id' && frameShaped && v === fromId) obj[k] = toId;
        } else if (v && typeof v === 'object') swapFrameIds(v, fromId, toId);
      }
    };

    // Main-world evaluations reference our sentinel context; strip it so Orca
    // evaluates in its real default context. Isolated worlds pass through.
    const remapContext = (p) => {
      if (!p || typeof p !== 'object') return;
      if (p.uniqueContextId === MAIN_UID) delete p.uniqueContextId;
      if (p.contextId === MAIN_CTX) delete p.contextId;
      if (p.executionContextId === MAIN_CTX) delete p.executionContextId;
    };

    down.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }

      // (1) Synthesize the attach event Orca never sends after setAutoAttach.
      if (msg.method === 'Target.setAutoAttach' && !msg.sessionId) {
        const id = injectId++;
        injected.set(id, (resp) => {
          const sid = (resp.result && resp.result.sessionId) || 'orca-proxy-session';
          pageSessionId = sid;
          sendDown({ id: msg.id, result: {} });
          sendDown({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: sid,
              targetInfo: {
                targetId: target.id, type: 'page', title: target.title,
                url: target.url, attached: true, canAccessOpener: false,
                browserContextId: 'orca-default', // Playwright asserts truthy
              },
              waitingForDebugger: false,
            },
          });
        });
        sendUp({ id, method: 'Target.attachToTarget', params: { targetId: target.id, flatten: true } });
        return;
      }

      if (msg.id != null && msg.sessionId) idToSession.set(msg.id, msg.sessionId);
      if (msg.id != null && msg.method) idToMethod.set(msg.id, msg.method);
      remapContext(msg.params);                          // (4) main-world ctx
      swapFrameIds(msg, proxyFrameId, realFrameId);      // (5) frameId -> real
      sendUp(msg);
    });

    up.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }

      // Bridge-injected command responses are consumed here, not forwarded.
      if (msg.id != null && injected.has(msg.id)) {
        const h = injected.get(msg.id); injected.delete(msg.id); return h(msg);
      }

      let method = null;
      if (msg.id != null) {
        method = idToMethod.get(msg.id); idToMethod.delete(msg.id);
        const sid = idToSession.get(msg.id);             // (2) restore sessionId
        if (sid) { msg.sessionId = sid; idToSession.delete(msg.id); }
      } else if (msg.method && pageSessionId && !msg.sessionId) {
        const domain = msg.method.split('.')[0];         // (3) tag page events
        if (domain !== 'Target' && domain !== 'Browser') msg.sessionId = pageSessionId;
      }

      // Learn Orca's real main-frame id, then rewrite it to the targetId.
      if (method === 'Page.getFrameTree' && msg.result?.frameTree?.frame?.id) {
        realFrameId = msg.result.frameTree.frame.id;
      } else if (msg.method === 'Page.frameNavigated' && msg.params?.frame && !msg.params.frame.parentId) {
        realFrameId = realFrameId || msg.params.frame.id;
      }
      swapFrameIds(msg, realFrameId, proxyFrameId);      // (5) real -> frameId

      sendDown(msg);

      // (4) After Runtime.enable, fabricate the main-world context once.
      if (method === 'Runtime.enable' && !mainCtxEmitted && pageSessionId) {
        mainCtxEmitted = true;
        sendDown({
          method: 'Runtime.executionContextCreated',
          sessionId: pageSessionId,
          params: {
            context: {
              id: MAIN_CTX, origin: '', name: '', uniqueId: MAIN_UID,
              auxData: { isDefault: true, type: 'default', frameId: proxyFrameId },
            },
          },
        });
      }
    });

    const closeBoth = () => { try { up.close(); } catch (_) {} try { down.close(); } catch (_) {} };
    down.on('close', closeBoth); down.on('error', closeBoth);
    up.on('close', closeBoth);   up.on('error', closeBoth);
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  bridgePort = server.address().port;

  return {
    url: `http://127.0.0.1:${bridgePort}`,
    bridgePort,
    target,
    close: () => new Promise((r) => { try { wss.close(); } catch (_) {} server.close(r); }),
  };
}

/** Resolve a Playwright `chromium` from a local or global install. */
function loadChromium() {
  let pw = gReq('playwright') || gReq('playwright-core');
  if (pw) return pw.chromium;
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    pw = gReq(`${root}/playwright`) || gReq(`${root}/playwright-core`);
  } catch (_) { /* ignore */ }
  if (pw) return pw.chromium;
  throw new Error('Playwright not found. Install: npm i -g playwright-core (or in your project).');
}

/**
 * One-call: start the bridge, connect Playwright, return the live Orca page.
 * @param {object} [opts] forwarded to startBridge (cdpUrl, match)
 * @returns {Promise<{browser, context, page, bridge, close}>}
 *   close() detaches Playwright and stops the bridge — it does NOT quit Orca.
 */
async function connectOrcaPlaywright(opts = {}) {
  const bridge = await startBridge(opts);
  const chromium = loadChromium();
  const browser = await chromium.connectOverCDP(bridge.url);
  const context = browser.contexts()[0] || null;
  let page = null;
  for (let i = 0; i < 40 && (!context || context.pages().length === 0); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  page = context ? context.pages()[0] || null : null;
  const close = async () => {
    try { await browser.close(); } catch (_) { /* ignore */ }
    try { await bridge.close(); } catch (_) { /* ignore */ }
  };
  return { browser, context, page, bridge, close };
}

/**
 * Open a NEW Orca tab and attach Playwright to it — the `newPage` equivalent.
 * Uses `orca tab create` (Playwright itself can't, the proxy rejects
 * Target.createTarget), then finds the freshly-appeared CDP endpoint by diffing
 * the port set (robust even if the URL duplicates an existing tab).
 * @param {string} url
 * @param {object} [opts] {profile?: string}  // profile is recorded but Orca does NOT isolate storage today
 * @returns {Promise<{browser, context, page, bridge, close}>} close() also closes the Orca tab.
 */
async function openOrcaTab(url, opts = {}) {
  const before = new Set(discoverAllCdpEndpoints().map((e) => e.port));
  const args = ['tab', 'create', '--url', url];
  if (opts.profile) args.push('--profile', opts.profile);
  const out = execFileSync('orca', [...args, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  let browserPageId = null;
  try { browserPageId = JSON.parse(out).result.browserPageId; } catch (_) { /* ignore */ }

  let ep = null;
  for (let i = 0; i < 30 && !ep; i++) {
    await sleep(300);
    ep = discoverAllCdpEndpoints().find((e) => !before.has(e.port));
  }
  if (!ep) throw new Error('Opened an Orca tab but it never exposed a CDP endpoint.');

  const conn = await connectOrcaPlaywright({ cdpUrl: ep.cdpUrl });
  conn.browserPageId = browserPageId;
  const baseClose = conn.close;
  conn.close = async () => {
    await baseClose();
    if (browserPageId) {
      try { execFileSync('orca', ['tab', 'close', '--page', browserPageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ }
    }
  };
  return conn;
}

module.exports = {
  startBridge, connectOrcaPlaywright, openOrcaTab, loadChromium, discoverCdpUrl,
  discoverAllCdpEndpoints, findCdpUrlForTab,
  orcaTabs, orcaTabList, switchToOrcaTab,
};

// --- CLI smoke test ----------------------------------------------------------
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const i = args.indexOf('--goto');
    const { page, bridge, close } = await connectOrcaPlaywright();
    console.error(`orca-pw-bridge: connected via ${bridge.url} -> ${bridge.target.url}`);
    if (!page) { console.error('No page available (open a tab in Orca).'); await close(); process.exit(2); }
    if (i !== -1 && args[i + 1]) { await page.goto(args[i + 1], { waitUntil: 'load' }); }
    console.log(JSON.stringify({ url: page.url(), title: await page.title() }, null, 2));
    await close();
  })().catch((e) => { console.error('orca-pw-bridge:', e.message); process.exit(1); });
}
