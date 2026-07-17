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
const { execSync, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `fn` until it returns truthy or the try budget is spent, with gentle
 * exponential backoff (fast when the answer is ready quickly, patient when it
 * isn't). Returns the truthy value, or null if the budget runs out.
 */
async function pollFor(fn, { tries = 30, startMs = 50, maxMs = 400, factor = 1.6 } = {}) {
  let delay = startMs;
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(delay);
    delay = Math.min(maxMs, Math.round(delay * factor));
  }
  return null;
}

// Fetch JSON over HTTP with Node's core `http` — no dependency on the `curl`
// binary (portable to minimal containers) and non-blocking so callers can probe
// many ports concurrently with Promise.all.
function httpGetJson(port, path, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${path}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function gReq(name) { try { return require(name); } catch (_) { return null; } }

// Compare dotted version strings: versionGte('1.4.144', '1.4.120') === true.
function versionGte(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

let _cachedOrcaVersion;
/**
 * Best-effort Orca app version, e.g. "1.4.144" — or null if it can't be read.
 * Cached for the process. Set ORCA_VERSION to override (handy on Linux, where
 * the app bundle isn't probed). Used to auto-select version-gated behavior
 * (e.g. native page.reload() is safe on Orca >= 1.4.120).
 */
function orcaVersion() {
  if (_cachedOrcaVersion !== undefined) return _cachedOrcaVersion;
  _cachedOrcaVersion = null;
  const env = (process.env.ORCA_VERSION || '').trim();
  if (env) { _cachedOrcaVersion = env; return _cachedOrcaVersion; }
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('defaults',
        ['read', '/Applications/Orca.app/Contents/Info.plist', 'CFBundleShortVersionString'],
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (/^\d+\.\d+/.test(out)) _cachedOrcaVersion = out;
    }
  } catch (_) { /* not found / not darwin — leave null */ }
  return _cachedOrcaVersion;
}

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

async function discoverCdpUrl() {
  if (process.env.ORCA_CDP_URL) return process.env.ORCA_CDP_URL.trim();
  // With more than one tab open, "the first endpoint" is nondeterministic and
  // flips to whichever tab is active — that's how two Claude/automation
  // sessions end up driving each other's tab. Refuse to guess: force the caller
  // to name the tab (opts.tab / opts.cdpUrl, or openOrcaTab/attachOrcaTab).
  const eps = await discoverAllCdpEndpoints();
  if (eps.length === 0) {
    throw new Error('No Orca CDP endpoint. Is a browser tab open in Orca?');
  }
  if (eps.length === 1) return eps[0].cdpUrl;
  const list = eps.map((e) => `    ${e.cdpUrl}  ${e.pageUrl}`).join('\n');
  throw new Error(
    `Ambiguous: ${eps.length} Orca tabs are open, each with its own CDP endpoint. ` +
    `Pick one so sessions don't cross-drive:\n${list}\n` +
    `  • openOrcaTab(url) to open + own a fresh tab,\n` +
    `  • attachOrcaTab(pageId) to re-attach to a tab you already own,\n` +
    `  • or pass { tab: /url-regex/ } or { cdpUrl } explicitly.`
  );
}

/**
 * Resolve the CDP endpoint that serves the tab with the given browserPageId.
 * The per-port /json/list does NOT carry the browserPageId (every tab reports
 * id "orca-proxy-target"), so we join on URL: browserPageId -> url (via
 * `orca tab list`) -> the endpoint whose page url matches. `preferNotIn` breaks
 * ties (same URL in two tabs) toward a port that wasn't present before.
 */
async function findEndpointForPageId(pageId, preferNotIn) {
  // Search ALL worktrees — a pageId is globally unique, and the tab you want to
  // attach to may live in a different worktree than the one you're invoking from
  // (`orca tab list` alone is worktree-scoped).
  const tab = orcaTabList('all').find((t) => t.browserPageId === pageId);
  if (!tab) throw new Error(`No open Orca tab with pageId ${pageId} (in any worktree).`);
  const eps = (await discoverAllCdpEndpoints()).filter((e) => e.pageUrl === tab.url);
  if (eps.length === 0) return null;
  if (eps.length > 1 && preferNotIn) {
    const fresh = eps.find((e) => !preferNotIn.has(e.port));
    if (fresh) return fresh;
  }
  return eps[0];
}

// Each Orca tab exposes its OWN CDP endpoint on its own ephemeral port. Scan
// every Orca-owned listening port and keep the ones that answer the CDP probe,
// recording which page each serves — this is how we target a specific tab.
async function discoverAllCdpEndpoints() {
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
  // Probe every candidate port concurrently via native http (no curl spawn).
  const probes = [...ports].map(async (port) => {
    try {
      const list = await httpGetJson(port, '/json/list', { timeoutMs: 2000 });
      if (Array.isArray(list) && list[0] && list[0].webSocketDebuggerUrl) {
        return { cdpUrl: `http://127.0.0.1:${port}`, port: Number(port), pageUrl: list[0].url, target: list[0] };
      }
    } catch (_) { /* not a CDP port */ }
    return null;
  });
  return (await Promise.all(probes)).filter(Boolean);
}

/** Resolve the CDP endpoint whose open page URL matches `match`. */
async function findCdpUrlForTab(match) {
  const re = match instanceof RegExp ? match : new RegExp(match);
  const eps = await discoverAllCdpEndpoints();
  const hit = eps.find((e) => re.test(e.pageUrl));
  if (!hit) {
    const seen = eps.map((e) => e.pageUrl).join(', ') || '(none)';
    throw new Error(`No Orca tab matches ${match}. Open it first (orca tab create --url <url>). Tabs with a CDP endpoint: ${seen}`);
  }
  return hit.cdpUrl;
}

// --- Orca CLI (multi-tab) --------------------------------------------------
// The CDP proxy only ever exposes the ACTIVE tab. Orca's own CLI, however, can
// list every open tab and address any of them by browserPageId. We leverage it
// to (a) switch which tab is active before attaching Playwright, and (b) drive
// multiple tabs concurrently via Orca's native browser commands (orcaTabs()).
function orcaCli(args) {
  // 64MB buffer: `screenshot` returns base64 image data that easily exceeds
  // execFileSync's 1MB default (ENOBUFS) for a tall/retina page.
  const out = execFileSync('orca', [...args, '--json'],
    { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  try { return JSON.parse(out); } catch (_) { return out; }
}

// Async variant — lets us fan out CLI calls across tabs with Promise.all for
// genuine wall-clock concurrency (the sync orcaCli above blocks per call).
async function orcaCliAsync(args) {
  const { stdout } = await execFileP('orca', [...args, '--json'], { maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(stdout); } catch (_) { return stdout; }
}

/**
 * List all open Orca browser tabs: [{index, browserPageId, url, active,
 * profileId, profileLabel, worktreeId}]. Pass a worktree selector (or 'all') to
 * scope the listing — Orca defaults to the current worktree's tabs otherwise.
 */
function orcaTabList(worktree) {
  const args = ['tab', 'list'];
  if (worktree) args.push('--worktree', worktree);
  return orcaCli(args).result.tabs;
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
    const pageId = tabs[idx].browserPageId;
    execFileSync('orca', ['tab', 'switch', '--index', String(idx), '--json'], { stdio: 'ignore' });
    // Poll until the tab actually reports active (the CDP proxy re-points then),
    // with backoff — faster when it's quick, patient when it's slow.
    await pollFor(() => {
      const now = orcaTabList().find((t) => t.browserPageId === pageId);
      return now && now.active;
    }, { tries: 30, startMs: 40, maxMs: 300 });
  }
  return tabs[idx];
}

/**
 * Concurrent multi-tab driver using Orca's NATIVE CLI (not Playwright). Each
 * tab is addressed by browserPageId via `orca <cmd> --page <id>`, so you can
 * drive several open tabs in parallel — the thing the single-target CDP proxy
 * cannot do. Lower-level than Playwright, but concurrent, and it mirrors Orca's
 * full browser verb set (read / navigate / interact).
 *
 *   const tabs = orcaTabs();
 *   tabs.list;                                 // [{index, pageId, url, active}]
 *   const t = tabs.tab(/wikipedia/);
 *   t.eval('document.title');
 *   t.get('text', 'e3');                       // element text from a snapshot ref
 *   t.is('visible', 'e3');                     // -> boolean
 *   t.fill('e5', 'query'); t.click('e6');
 *   tabs.all().map(x => x.eval('location.href'));   // every tab, no switching
 */
function orcaTabs(opts = {}) {
  // Run an Orca browser command against one page; return its `result` payload.
  const run = (pageId, args) => {
    const r = orcaCli([...args, '--page', pageId]);
    return r && typeof r === 'object' && 'result' in r ? r.result : r;
  };
  const driver = (pageId, url) => ({
    pageId,
    url,
    // --- read ---------------------------------------------------------------
    eval(js) { return run(pageId, ['eval', '--expression', js])?.result; },
    snapshot() { return run(pageId, ['snapshot']); },
    screenshot(format) { return run(pageId, format ? ['screenshot', '--format', format] : ['screenshot']); },
    /** element/page property: what ∈ text|html|value|url|title (ref optional for url/title). */
    get(what, ref) { return run(pageId, ref ? ['get', '--what', what, '--element', ref] : ['get', '--what', what])?.[what]; },
    /** element state: what ∈ visible|enabled|checked. Returns a boolean. */
    is(what, ref) { return run(pageId, ['is', '--what', what, '--element', ref])?.[what]; },
    // --- navigate -----------------------------------------------------------
    goto(u) { return run(pageId, ['goto', '--url', u]); },
    back() { return run(pageId, ['back']); },
    forward() { return run(pageId, ['forward']); },
    reload() { return run(pageId, ['reload']); },
    // --- interact -----------------------------------------------------------
    click(ref) { return run(pageId, ['click', '--element', ref]); },
    dblclick(ref) { return run(pageId, ['dblclick', '--element', ref]); },
    hover(ref) { return run(pageId, ['hover', '--element', ref]); },
    focus(ref) { return run(pageId, ['focus', '--element', ref]); },
    fill(ref, value) { return run(pageId, ['fill', '--element', ref, '--value', value]); },
    clear(ref) { return run(pageId, ['clear', '--element', ref]); },
    select(ref, value) { return run(pageId, ['select', '--element', ref, '--value', value]); },
    check(ref) { return run(pageId, ['check', '--element', ref]); },
    uncheck(ref) { return run(pageId, ['uncheck', '--element', ref]); },
    type(text) { return run(pageId, ['type', '--input', text]); },
    inserttext(text) { return run(pageId, ['inserttext', '--input', text]); },
    keypress(key) { return run(pageId, ['keypress', '--key', key]); },
    scroll(direction, amount) { return run(pageId, amount != null ? ['scroll', '--direction', direction, '--amount', String(amount)] : ['scroll', '--direction', direction]); },
    scrollIntoView(ref) { return run(pageId, ['scrollintoview', '--element', ref]); },
    drag(from, to) { return run(pageId, ['drag', '--from', from, '--to', to]); },
    upload(ref, files) { return run(pageId, ['upload', '--element', ref, '--files', Array.isArray(files) ? files.join(',') : files]); },
    wait(timeoutMs) { return run(pageId, timeoutMs != null ? ['wait', '--timeout', String(timeoutMs)] : ['wait']); },
    // --- emulate (Orca's native `set` primitives; per-tab) -------------------
    /** Emulate a named device, e.g. 'iPhone 12' — sets viewport + mobile UA. */
    setDevice(name) { return run(pageId, ['set', 'device', '--name', name]); },
    /** Toggle network offline. `on` truthy => offline. */
    setOffline(on = true) { return run(pageId, ['set', 'offline', '--state', on ? 'on' : 'off']); },
    /** Extra HTTP request headers, e.g. { 'X-Test': '1' }. */
    setHeaders(headers) { return run(pageId, ['set', 'headers', '--headers', JSON.stringify(headers)]); },
    /** HTTP basic-auth credentials for the tab. */
    setCredentials(user, pass) { return run(pageId, ['set', 'credentials', '--user', user, '--pass', pass]); },
    /** Media prefs: { colorScheme?: 'dark'|'light', reducedMotion?: 'reduce'|'no-preference' }. */
    setMedia({ colorScheme, reducedMotion } = {}) {
      const args = ['set', 'media'];
      if (colorScheme) args.push('--color-scheme', colorScheme);
      if (reducedMotion) args.push('--reduced-motion', reducedMotion);
      return run(pageId, args);
    },
    // --- semantic locators (Orca 1.4.114+) ----------------------------------
    /**
     * Find an element by a semantic locator and act on it in one call — like
     * Playwright's getByRole(...).click(). Unlike snapshot refs (e1, e2…),
     * semantic locators survive navigation.
     * @param {'role'|'text'|'label'} locator
     * @param {string} value  the locator match (e.g. 'button', 'Save')
     * @param {object} [opts] { action='click', text } — text is the fill/type payload
     */
    find(locator, value, { action = 'click', text } = {}) {
      const args = ['find', '--locator', locator, '--value', value, '--action', action];
      if (text != null) args.push('--text', text);
      return run(pageId, args);
    },
    // --- low-level mouse (Orca 1.4.114+ completes up/wheel) ------------------
    mouseMove(x, y) { return run(pageId, ['mouse', 'move', '--x', String(x), '--y', String(y)]); },
    mouseDown() { return run(pageId, ['mouse', 'down']); },
    mouseUp() { return run(pageId, ['mouse', 'up']); },
    mouseWheel(dy, dx = 0) { return run(pageId, ['mouse', 'wheel', '--dy', String(dy), '--dx', String(dx)]); },
    /** Bring this tab to the foreground (make it the active, focused tab). */
    activate() { return run(pageId, ['tab', 'switch', '--focus']); },
    // --- Orca 1.4.117+ -------------------------------------------------------
    /** Accept a pending JS dialog (alert/confirm/prompt); `text` answers a prompt. */
    acceptDialog(text) { return run(pageId, text != null ? ['dialog', 'accept', '--text', text] : ['dialog', 'accept']); },
    /** Dismiss a pending JS dialog (no-ops gracefully if none is open). */
    dismissDialog() { return run(pageId, ['dialog', 'dismiss']); },
    /** Read a storage value by key. opts.session → sessionStorage (default localStorage). */
    getStorage(key, { session } = {}) { return run(pageId, ['storage', session ? 'session' : 'local', 'get', '--key', key])?.value; },
    setStorage(key, value, { session } = {}) { return run(pageId, ['storage', session ? 'session' : 'local', 'set', '--key', key, '--value', value]); },
    clearWebStorage({ session } = {}) { return run(pageId, ['storage', session ? 'session' : 'local', 'clear']); },
    /** Outline an element on the page (by CSS selector) — handy for demos/debugging. */
    highlight(selector) { return run(pageId, ['highlight', '--selector', selector]); },
    /** Download the file behind `selector` to `path`. */
    download(selector, path) { return run(pageId, ['download', '--selector', selector, '--path', path]); },
    /** Escape hatch: run any raw agent-browser command string against this tab. */
    exec(command) { return run(pageId, ['exec', '--command', command]); },
  });
  const tabs = orcaTabList(opts.worktree);
  return {
    list: tabs.map((t) => ({
      index: t.index, pageId: t.browserPageId, url: t.url, active: !!t.active,
      profileId: t.profileId, profileLabel: t.profileLabel, worktreeId: t.worktreeId,
    })),
    tab(match) {
      const re = match instanceof RegExp ? match : new RegExp(match);
      const t = tabs.find((x) => re.test(x.url));
      if (!t) throw new Error(`No open Orca tab matches ${match}`);
      return driver(t.browserPageId, t.url);
    },
    byId: (pageId) => driver(pageId),
    all: () => tabs.map((t) => driver(t.browserPageId, t.url)),
    /**
     * Evaluate `js` in EVERY open tab, genuinely concurrently (async CLI +
     * Promise.all — unlike the per-verb driver methods, which are synchronous
     * and therefore serial). Resolves to [{ pageId, url, value }].
     */
    async evalAll(js) {
      return Promise.all(tabs.map(async (t) => {
        const r = await orcaCliAsync(['eval', '--expression', js, '--page', t.browserPageId]);
        return { pageId: t.browserPageId, url: t.url, value: r && r.result ? r.result.result : undefined };
      }));
    },
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
  const base = opts.cdpUrl || (opts.tab ? await findCdpUrlForTab(opts.tab) : await discoverCdpUrl());
  if (!base) throw new Error('No Orca CDP endpoint. Is a browser tab open in Orca?');
  const upstreamPort = Number(base.split(':').pop());

  const targets = await httpGetJson(upstreamPort, '/json/list');
  if (!targets.length) throw new Error('Orca CDP exposes no targets (open a tab in Orca).');
  let target = targets[0];
  if (opts.match) {
    const re = opts.match instanceof RegExp ? opts.match : new RegExp(opts.match);
    target = targets.find((t) => re.test(t.url)) || target;
  }
  const upstreamWsUrl = target.webSocketDebuggerUrl;
  const proxyFrameId = target.id; // the targetId Playwright sees == the frame id it assumes

  // Pre-fetch /json/version once so the request handler can stay synchronous
  // (Playwright hits it during connectOverCDP; a per-request upstream call would
  // add a round-trip and force an async handler).
  const versionInfo = await httpGetJson(upstreamPort, '/json/version').catch(() => ({}));

  let bridgePort;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const path = req.url.replace(/\/+$/, '') || '/'; // tolerate trailing slash
    if (path === '/json/version') {
      const v = { ...versionInfo, webSocketDebuggerUrl: `ws://127.0.0.1:${bridgePort}/devtools/browser/orca` };
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
    // Playwright assumes the main frame uses. Walks objects; touches `frameId`,
    // parent-reference keys (`parentId` in getFrameTree childFrames,
    // `parentFrameId` in Page.frameAttached), and the `id` of frame-shaped
    // objects — never `targetId`. Rewriting the parent refs is what lets child
    // <iframe>s attach to the main frame Playwright knows (else they orphan).
    const swapFrameIds = (obj, fromId, toId) => {
      if (!fromId || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { for (const v of obj) swapFrameIds(v, fromId, toId); return; }
      const frameShaped = ('url' in obj) || ('loaderId' in obj) || ('mimeType' in obj);
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string') {
          if ((k === 'frameId' || k === 'parentId' || k === 'parentFrameId') && v === fromId) obj[k] = toId;
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
 * @param {object} [opts] forwarded to startBridge (cdpUrl, tab, match)
 * @param {object} [opts.connectOptions] override the options passed to
 *   connectOverCDP. Defaults to `{ isLocal: true, noDefaults: true }` —
 *   isLocal enables same-host filesystem optimizations, and noDefaults stops
 *   Playwright from stamping its download/focus/media overrides onto Orca's
 *   live browser (these are off by default in Playwright; on for daily-driver
 *   attach, which Orca's embedded browser effectively is).
 * @returns {Promise<{browser, context, page, bridge, close}>}
 *   close() detaches Playwright and stops the bridge — it does NOT quit Orca.
 */
async function connectOrcaPlaywright(opts = {}) {
  const bridge = await startBridge(opts);
  const chromium = loadChromium();
  const connectOptions = { isLocal: true, noDefaults: true, ...(opts.connectOptions || {}) };
  let browser;
  try {
    browser = await chromium.connectOverCDP(bridge.url, connectOptions);
  } catch (_) {
    // Older playwright-core predates isLocal/noDefaults — fall back to a bare connect.
    browser = await chromium.connectOverCDP(bridge.url);
  }
  const context = browser.contexts()[0] || null;
  let page = null;
  for (let i = 0; i < 40 && (!context || context.pages().length === 0); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  page = context ? context.pages()[0] || null : null;
  // Safe reload. On Orca >= 1.4.120, native page.reload() works upstream
  // (stablyai/orca#7031), so prefer it. On older Orca (or if the version can't
  // be read and the native call fails) fall back to re-navigating the current
  // URL — a true document reload that keeps the tab and the bridge alive
  // (Playwright's page.reload() tore the tab down through the proxy back then).
  const reload = async ({ waitUntil = 'load' } = {}) => {
    if (!page) throw new Error('no page to reload');
    const v = orcaVersion();
    if (v && versionGte(v, '1.4.120')) {
      try { return await page.reload({ waitUntil }); } catch (_) { /* fall back */ }
    }
    return page.goto(page.url(), { waitUntil });
  };
  const close = async () => {
    try { await browser.close(); } catch (_) { /* ignore */ }
    try { await bridge.close(); } catch (_) { /* ignore */ }
  };
  return { browser, context, page, bridge, reload, close };
}

/**
 * Resolve the `--profile` id to open a tab with, honoring isolation options.
 *   - opts.profile   use this existing profile id verbatim.
 *   - opts.isolated  create a FRESH isolated profile (its own storage partition —
 *                    isolation fixed upstream in Orca 1.4.123, stablyai/orca#6923)
 *                    and use it. A string value becomes the profile label.
 * Returns { profileId, createdProfileId } — createdProfileId is set only when we
 * created one, so the caller can delete it on close.
 */
function resolveTabProfile(opts = {}) {
  if (opts.isolated) {
    const label = typeof opts.isolated === 'string' ? opts.isolated : `opb-${process.pid}-${Date.now()}`;
    const r = orcaCli(['tab', 'profile', 'create', '--label', label, '--scope', 'isolated']);
    const id = r && r.result && r.result.profile && r.result.profile.id;
    if (!id) throw new Error('Failed to create an isolated browser profile.');
    return { profileId: id, createdProfileId: id };
  }
  if (opts.profile) return { profileId: opts.profile, createdProfileId: null };
  return { profileId: null, createdProfileId: null };
}

/**
 * Resolve the CDP endpoint for `pageId`, waking the tab if needed. Orca reclaims
 * the CDP debug port of a tab whose renderer has been backgrounded and left idle
 * — so a pre-existing/idle tab can be *listed* yet expose no endpoint. When that
 * happens (and `activate !== false`) we focus the tab to revive its renderer and
 * poll until its port reappears, so attaching to a dormant tab "just works".
 * @returns {Promise<CdpEndpoint>}
 */
async function resolveEndpointForPageId(pageId, { preferNotIn, activate = true, timeoutMs = 15000 } = {}) {
  let ep = await findEndpointForPageId(pageId, preferNotIn); // throws if the tab doesn't exist at all
  if (ep) return ep;
  // Listed but no endpoint → an idle/backgrounded tab whose debug port Orca reclaimed.
  if (!activate) {
    throw new Error(
      `Tab ${pageId} is open but exposes no CDP endpoint — it's likely idle/backgrounded ` +
      `(Orca reclaims the debug port of dormant tabs). Activate it first ` +
      `(orca tab switch --page ${pageId} --focus), or call attachOrcaTab without { activate: false }.`);
  }
  try { execFileSync('orca', ['tab', 'switch', '--page', pageId, '--focus', '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ }
  const tries = Math.max(1, Math.ceil(timeoutMs / 400));
  ep = await pollFor(async () => {
    try { return await findEndpointForPageId(pageId, preferNotIn); } catch (_) { return null; }
  }, { tries, startMs: 100, maxMs: 600 });
  if (!ep) throw new Error(`Tab ${pageId} is open but never exposed a CDP endpoint, even after activating it.`);
  return ep;
}

/**
 * Attach Playwright to the tab that owns `pageId` and decorate the connection:
 *   - `browserPageId`   the tab it's pinned to
 *   - `reattach()`      rebuild a fresh connection to the SAME tab — the remedy
 *                       for the "one client per tab" trap (attaching another
 *                       client kills the current one). Returns a new conn; use it
 *                       in place of the dead one: `conn = await conn.reattach()`.
 *   - `close()`         detaches; also closes the tab (and deletes a profile we
 *                       created for it) when this connection owns them.
 * When `activate` (default true), an idle tab with no live endpoint is focused to
 * wake it before attaching (see resolveEndpointForPageId).
 */
async function _attachExisting(pageId, { closesTab = false, profileToDelete = null, connectOpts = {}, preferNotIn, activate = true } = {}) {
  const ep = await resolveEndpointForPageId(pageId, { preferNotIn, activate });
  const conn = await connectOrcaPlaywright({ ...connectOpts, cdpUrl: ep.cdpUrl });
  conn.browserPageId = pageId;
  const baseClose = conn.close;
  conn.close = async () => {
    await baseClose();
    if (closesTab) {
      try { execFileSync('orca', ['tab', 'close', '--page', pageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ }
    }
    if (profileToDelete) {
      try { execFileSync('orca', ['tab', 'profile', 'delete', '--profile', profileToDelete, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ }
    }
  };
  // Rebuild against the same tab. Free THIS connection's bridge/browser first
  // (but NOT the tab) so a `conn = await conn.reattach()` leaves no orphaned
  // bridge server behind.
  conn.reattach = async () => {
    try { await conn.browser.close(); } catch (_) { /* client already dead */ }
    try { await conn.bridge.close(); } catch (_) { /* already stopped */ }
    return _attachExisting(pageId, { closesTab, profileToDelete, connectOpts, activate });
  };
  return conn;
}

/**
 * Open a NEW Orca tab and attach Playwright to it — the `newPage` equivalent.
 * Uses `orca tab create` (Playwright itself can't, the proxy rejects
 * Target.createTarget), then pins to the freshly-created tab by its
 * browserPageId (multi-session safe — a bare port-diff could grab another
 * session's tab).
 * @param {string} url
 * @param {object} [opts] {profile?: string, isolated?: boolean|string, focus?: boolean, connectOptions?: object}
 *   profile   — open the tab in this existing profile id.
 *   isolated  — open in a fresh isolated profile (own storage; deleted on close).
 *               A string value names the profile. Overrides `profile`.
 *   focus     — (default true) foreground the tab so you can watch; false for
 *               background automation.
 * @returns {Promise<{browser, context, page, bridge, reload, close, reattach, browserPageId, profileId}>}
 *   close() also closes the Orca tab (and deletes an isolated profile it created).
 */
async function openOrcaTab(url, opts = {}) {
  const before = new Set((await discoverAllCdpEndpoints()).map((e) => e.port));
  const { profileId, createdProfileId } = resolveTabProfile(opts);
  const cleanupProfile = () => {
    if (createdProfileId) { try { execFileSync('orca', ['tab', 'profile', 'delete', '--profile', createdProfileId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ } }
  };

  const args = ['tab', 'create', '--url', url];
  if (profileId) args.push('--profile', profileId);
  let browserPageId = null;
  try {
    const out = execFileSync('orca', [...args, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    browserPageId = JSON.parse(out).result.browserPageId;
  } catch (e) { cleanupProfile(); throw e; }
  if (!browserPageId) { cleanupProfile(); throw new Error('orca tab create did not return a browserPageId.'); }

  // Bring the tab to the foreground (Orca opens it in the background otherwise).
  if (opts.focus !== false) {
    try { execFileSync('orca', ['tab', 'switch', '--page', browserPageId, '--focus', '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ }
  }

  // Wait (with backoff) until this exact tab exposes its CDP endpoint, joined on
  // its browserPageId so concurrent opens never cross-wire.
  const ep = await pollFor(async () => {
    try { return await findEndpointForPageId(browserPageId, before); } catch (_) { return null; }
  }, { tries: 30, startMs: 100, maxMs: 500 });
  if (!ep) { cleanupProfile(); throw new Error('Opened an Orca tab but it never exposed a CDP endpoint.'); }

  const conn = await _attachExisting(browserPageId, {
    closesTab: true, profileToDelete: createdProfileId,
    connectOpts: opts.connectOptions ? { connectOptions: opts.connectOptions } : {},
    preferNotIn: before,
  });
  conn.profileId = profileId || 'default';
  return conn;
}

/**
 * Re-attach Playwright to a tab you ALREADY own, by its browserPageId — the
 * multi-session-safe way to reconnect. Unlike default discovery (which grabs
 * whatever tab is active/first, so a second session steals the first's tab),
 * this pins to the exact tab regardless of which one is focused. Use the
 * `browserPageId` returned by a prior openOrcaTab() / from orcaTabs().list.
 * If the tab is idle/backgrounded and has no live CDP endpoint, it is focused to
 * wake it first (Orca reclaims dormant tabs' debug ports) — pass `{ activate:
 * false }` to opt out and get a clear error instead of stealing focus.
 * @param {string} pageId  the tab's browserPageId
 * @param {object} [opts] {activate?: boolean} + forwarded to connectOrcaPlaywright (connectOptions, …)
 * @returns {Promise<{browser, context, page, bridge, reload, close, reattach, browserPageId}>}
 *   close() detaches the bridge but LEAVES the tab open (you didn't create it here).
 */
async function attachOrcaTab(pageId, opts = {}) {
  const { activate = true, ...connectOpts } = opts;
  return _attachExisting(pageId, { closesTab: false, connectOpts, activate });
}

/**
 * Run `action` (which should open a new tab/window — e.g. clicking a
 * `target=_blank` link) and return a driver for the tab it spawns.
 *
 * Page-spawned popups open as a separate Orca tab (not a Playwright `popup`
 * event) and — unlike `orca tab create` tabs — Orca exposes **no CDP endpoint**
 * for them, so Playwright can't attach. They ARE addressable by browserPageId,
 * so this returns the native `orcaTabs()` driver for the popup instead.
 * @param {() => any} action  triggers the new tab (its promise is awaited)
 * @param {object} [opts] { timeout=10000 }
 * @returns {Promise<{pageId, url, tab, close}>} `tab` is an orcaTabs() driver; close() closes the popup.
 */
async function waitForNewTab(action, { timeout = 10000 } = {}) {
  const beforeIds = new Set(orcaTabList().map((t) => t.browserPageId));
  await action();
  let found = null;
  const deadline = Date.now() + timeout;
  while (!found && Date.now() < deadline) {
    await sleep(300);
    found = orcaTabList().find((t) => !beforeIds.has(t.browserPageId));
  }
  if (!found) throw new Error('waitForNewTab: no new tab appeared after the action.');
  return {
    pageId: found.browserPageId,
    url: found.url,
    tab: orcaTabs().byId(found.browserPageId), // native driver — popups have no CDP endpoint for Playwright
    close() { try { execFileSync('orca', ['tab', 'close', '--page', found.browserPageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* best effort */ } },
  };
}

module.exports = {
  startBridge, connectOrcaPlaywright, openOrcaTab, attachOrcaTab, waitForNewTab, loadChromium, discoverCdpUrl,
  discoverAllCdpEndpoints, findCdpUrlForTab, findEndpointForPageId, resolveEndpointForPageId,
  orcaTabs, orcaTabList, switchToOrcaTab,
  orcaVersion, versionGte,
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
