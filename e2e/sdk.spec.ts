import { expect, test } from '@playwright/test';

import { pageHtml, startIngest, type Ingest } from './harness.js';

let ingest: Ingest;

test.beforeEach(async () => {
  ingest = await startIngest('');
  (ingest as { page?: string }).page = '';
});

test.afterEach(async () => {
  await ingest.close();
});

async function open(page: import('@playwright/test').Page, extra = ''): Promise<void> {
  // The page is served by the harness itself, so replace it with one that points back at it.
  await page.route(`${ingest.url}/`, (route) => route.fulfill({ contentType: 'text/html', body: pageHtml(ingest.url, extra) }));
  await page.goto(`${ingest.url}/`);
}

test('sends a pageview on load with the three allowed headers', async ({ page }) => {
  await open(page);
  const [first] = await ingest.waitFor((r) => r.length >= 1);
  expect(first!.path).toBe('/v1/batch');
  expect(first!.headers['x-vinktar-key']).toBe('vnk_pk_e2e');
  const batch = first!.body['batch'] as Array<Record<string, unknown>>;
  expect(batch[0]!['name']).toBe('$pageview');
  expect((batch[0]!['context'] as Record<string, unknown>)['$lib']).toBe('vinktar-browser');
});

test('compresses a large batch and the server can read it', async ({ page }) => {
  await open(page);
  await ingest.waitFor((r) => r.length >= 1);
  await page.evaluate(() => {
    const v = (window as unknown as { vinktar: { track(n: string, p: object): void; flush(): Promise<boolean> } }).vinktar;
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
    (window as unknown as { vinktar: { track(n: string): void } }).vinktar.track('last words');
  });
  await page.close();
  const received = await ingest.waitFor((r) => r.some((x) => (x.body['batch'] as Array<{ name: string }> | undefined)?.some((e) => e.name === 'last words')));
  expect(received.length).toBeGreaterThanOrEqual(2);
  await context.close();
});

test('scrubs a secret out of an error message', async ({ page }) => {
  await open(page);
  await ingest.waitFor((r) => r.length >= 1);
  await page.evaluate(() => {
    (window as unknown as { vinktar: { captureException(e: unknown): string } }).vinktar.captureException(new Error('key sk_live_abcdefghijklmnop leaked'));
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
    await (window as unknown as { vinktar: { flush(): Promise<boolean> } }).vinktar.flush();
  });
  const received = await ingest.waitFor((r) => r.flatMap((x) => (x.body['batch'] as Array<{ name: string }> | undefined) ?? []).filter((e) => e.name === '$pageview').length >= 2);
  const views = received.flatMap((x) => (x.body['batch'] as Array<{ name: string; payload: Record<string, unknown> }> | undefined) ?? []).filter((e) => e.name === '$pageview');
  expect(views).toHaveLength(2);
  expect(views[1]!.payload['$navigation_type']).toBe('pushState');
});
