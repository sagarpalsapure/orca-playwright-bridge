// Type definitions for orca-playwright-bridge (main / ./bridge entry).
// Raw-CDP driver types live in ./connect (connect.d.ts).

import type { Browser, BrowserContext, Page, BrowserType } from 'playwright-core';

export interface Bridge {
  /** http URL Playwright connects to (the local proxy). */
  url: string;
  bridgePort: number;
  /** The upstream CDP target this bridge fronts. */
  target: Record<string, unknown>;
  /** Detach + stop the bridge. Does NOT quit Orca. */
  close(): Promise<void>;
}

export interface OrcaPlaywright {
  browser: Browser;
  context: BrowserContext | null;
  /** The live Orca tab as a Playwright page (null if none resolved). */
  page: Page | null;
  bridge: Bridge;
  /** Present on openOrcaTab() results — the Orca browserPageId of the new tab. */
  browserPageId?: string;
  /** Reload safely (re-navigates the current URL; page.reload() would close the tab). */
  reload(opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }): Promise<unknown>;
  /** Detach Playwright + stop the bridge (openOrcaTab also closes the tab). */
  close(): Promise<void>;
}

export interface CdpEndpoint {
  cdpUrl: string;
  port: number;
  pageUrl: string;
  target: Record<string, unknown>;
}

/** Raw entry from `orca tab list`. */
export interface OrcaTabInfo {
  index: number;
  browserPageId: string;
  url: string;
  active: boolean;
  [k: string]: unknown;
}

export interface TabListItem {
  index: number;
  pageId: string;
  url: string;
  active: boolean;
}

export interface Snapshot {
  origin: string;
  refs: Record<string, { name: string; role: string }>;
  snapshot: string;
}

export type GetProperty = 'text' | 'html' | 'value' | 'url' | 'title';
export type ElementState = 'visible' | 'enabled' | 'checked';
export type Locator = 'role' | 'text' | 'label';

/** A per-tab driver over Orca's native browser CLI. Methods are synchronous. */
export interface TabDriver {
  pageId: string;
  url?: string;
  // read
  eval(js: string): any;
  snapshot(): Snapshot;
  screenshot(format?: 'png' | 'jpeg'): { data: string; format: string };
  get(what: GetProperty, ref?: string): string;
  is(what: ElementState, ref: string): boolean;
  // navigate
  goto(url: string): any;
  back(): any;
  forward(): any;
  reload(): any;
  // interact
  click(ref: string): any;
  dblclick(ref: string): any;
  hover(ref: string): any;
  focus(ref: string): any;
  fill(ref: string, value: string): any;
  clear(ref: string): any;
  select(ref: string, value: string): any;
  check(ref: string): any;
  uncheck(ref: string): any;
  type(text: string): any;
  inserttext(text: string): any;
  keypress(key: string): any;
  scroll(direction: 'up' | 'down', amount?: number): any;
  scrollIntoView(ref: string): any;
  drag(from: string, to: string): any;
  upload(ref: string, files: string | string[]): any;
  wait(timeoutMs?: number): any;
  // emulate (Orca native `set` primitives)
  setDevice(name: string): any;
  setOffline(on?: boolean): any;
  setHeaders(headers: Record<string, string>): any;
  setCredentials(user: string, pass: string): any;
  setMedia(opts?: { colorScheme?: 'dark' | 'light'; reducedMotion?: 'reduce' | 'no-preference' }): any;
  // semantic locators (Orca 1.4.114+)
  find(locator: Locator, value: string, opts?: { action?: string; text?: string }): any;
  // low-level mouse
  mouseMove(x: number, y: number): any;
  mouseDown(): any;
  mouseUp(): any;
  mouseWheel(dy: number, dx?: number): any;
  /** Bring this tab to the foreground (active + focused). */
  activate(): any;
  // Orca 1.4.117+
  /** Accept a pending JS dialog; `text` answers a prompt. */
  acceptDialog(text?: string): any;
  /** Dismiss a pending JS dialog (no-ops if none open). */
  dismissDialog(): any;
  /** Read a storage value by key (opts.session → sessionStorage). */
  getStorage(key: string, opts?: { session?: boolean }): string | undefined;
  setStorage(key: string, value: string, opts?: { session?: boolean }): any;
  clearWebStorage(opts?: { session?: boolean }): any;
  /** Outline an element by CSS selector (demos/debugging). */
  highlight(selector: string): any;
  /** Download the file behind `selector` to `path`. */
  download(selector: string, path: string): any;
  /** Escape hatch: run any raw agent-browser command against this tab. */
  exec(command: string): any;
}

export interface OrcaTabs {
  list: TabListItem[];
  tab(match: RegExp | string): TabDriver;
  byId(pageId: string): TabDriver;
  all(): TabDriver[];
  /** Evaluate `js` in every open tab, genuinely concurrently. */
  evalAll(js: string): Promise<Array<{ pageId: string; url: string; value: any }>>;
}

export interface StartBridgeOptions {
  /** Attach to the open tab whose URL matches (each tab has its own endpoint). */
  tab?: RegExp | string;
  /** Use an explicit CDP base url. */
  cdpUrl?: string;
  /** Pick among a single endpoint's targets by URL. */
  match?: RegExp | string;
}

export interface ConnectPlaywrightOptions extends StartBridgeOptions {
  /** Overrides for connectOverCDP (defaults: { isLocal: true, noDefaults: true }). */
  connectOptions?: Record<string, unknown>;
}

export function startBridge(opts?: StartBridgeOptions): Promise<Bridge>;
export function connectOrcaPlaywright(opts?: ConnectPlaywrightOptions): Promise<OrcaPlaywright>;
export function openOrcaTab(url: string, opts?: { profile?: string; focus?: boolean }): Promise<OrcaPlaywright>;
/**
 * Run an action that opens a new tab/window and return a driver for it.
 * Popups have no CDP endpoint (Playwright can't attach), so `tab` is the native
 * orcaTabs() driver.
 */
export function waitForNewTab(
  action: () => unknown,
  opts?: { timeout?: number }
): Promise<{ pageId: string; url: string; tab: TabDriver; close(): void }>;
export function loadChromium(): BrowserType;
export function discoverCdpUrl(): string;
export function discoverAllCdpEndpoints(): CdpEndpoint[];
export function findCdpUrlForTab(match: RegExp | string): string;
export function orcaTabs(): OrcaTabs;
export function orcaTabList(): OrcaTabInfo[];
export function switchToOrcaTab(match: RegExp | string): Promise<OrcaTabInfo>;
