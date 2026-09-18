import * as facade from './index.js';
import type { VinktarOptions } from './options.js';
import { natives } from './browser/natives.js';
import { safeString } from './core/guard.js';

/**
 * The CDN build's entry point: `window.vinktar`.
 *
 * Two ways to install. A `<script src="…/vinktar.min.js" data-key="vnk_pk_…">` tag reads its
 * options from `data-*` attributes and calls `init()` itself. Or the documented snippet defines a
 * stub before the script loads (`window.vinktar = { q: [] }` plus methods that push into `q`) so
 * calls made during the first render are kept; that queue is drained here, in order, and `init`
 * runs first if it is in it.
 *
 * The stub's `__sv` marks it so pasting the snippet twice does not create a second queue, and
 * `toString()` says "(stub)" so a developer logging the object can see the bundle has not loaded.
 */
type Stub = { q?: unknown[][]; __sv?: number } | undefined;

const win = natives.window as (Window & { vinktar?: unknown }) | undefined;

function install(): void {
  if (win === undefined) return;
  const stub = win.vinktar as Stub;
  const api = { ...facade, toString: () => `vinktar/${facade.VERSION}` };
  win.vinktar = api;

  const script = currentScript();
  const queued = Array.isArray(stub?.q) ? stub.q : [];
  const initInQueue = queued.some((call) => call[0] === 'init');

  if (script !== null && !initInQueue) facade.init(optionsFromAttributes(script));

  for (const call of queued) {
    try {
      const [method, ...args] = call;
      const fn = (api as Record<string, unknown>)[safeString(method)];
      if (typeof fn === 'function') (fn as (...a: unknown[]) => unknown)(...args);
    } catch {
      // A queued call that throws, or an entry that is not a call, must not stop the ones after it.
    }
  }
}

/** The tag that loaded this bundle, by `document.currentScript` or by looking for a keyed tag. */
function currentScript(): HTMLScriptElement | null {
  const doc = natives.document;
  if (doc === undefined) return null;
  const current = doc.currentScript;
  if (current instanceof HTMLScriptElement && current.hasAttribute('data-key')) return current;
  // `defer`/`async` tags and module scripts leave currentScript null; find the tag by its key.
  for (const script of Array.from(doc.querySelectorAll('script[data-key]'))) {
    if (script instanceof HTMLScriptElement) return script;
  }

  return null;
}

const BOOLEANS = [
  'debug', 'analytics', 'errors', 'autocapture', 'auto-pageviews', 'send-default-pii', 'cross-subdomain-cookie',
  'opt-out-by-default', 'respect-dnt', 'filter-bots', 'gzip', 'persist-queue', 'disable-persistence', 'dedupe',
] as const;
const STRINGS = ['host', 'release', 'environment'] as const;
const NUMBERS = ['sample-rate', 'error-sample-rate', 'flush-at', 'flush-interval-ms', 'session-timeout-ms', 'max-breadcrumbs'] as const;

export function optionsFromAttributes(script: Element): VinktarOptions {
  const options: Record<string, unknown> = {
    writeKey: script.getAttribute('data-key') ?? script.getAttribute('data-write-key') ?? '',
  };
  const camel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

  for (const name of STRINGS) {
    const value = script.getAttribute(`data-${name}`);
    if (value !== null && value !== '') options[camel(name)] = value;
  }
  for (const name of NUMBERS) {
    const value = script.getAttribute(`data-${name}`);
    if (value !== null && value !== '' && Number.isFinite(Number(value))) options[camel(name)] = Number(value);
  }
  for (const name of BOOLEANS) {
    const value = script.getAttribute(`data-${name}`);
    if (value === null) continue;
    // A bare attribute (`data-debug`) means on, which is what anyone typing it expects.
    options[camel(name)] = !(value === 'false' || value === '0' || value === 'off');
  }

  return options as VinktarOptions;
}

// A script tag cannot be wrapped in a `try` by the page that includes it.
try {
  install();
} catch (error) {
  natives.console.error(`[vinktar] the bundle failed to start, so nothing will be sent: ${safeString(error)}`);
}
