// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { Identity } from '../src/browser/identity.js';
import { cookieDomain, cookieStore, createStores, forgetCookieDomain, memoryStore } from '../src/browser/storage.js';
import { Logger } from '../src/core/logger.js';

const logger = new Logger(() => {}, false);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetCookieDomain();
});

describe('stores', () => {
  it('prefers localStorage for data and keeps a per-tab store', () => {
    const stores = createStores({ disablePersistence: false, crossSubdomainCookie: false });
    expect(stores.data.kind).toBe('local');
    expect(stores.tab.kind).toBe('session');
    stores.data.set('a_1', 'x');
    stores.data.set('b_1', 'y');
    expect(stores.data.keys('a_')).toEqual(['a_1']);
  });

  it('is memory only when persistence is disabled', () => {
    const stores = createStores({ disablePersistence: true, crossSubdomainCookie: false });
    expect([stores.identity.kind, stores.data.kind, stores.tab.kind]).toEqual(['memory', 'memory', 'memory']);
  });

  it('has no cookie domain on localhost or an IP', () => {
    expect(cookieDomain('localhost')).toBeNull();
    forgetCookieDomain();
    expect(cookieDomain('127.0.0.1')).toBeNull();
  });

  it('round-trips a cookie', () => {
    const store = cookieStore({ domain: null, secure: false, maxAgeSeconds: 60 });
    expect(store).not.toBeNull();
    store!.set('k', 'v w');
    expect(store!.get('k')).toBe('v w');
    store!.remove('k');
    expect(store!.get('k')).toBeNull();
  });
});

describe('identity', () => {
  const make = (now: () => number, store = memoryStore()) =>
    new Identity({ identity: store, data: memoryStore(), tab: memoryStore() }, 'vnk_pk_x', { sessionTimeoutMs: 1000, sessionMaxMs: 5000, optOutByDefault: false, now }, logger);

  it('rotates the session after idle and after the hard cap, guarding against clock jumps', () => {
    let t = 10_000;
    const id = make(() => t);
    const first = id.sessionId();
    t += 500;
    expect(id.sessionId()).toBe(first);
    t += 1500;
    const second = id.sessionId();
    expect(second).not.toBe(first);
    t -= 100_000; // clock jumped backwards
    expect(id.sessionId()).not.toBe(second);
  });

  it('adopts a sibling tab\'s session from the shared store before declaring idle', () => {
    let t = 10_000;
    const store = memoryStore();
    const opts = { sessionTimeoutMs: 10_000, sessionMaxMs: 100_000, optOutByDefault: false, now: () => t };
    const a = new Identity({ identity: store, data: memoryStore(), tab: memoryStore() }, 'vnk_pk_x', opts, logger);
    const b = new Identity({ identity: store, data: memoryStore(), tab: memoryStore() }, 'vnk_pk_x', opts, logger);
    const session = a.sessionId();
    expect(b.sessionId()).toBe(session);
    t += 6000;
    b.sessionId(); // the sibling keeps it alive; activity writes through every five seconds
    t += 6000;
    expect(a.sessionId()).toBe(session); // 12 s since a's own activity, 6 s since the sibling's
  });

  it('remembers links and reports a rebind', () => {
    const id = make(() => 0);
    expect(id.setUser('a')).toBe('new');
    expect(id.setUser('a')).toBe('known');
    expect(id.setUser('b')).toBe('rebind');
    id.reset();
    expect(id.setUser('b')).toBe('new');
  });

  it('keeps consent across reset', () => {
    const id = make(() => 0);
    id.setConsent(false);
    id.reset();
    expect(id.allowed).toBe(false);
  });
});
