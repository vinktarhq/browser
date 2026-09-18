// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installHarness, tick, type Harness } from './harness.js';

type Facade = typeof import('../src/index.js');

let harness: Harness;
let sdk: Facade;
const lines: string[] = [];
const logger = (_level: string, message: string): void => void lines.push(message);

beforeEach(async () => {
  vi.resetModules();
  lines.splice(0);
  localStorage.clear();
  sessionStorage.clear();
  harness = installHarness();
  sdk = await import('../src/index.js');
});

// Every client is closed after its test, so patches and listeners never leak between tests.
const open: Array<{ close(): Promise<boolean> }> = [];
const make = (options: Parameters<Facade['init']>[0]): InstanceType<Facade['Vinktar']> => {
  const client = new sdk.Vinktar(options);
  open.push(client);

  return client;
};

afterEach(async () => {
  await sdk.close();
  for (const client of open.splice(0)) await client.close();
  vi.unstubAllGlobals();
});

const KEY = 'vnk_pk_test_key_0001';
// happy-dom reports `navigator.webdriver`, so the bot filter would (correctly) drop every analytics event.
const BASE = { writeKey: KEY, logger, filterBots: false } as const;

describe('init', () => {
  it('is inert with a secret key and without a key, and says so once at error level', async () => {
    for (const [options, said] of [[{ writeKey: 'vnk_sk_secret' }, /secret key/], [{}, /no write key/]] as const) {
      const errors: string[] = [];
      const inert = make({ ...options, logger: (level, message) => void (level === 'error' && errors.push(message)) });
      inert.track('x');
      inert.captureException(new Error('x'));
      expect(await inert.flush()).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(said);
    }
    expect(harness.requests).toHaveLength(0);
  });

  it('sends the first pageview at once, on the next tick', async () => {
    sdk.init({ ...BASE });
    await tick(5);
    const [first] = harness.batches();
    expect(first?.['name']).toBe('$pageview');
    expect(first?.['device_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.['session_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((first?.['context'] as Record<string, unknown>)['$lib']).toBe('vinktar-browser');
    expect(harness.requests[0]!.headers['x-vinktar-key']).toBe(KEY);
    expect(Object.keys(harness.requests[0]!.headers).sort()).toEqual(['content-type', 'x-vinktar-key']);
  });

  it('compresses bodies of a kilobyte and over, and sends exactly the three allowed headers', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    for (let i = 0; i < 10; i += 1) client.track('bulk', { text: 'x'.repeat(200), i });
    await client.flush();
    expect(harness.requests[0]!.gzip).toBe(true);
    expect(Object.keys(harness.requests[0]!.headers).sort()).toEqual(['content-encoding', 'content-type', 'x-vinktar-key']);
    expect(harness.batches()).toHaveLength(10);
  });

  it('warns about unknown options and clamps bad numbers', () => {
    make({ ...BASE, flushAt: 0, autoPageviews: false, ...({ bogus: 1 } as object) });
    expect(lines.some((l) => l.includes('unknown option "bogus"'))).toBe(true);
    expect(lines.some((l) => l.includes('flushAt 0'))).toBe(true);
  });

  it('replays calls made before init', async () => {
    sdk.track('early', { n: 1 });
    sdk.init({ ...BASE, autoPageviews: false });
    await sdk.flush();
    expect(harness.batches().map((e) => e['name'])).toEqual(['early']);
  });
});

describe('analytics', () => {
  it('merges super properties, registered properties and initial attribution', async () => {
    const client = make({ ...BASE, autoPageviews: false, superProperties: { plan: 'pro' } });
    client.register({ theme: 'dark' });
    client.track('clicked', { button: 'buy' });
    await client.flush();
    const payload = harness.batches()[0]!['payload'] as Record<string, unknown>;
    expect(payload).toMatchObject({ plan: 'pro', theme: 'dark', button: 'buy', $initial_referrer: '$direct' });
    await client.close();
  });

  it('stamps the user on events after identify and sends the link once', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    client.identify('user_1', { email: 'a@b.com', plan: 'pro' }, { signup: '2026-01-01' });
    await tick(5);
    const identify = harness.requests[0]!.body['identify'] as Array<Record<string, unknown>>;
    expect(identify[0]).toMatchObject({ user_id: 'user_1', $set: { $email: 'a@b.com', plan: 'pro' }, $set_once: { signup: '2026-01-01' } });
    harness.reset();
    client.identify('user_1');
    client.track('after');
    await client.flush();
    expect(harness.requests[0]!.body['identify']).toBeUndefined();
    expect(harness.batches()[0]!['user_id']).toBe('user_1');
    await client.close();
  });

  it('refuses blocked ids and warns on a rebind', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    client.identify('undefined');
    expect(lines.some((l) => l.includes('not a usable user id'))).toBe(true);
    client.identify('alice');
    client.identify('bob');
    expect(lines.some((l) => l.includes('already linked'))).toBe(true);
    await client.close();
  });

  it('reset() mints a new device id and forgets the user', () => {
    const client = make({ ...BASE, autoPageviews: false });
    const before = client.getDeviceId();
    client.identify('alice');
    client.reset();
    expect(client.getDeviceId()).not.toBe(before);
    expect(client.getUserId()).toBeNull();
  });

  it('honours beforeTrack and counts the drop', async () => {
    const client = make({ ...BASE, autoPageviews: false, beforeTrack: (e) => (e['name'] === 'secret' ? null : e) });
    client.track('secret');
    client.track('public');
    await client.flush();
    expect(harness.batches().map((e) => e['name'])).toEqual(['public']);
    expect(harness.requests[0]!.body['client_report']).toEqual({ discarded: [{ reason: 'before_send', category: 'event', quantity: 1 }] });
    await client.close();
  });

  it('keeps the URL to origin and path unless PII is allowed', async () => {
    window.history.replaceState({}, '', '/checkout?token=abc&utm_source=news&gclid=123');
    const client = make({ ...BASE, autoPageviews: false });
    client.track('x');
    await client.flush();
    const context = harness.batches()[0]!['context'] as Record<string, unknown>;
    expect(context['$current_url']).toBe('http://localhost:3000/checkout');
    expect(context['utm_source']).toBe('news');
    expect(context['gclid']).toBeUndefined();
    await client.close();
  });

  it('emits one pageview per meaningful navigation, not per replaceState', async () => {
    const client = make({ ...BASE, autoPageviews: true });
    await tick(5);
    harness.reset();
    window.history.replaceState({ a: 1 }, '', window.location.pathname);
    window.history.replaceState({ a: 2 }, '', window.location.pathname + '?tab=2');
    window.history.pushState({}, '', '/settings');
    await client.flush();
    const views = harness.batches().filter((e) => e['name'] === '$pageview');
    expect(views).toHaveLength(1);
    expect((views[0]!['payload'] as Record<string, unknown>)['$navigation_type']).toBe('pushState');
    await client.close();
  });
});

