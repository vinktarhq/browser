/**
 * Pristine references to the platform APIs the SDK uses, captured the moment this module loads.
 *
 * Two reasons. The SDK patches `fetch`, `XMLHttpRequest` and `console` for breadcrumbs, and must
 * never observe its own traffic or its own warnings through those patches. And third-party
 * scripts patch the same globals, sometimes to throw synchronously; sending analytics through
 * somebody else's wrapper is how a customer's "fetch replacement" ends up in the SDK's stack.
 *
 * Every property is optional: this module is imported in Node during SSR and in workers, where
 * `window` does not exist, and the client checks what it needs.
 */
const g = globalThis as typeof globalThis & Record<string, unknown>;
const win = typeof window === 'object' && window !== null ? window : undefined;
const nav = typeof navigator === 'object' && navigator !== null ? navigator : undefined;
const doc = typeof document === 'object' && document !== null ? document : undefined;

function bound<T extends (...args: never[]) => unknown>(owner: object | undefined, name: string): T | undefined {
  if (owner === undefined) return undefined;
  const fn = (owner as Record<string, unknown>)[name];

  return typeof fn === 'function' ? (fn.bind(owner) as T) : undefined;
}

export type Timer = (fn: () => void, ms?: number) => ReturnType<typeof setTimeout>;

const timer: Timer = bound<Timer>(g, 'setTimeout') ?? ((fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; });
const clearTimer: (t: ReturnType<typeof setTimeout>) => void = bound(g, 'clearTimeout') ?? (() => {});

export const natives = {
  window: win,
  document: doc,
  navigator: nav,
  fetch: bound<typeof fetch>(g, 'fetch'),
  sendBeacon: bound<Navigator['sendBeacon']>(nav, 'sendBeacon'),
  setTimeout: timer,
  clearTimeout: clearTimer,
  XMLHttpRequest: g['XMLHttpRequest'] as typeof XMLHttpRequest | undefined,
  Blob: g['Blob'] as typeof Blob | undefined,
  CompressionStream: g['CompressionStream'] as typeof CompressionStream | undefined,
  AbortController: g['AbortController'] as typeof AbortController | undefined,
  console: {
    debug: bound<Console['debug']>(g['console'] as object, 'debug') ?? (() => {}),
    info: bound<Console['info']>(g['console'] as object, 'info') ?? (() => {}),
    warn: bound<Console['warn']>(g['console'] as object, 'warn') ?? (() => {}),
    error: bound<Console['error']>(g['console'] as object, 'error') ?? (() => {}),
  },
};

export const hasDom = win !== undefined && doc !== undefined;
