import { LEVELS } from './core/limits.js';
import { consoleSink, Logger, type LogSink } from './core/logger.js';
import { MAX_STRING_BYTES, MAX_DEPTH } from './core/limits.js';
import { toPatterns } from './core/filters.js';
import { isObject, readOptions as readKnown, safeString } from './core/guard.js';
import { toHookList } from './core/hooks.js';
import type { Props } from './core/normalize.js';
import { natives } from './browser/natives.js';
import type { CrumbHook, EventHook, Integration } from './types.js';

/**
 * Everything `init()` accepts.
 *
 * Every numeric option is clamped to a sane range with a warning rather than accepted verbatim:
 * a `flushAt` of 0 or a `requestTimeoutMs` of 10 would otherwise turn into a request per event or
 * a transport that never succeeds, and neither failure is visible from the outside.
 *
 * Nothing here throws. A missing key, and a secret key, which the browser SDK refuses to use, are
 * each said once at error level, and the client is then inert, exactly as if it were switched off.
 */
export interface VinktarOptions {
  /** The project's write key (`vnk_pk_…`). Without one the SDK is inert and says so. */
  writeKey?: string;
  /** Alias of `writeKey`. */
  key?: string;
  /** Ingest host. Default `https://in.vinktar.com`. */
  host?: string;
  /** Master switch. `false` turns every method into a no-op. */
  enabled?: boolean;
  /** Verbose logging. */
  debug?: boolean;

  /** The analytics half: `track`, pageviews, autocapture. Identify is never silenced. */
  analytics?: boolean;
  /** The error-tracking half: global handlers and `captureException`. */
  errors?: boolean;
  /** Alias of `errors`, as written by the install snippet. */
  autoCaptureErrors?: boolean;

  release?: string;
  /** Defaults to `development` on localhost and `production` elsewhere. */
  environment?: string;
  /** Send only from these environments. Empty means all. */
  enabledEnvironments?: string[];

  flushAt?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  requestTimeoutMs?: number;
  /** Milliseconds `close()` may spend on its final delivery. Default 2000. */
  shutdownTimeout?: number;
  /** Compress bodies of 1 KiB and over. */
  gzip?: boolean;
  /** Keep the queue in localStorage across navigations and crashes. */
  persistQueue?: boolean;

  /** `$pageview` on load and on history changes. An object picks which URL parts count as a change. */
  autoPageviews?: boolean | { path?: boolean; search?: boolean; hash?: boolean; leave?: boolean };
  /** `$autocapture` for clicks and form submits, element identity only. */
  autocapture?: boolean | { clicks?: boolean; forms?: boolean };
  /** Idle time before a new session starts. 30 minutes. */
  sessionTimeoutMs?: number;
  /** Hard cap on one session's length. 24 hours. */
  sessionMaxMs?: number;

  breadcrumbs?: boolean | { console?: boolean; network?: boolean; navigation?: boolean; click?: boolean };
  maxBreadcrumbs?: number;

  /** Analytics sampling, per device. */
  sampleRate?: number;
  /** Error sampling, per issue. */
  errorSampleRate?: number;
  maxErrorsPerMinute?: number;
  maxEventsPerMinute?: number;
  dedupe?: boolean;

  ignoreErrors?: Array<string | RegExp>;
  denyUrls?: Array<string | RegExp>;
  allowUrls?: Array<string | RegExp>;
  /** Turn off the built-in browser-noise ignore list. */
  disableErrorDefaults?: boolean;

  /** Properties on every event, under whatever `register()` persisted. */
  superProperties?: Props;
  /** Keep full URLs (query, fragment) and click ids. Off: origin and path only. */
  sendDefaultPii?: boolean;
  /** Extra key fragments to redact, on top of the built-in set. */
  redactedKeys?: string[];
  /** Top-level property names dropped outright. */
  propertyDenylist?: string[];
  /** Memory only: nothing written to cookies or storage. A new device id every load. */
  disablePersistence?: boolean;
  /** Share the device and session across subdomains via a cookie on the registrable domain. */
  crossSubdomainCookie?: boolean;
  /** Use `sendBeacon` on unload when a keepalive fetch cannot carry the batch. */
  useBeacon?: boolean;