describe('errors', () => {
  it('captures an exception with crash-last frames and a manual mechanism', async () => {
    const client = make({ ...BASE, autoPageviews: false, release: '1.2.3' });
    const err = new TypeError('boom');
    err.stack = 'TypeError: boom\n    at inner (https://x/app.js:10:5)\n    at outer (https://x/app.js:20:1)';
    const id = client.captureException(err, { tags: { area: 'checkout' } });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // Automatic delivery includes asynchronous compression; don't race it with a sleep.
    await vi.waitFor(() => expect(harness.errors()).toHaveLength(1));
    const [error] = harness.errors();
    expect(error).toMatchObject({ event_id: id, level: 'error', release: '1.2.3', mechanism: { type: 'manual', handled: true, synthetic: false }, tags: { area: 'checkout' } });
    const exceptions = error!['exceptions'] as Array<{ stack: Array<{ function: string; col: number }> }>;
    expect(exceptions[0]!.stack.map((f) => f.function)).toEqual(['outer', 'inner']);
    expect(exceptions[0]!.stack[1]!.col).toBe(4);
    await client.close();
  });

  it('reports uncaught errors and unhandled rejections from the window', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('uncaught'), message: 'uncaught' }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = { code: 'PAYMENT_FAILED' };
    window.dispatchEvent(rejection);
    await client.flush();
    const errors = harness.errors();
    expect(errors.map((e) => (e['mechanism'] as { type: string }).type)).toEqual(['onerror', 'onunhandledrejection']);
    expect((errors[1]!['exceptions'] as Array<{ type: string; value: string }>)[0]).toMatchObject({ type: 'UnhandledRejection', value: 'PAYMENT_FAILED' });
    await client.close();
  });

  it('dedupes, ignores and filters by URL', async () => {
    const client = make({ ...BASE, autoPageviews: false, ignoreErrors: [/ignored/], denyUrls: ['cdn.third.party'] });
    const err = new Error('same');
    err.stack = 'Error: same\n    at f (https://x/app.js:1:1)';
    client.captureException(err);
    client.captureException(err);
    client.captureException(new Error('ignored please'));
    const third = new Error('from a cdn');
    third.stack = 'Error: x\n    at f (https://cdn.third.party/w.js:1:1)';
    client.captureException(third);
    client.captureException(new Error('Script error.'));
    await client.flush();
    expect(harness.errors()).toHaveLength(1);
    await client.close();
  });

  it('carries breadcrumbs from console and clicks, never the SDK\'s own lines', async () => {
    const client = make({ writeKey: KEY, autoPageviews: false, filterBots: false });
    console.info('user did a thing', { n: 1 });
    const button = document.createElement('button');
    button.id = 'buy';
    document.body.appendChild(button);
    button.click();
    button.click();
    client.captureException(new Error('after crumbs'));
    // Wait for the automatic send already in flight, including gzip compression.
    await client.flush();
    const crumbs = harness.errors()[0]!['breadcrumbs'] as Array<{ category: string; message: string }>;
    expect(crumbs.map((c) => c.category)).toEqual(['console', 'ui.click']);
    expect(crumbs[0]!.message).toBe('user did a thing {"n":1}');
    expect(crumbs[1]!.message).toBe('body > button#buy');
    await client.close();
  });

  it('withScope returns the value and lets the exception through unreported', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    expect(client.withScope(() => 7)).toBe(7);
    expect(() =>
      client.withScope(() => {
        throw new Error('application bug');
      }),
    ).toThrow('application bug');
    await client.flush();
    expect(harness.errors()).toHaveLength(0);
  });

  it('withScope tags apply only inside', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    client.withScope((scope) => {
      scope.setTag('inside', 'yes');
      client.captureMessage('one');
    });
    client.captureMessage('two');
    await client.flush();
    const errors = harness.errors();
    expect(errors[0]!['tags']).toEqual({ inside: 'yes' });
    expect(errors[1]!['tags']).toBeUndefined();
    expect(errors[0]!['level']).toBe('info');
    await client.close();
  });
});

