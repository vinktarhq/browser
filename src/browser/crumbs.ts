import type { Breadcrumb } from '../core/breadcrumbs.js';
import { truncateToBytes } from '../core/bytes.js';
import type { Logger } from '../core/logger.js';
import { matches } from '../core/filters.js';
import { safeString } from '../core/guard.js';
import type { Instrumentation } from './instrument.js';
import { natives } from './natives.js';
import type { Navigation } from './navigation.js';

/**
 * Where breadcrumbs come from: console, network, navigation, clicks.
 *
 * Network crumbs record method, URL, status and duration and nothing else: never a body, never a
 * header. URLs lose their query and fragment unless PII is allowed. The SDK's own ingest requests
 * are skipped, and so is anything logged while the SDK is writing to the console itself
 * (`logger.isReentrant`), because a warning about a dropped error must not become a breadcrumb on
 * the next error, which mentions the warning, and so on.
 *
 * The same `fetch`/XHR patch carries identity propagation: `X-Vinktar-Device-Id` and
 * `X-Vinktar-Session-Id` are added to requests whose origin the application listed, so a server
 * SDK can stitch its events and errors to this visit. Only listed origins, ever: a header on a
 * request to a third party would trigger a CORS preflight that party never agreed to.
 *
 * Every wrapper here is transparent. The original is called once, with the caller's own arguments
 * (the identity headers are the one addition), and the caller gets what it returned or threw:
 * `fetch(undefined)` stays a rejected promise, `xhr.open('GET', undefined)` stays a request for
 * "undefined". What the SDK does around the call sits in a `try` of its own, so a value it cannot
 * read costs a breadcrumb and never a request.
 */
export interface CrumbSources {
  readonly console: boolean;
  readonly network: boolean;
  readonly navigation: boolean;
  readonly click: boolean;
}

export interface CrumbOptions {
  readonly sources: CrumbSources;
  readonly sendDefaultPii: boolean;
  readonly ingestHost: string;
  readonly propagateTo: ReadonlyArray<string | RegExp>;
  readonly identity: () => { deviceId: string; sessionId: string };
  readonly add: (crumb: Partial<Breadcrumb>) => void;
  readonly logger: Logger;
  readonly navigation: Navigation;
}

const CONSOLE_LEVELS = ['debug', 'info', 'log', 'warn', 'error'] as const;
const CLICK_DEBOUNCE_MS = 1_000;

export function installCrumbSources(instrumentation: Instrumentation, options: CrumbOptions): void {
  const win = natives.window;
  if (win === undefined) return;

  if (options.sources.console) installConsole(instrumentation, options);
  if (options.sources.network || options.propagateTo.length > 0) {
    installFetch(instrumentation, options);
    installXhr(instrumentation, options);
  }
  if (options.sources.navigation) {
    const unsubscribe = options.navigation.subscribe((change) => {
      options.add({ category: 'navigation', message: `${change.type}`, data: { from: stripUrl(change.from, options.sendDefaultPii), to: stripUrl(change.to, options.sendDefaultPii) } });
    });
    instrumentation.onTeardown(unsubscribe);
  }
  if (options.sources.click) installClicks(instrumentation, options);
}

function installConsole(instrumentation: Instrumentation, options: CrumbOptions): void {
  const target = (globalThis as { console?: Console }).console;
  if (target === undefined) return;

  for (const level of CONSOLE_LEVELS) {
    const wrap = (original: Console[typeof level]): Console[typeof level] => {
      return function patched(this: Console, ...args: unknown[]) {
        if (!options.logger.isReentrant) {
          try {
            options.add({
              category: 'console',
              level: level === 'warn' ? 'warning' : level === 'error' ? 'error' : level === 'debug' ? 'debug' : 'info',
              message: formatArgs(args),
            });
          } catch {
            // Never let a breadcrumb break console.log.
          }
        }

        return original.apply(this, args as never[]);
      } as Console[typeof level];
    };
    instrumentation.patch(target, level, wrap, `console.${level}`);
  }
}