  /** Start opted out; nothing leaves until `optIn()`. */
  optOutByDefault?: boolean;
  /** Honour Do Not Track and Global Privacy Control by never starting. */
  respectDnt?: boolean;
  /** Drop analytics from known automated traffic. Errors are never filtered. */
  filterBots?: boolean;
  /** Origins that receive `X-Vinktar-Device-Id` / `X-Vinktar-Session-Id` on the page's own requests. */
  propagateIdentity?: Array<string | RegExp>;

  initialScope?: { tags?: Record<string, string>; context?: Props };

  /** Per-string byte cap. At most the server's 255. */
  maxValueBytes?: number;
  normalizeDepth?: number;
  includeRawStack?: boolean;
  /** Attach a stack to `captureMessage`. */
  attachStacktrace?: boolean;

  integrations?: Integration[];

  beforeSend?: EventHook | EventHook[];
  beforeTrack?: EventHook | EventHook[];
  beforeBreadcrumb?: CrumbHook | CrumbHook[];
  /** Called with an Error whenever the SDK itself fails at something. */
  onError?: (error: Error) => void;
  logger?: LogSink;
}

export interface Resolved {
  readonly writeKey: string;
  readonly host: string;
  readonly enabled: boolean;
  readonly debug: boolean;
  readonly analytics: boolean;
  readonly errors: boolean;
  readonly release: string;
  readonly environment: string;
  readonly enabledEnvironments: readonly string[];
  readonly flushAt: number;
  readonly flushIntervalMs: number;
  readonly maxQueueSize: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeout: number;
  readonly gzip: boolean;
  readonly persistQueue: boolean;
  readonly autoPageviews: { enabled: boolean; path: boolean; search: boolean; hash: boolean; leave: boolean };
  readonly autocapture: { clicks: boolean; forms: boolean };
  readonly sessionTimeoutMs: number;
  readonly sessionMaxMs: number;
  readonly breadcrumbs: { console: boolean; network: boolean; navigation: boolean; click: boolean };
  readonly maxBreadcrumbs: number;
  readonly sampleRate: number;
  readonly errorSampleRate: number;
  readonly maxErrorsPerMinute: number;
  readonly maxEventsPerMinute: number;
  readonly dedupe: boolean;
  readonly ignoreErrors: ReadonlyArray<string | RegExp>;
  readonly denyUrls: ReadonlyArray<string | RegExp>;
  readonly allowUrls: ReadonlyArray<string | RegExp>;
  readonly disableErrorDefaults: boolean;
  readonly superProperties: Props;
  readonly sendDefaultPii: boolean;
  readonly redactedKeys: readonly string[];
  readonly propertyDenylist: readonly string[];
  readonly disablePersistence: boolean;
  readonly crossSubdomainCookie: boolean;
  readonly useBeacon: boolean;
  readonly optOutByDefault: boolean;
  readonly respectDnt: boolean;
  readonly filterBots: boolean;
  readonly propagateIdentity: ReadonlyArray<string | RegExp>;
  readonly initialScope: { tags: Record<string, string>; context: Props };
  readonly maxValueBytes: number;
  readonly normalizeDepth: number;
  readonly includeRawStack: boolean;
  readonly attachStacktrace: boolean;
  readonly integrations: readonly Integration[];
  readonly beforeSend: readonly EventHook[];
  readonly beforeTrack: readonly EventHook[];
  readonly beforeBreadcrumb: readonly CrumbHook[];
  readonly onError: ((error: Error) => void) | undefined;
  /** Why the SDK will not run at all, when it will not. */
  readonly inert: string | null;
  readonly warnings: readonly string[];
}

export const DEFAULT_HOST = 'https://in.vinktar.com';

