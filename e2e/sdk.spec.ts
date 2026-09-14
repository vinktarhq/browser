import { expect, test, type Page } from '@playwright/test';

import { startIngest, startSite, type Ingest, type Received, type Site } from './harness.js';

interface Global {
  track(name: string, properties?: object): void;
  identify(userId: string): void;
  reset(): void;
  flush(): Promise<boolean>;
  close(): Promise<boolean>;
  captureException(error: unknown): string;
  getDeviceId(): string;
  getUserId(): string | null;
}

let ingest: Ingest;
let site: Site;

test.beforeEach(async () => {
  ingest = await startIngest();
  site = await startSite(ingest.url, '', ingest);
});

test.afterEach(async () => {
  await site.close();
  await ingest.close();
});

async function open(page: Page, extra = ''): Promise<void> {
  if (extra !== '') {
    await site.close();
    site = await startSite(ingest.url, extra, ingest);
  }
  await page.goto(`${site.url}/`);
}

const events = (received: Received[]): Array<Record<string, unknown>> =>
  received.flatMap((r) => (r.body['batch'] as Array<Record<string, unknown>> | undefined) ?? []);

test('sends a pageview on load, cross-origin, with the three allowed headers', async ({ page }) => {
  await open(page);
  const [first] = await ingest.waitFor((r) => r.length >= 1);
  expect(first!.path).toBe('/v1/batch');
  expect(first!.headers['x-vinktar-key']).toBe('vnk_pk_e2e');
  expect(first!.headers['origin']).toBe(site.url);
  expect(ingest.preflights()).toBeGreaterThan(0);
  const batch = first!.body['batch'] as Array<Record<string, unknown>>;
  expect(batch[0]!['name']).toBe('$pageview');
  expect((batch[0]!['context'] as Record<string, unknown>)['$lib']).toBe('vinktar-browser');
});

test('compresses a large batch and the server can read it', async ({ page }) => {
  await open(page);
  await ingest.waitFor((r) => r.length >= 1);
  await page.evaluate(() => {
    const v = (window as unknown as { vinktar: Global }).vinktar;
    for (let i = 0; i < 10; i += 1) v.track('bulk', { text: 'x'.repeat(300), i });

    return v.flush();
  });
  const received = await ingest.waitFor((r) => r.some((x) => (x.body['batch'] as unknown[] | undefined)?.length === 10));
  const big = received.find((x) => (x.body['batch'] as unknown[] | undefined)?.length === 10)!;
  expect(big.headers['content-encoding']).toBe('gzip');
});

test('reports an uncaught error with crash-last frames and a click breadcrumb', async ({ page }) => {
  await open(page, `<script>document.getElementById('buy').addEventListener('click', function boom() { throw new TypeError('clicked and broke'); });</script>`);
  await ingest.waitFor((r) => r.length >= 1);
  await page.click('#buy');
  const received = await ingest.waitFor((r) => r.some((x) => x.path === '/v1/errors'));
  const error = (received.find((x) => x.path === '/v1/errors')!.body['errors'] as Array<Record<string, unknown>>)[0]!;
  expect(error['mechanism']).toEqual({ type: 'onerror', handled: false, synthetic: false });
  const [exception] = error['exceptions'] as Array<{ type: string; value: string; stack: Array<{ function?: string; col?: number; line: number }> }>;
  expect(exception!.type).toBe('TypeError');
  expect(exception!.value).toBe('clicked and broke');
  const crash = exception!.stack[exception!.stack.length - 1]!;
  expect(crash.function ?? '').toContain('boom');
  expect(crash.line).toBeGreaterThan(0);
  const crumbs = error['breadcrumbs'] as Array<{ category: string; message: string }>;
  expect(crumbs.some((c) => c.category === 'ui.click' && c.message.includes('button#buy'))).toBe(true);
});

test('delivers what is queued when the page is closed', async ({ page, context }) => {
  await open(page);
  await ingest.waitFor((r) => r.length >= 1);
  await page.evaluate(() => {
    (window as unknown as { vinktar: Global }).vinktar.track('last words');
  });
  await page.close();
  const received = await ingest.waitFor((r) => events(r).some((e) => e['name'] === 'last words'));
  expect(received.length).toBeGreaterThanOrEqual(2);
  await context.close();
});

