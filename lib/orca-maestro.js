// orca-maestro.js — drive Orca's iOS Simulator (and Android emulators) with Maestro.
//
// Orca boots and manages the iOS simulator via its bundled `serve-sim` helper;
// Maestro is a separate JVM CLI that talks to the *same* device by id. This
// module bridges them: it resolves the target device (Orca's booted iOS sim,
// or a booted Android emulator via adb), then generates + runs Maestro flows
// against it and parses results.
//
// Why Maestro over the raw `orca emulator` verbs: implicit waits, flake
// handling, text/id selectors, view-hierarchy dumps, and one flow language for
// BOTH iOS and Android — the "Playwright for mobile" ergonomics. We keep it
// pointed at Orca's device so serve-sim and Maestro coexist on one simulator.
//
// Requirements: a JVM (Java 11+) and the `maestro` CLI (install:
//   curl -Ls "https://get.maestro.mobile.dev" | bash ). The JDK need not be on
// PATH — resolveJavaHome() discovers a Homebrew/macOS/SDKMAN JDK and injects it
// into Maestro's environment. Android also needs `adb` (Android SDK platform-tools).

'use strict';

const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileP = promisify(execFile);
const HOME = os.homedir();

// ---------------------------------------------------------------------------
// JDK discovery — Maestro's launcher needs `java`, which is often not on PATH
// (Homebrew's openjdk is keg-only). Find a JDK and export JAVA_HOME for the
// maestro child process so callers don't have to configure their shell.
// ---------------------------------------------------------------------------

let _javaHome; // memoized ('' = searched, none found)
function resolveJavaHome() {
  if (_javaHome !== undefined) return _javaHome || null;
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'java'))) {
    return (_javaHome = process.env.JAVA_HOME);
  }
  const candidates = [];
  // macOS: java_home reports the newest registered JDK.
  try {
    const h = execFileSync('/usr/libexec/java_home', [], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (h) candidates.push(h);
  } catch (_) { /* none registered */ }
  // Homebrew keg-only openjdk locations.
  candidates.push(
    '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    path.join(HOME, '.sdkman/candidates/java/current'),
  );
  // Homebrew Cellar fallback (version-specific).
  for (const base of ['/opt/homebrew/opt/openjdk@17', '/opt/homebrew/opt/openjdk']) {
    if (fs.existsSync(path.join(base, 'bin', 'java'))) candidates.push(base);
  }
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'bin', 'java'))) return (_javaHome = c);
  }
  return (_javaHome = '') || null;
}

/** Build an env for maestro child processes with JAVA_HOME + adb on PATH. */
function maestroEnv() {
  const env = { ...process.env };
  const jh = resolveJavaHome();
  const extraPath = [];
  if (jh) { env.JAVA_HOME = jh; extraPath.push(path.join(jh, 'bin')); }
  const adbDir = path.dirname(resolveAdb() || '');
  if (adbDir && adbDir !== '.') extraPath.push(adbDir);
  extraPath.push(path.join(HOME, '.maestro', 'bin'));
  env.PATH = [...extraPath, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

const MAESTRO_BIN_CANDIDATES = [
  process.env.MAESTRO_BIN,
  path.join(HOME, '.maestro', 'bin', 'maestro'),
  'maestro',
].filter(Boolean);

let _maestroBin;
function resolveMaestro() {
  if (_maestroBin !== undefined) return _maestroBin || null;
  const env = maestroEnv();
  for (const cand of MAESTRO_BIN_CANDIDATES) {
    try {
      execFileSync(cand, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000, env });
      return (_maestroBin = cand);
    } catch (_) { /* try next */ }
  }
  return (_maestroBin = '') || null;
}

function checkMaestro() {
  const bin = resolveMaestro();
  if (bin) return bin;
  const binOnDisk = MAESTRO_BIN_CANDIDATES.some((c) => { try { fs.accessSync(c); return true; } catch { return false; } });
  throw new Error(binOnDisk
    ? 'Maestro is installed but could not start — its Java runtime is missing. Install a JDK 11+ (`brew install openjdk@17`); this module auto-discovers it, no PATH setup needed.'
    : 'Maestro is not installed. Install it with:\n  curl -Ls "https://get.maestro.mobile.dev" | bash\nMaestro also needs a JDK 11+ (`brew install openjdk@17`).');
}

let _adb;
function resolveAdb() {
  if (_adb !== undefined) return _adb || null;
  const candidates = [
    process.env.ADB_PATH,
    path.join(process.env.ANDROID_HOME || '', 'platform-tools', 'adb'),
    path.join(process.env.ANDROID_SDK_ROOT || '', 'platform-tools', 'adb'),
    path.join(HOME, 'Library/Android/sdk/platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    'adb',
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); return (_adb = c); }
    catch (_) { /* next */ }
  }
  return (_adb = '') || null;
}