const KNOWN = new Set<keyof VinktarOptions>([
  'writeKey', 'key', 'host', 'enabled', 'debug', 'analytics', 'errors', 'autoCaptureErrors', 'release', 'environment',
  'enabledEnvironments', 'flushAt', 'flushIntervalMs', 'maxQueueSize', 'requestTimeoutMs', 'shutdownTimeout', 'gzip', 'persistQueue',
  'autoPageviews', 'autocapture', 'sessionTimeoutMs', 'sessionMaxMs', 'breadcrumbs', 'maxBreadcrumbs', 'sampleRate',
  'errorSampleRate', 'maxErrorsPerMinute', 'maxEventsPerMinute', 'dedupe', 'ignoreErrors', 'denyUrls', 'allowUrls',
  'disableErrorDefaults', 'superProperties', 'sendDefaultPii', 'redactedKeys', 'propertyDenylist', 'disablePersistence',
  'crossSubdomainCookie', 'useBeacon', 'optOutByDefault', 'respectDnt', 'filterBots', 'propagateIdentity', 'initialScope',
  'maxValueBytes', 'normalizeDepth', 'includeRawStack', 'attachStacktrace', 'integrations', 'beforeSend', 'beforeTrack',
  'beforeBreadcrumb', 'onError', 'logger',
]);

/** What `init()` was handed, as options that are safe to read. */
export function readOptions(given: unknown): { options: VinktarOptions; problems: string[] } {
  return readKnown(given, KNOWN);
}

export function makeLogger(options: VinktarOptions): Logger {
  const sink: LogSink = typeof options.logger === 'function' ? options.logger : consoleSink(natives.console);

  return new Logger(sink, options.debug === true);
}

/**
 * @param options what `readOptions` returned, never what the page passed
 * @param broken set when the options could not be resolved at all: the client is inert for that reason
 */
