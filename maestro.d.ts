// Type definitions for orca-playwright-bridge/maestro.
// Drive Orca's iOS Simulator (and booted Android emulators) with Maestro.

export type Platform = 'ios' | 'android';

/** A Maestro tapOn/assert selector: plain text, or a structured matcher. */
export type Selector =
  | string
  | {
      text?: string;
      id?: string;
      index?: number;
      point?: string;            // "50%,50%" or "x,y"
      below?: Selector;
      above?: Selector;
      containsChild?: Selector;
      [k: string]: unknown;
    };

export interface SwipeOptions {
  direction?: 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
  start?: string;                // "50%,80%"
  end?: string;                  // "50%,20%"
  duration?: number;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  yaml: string;
  file: string;
  code?: number;
}

/** Fluent builder that emits a Maestro flow YAML document. */
export declare class Flow {
  constructor(appId?: string);
  appId: string | null;
  commands: unknown[];
  launchApp(opts?: Record<string, unknown>): this;
  stopApp(appId?: string): this;
  tapOn(selector: Selector): this;
  doubleTapOn(selector: Selector): this;
  longPressOn(selector: Selector): this;
  inputText(text: string): this;
  eraseText(chars?: number): this;
  pressKey(key: string): this;          // Enter, Backspace, Home, Back, Lock, ...
  back(): this;
  scroll(): this;
  swipe(opts: SwipeOptions): this;
  openLink(url: string): this;
  assertVisible(selector: Selector): this;
  assertNotVisible(selector: Selector): this;
  waitForAnimationToEnd(timeout?: number): this;
  takeScreenshot(name?: string): this;
  /** Escape hatch: append any raw Maestro command (object or bare string). */
  raw(command: unknown): this;
  yaml(): string;
}

export interface MaestroDriver {
  /** iOS simulator UDID or Android adb serial this driver targets. */
  device: string;
  platform: Platform;
  bin: string;
  /**
   * Orca attach info if the device was mirrored into the Orca app (the default),
   * else null. `{ deviceUdid, backend, streamUrl?, ... }`.
   */
  orcaMirrored: { deviceUdid: string; backend: string; streamUrl?: string; [k: string]: unknown } | null;
  /** Start a new flow (appId defaults to the platform springboard/launcher). */
  flow(appId?: string): Flow;
  /** Run a Flow (or a raw YAML string). Never rejects — inspect `.ok`. */
  runFlow(flow: Flow | string, opts?: { format?: string; timeout?: number }): Promise<RunResult>;
  /** Dump the current on-screen view hierarchy as JSON (DOM/AX analogue). */
  hierarchy(opts?: { timeout?: number }): Promise<any>;
  /** One-command convenience flows. */
  launchApp(appId: string, opts?: Record<string, unknown>): Promise<RunResult>;
  tapOn(appId: string, selector: Selector): Promise<RunResult>;
  inputText(appId: string, text: string): Promise<RunResult>;
  openLink(url: string, appId?: string): Promise<RunResult>;
  /** PNG screenshot via simctl (iOS) or adb (Android). Returns the path. */
  screenshot(destPath: string): string;
  /** Remove the driver's temp flow directory. */
  cleanup(): void;
}

export interface IosMaestroOptions {
  /** Target UDID. Defaults to Orca's booted simulator. */
  udid?: string;
  /** If no UDID and none booted, attach this device via Orca first. */
  device?: string;
  /** Make Orca mirror the device so it opens in the app. Default true. */
  attachToOrca?: boolean;
  /** Explicit maestro binary path. */
  bin?: string;
}

export interface AndroidMaestroOptions {
  /** adb serial (e.g. "emulator-5554"). Defaults to the first booted device. */
  serial?: string;
  /**
   * Attach the device in Orca (scrcpy mirror) so it opens in the app. Default true.
   * Best-effort — the driver still works over adb if Orca is unreachable.
   */
  attachToOrca?: boolean;
  bin?: string;
}

export interface SimulatorInfo { platform: 'ios'; runtime: string; name: string; udid: string; state: string; }
export interface AndroidDevice { platform: 'android'; serial: string; state: string; }

/** Maestro driver bound to Orca's iOS simulator (attaches one if `device` given). */
export function iosMaestro(opts?: IosMaestroOptions): Promise<MaestroDriver>;
/** Maestro driver bound to a booted Android emulator/device. */
export function androidMaestro(opts?: AndroidMaestroOptions): Promise<MaestroDriver>;

export function flow(appId?: string): Flow;

/** Resolve a runnable `maestro`, or throw an actionable install message. */
export function checkMaestro(): string;
/** Resolve a runnable `maestro` path, or null if unusable. */
export function resolveMaestro(): string | null;
/** Discover a JDK (Homebrew keg-only / macOS / SDKMAN), or null. */
export function resolveJavaHome(): string | null;
/** Resolve an `adb` path (ANDROID_HOME, default SDK, PATH), or null. */
export function resolveAdb(): string | null;

/** UDID of the iOS simulator Orca currently has booted, or null. */
export function orcaSimulatorUdid(): string | null;
/** Boot an iOS simulator through Orca; returns serve-sim helper info. */
export function attachOrcaSimulator(device: string): {
  deviceUdid: string; wsUrl: string; streamUrl: string; helperPid: number; streamCodec: string; backend: string;
};
export function listSimulators(): SimulatorInfo[];
export function listAndroidDevices(): AndroidDevice[];