// ---------------------------------------------------------------------------
// Device resolution
// ---------------------------------------------------------------------------

function orcaEmulatorList() {
  try {
    const out = execFileSync('orca', ['emulator', 'list', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).toString();
    return JSON.parse(out);
  } catch (_) { return null; }
}

/** UDID of the iOS simulator Orca currently has booted, or null. */
function orcaSimulatorUdid() {
  const res = orcaEmulatorList();
  return res && res.result && res.result.running ? (res.result.device || null) : null;
}

/** Boot an iOS simulator through Orca (so serve-sim + Maestro share the device). */
function attachOrcaSimulator(device) {
  const out = execFileSync('orca', ['emulator', 'attach', device, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }).toString();
  const res = JSON.parse(out);
  if (!res.ok) throw new Error(`orca emulator attach failed: ${res.error && res.error.message}`);
  return res.result.info; // { deviceUdid, wsUrl, streamUrl, helperPid, streamCodec, backend }
}

/** The AVD name backing a running Android emulator serial (needed to attach it in Orca). */
function avdNameForSerial(serial) {
  const adb = resolveAdb();
  if (!adb) return null;
  try {
    // `adb -s <serial> emu avd name` prints "<name>\nOK" — first non-OK line is the AVD name.
    const out = execFileSync(adb, ['-s', serial, 'emu', 'avd', 'name'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString();
    const line = out.split('\n').map((l) => l.trim()).find((l) => l && l !== 'OK');
    return line || null;
  } catch (_) { return null; }
}

/**
 * Make Orca mirror/own a device so it opens in the Orca app (best-effort).
 * iOS attaches by simulator name; Android by AVD name (resolved from the serial).
 * Returns the attach info, or null if Orca is unreachable / the attach failed —
 * the Maestro driver still works over its own transport regardless.
 */
function attachToOrca(nameOrSerial, platform) {
  try {
    const target = platform === 'android' ? (avdNameForSerial(nameOrSerial) || nameOrSerial) : nameOrSerial;
    const out = execFileSync('orca', ['emulator', 'attach', target, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }).toString();
    const res = JSON.parse(out);
    return res.ok ? res.result.info : null;
  } catch (_) { return null; }
}

/** All iOS simulators known to simctl. */
function listSimulators() {
  const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const parsed = JSON.parse(out);
  const flat = [];
  for (const [runtime, devices] of Object.entries(parsed.devices || {})) {
    for (const d of devices) flat.push({ platform: 'ios', runtime, name: d.name, udid: d.udid, state: d.state });
  }
  return flat;
}

/** Booted Android devices/emulators visible to adb: [{ serial, state }]. */
function listAndroidDevices() {
  const adb = resolveAdb();
  if (!adb) return [];
  const out = execFileSync(adb, ['devices'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return out.split('\n').slice(1)
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [serial, state] = l.split(/\s+/); return { platform: 'android', serial, state }; })
    .filter((d) => d.state === 'device');
}

// ---------------------------------------------------------------------------
// Flow builder — fluent API that emits Maestro YAML
// ---------------------------------------------------------------------------

class Flow {
  constructor(appId) { this.appId = appId || null; this.commands = []; }
  _push(cmd) { this.commands.push(cmd); return this; }

  launchApp(opts) { return this._push(opts ? { launchApp: opts } : 'launchApp'); }
  stopApp(appId) { return this._push(appId ? { stopApp: appId } : 'stopApp'); }
  tapOn(selector) { return this._push({ tapOn: selector }); }          // string (text) or { id, text, index, point }
  doubleTapOn(selector) { return this._push({ doubleTapOn: selector }); }
  longPressOn(selector) { return this._push({ longPressOn: selector }); }
  inputText(text) { return this._push({ inputText: String(text) }); }
  eraseText(chars) { return this._push(chars ? { eraseText: chars } : 'eraseText'); }
  pressKey(key) { return this._push({ pressKey: key }); }              // Enter, Backspace, Home, Back, Lock, ...
  back() { return this._push('back'); }
  scroll() { return this._push('scroll'); }
  swipe(opts) { return this._push({ swipe: opts }); }                  // { direction: LEFT|RIGHT|UP|DOWN } or { start, end }
  openLink(url) { return this._push({ openLink: url }); }
  assertVisible(selector) { return this._push({ assertVisible: selector }); }
  assertNotVisible(selector) { return this._push({ assertNotVisible: selector }); }
  waitForAnimationToEnd(timeout) { return this._push(timeout ? { waitForAnimationToEnd: { timeout } } : 'waitForAnimationToEnd'); }
  takeScreenshot(name) { return this._push({ takeScreenshot: name || 'screenshot' }); }
  raw(command) { return this._push(command); }                        // escape hatch: any Maestro command

  yaml() {
    const lines = [`appId: ${this.appId || 'com.apple.springboard'}`, '---'];
    for (const cmd of this.commands) lines.push(renderCommand(cmd));
    return lines.join('\n') + '\n';
  }
}

function renderCommand(cmd) {
  if (typeof cmd === 'string') return `- ${cmd}`;
  const key = Object.keys(cmd)[0];
  const val = cmd[key];
  if (val === true || val === undefined) return `- ${key}`;
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return `- ${key}: ${yamlScalar(val)}`;
  const inner = Object.entries(val).map(([k, v]) => `    ${k}: ${yamlScalar(v)}`);
  return `- ${key}:\n${inner.join('\n')}`;
}

function yamlScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /[:#{}\[\],&*!|>'"%@`]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function flow(appId) { return new Flow(appId); }

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

let _flowCounter = 0;
function nextFlowName() { return (++_flowCounter).toString().padStart(4, '0'); }

function makeDriver({ device, platform, bin, orcaMirrored = null }) {
  const env = maestroEnv();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-maestro-'));

  async function runFlow(flowOrYaml, { format = 'noop', timeout = 180000 } = {}) {
    const yaml = flowOrYaml instanceof Flow ? flowOrYaml.yaml() : String(flowOrYaml);
    const file = path.join(tmpDir, `flow-${nextFlowName()}.yaml`);
    fs.writeFileSync(file, yaml);
    const args = ['--device', device, 'test', file];
    if (format && format !== 'noop') args.push('--format', format);
    try {
      const { stdout, stderr } = await execFileP(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, env });
      return { ok: true, stdout, stderr, yaml, file };
    } catch (e) {
      return { ok: false, stdout: e.stdout || '', stderr: e.stderr || String(e.message), yaml, file, code: e.code };
    }
  }

  async function hierarchy({ timeout = 90000 } = {}) {
    const { stdout } = await execFileP(bin, ['--device', device, 'hierarchy'], { timeout, maxBuffer: 64 * 1024 * 1024, env });
    const start = stdout.indexOf('{');
    if (start === -1) throw new Error('maestro hierarchy returned no JSON');
    return JSON.parse(stdout.slice(start));
  }

  function screenshot(destPath) {
    if (platform === 'ios') {
      execFileSync('xcrun', ['simctl', 'io', device, 'screenshot', destPath], { stdio: 'ignore' });
    } else {
      const adb = resolveAdb();
      const png = execFileSync(adb, ['-s', device, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
      fs.writeFileSync(destPath, png);
    }
    return destPath;
  }

  const launchApp = (appId, opts) => runFlow(flow(appId).launchApp(opts));
  const tapOn = (appId, selector) => runFlow(flow(appId).tapOn(selector));
  const inputText = (appId, text) => runFlow(flow(appId).inputText(text));
  const openLink = (url, appId) => runFlow(flow(appId || (platform === 'ios' ? 'com.apple.springboard' : 'com.android.chrome')).openLink(url));
  function cleanup() { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }

  return {
    device, platform, bin,
    orcaMirrored,   // did Orca attach the device for display? (null if not attempted / failed)
    flow, runFlow, hierarchy,
    launchApp, tapOn, inputText, openLink, screenshot,
    cleanup,
  };
}

/**
 * Maestro driver for Orca's iOS simulator.
 * @param {object} [opts]
 * @param {string} [opts.udid]     Target UDID (defaults to Orca's booted sim).
 * @param {string} [opts.device]   Attach this sim via Orca if none is booted.
 * @param {boolean} [opts.attachToOrca=true]  Make Orca mirror the device so it opens in the app.
 * @param {string} [opts.bin]      Explicit maestro binary path.
 */
async function iosMaestro(opts = {}) {
  const bin = opts.bin || checkMaestro();
  const attach = opts.attachToOrca !== false;
  let udid = opts.udid || orcaSimulatorUdid();
  let mirrored = udid ? { deviceUdid: udid, backend: 'ios' } : null;   // a resolved Orca udid is already mirrored
  if (!udid && opts.device) { const info = attachOrcaSimulator(opts.device); udid = info.deviceUdid; mirrored = info; }
  if (!udid) throw new Error(
    'No booted iOS simulator. Attach one through Orca first (so serve-sim + Maestro share it):\n' +
    '  orca emulator attach "iPhone 17"\nor pass { device: "iPhone 17" } to iosMaestro().');
  return makeDriver({ device: udid, platform: 'ios', bin, orcaMirrored: attach ? mirrored : null });
}

/**
 * Maestro driver for a booted Android emulator/device.
 * @param {object} [opts]
 * @param {string} [opts.serial]   adb serial (defaults to the first booted device).
 * @param {boolean} [opts.attachToOrca=true]  Attach the device in Orca (scrcpy mirror) so it
 *   opens in the app. Best-effort — the driver still works over adb if Orca is unreachable.
 * @param {string} [opts.bin]      Explicit maestro binary path.
 */
async function androidMaestro(opts = {}) {
  const bin = opts.bin || checkMaestro();
  if (!resolveAdb()) throw new Error('adb not found. Install Android SDK platform-tools, or set ANDROID_HOME / ADB_PATH.');
  let serial = opts.serial;
  if (!serial) {
    const devs = listAndroidDevices();
    if (!devs.length) throw new Error('No booted Android device. Start an emulator:\n  $ANDROID_HOME/emulator/emulator -avd <name>');
    serial = devs[0].serial;
  }
  // Open it in the Orca app by default (scrcpy mirror). Best-effort: never block driving.
  const mirrored = opts.attachToOrca === false ? null : attachToOrca(serial, 'android');
  return makeDriver({ device: serial, platform: 'android', bin, orcaMirrored: mirrored });
}

module.exports = {
  iosMaestro,
  androidMaestro,
  flow,
  Flow,
  checkMaestro,
  resolveMaestro,
  resolveJavaHome,
  resolveAdb,
  orcaSimulatorUdid,
  attachOrcaSimulator,
  attachToOrca,
  avdNameForSerial,
  listSimulators,
  listAndroidDevices,
};

// --- CLI smoke test ----------------------------------------------------------
if (require.main === module) {
  (async () => {
    const bin = resolveMaestro();
    console.error(`maestro:       ${bin || 'NOT INSTALLED'}`);
    console.error(`java home:     ${resolveJavaHome() || '(none found)'}`);
    console.error(`adb:           ${resolveAdb() || '(none)'}`);
    console.error(`ios udid:      ${orcaSimulatorUdid() || '(none booted)'}`);
    console.error(`android:       ${listAndroidDevices().map((d) => d.serial).join(', ') || '(none booted)'}`);
    if (!bin) process.exit(2);
  })().catch((e) => { console.error('smoke failed:', e.message); process.exit(1); });
}