export function resolve(options: VinktarOptions, logger: Logger, broken?: string): Resolved {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    logger.warn(message);
  };

  const clamp = (name: string, value: unknown, min: number, max: number, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warn(`${name} must be a number; using ${fallback}`);

      return fallback;
    }
    if (value < min || value > max) {
      const clamped = Math.min(max, Math.max(min, value));
      warn(`${name} ${value} is outside ${min}–${max}; using ${clamped}`);

      return clamped;
    }

    return value;
  };
  const list = <T>(name: string, value: unknown): T[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      warn(`${name} must be an array; ignored`);

      return [];
    }

    return value as T[];
  };
  /** Strings only: `String(null)` in a list of key fragments would redact every key containing "null". */
  const strings = (name: string, value: unknown): string[] =>
    list<unknown>(name, value).filter((entry, index): entry is string => {
      if (typeof entry !== 'string') warn(`${name}[${index}] is not a string and was dropped`);

      return typeof entry === 'string';
    });
  // These lists are matched inside the page's own fetch and XHR calls; only a string or a RegExp gets that far.
  const patterns = (name: string, value: unknown): Array<string | RegExp> =>
    toPatterns(list(name, value), (index) => warn(`${name}[${index}] is not a string or a RegExp and was dropped`));
  const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback);
  const hooks = <T>(name: string, value: T | T[] | undefined): T[] =>
    toHookList(value as never, (index) => warn(`${name}[${index}] is not a function and was dropped`)) as T[];

  const given = text(options.writeKey ?? options.key).trim();
  let inert: string | null = broken ?? null;
  const enabled = options.enabled ?? true;
  if (!enabled) inert ??= 'enabled is false';

  // A secret key in a browser bundle is a security incident, not a configuration slip: it is in
  // every visitor's hands already. The SDK will not send with it, and will not keep it either.
  const secret = given.startsWith('vnk_sk_');
  const writeKey = secret ? '' : given;
  let refused: string | null = null;
  if (inert === null && secret) refused = 'a secret key (vnk_sk_…) must never be used in a browser, and this one should be rotated; use the project write key (vnk_pk_…). Nothing will be sent';
  else if (inert === null && writeKey === '') refused = 'no write key: pass { writeKey } to init(). Nothing will be sent until there is one';
  else if (writeKey !== '' && !writeKey.startsWith('vnk_pk_')) warn('the write key does not look like a project write key (vnk_pk_…)');
  if (refused !== null) inert = secret ? 'a secret key was refused' : 'no write key';

  const environment = text(options.environment, detectEnvironment());
  const enabledEnvironments = strings('enabledEnvironments', options.enabledEnvironments);
  if (enabledEnvironments.length > 0 && !enabledEnvironments.includes(environment)) {
    inert ??= `environment "${environment}" is not in enabledEnvironments`;
  }

  const respectDnt = options.respectDnt ?? false;
  if (respectDnt && doNotTrack()) inert ??= 'Do Not Track / Global Privacy Control is on and respectDnt is set';

  const initial: { tags?: unknown; context?: unknown } = isObject(options.initialScope) ? options.initialScope : {};
  const pageviews = options.autoPageviews ?? true;
  const autocapture = options.autocapture ?? false;
  const crumbs = options.breadcrumbs ?? true;
  const maxValueBytes = clamp('maxValueBytes', options.maxValueBytes, 16, MAX_STRING_BYTES, MAX_STRING_BYTES);

  const resolved: Resolved = {
    writeKey,
    host: normalizeHost(options.host, warn),
    enabled,
    debug: options.debug === true,
    analytics: options.analytics ?? true,
    errors: options.errors ?? options.autoCaptureErrors ?? true,
    release: text(options.release),
    environment,
    enabledEnvironments,
    flushAt: clamp('flushAt', options.flushAt, 1, 1000, 20),
    flushIntervalMs: clamp('flushIntervalMs', options.flushIntervalMs, 250, 300_000, 10_000),
    maxQueueSize: clamp('maxQueueSize', options.maxQueueSize, 1, 10_000, 500),
    requestTimeoutMs: clamp('requestTimeoutMs', options.requestTimeoutMs, 1_000, 60_000, 10_000),
    shutdownTimeout: clamp('shutdownTimeout', options.shutdownTimeout, 0, 60_000, 2_000),
    gzip: options.gzip ?? true,
    persistQueue: options.persistQueue ?? true,
    autoPageviews:
      typeof pageviews === 'object'
        ? { enabled: true, path: pageviews.path ?? true, search: pageviews.search ?? false, hash: pageviews.hash ?? false, leave: pageviews.leave ?? false }
        : { enabled: pageviews, path: true, search: false, hash: false, leave: false },
    autocapture:
      typeof autocapture === 'object'
        ? { clicks: autocapture.clicks ?? true, forms: autocapture.forms ?? true }
        : { clicks: autocapture, forms: autocapture },
    sessionTimeoutMs: clamp('sessionTimeoutMs', options.sessionTimeoutMs, 60_000, 36_000_000, 1_800_000),
    sessionMaxMs: clamp('sessionMaxMs', options.sessionMaxMs, 60_000, 7 * 86_400_000, 86_400_000),
    breadcrumbs:
      typeof crumbs === 'object'
        ? { console: crumbs.console ?? true, network: crumbs.network ?? true, navigation: crumbs.navigation ?? true, click: crumbs.click ?? true }
        : { console: crumbs, network: crumbs, navigation: crumbs, click: crumbs },
    maxBreadcrumbs: clamp('maxBreadcrumbs', options.maxBreadcrumbs, 0, 50, 30),
    sampleRate: clamp('sampleRate', options.sampleRate, 0, 1, 1),
    errorSampleRate: clamp('errorSampleRate', options.errorSampleRate, 0, 1, 1),
    maxErrorsPerMinute: clamp('maxErrorsPerMinute', options.maxErrorsPerMinute, 1, 1000, 25),
    maxEventsPerMinute: clamp('maxEventsPerMinute', options.maxEventsPerMinute, 1, 60_000, 600),
    dedupe: options.dedupe ?? true,
    ignoreErrors: patterns('ignoreErrors', options.ignoreErrors),
    denyUrls: patterns('denyUrls', options.denyUrls),
    allowUrls: patterns('allowUrls', options.allowUrls),
    disableErrorDefaults: options.disableErrorDefaults ?? false,
    superProperties: isObject(options.superProperties) ? options.superProperties : {},
    sendDefaultPii: options.sendDefaultPii ?? false,
    redactedKeys: strings('redactedKeys', options.redactedKeys),
    propertyDenylist: strings('propertyDenylist', options.propertyDenylist),
    disablePersistence: options.disablePersistence ?? false,
    crossSubdomainCookie: options.crossSubdomainCookie ?? false,
    useBeacon: options.useBeacon ?? true,
    optOutByDefault: options.optOutByDefault ?? false,
    respectDnt,
    filterBots: options.filterBots ?? true,
    propagateIdentity: patterns('propagateIdentity', options.propagateIdentity),
    initialScope: {
      tags: isObject(initial.tags) ? { ...(initial.tags as Record<string, string>) } : {},
      context: isObject(initial.context) ? { ...initial.context } : {},
    },
    maxValueBytes,
    normalizeDepth: clamp('normalizeDepth', options.normalizeDepth, 1, MAX_DEPTH, MAX_DEPTH),
    includeRawStack: options.includeRawStack ?? false,
    attachStacktrace: options.attachStacktrace ?? false,
    integrations: list<Integration>('integrations', options.integrations).filter((i) => {
      const ok = typeof i === 'object' && i !== null && typeof i.setup === 'function';
      if (!ok) warn('an integration without a setup() function was dropped');

      return ok;
    }),
    beforeSend: hooks('beforeSend', options.beforeSend),
    beforeTrack: hooks('beforeTrack', options.beforeTrack),
    beforeBreadcrumb: hooks('beforeBreadcrumb', options.beforeBreadcrumb),
    onError: typeof options.onError === 'function' ? options.onError : undefined,
    inert,
    warnings,
  };

  if (refused !== null) logger.error(refused);
  // Switched off on purpose is a decision, not a problem: only debug output mentions it.
  else if (!enabled && broken === undefined) logger.debug('inert: enabled is false');
  else if (inert !== null) logger.warn(`inert: ${inert}`);

  return resolved;
}

