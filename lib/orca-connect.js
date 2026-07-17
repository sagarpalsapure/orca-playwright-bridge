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

const { execSync, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// GET a small text body over HTTP via Node core — no `curl` binary needed.
function httpGetText(port, urlPath, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Discover Orca's CDP base URL (e.g. http://127.0.0.1:65279). Throws if none. */
async function discoverCdpUrl() {
  if (process.env.ORCA_CDP_URL) return process.env.ORCA_CDP_URL.trim();
  try {
    const out = execSync('orca-cdp -q', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out;
  } catch (_) { /* fall through */ }
  const url = await scanForCdp();
  if (url) return url;
  throw new Error(
    'Could not find an Orca CDP endpoint. Is Orca running? ' +
    'Try `orca status` / `orca-cdp`, or set ORCA_CDP_URL manually.'
  );
}

async function scanForCdp() {
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
  // Probe candidate ports concurrently via native http (no curl spawn).
  const hits = await Promise.all([...ports].map(async (port) => {
    try {
      const body = await httpGetText(port, '/json/version', { timeoutMs: 2000 });
      return body.includes('webSocketDebuggerUrl') ? `http://127.0.0.1:${port}` : null;
    } catch (_) { return null; }
  }));
  return hits.find(Boolean) || null;
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

// Device presets for emulate({ device }). width/height are CSS px.
const DEVICES = {
  'iPhone 12': { width: 390, height: 844, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1' },
  'iPhone SE': { width: 375, height: 667, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1' },
  'Pixel 5': { width: 393, height: 851, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0 Mobile Safari/537.36' },
  'iPad Pro 11': { width: 834, height: 1194, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1' },
};

// Network throttling presets (throughput in bytes/sec).
const NET_PRESETS = {
  'slow-3g': { latency: 400, download: (400 * 1024) / 8, upload: (400 * 1024) / 8 },
  'fast-3g': { latency: 150, download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8 },
  'offline': { offline: true },
};

// Encode numbered screencast frames to a video/GIF via ffmpeg. `writeFrames(dir)`
// materializes frame-NNNN.<ext> files into `dir`; we clean up the temp dir after.
function framesToMedia(writeFrames, ext, outPath, { fps, gif }) {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch (_) { throw new Error('ffmpeg not found on PATH — install it to encode screencast frames, or use save(dir) and encode yourself.'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-screencast-'));
  try {
    const written = writeFrames(dir);
    if (!written.length) throw new Error('no screencast frames captured to encode.');
    const input = path.join(dir, `frame-%04d.${ext}`);
    const args = gif
      ? ['-y', '-framerate', String(fps), '-i', input,
        '-vf', 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', outPath]
      : ['-y', '-framerate', String(fps), '-i', input,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', outPath];
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return outPath;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

/**
 * Connect to Orca's embedded browser over raw CDP.
 *
 * Orca's proxy advertises ~35 CDP domains, and — unlike Playwright's blocked
 * newCDPSession — the page socket answers almost all of them. The helpers below
 * wrap the high-value ones (console/network capture, emulation, cookies,
 * a11y/perf, full-page & MHTML capture). Anything else is one `client.send()`.
 *
 * @param {object} [opts]
 * @param {string} [opts.cdpUrl]      override discovery
 * @param {RegExp|string} [opts.match] pick a target whose url matches (default: first)
 * @param {string[]} [opts.domains]   extra CDP domains to enable (Page/Runtime/DOM always on)
 * @returns {Promise<object>} { client, cdpUrl, target, evaluate, goto, screenshot,
 *   captureConsole, recordNetwork, throttle, offline, cookies, setCookie, clearCookies,
 *   emulate, clearEmulation, fullPageScreenshot, captureMHTML, pdf, axTree, metrics, close }
 */
async function connectOrca(opts = {}) {
  const cdpUrl = opts.cdpUrl || await discoverCdpUrl();
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

  // --- capture: console + JS errors ----------------------------------------
  /** Start collecting console messages + uncaught exceptions. Returns { messages, stop }. */
  function captureConsole() {
    const messages = [];
    const onLog = (e) => messages.push({
      type: e.type,
      text: (e.args || []).map((a) => (a.value !== undefined ? a.value : a.description) ?? '').join(' '),
    });
    const onExc = (e) => messages.push({
      type: 'error',
      text: e.exceptionDetails?.exception?.description || e.exceptionDetails?.text || 'uncaught exception',
    });
    client.on('Runtime.consoleAPICalled', onLog);
    client.on('Runtime.exceptionThrown', onExc);
    return { messages, stop() { client.off('Runtime.consoleAPICalled', onLog); client.off('Runtime.exceptionThrown', onExc); } };
  }

  // --- capture: network -----------------------------------------------------
  /**
   * Start collecting request/response events. Returns { events, har(), stop }.
   * `har()` builds a HAR 1.2 log from what's been captured so far — openable in
   * any HAR viewer / Chrome DevTools.
   * @param {object} [opts]
   * @param {boolean} [opts.bodies=false]  also fetch response bodies (via
   *   Network.getResponseBody, as each request finishes) so the HAR carries
   *   `content.text` — a fully replayable archive. Off by default: bodies add a
   *   round-trip per request and aren't retained for every resource type.
   */
  async function recordNetwork({ bodies = false } = {}) {
    await client.send('Network.enable');
    const events = [];
    const byId = new Map();   // requestId -> partial HAR entry data
    const hdrs = (o) => Object.entries(o || {}).map(([name, value]) => ({ name, value: String(value) }));

    const onReq = (e) => {
      events.push({ phase: 'request', id: e.requestId, method: e.request.method, url: e.request.url });
      byId.set(e.requestId, { req: e.request, sendTs: e.timestamp, wallTime: e.wallTime });
    };
    const onRes = (e) => {
      events.push({ phase: 'response', id: e.requestId, status: e.response.status, mimeType: e.response.mimeType, url: e.response.url });
      const d = byId.get(e.requestId); if (d) { d.res = e.response; }
    };
    const onFin = async (e) => {
      const d = byId.get(e.requestId); if (!d) return;
      d.finishTs = e.timestamp; d.size = e.encodedDataLength;
      if (bodies) {
        // Must be fetched before the body is evicted — do it as the request ends.
        try {
          const b = await client.send('Network.getResponseBody', { requestId: e.requestId });
          d.body = b.body; d.bodyBase64 = !!b.base64Encoded;
        } catch (_) { /* body unavailable (redirect, no content, evicted) */ }
      }
    };
    const onFail = (e) => { events.push({ phase: 'failed', id: e.requestId, error: e.errorText }); const d = byId.get(e.requestId); if (d) { d.failed = e.errorText; d.finishTs = e.timestamp; } };

    client.on('Network.requestWillBeSent', onReq);
    client.on('Network.responseReceived', onRes);
    client.on('Network.loadingFinished', onFin);
    client.on('Network.loadingFailed', onFail);

    return {
      events,
      /** Build a HAR 1.2 log from captured traffic. */
      har() {
        const entries = [];
        for (const d of byId.values()) {
          if (!d.req) continue;
          const q = [];
          try { new URL(d.req.url).searchParams.forEach((value, name) => q.push({ name, value })); } catch (_) { /* ignore */ }
          const time = d.finishTs && d.sendTs ? Math.max(0, (d.finishTs - d.sendTs) * 1000) : -1;
          const content = { size: d.size || 0, mimeType: (d.res && d.res.mimeType) || '' };
          if (d.body != null) {
            content.text = d.body;
            if (d.bodyBase64) content.encoding = 'base64';
          }
          entries.push({
            startedDateTime: d.wallTime ? new Date(d.wallTime * 1000).toISOString() : new Date(0).toISOString(),
            time,
            request: { method: d.req.method, url: d.req.url, httpVersion: 'HTTP/1.1', headers: hdrs(d.req.headers), queryString: q, cookies: [], headersSize: -1, bodySize: d.req.postData ? d.req.postData.length : 0 },
            response: d.res
              ? { status: d.res.status, statusText: d.res.statusText || '', httpVersion: d.res.protocol || 'HTTP/1.1', headers: hdrs(d.res.headers), cookies: [], content, redirectURL: '', headersSize: -1, bodySize: d.size || -1 }
              : { status: 0, statusText: d.failed || 'failed', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
            cache: {},
            timings: { send: 0, wait: time >= 0 ? time : 0, receive: 0 },
          });
        }
        return { log: { version: '1.2', creator: { name: 'orca-playwright-bridge', version: require('../package.json').version }, entries } };
      },
      stop() { client.off('Network.requestWillBeSent', onReq); client.off('Network.responseReceived', onRes); client.off('Network.loadingFinished', onFin); client.off('Network.loadingFailed', onFail); },
    };
  }

  /** Emulate network conditions: 'slow-3g' | 'fast-3g' | 'offline' | custom {latency,download,upload}. */
  async function throttle(preset = 'slow-3g') {
    const c = typeof preset === 'string' ? NET_PRESETS[preset] : preset;
    if (!c) throw new Error(`unknown throttle preset: ${preset}`);
    await client.send('Network.enable');
    return client.send('Network.emulateNetworkConditions', {
      offline: !!c.offline, latency: c.latency || 0,
      downloadThroughput: c.download != null ? c.download : -1,
      uploadThroughput: c.upload != null ? c.upload : -1,
    });
  }
  async function offline(on = true) {
    await client.send('Network.enable');
    return client.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  /**
   * Block requests matching any pattern, via CDP `Fetch`. This works for real
   * requests — unlike Playwright's `route.continue()/abort()`, which hangs
   * through the bridge (its Network↔Fetch correlation breaks across the proxy).
   * @param {Array<string|RegExp|((url:string)=>boolean)>} patterns  substring, RegExp, or predicate
   * @returns {Promise<{counts:{blocked:number,allowed:number}, stop:()=>Promise<void>}>}
   */
  async function blockRequests(patterns) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const match = (url) => list.some((p) => (typeof p === 'function' ? p(url) : p instanceof RegExp ? p.test(url) : url.includes(p)));
    const counts = { blocked: 0, allowed: 0 };
    const handler = async (e) => {
      try {
        if (match(e.request.url)) { counts.blocked++; await client.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' }); }
        else { counts.allowed++; await client.send('Fetch.continueRequest', { requestId: e.requestId }); }
      } catch (_) { /* request already resolved */ }
    };
    client.on('Fetch.requestPaused', handler);
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    return { counts, async stop() { client.off('Fetch.requestPaused', handler); await client.send('Fetch.disable').catch(() => {}); } };
  }

  /**
   * Mock the response for requests matching any pattern, via CDP `Fetch` —
   * matched requests are fulfilled with your response, the rest pass through.
   * Reliable for real requests (Playwright's route.continue hangs through the
   * bridge; this uses Fetch.fulfillRequest/continueRequest directly).
   * @param {Array<string|RegExp|((url:string)=>boolean)>} patterns
   * @param {{status?:number, contentType?:string, headers?:Record<string,string>, body?:string}} [response]
   * @returns {Promise<{counts:{mocked:number,passed:number}, stop:()=>Promise<void>}>}
   */
  async function mockResponse(patterns, response = {}) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const match = (url) => list.some((p) => (typeof p === 'function' ? p(url) : p instanceof RegExp ? p.test(url) : url.includes(p)));
    const status = response.status || 200;
    const body = response.body != null ? Buffer.from(response.body).toString('base64') : undefined;
    const hdrObj = response.headers || { 'content-type': response.contentType || 'text/html; charset=utf-8' };
    const responseHeaders = Object.entries(hdrObj).map(([name, value]) => ({ name, value: String(value) }));
    const counts = { mocked: 0, passed: 0 };
    const handler = async (e) => {
      try {
        if (match(e.request.url)) { counts.mocked++; await client.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: status, responseHeaders, ...(body !== undefined ? { body } : {}) }); }
        else { counts.passed++; await client.send('Fetch.continueRequest', { requestId: e.requestId }); }
      } catch (_) { /* request already resolved */ }
    };
    client.on('Fetch.requestPaused', handler);
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    return { counts, async stop() { client.off('Fetch.requestPaused', handler); await client.send('Fetch.disable').catch(() => {}); } };
  }

  // --- cookies --------------------------------------------------------------
  async function cookies(urls) {
    await client.send('Network.enable');
    if (urls) return (await client.send('Network.getCookies', { urls: [].concat(urls) })).cookies;
    return (await client.send('Network.getAllCookies')).cookies;
  }
  async function setCookie(cookie) { await client.send('Network.enable'); return client.send('Network.setCookie', cookie); }
  async function clearCookies() { await client.send('Network.enable'); return client.send('Network.clearBrowserCookies'); }

  // --- emulation (instant; no reload) --------------------------------------
  /** @param {object} o { device, timezone, locale, cpu (throttle rate), colorScheme } */
  async function emulate({ device, timezone, locale, cpu, colorScheme } = {}) {
    if (device) {
      const d = DEVICES[device] || device;
      await client.send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.dpr || 2, mobile: !!d.mobile });
      if (d.ua) await client.send('Emulation.setUserAgentOverride', { userAgent: d.ua });
    }
    if (timezone) await client.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
    if (locale) await client.send('Emulation.setLocaleOverride', { locale });
    if (cpu) await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    if (colorScheme) await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
  }
  async function clearEmulation() {
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await client.send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
    await client.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
    await client.send('Emulation.setLocaleOverride', {}).catch(() => {});
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] }).catch(() => {});
  }

  // --- capture: full page & MHTML ------------------------------------------
  /**
   * Screenshot the FULL page (beyond the viewport). Dimensions are capped at
   * Chrome's 16384px limit — past it, `Page.captureScreenshot` silently returns
   * empty data, so on an ultra-tall page this captures the top 16384px rather
   * than nothing.
   */
  async function fullPageScreenshot(path, { format = 'png' } = {}) {
    const MAX = 16384;
    const m = await client.send('Page.getLayoutMetrics');
    const size = m.cssContentSize || m.contentSize;
    const width = Math.min(MAX, Math.ceil(size.width));
    const height = Math.min(MAX, Math.ceil(size.height));
    const { data } = await client.send('Page.captureScreenshot', {
      format, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const buf = Buffer.from(data, 'base64');
    if (path) fs.writeFileSync(path, buf);
    return buf;
  }
  /** Save the page as a single-file MHTML archive. */
  async function captureMHTML(path) {
    const { data } = await client.send('Page.captureSnapshot', { format: 'mhtml' });
    if (path) fs.writeFileSync(path, data);
    return data;
  }

  /**
   * Print the page to PDF via `Page.printToPDF`. This was absent from the proxy
   * until Orca 1.4.123 fixed it (stablyai/orca#7032) — on older Orca use
   * `fullPageScreenshot()` or `captureMHTML()` instead. Options pass straight to
   * CDP (printBackground, landscape, scale, paperWidth/Height, margin*, etc.).
   */
  async function pdf(path, opts = {}) {
    const { data } = await client.send('Page.printToPDF', { printBackground: true, ...opts });
    const buf = Buffer.from(data, 'base64');
    if (path) fs.writeFileSync(path, buf);
    return buf;
  }

  /**
   * Record the page as a screencast (a stream of frames via CDP). Drive the page
   * while recording, then stop(). Returns { frames, save(dir), stop }.
   * `save(dir)` writes numbered frames (assemble to GIF/MP4 with e.g. ffmpeg).
   */
  async function recordScreencast({ format = 'jpeg', quality = 60, everyNthFrame = 1, maxWidth, maxHeight } = {}) {
    const frames = [];
    const handler = async (e) => {
      frames.push({ data: e.data, metadata: e.metadata });
      try { await client.send('Page.screencastAck', { sessionId: e.sessionId }); } catch (_) { /* stopped */ }
    };
    client.on('Page.screencastFrame', handler);
    const params = { format, quality, everyNthFrame };
    if (maxWidth) params.maxWidth = maxWidth;
    if (maxHeight) params.maxHeight = maxHeight;
    await client.send('Page.startScreencast', params);
    const ext = format === 'png' ? 'png' : 'jpg';
    const writeFrames = (dir) => frames.map((f, i) => {
      const p = path.join(dir, `frame-${String(i).padStart(4, '0')}.${ext}`);
      fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
      return p;
    });
    return {
      frames,
      /** Write captured frames as numbered images to `dir`; returns the paths. */
      save(dir) { return writeFrames(dir); },
      /**
       * Encode the captured frames to a video (needs `ffmpeg` on PATH). Writes
       * `outPath` (extension picks the container, e.g. .mp4/.webm). Throws a
       * clear error if ffmpeg isn't installed. Returns outPath.
       */
      toVideo(outPath, { fps = 10 } = {}) { return framesToMedia(writeFrames, ext, outPath, { fps, gif: false }); },
      /** Encode the captured frames to an animated GIF (needs `ffmpeg`). Returns outPath. */
      toGif(outPath, { fps = 10 } = {}) { return framesToMedia(writeFrames, ext, outPath, { fps, gif: true }); },
      async stop() { client.off('Page.screencastFrame', handler); await client.send('Page.stopScreencast').catch(() => {}); },
    };
  }

  // --- storage --------------------------------------------------------------
  /** Read the current origin's storage as a plain object. kind: 'local' | 'session'. */
  async function storage(kind = 'local') {
    const key = kind === 'session' ? 'sessionStorage' : 'localStorage';
    return evaluate(`Object.assign({}, ${key})`);
  }
  /** Clear storage. kind: 'local' | 'session' | 'all' (default). */
  async function clearStorage(kind = 'all') {
    const js = kind === 'local' ? 'localStorage.clear()'
      : kind === 'session' ? 'sessionStorage.clear()'
        : 'localStorage.clear(); sessionStorage.clear()';
    await evaluate(js + '; 1');
  }

  // --- audits ---------------------------------------------------------------
  /** Full accessibility tree (array of AX nodes). */
  async function axTree() { return (await client.send('Accessibility.getFullAXTree')).nodes; }
  /** Live DOM counters (nodes / listeners / documents) — handy for leak checks. */
  async function domCounters() { return client.send('Memory.getDOMCounters'); }
  /** Performance metrics as a { name: value } map. */
  async function metrics() {
    await client.send('Performance.enable');
    const r = await client.send('Performance.getMetrics');
    return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
  }

  async function close() { try { await client.close(); } catch (_) { /* already gone */ } }

  return {
    client, cdpUrl, target, evaluate, goto, screenshot,
    captureConsole, recordNetwork, throttle, offline, blockRequests, mockResponse,
    cookies, setCookie, clearCookies,
    storage, clearStorage,
    emulate, clearEmulation, fullPageScreenshot, captureMHTML, pdf, recordScreencast, axTree, domCounters, metrics,
    close,
  };
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