describe('consent and persistence', () => {
  it('sends nothing while opted out and resumes after opting in', async () => {
    const client = make({ ...BASE, autoPageviews: false, optOutByDefault: true });
    client.track('hidden');
    await client.flush();
    expect(harness.requests).toHaveLength(0);
    expect(client.hasOptedOut()).toBe(true);
    client.optIn();
    client.track('visible');
    await client.flush();
    expect(harness.batches().map((e) => e['name'])).toEqual(['visible']);
    await client.close();
  });

  it('persists the queue and a later client on the same tab picks it up', async () => {
    harness.respond(503, { error: 'storage_unavailable' });
    const first = make({ ...BASE, autoPageviews: false });
    first.track('kept');
    await first.flush();
    const slots = Object.keys(localStorage).filter((k) => k.includes('_q_'));
    expect(slots).toHaveLength(1);
    // A second page load: the same tab restores its own slot and sends it.
    const second = make({ ...BASE, autoPageviews: false });
    await tick(5);
    await second.flush();
    expect(harness.batches().map((e) => e['name'])).toEqual(['kept', 'kept']);
    await first.close();
    await second.close();
  });

  it('sends what is queued on pagehide with keepalive when beacons are off, and keeps the persisted copy', async () => {
    const client = make({ ...BASE, autoPageviews: false, flushIntervalMs: 60_000, useBeacon: false });
    client.track('last thing');
    harness.reset();
    window.dispatchEvent(new Event('pagehide'));
    await tick(5);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.keepalive).toBe(true);
    expect(Object.keys(localStorage).some((k) => k.includes('_q_'))).toBe(true);
    await client.close();
  });

  it('shares the device across two clients on one origin', () => {
    const a = make({ ...BASE, autoPageviews: false });
    const b = make({ ...BASE, autoPageviews: false });
    expect(a.getDeviceId()).toBe(b.getDeviceId());
    expect(a.getSessionId()).toBe(b.getSessionId());
  });
});