function normalizeHost(host: unknown, warn: (m: string) => void): string {
  if (host === undefined || host === '') return DEFAULT_HOST;
  const text = safeString(host).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(text)) {
    warn(`host "${text}" is not an http(s) URL; using ${DEFAULT_HOST}`);

    return DEFAULT_HOST;
  }

  return text;
}

/** Localhost, loopback, `.local` and `file:` pages are development; everything else is production. */
export function detectEnvironment(): string {
  const loc = typeof location === 'object' && location !== null ? location : undefined;
  if (loc === undefined) return 'production';
  const host = loc.hostname ?? '';
  if (loc.protocol === 'file:') return 'development';
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')) {
    return 'development';
  }

  return 'production';
}

/**
 * Four signals, deliberately read permissively (`'1'`, `1`, `'yes'`, `true`): `navigator.doNotTrack`
 * and the two legacy spellings, plus Global Privacy Control, which replaced DNT in the browsers
 * that still ship one and is legally load-bearing in some jurisdictions.
 */
export function doNotTrack(): boolean {
  const nav = typeof navigator === 'object' ? (navigator as Navigator & { msDoNotTrack?: unknown; globalPrivacyControl?: unknown }) : undefined;
  const win = typeof window === 'object' ? (window as Window & { doNotTrack?: unknown }) : undefined;
  const yes = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'yes' || value === 'true';

  return yes(nav?.doNotTrack) || yes(nav?.msDoNotTrack) || yes(win?.doNotTrack) || yes(nav?.globalPrivacyControl);
}

export function isLevel(value: unknown): value is (typeof LEVELS)[number] {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}