test('scrubs a secret out of an error message', async ({ page }) => {
  await open(page);
  await ingest.waitFor((r) => r.length >= 1);
  await page.evaluate(() => {
    (window as unknown as { vinktar: Global }).vinktar.captureException(new Error('key sk_live_abcdefghijklmnop leaked'));
  });
  const received = await ingest.waitFor((r) => r.some((x) => x.path === '/v1/errors'));
  const error = (received.find((x) => x.path === '/v1/errors')!.body['errors'] as Array<Record<string, unknown>>)[0]!;
  expect((error['exceptions'] as Array<{ value: string }>)[0]!.value).toBe('key [Filtered] leaked');
});

test('one pageview per real navigation in a single-page app', async ({ page }) => {
  await open(page);
  await ingest.waitFor((r) => r.length >= 1);
  await page.evaluate(async () => {
    history.replaceState({ a: 1 }, '', location.pathname);
    history.replaceState({ a: 2 }, '', location.pathname + '?tab=2');
    history.pushState({}, '', '/settings');
    await (window as unknown as { vinktar: Global }).vinktar.flush();
  });
  const received = await ingest.waitFor((r) => events(r).filter((e) => e['name'] === '$pageview').length >= 2);
  const views = events(received).filter((e) => e['name'] === '$pageview');
  expect(views).toHaveLength(2);
  expect((views[1]!['payload'] as Record<string, unknown>)['$navigation_type']).toBe('pushState');
});

test('keeps a batch the server did not store and sends it after a reload', async ({ page }) => {
  ingest.respond({ status: 503, body: { error: 'storage_unavailable' }, headers: { 'Retry-After': '10' } });
  await open(page);
  const [refused] = await ingest.waitFor((r) => r.length >= 1);
  expect(refused!.status).toBe(503);
  const lost = (refused!.body['batch'] as Array<{ event_id: string }>)[0]!.event_id;

  await page.reload();
  const received = await ingest.waitFor((r) => r.some((x) => x.status === 202 && events([x]).some((e) => e['event_id'] === lost)));
  // Sent again with the id and timestamp it was captured with. It may arrive more than once (the
  // unload send on reload cannot report back before the page is gone), and the server
  // deduplicates exactly those copies.
  const copies = events(received.filter((x) => x.status === 202)).filter((e) => e['event_id'] === lost);
  expect(copies.length).toBeGreaterThanOrEqual(1);
  const original = (refused!.body['batch'] as Array<Record<string, unknown>>)[0]!;
  for (const copy of copies) expect(copy['timestamp']).toBe(original['timestamp']);
});

test('a logout in one tab is adopted by the other tabs', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto(`${site.url}/`);
  await second.goto(`${site.url}/`);
  await ingest.waitFor((r) => events(r).filter((e) => e['name'] === '$pageview').length >= 2);

  const sdk = (page: Page) => ({
    identify: (id: string) => page.evaluate((u) => (window as unknown as { vinktar: Global }).vinktar.identify(u), id),
    reset: () => page.evaluate(() => (window as unknown as { vinktar: Global }).vinktar.reset()),
    device: () => page.evaluate(() => (window as unknown as { vinktar: Global }).vinktar.getDeviceId()),
    user: () => page.evaluate(() => (window as unknown as { vinktar: Global }).vinktar.getUserId()),
  });

  await sdk(first).identify('alice');
  await expect.poll(() => sdk(second).user()).toBe('alice');

  await sdk(first).reset();
  const rotated = await sdk(first).device();
  await expect.poll(() => sdk(second).device()).toBe(rotated);
  expect(await sdk(second).user()).toBeNull();
});

test('close resolves with whether the last delivery was accepted', async ({ page }) => {
  await open(page);
  await ingest.waitFor((r) => r.length >= 1);
  ingest.respond({ status: 503, body: { error: 'storage_unavailable' }, headers: { 'Retry-After': '10' } });
  const refused = await page.evaluate(() => {
    const v = (window as unknown as { vinktar: Global }).vinktar;
    v.track('not stored');

    return v.close();
  });
  expect(refused).toBe(false);

  await page.reload();
  await ingest.waitFor((r) => r.filter((x) => x.status === 202).length >= 2);
  const accepted = await page.evaluate(() => {
    const v = (window as unknown as { vinktar: Global }).vinktar;
    v.track('stored');

    return v.close();
  });
  expect(accepted).toBe(true);
});