describe('lifecycle', () => {
  it('close refuses new work at once and gives every caller the same answer', async () => {
    harness.respond(503, { error: 'storage_unavailable' });
    const client = make({ ...BASE, autoPageviews: false, shutdownTimeout: 200 });
    client.track('before close');
    const first = client.close();
    const second = client.close();
    client.track('after close');
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await client.close()).toBe(false);
    expect(harness.batches().map((e) => e['name'])).toEqual(['before close']);
  });

  it('close answers true when the final delivery is accepted', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    client.track('delivered');
    expect(await client.close()).toBe(true);
    expect(harness.batches().map((e) => e['name'])).toEqual(['delivered']);
  });

  it('opting out discards the queue without reporting it as a send failure', async () => {
    const client = make({ ...BASE, autoPageviews: false });
    client.track('before opting out');
    client.optOut();
    client.optIn();
    client.track('after opting in');
    await client.flush();
    const discarded = harness.requests.flatMap((r) => (r.body['client_report'] as { discarded: Array<{ reason: string }> } | undefined)?.discarded ?? []);
    expect(discarded.filter((d) => d.reason === 'send_error')).toHaveLength(0);
    expect(harness.batches().map((e) => e['name'])).toEqual(['after opting in']);
  });

  it('does not hand the next person first-touch attribution taken from the logout page', async () => {
    window.history.replaceState({}, '', '/landing?utm_source=newsletter');
    const client = make({ ...BASE, autoPageviews: false });
    client.track('first visit');
    window.history.replaceState({}, '', '/logout?utm_source=logout');
    client.reset();
    client.track('next person');
    await client.flush();
    const initial = (name: string): string[] =>
      Object.keys((harness.batches().find((e) => e['name'] === name)!['payload'] as Record<string, unknown>) ?? {}).filter((k) => k.startsWith('$initial_'));
    expect(initial('first visit').length).toBeGreaterThan(0);
    expect(initial('next person')).toEqual([]);
    window.history.replaceState({}, '', '/');
  });

  it('adopts a login or logout made in another tab', () => {
    const here = make({ ...BASE, autoPageviews: false });
    const elsewhere = make({ ...BASE, autoPageviews: false });
    elsewhere.identify('alice');
    window.dispatchEvent(new Event('storage'));
    expect(here.getUserId()).toBe('alice');
    elsewhere.reset();
    window.dispatchEvent(new Event('storage'));
    expect(here.getUserId()).toBeNull();
    expect(here.getDeviceId()).toBe(elsewhere.getDeviceId());
  });

  it('keeps records sent from a hidden tab until the keepalive request is answered', async () => {
    const client = make({ ...BASE, autoPageviews: false, flushIntervalMs: 60_000 });
    const hide = (state: 'hidden' | 'visible'): void => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    client.track('answered');
    harness.reset();
    hide('hidden');
    await tick(5);
    hide('visible');
    expect(harness.requests).toHaveLength(1);
    expect(await client.flush()).toBe(true);
    expect(harness.requests).toHaveLength(1);

    harness.respond(503, { error: 'storage_unavailable' });
    client.track('refused while hidden');
    hide('hidden');
    await tick(5);
    hide('visible');
    expect(await client.flush()).toBe(true);
    expect(harness.batches().filter((e) => e['name'] === 'refused while hidden')).toHaveLength(2);
  });
});

describe('bots', () => {
  it('drops analytics but never errors from automated traffic', async () => {
    const client = make({ writeKey: KEY, logger, autoPageviews: false });
    client.track('from a bot');
    client.captureException(new Error('still reported'));
    await tick(5);
    await client.flush();
    expect(harness.batches()).toHaveLength(0);
    expect(harness.errors()).toHaveLength(1);
    await client.close();
  });
});

describe('transport policy through the client', () => {
  it('stops after a refused key and warns loudly', async () => {
    harness.respond(401, { error: 'invalid_api_key' });
    const client = make({ ...BASE, autoPageviews: false });
    client.track('a');
    await client.flush();
    client.track('b');
    expect(await client.flush()).toBe(false);
    expect(harness.requests).toHaveLength(1);
    expect(lines.some((l) => l.includes('write key was refused'))).toBe(true);
    await client.close();
  });
});
