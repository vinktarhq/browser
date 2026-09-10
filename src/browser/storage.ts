import { natives } from './natives.js';

/**
 * Where state lives, and how the SDK finds out which stores actually work.
 *
 * Every backend is PROBED with a set/get/remove round trip before it is trusted, because the
 * platform lies: Safari private mode throws on `setItem`, a page at a `data:` URL has a
 * `document` but throws on `document.cookie`, sandboxed iframes deny storage entirely, and some
 * embedded webviews accept a cookie and silently drop it. A `typeof` check passes in all of them.
 * When nothing works the SDK falls back to memory rather than logging an exception per event.
 *
 * Two tiers on purpose. The small identity set (device, user, session, consent) can live in a
 * cookie so sibling subdomains see the same visitor; everything else (queues, super properties,
 * attribution) is localStorage only, so the cookie stays far under the size at which browsers
 * drop it and the origin's own requests are not carrying kilobytes of SDK state as a header.
 */
export type StoreKind = 'local' | 'session' | 'cookie' | 'memory';

export interface Store {
  readonly kind: StoreKind;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Every key starting with `prefix`. */
  keys(prefix: string): string[];
}

export function memoryStore(): Store {
  const data = new Map<string, string>();

  return {
    kind: 'memory',
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
    keys: (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
  };
}

const PROBE = '__vk_probe__';

function webStore(kind: 'local' | 'session'): Store | null {
  let backing: globalThis.Storage;
  try {
    // Reading `window.localStorage` itself throws in a sandboxed frame.
    const candidate = kind === 'local' ? natives.window?.localStorage : natives.window?.sessionStorage;
    if (candidate === undefined || candidate === null) return null;
    backing = candidate;
    backing.setItem(PROBE, '1');
    if (backing.getItem(PROBE) !== '1') return null;
    backing.removeItem(PROBE);
  } catch {
    return null;
  }

  return {
    kind,
    get: (key) => {
      try {
        return backing.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        backing.setItem(key, value);
      } catch {
        // Quota, or storage revoked after the probe. The in-memory value still stands.
      }
    },
    remove: (key) => {
      try {
        backing.removeItem(key);
      } catch {
        // Nothing to do.
      }
    },
    keys: (prefix) => {
      const out: string[] = [];
      try {
        for (let i = 0; i < backing.length; i += 1) {
          const key = backing.key(i);
          if (key !== null && key.startsWith(prefix)) out.push(key);
        }
      } catch {
        // Enumeration denied: the own slot is still reachable by name.
      }

      return out;
    },
  };
}

/** 4096 bytes is where some browsers refuse a cookie outright; warn before that. */
export const COOKIE_WARN_BYTES = Math.floor(4096 * 0.9);

export interface CookieOptions {
  readonly domain: string | null;
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
  readonly onLarge?: (key: string, bytes: number) => void;
}

function readCookie(name: string): string | null {
  const doc = natives.document;
  if (doc === undefined) return null;
  let all: string;
  try {
    all = doc.cookie;
  } catch {
    return null;
  }
  const prefix = `${name}=`;
  for (const part of all.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        const value = decodeURIComponent(trimmed.slice(prefix.length));

        // A removed cookie can linger as an empty value until the browser sweeps it.
        return value === '' ? null : value;
      } catch {
        return null;
      }
    }
  }

  return null;
}

function writeCookie(name: string, value: string, maxAge: number, options: CookieOptions): void {
  const doc = natives.document;
  if (doc === undefined) return;
  let text = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
  if (options.secure) text += '; Secure';
  if (options.domain !== null && options.domain !== '') text += `; Domain=${options.domain}`;
  try {
    doc.cookie = text;
  } catch {
    // The probe passed, but the page changed its mind. Memory carries on.
  }
}

export function cookieStore(options: CookieOptions): Store | null {
  writeCookie(PROBE, '1', 60, options);
  if (readCookie(PROBE) !== '1') return null;
  writeCookie(PROBE, '', 0, options);

  return {
    kind: 'cookie',
    get: (key) => readCookie(key),
    set: (key, value) => {
      const bytes = key.length + encodeURIComponent(value).length;
      if (bytes > COOKIE_WARN_BYTES) options.onLarge?.(key, bytes);
      writeCookie(key, value, options.maxAgeSeconds, options);
    },
    remove: (key) => writeCookie(key, '', 0, options),
    keys: () => [],
  };
}

let cachedDomain: string | null | undefined;

/**
 * The widest domain a cookie can be set on, found by asking the browser.
 *
 * There is no API for "is this a public suffix", but browsers reject a cookie set on one. So walk
 * the hostname's labels from the right (`uk` → `co.uk` → `example.co.uk`), try each, and the
 * first the browser keeps is the registrable domain. Exact, and no suffix list to ship or to let
 * go stale. Localhost and IP addresses have no domain; the cookie is host-only there.
 */
export function cookieDomain(hostname: string = natives.window?.location.hostname ?? ''): string | null {
  if (cachedDomain !== undefined) return cachedDomain;
  if (hostname === '' || hostname === 'localhost' || /^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    cachedDomain = null;

    return null;
  }

  const labels = hostname.split('.');
  const key = '__vk_domain__';
  for (let i = labels.length - 2; i >= 0 && labels.length - i <= 8; i -= 1) {
    const candidate = `.${labels.slice(i).join('.')}`;
    try {
      natives.document!.cookie = `${key}=1; Domain=${candidate}; Path=/; Max-Age=3; SameSite=Lax`;
      if (readCookie(key) === '1') {
        natives.document!.cookie = `${key}=; Domain=${candidate}; Path=/; Max-Age=0; SameSite=Lax`;
        cachedDomain = candidate;

        return candidate;
      }
    } catch {
      break;
    }
  }

  cachedDomain = null;

  return null;
}

export interface Stores {
  /** Device, user, session, consent. Small, and shared across subdomains when asked. */
  readonly identity: Store;
  /** Queues, super properties, attribution. Never a cookie. */
  readonly data: Store;
  /** Per-tab: the tab id and the unloading flag. */
  readonly tab: Store;
}

export interface StoreOptions {
  readonly disablePersistence: boolean;
  readonly crossSubdomainCookie: boolean;
  readonly onLarge?: (key: string, bytes: number) => void;
}

export function createStores(options: StoreOptions): Stores {
  if (options.disablePersistence) return { identity: memoryStore(), data: memoryStore(), tab: memoryStore() };

  const local = webStore('local');
  const session = webStore('session');
  const secure = natives.window?.location.protocol === 'https:';
  const cookie = (): Store | null =>
    cookieStore({
      domain: options.crossSubdomainCookie ? cookieDomain() : null,
      secure,
      maxAgeSeconds: 365 * 86_400,
      ...(options.onLarge ? { onLarge: options.onLarge } : {}),
    });

  const identity = (options.crossSubdomainCookie ? cookie() ?? local : local ?? cookie()) ?? memoryStore();

  return {
    identity,
    data: local ?? memoryStore(),
    tab: session ?? memoryStore(),
  };
}

/** Reset the cookie-domain cache, for tests that change the hostname. */
export function forgetCookieDomain(): void {
  cachedDomain = undefined;
}
