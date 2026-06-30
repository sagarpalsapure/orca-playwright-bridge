'use strict';
/*
 * orca-playwright-bridge — live demo control panel.
 *
 * A tiny zero-dependency HTTP server (Node built-in `http`) that serves a UI
 * and a JSON API. The API drives Orca's embedded browser through this package:
 * tabs, navigation, eval, snapshot, screenshots, device/media/offline
 * emulation, and a Playwright network-mock showcase.
 *
 *   npm run demo        # then open http://127.0.0.1:7799
 *
 * Requires Orca running with browser-use enabled. Nothing here is published to
 * npm — the demo lives in the repo only.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { orcaTabs, openOrcaTab } = require('..');

const PORT = Number(process.env.DEMO_PORT || 7799);
const UI = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

function orcaReachable() {
  try {
    const out = execFileSync('orca', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return JSON.parse(out)?.result?.runtime?.reachable === true;
  } catch (_) { return false; }
}
function createTab(url) {
  const out = execFileSync('orca', ['tab', 'create', '--url', url, '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return JSON.parse(out).result.browserPageId;
}
function closeTab(pageId) {
  try { execFileSync('orca', ['tab', 'close', '--page', pageId, '--json'], { stdio: 'ignore' }); } catch (_) { /* ignore */ }
}

// --- API handlers (return a JSON-serializable value or throw) ----------------
const api = {
  status() {
    const reachable = orcaReachable();
    return { reachable, tabs: reachable ? orcaTabs().list : [] };
  },
  open({ url }) {
    if (!url) throw new Error('url required');
    const pageId = createTab(url);
    return { pageId };
  },
  goto({ pageId, url }) { return orcaTabs().byId(pageId).goto(url); },
  eval({ pageId, expr }) { return { result: orcaTabs().byId(pageId).eval(expr) }; },
  snapshot({ pageId }) { return orcaTabs().byId(pageId).snapshot(); },
  screenshot({ pageId }) { return orcaTabs().byId(pageId).screenshot(); }, // { data, format }
  get({ pageId, what }) { return { what, value: orcaTabs().byId(pageId).get(what) }; },
  emulate({ pageId, device, colorScheme, offline }) {
    const d = orcaTabs().byId(pageId);
    const applied = [];
    if (device) { d.setDevice(device); applied.push(`device=${device}`); }
    if (colorScheme) { d.setMedia({ colorScheme }); applied.push(`media=${colorScheme}`); }
    if (offline != null) { d.setOffline(!!offline); applied.push(`offline=${!!offline}`); }
    return { applied };
  },
  close({ pageId }) { closeTab(pageId); return { closed: pageId }; },

  // Playwright bridge showcase: mock a network response, then capture it.
  async mock({ url, body }) {
    const target = url || 'https://example.com/api/demo';
    const t = await openOrcaTab('data:text/html,<title>mock</title>');
    try {
      await t.page.route('**/*', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: body || '<h1>Mocked by the bridge</h1>' }));
      await t.page.goto(target, { waitUntil: 'load', timeout: 8000 });
      const shot = await t.page.screenshot({ type: 'png' });
      return { title: await t.page.title(), data: shot.toString('base64'), format: 'png', servedFrom: target };
    } finally { await t.close(); }
  },
};

function send(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(UI);
  }

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice('/api/'.length);
    const handler = api[name];
    if (!handler) return send(res, 404, { error: `no such action: ${name}` });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let args = {};
      if (raw) { try { args = JSON.parse(raw); } catch (_) { return send(res, 400, { error: 'invalid JSON body' }); } }
      try {
        const result = await handler(args);
        send(res, 200, { ok: true, result });
      } catch (e) {
        send(res, 200, { ok: false, error: e.message.split('\n')[0] });
      }
    });
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  orca-playwright-bridge demo → http://127.0.0.1:${PORT}\n`);
  if (!orcaReachable()) console.log('  ⚠ Orca is not reachable yet — open Orca (browser-use enabled), the UI will pick it up on Refresh.\n');
});
