// Type definitions for orca-playwright-bridge/connect (raw-CDP driver).

export interface ConsoleMessage {
  type: string;   // 'log' | 'warning' | 'error' | 'info' | 'debug' | …
  text: string;
}

export interface NetworkEvent {
  phase: 'request' | 'response' | 'failed';
  id: string;
  method?: string;
  url?: string;
  status?: number;
  mimeType?: string;
  error?: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  cache: Record<string, unknown>;
  timings: { send: number; wait: number; receive: number };
}

export interface Har {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

export interface ConsoleCapture {
  /** Grows as messages arrive. */
  messages: ConsoleMessage[];
  stop(): void;
}

export interface NetworkRecorder {
  /** Grows as requests/responses arrive. */
  events: NetworkEvent[];
  /** Build a HAR 1.2 log from what's been captured so far. */
  har(): Har;
  stop(): void;
}

export type ThrottlePreset =
  | 'slow-3g'
  | 'fast-3g'
  | 'offline'
  | { latency?: number; download?: number; upload?: number; offline?: boolean };

export interface EmulateOptions {
  /** A DEVICES preset name (e.g. 'iPhone 12') or a metrics object. */
  device?: string | { width: number; height: number; dpr?: number; mobile?: boolean; ua?: string };
  timezone?: string;
  locale?: string;
  /** CPU throttling rate (1 = no throttle, 4 = 4x slower). */
  cpu?: number;
  colorScheme?: 'dark' | 'light';
}

export interface OrcaCdp {
  /** The underlying chrome-remote-interface client (send any CDP command). */
  client: any;
  cdpUrl: string;
  target: Record<string, unknown>;

  evaluate(expression: string): Promise<any>;
  goto(url: string, opts?: { waitMs?: number }): Promise<void>;
  screenshot(path?: string, opts?: { format?: 'png' | 'jpeg' }): Promise<Buffer>;

  captureConsole(): ConsoleCapture;
  recordNetwork(): Promise<NetworkRecorder>;
  throttle(preset?: ThrottlePreset): Promise<any>;
  offline(on?: boolean): Promise<any>;
  /** Block requests matching any pattern via CDP Fetch (works for real requests, unlike Playwright route.continue/abort). */
  blockRequests(
    patterns: Array<string | RegExp | ((url: string) => boolean)> | string | RegExp | ((url: string) => boolean)
  ): Promise<{ counts: { blocked: number; allowed: number }; stop(): Promise<void> }>;

  cookies(urls?: string | string[]): Promise<any[]>;
  setCookie(cookie: Record<string, unknown>): Promise<any>;
  clearCookies(): Promise<any>;
  storage(kind?: 'local' | 'session'): Promise<Record<string, string>>;
  clearStorage(kind?: 'local' | 'session' | 'all'): Promise<void>;

  emulate(opts?: EmulateOptions): Promise<void>;
  clearEmulation(): Promise<void>;
  fullPageScreenshot(path?: string, opts?: { format?: 'png' | 'jpeg' }): Promise<Buffer>;
  captureMHTML(path?: string): Promise<string>;
  /** Record the page as a screencast (stream of frames). save(dir) writes numbered images. */
  recordScreencast(opts?: { format?: 'jpeg' | 'png'; quality?: number; everyNthFrame?: number; maxWidth?: number; maxHeight?: number }):
    Promise<{ frames: Array<{ data: string; metadata: any }>; save(dir: string): string[]; stop(): Promise<void> }>;
  axTree(): Promise<any[]>;
  domCounters(): Promise<any>;
  metrics(): Promise<Record<string, number>>;

  close(): Promise<void>;
}

export interface ConnectOrcaOptions {
  cdpUrl?: string;
  match?: RegExp | string;
  /** Extra CDP domains to enable (Page/Runtime/DOM are always on). */
  domains?: string[];
}

export function connectOrca(opts?: ConnectOrcaOptions): Promise<OrcaCdp>;
export function discoverCdpUrl(): string;
export function scanForCdp(): string | null;
export function loadCRI(): any;