/** Arguments to one line, cheaply: strings as they are, everything else summarised. */
export function formatArgs(args: readonly unknown[]): string {
  const parts: string[] = [];
  for (const arg of args.slice(0, 8)) {
    if (typeof arg === 'string') parts.push(arg);
    else if (arg instanceof Error) parts.push(`${arg.name}: ${arg.message}`);
    else if (typeof arg === 'object' && arg !== null) {
      try {
        parts.push(truncateToBytes(JSON.stringify(arg) ?? '[object]', 256));
      } catch {
        parts.push('[object]');
      }
    } else parts.push(safeString(arg));
  }

  return parts.join(' ');
}

function installFetch(instrumentation: Instrumentation, options: CrumbOptions): void {
  const win = natives.window!;
  instrumentation.patch(win, 'fetch', (original) => {
    return function patched(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      let call = args;
      let done: ((status: number | string) => void) | undefined;
      try {
        const [input, init] = args;
        const request = typeof input === 'object' && input !== null && !(input instanceof URL) ? input : undefined;
        const url = resolveUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : safeText(request?.url));
        if (url !== '' && !url.startsWith(options.ingestHost)) {
          if (shouldPropagate(url, options.propagateTo)) {
            const { deviceId, sessionId } = options.identity();
            const headers = new Headers(init?.headers ?? request?.headers);
            headers.set('X-Vinktar-Device-Id', deviceId);
            headers.set('X-Vinktar-Session-Id', sessionId);
            call = [input, { ...init, headers }];
          }
          if (options.sources.network) {
            const method = safeText(init?.method ?? request?.method, 'GET').toUpperCase();
            const shown = stripUrl(url, options.sendDefaultPii);
            const started = Date.now();
            done = (status) =>
              options.add({
                category: 'http',
                message: `${method} ${shown}`,
                data: { method, url: shown, status, duration_ms: Date.now() - started },
                ...(typeof status === 'number' && status >= 400 ? { level: 'error' as const } : {}),
              });
          }
        }
      } catch {
        // Not a request this can describe, or headers it cannot add to: it goes through as it came.
        call = args;
      }
      if (done === undefined) return original.apply(this, call);
      const finish = quiet(done);

      let result: Promise<Response>;
      try {
        result = original.apply(this, call);
      } catch (error) {
        // A wrapper further down threw synchronously. Record it, then surface it exactly as thrown.
        finish('error');
        throw error;
      }
      // An earlier wrapper may return something that is not a promise. It is the page's either way.
      if (!isThenable(result)) return result;

      return result.then(
        (response) => {
          finish(statusOf(response));

          return response;
        },
        (error: unknown) => {
          finish('error');
          throw error;
        },
      );
    } as typeof fetch;
  });
}

function installXhr(instrumentation: Instrumentation, options: CrumbOptions): void {
  const XHR = natives.XMLHttpRequest;
  if (XHR === undefined) return;
  const proto = XHR.prototype;
  const META = '__vinktar_xhr__';

  instrumentation.patch(
    proto,
    'open',
    (original) => {
      return function patched(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
        try {
          const [method, url] = args;
          // The browser coerces whatever it is given; so does this, for the breadcrumb only.
          const absolute = resolveUrl(typeof url === 'string' ? url : safeString(url));
          (this as unknown as Record<string, unknown>)[META] = { method: safeString(method).toUpperCase(), url: absolute, started: 0 };
        } catch {
          // The request opens without a breadcrumb.
        }

        return original.apply(this, args);
      } as XMLHttpRequest['open'];
    },
    'XMLHttpRequest.open',
  );

  instrumentation.patch(
    proto,
    'send',
    (original) => {
      return function patched(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
        try {
          const meta = (this as unknown as Record<string, unknown>)[META] as { method: string; url: string; started: number } | undefined;
          if (meta !== undefined && meta.url !== '' && !meta.url.startsWith(options.ingestHost)) {
            if (shouldPropagate(meta.url, options.propagateTo)) {
              try {
                const { deviceId, sessionId } = options.identity();
                this.setRequestHeader('X-Vinktar-Device-Id', deviceId);
                this.setRequestHeader('X-Vinktar-Session-Id', sessionId);
              } catch {
                // Already sent, or a header the browser refuses: the request goes without it.
              }
            }
            if (options.sources.network) {
              meta.started = Date.now();
              this.addEventListener(
                'loadend',
                quiet(() => {
                  const status = this.status;
                  options.add({
                    category: 'http',
                    message: `${meta.method} ${stripUrl(meta.url, options.sendDefaultPii)}`,
                    data: { method: meta.method, url: stripUrl(meta.url, options.sendDefaultPii), status, duration_ms: Date.now() - meta.started },
                    ...(status === 0 || status >= 400 ? { level: 'error' as const } : {}),
                  });
                }),
              );
            }
          }
        } catch {
          // The request is sent without a breadcrumb.
        }

        return original.apply(this, args);
      } as XMLHttpRequest['send'];
    },
    'XMLHttpRequest.send',
  );
}

/** `fn`, for a place where what it throws would land in the page: a listener, a promise handler. */
function quiet<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch {
      // A breadcrumb must never reach the request it describes.
    }
  };
}

function safeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function isThenable(value: unknown): boolean {
  try {
    return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
  } catch {
    return false;
  }
}

function statusOf(response: unknown): number | string {
  try {
    const status = (response as { status?: unknown } | null | undefined)?.status;

    return typeof status === 'number' ? status : 'unknown';
  } catch {
    return 'unknown';
  }
}

function installClicks(instrumentation: Instrumentation, options: CrumbOptions): void {
  const doc = natives.document!;
  let lastKey = '';
  let lastAt = 0;

  instrumentation.listen(
    doc,
    'click',
    (event) => {
      const target = eventTarget(event);
      if (target === null) return;
      const selector = describeElement(target);
      const now = Date.now();
      // The same element clicked repeatedly within a second is one crumb, not a flood.
      if (selector === lastKey && now - lastAt < CLICK_DEBOUNCE_MS) return;
      lastKey = selector;
      lastAt = now;
      options.add({ category: 'ui.click', message: selector });
    },
    { capture: true, passive: true },
  );
}

/** The real target, through shadow roots. */
export function eventTarget(event: Event): Element | null {
  try {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const first = path[0] ?? event.target;

    return first instanceof Element ? first : null;
  } catch {
    return event.target instanceof Element ? event.target : null;
  }
}

/** `form#checkout > button.primary[type="submit"]`: identity, never text. */
export function describeElement(element: Element, depth = 3): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current !== null && parts.length < depth && current !== natives.document?.documentElement) {
    parts.unshift(selectorFor(current));
    current = current.parentElement;
  }

  return truncateToBytes(parts.join(' > '), 256);
}

function selectorFor(element: Element): string {
  let out = element.tagName.toLowerCase();
  if (element.id) out += `#${element.id}`;
  const classes = typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).slice(0, 3) : [];
  for (const cls of classes) out += `.${cls}`;
  for (const attr of ['name', 'type', 'role', 'aria-label']) {
    const value = attribute(element, attr);
    if (value !== null && value !== '') out += `[${attr}="${truncateToBytes(value, 32)}"]`;
  }

  return out;
}

/**
 * An attribute, read through the prototype. A form control named `getAttribute` (or `id`, or
 * `action`) replaces that property on its form, and the form's own method is then an `<input>`.
 */
export function attribute(element: Element, name: string): string | null {
  try {
    return Element.prototype.getAttribute.call(element, name);
  } catch {
    return null;
  }
}

export function resolveUrl(url: string): string {
  if (url === '') return '';
  try {
    return new URL(url, natives.window?.location.href).href;
  } catch {
    return url;
  }
}

/** Origin and path only, unless PII is allowed. */
export function stripUrl(url: string, sendDefaultPii: boolean): string {
  if (sendDefaultPii) return url;
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0]?.split('#')[0] ?? url;
  }
}

function shouldPropagate(url: string, origins: ReadonlyArray<string | RegExp>): boolean {
  if (origins.length === 0) return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }

  return matches(origins, origin);
}
