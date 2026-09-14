import { describe, expect, it } from 'vitest';

import { Dispatcher, type Delivery, type Outbound } from '../src/core/dispatcher.js';
import { Logger } from '../src/core/logger.js';

/** A transport that answers from a script and records what it was asked to send. */
function fake(script: Array<Partial<Delivery> | Error>) {
  const sent: Array<{ out: Outbound; gzip: boolean }> = [];
  const transport = {
    async send(out: Outbound, options: { gzip: boolean }): Promise<Delivery> {
      sent.push({ out, gzip: options.gzip });
      const next = script.shift() ?? { status: 202, body: { received: out.count, rejected: 0, errors: [] } };
      if (next instanceof Error) throw next;

      return { status: 202, body: null, ...next };
    },
  };

  return { transport, sent };
}

function make(script: Array<Partial<Delivery> | Error>, extra: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {}) {
  const lines: string[] = [];
  const { transport, sent } = fake(script);
  const now = { t: 0 };
  const d = new Dispatcher({
    transport,
    logger: new Logger((_, m) => lines.push(m), true),
    maxQueueSize: 100,
    maxPendingErrors: 50,
    gzip: true,
    now: () => now.t,
    random: () => 0.5,
    ...extra,
  });

  return { d, sent, lines, now };
}

describe('dispatcher', () => {
  it('sends events and identifies in one request and commits the client report on 202', async () => {
    const { d, sent } = make([]);
    d.reports.record('sample_rate', 'event', 3);
    d.events.push('event', { name: 'a' });
    d.events.push('identify', { user_id: 'u' });
    expect(await d.flush()).toBe(true);
    const body = JSON.parse(sent[0]!.out.body) as Record<string, unknown>;
    expect(body['batch']).toHaveLength(1);
    expect(body['identify']).toHaveLength(1);
    expect(body['client_report']).toEqual({ discarded: [{ reason: 'sample_rate', category: 'event', quantity: 3 }] });
    expect(d.reports.isEmpty).toBe(true);
  });

  it('keeps the batch on 503 and holds for the server wait', async () => {
    const { d, sent, now } = make([{ status: 503, body: { error: 'storage_unavailable' }, retryAfter: 10 }]);
    d.events.push('event', { name: 'a' });
    expect(await d.flush()).toBe(false);
    expect(d.events.length).toBe(1);
    expect(d.nextRetryIn()).toBe(10_000);
    now.t = 11_000;
    expect(await d.flush()).toBe(true);
    expect(sent).toHaveLength(2);
    expect(d.events.length).toBe(0);
  });

  it('halves on 413 and drops a single item that never fits', async () => {
    const { d, sent, lines } = make([
      { status: 413, body: { error: 'payload_too_large' } },
      { status: 413, body: { error: 'payload_too_large' } },
      { status: 413, body: { error: 'payload_too_large' } },
    ]);
    for (let i = 0; i < 4; i += 1) d.events.push('event', { name: `e${i}` });
    expect(await d.flush()).toBe(false);
    // The single item that never fits is dropped; the other three go out together.
    expect(sent.map((s) => s.out.count)).toEqual([4, 2, 1, 3]);
    expect(d.events.length).toBe(0);
    expect(lines.some((l) => l.includes('too large'))).toBe(true);
  });

  it('holds only the throttled endpoint on 429', async () => {
    const { d, sent } = make([{ status: 429, body: { error: 'rate_limited' } }]);
    d.errors.push('error', { event_id: 'x' });
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(sent.map((s) => s.out.endpoint)).toEqual(['/v1/errors', '/v1/batch']);
    expect(d.errors.length).toBe(1);
    expect(d.events.length).toBe(0);
    expect(d.backoff.isHeld(['error'])).toBe(true);
    expect(d.backoff.isHeld(['event'])).toBe(false);
  });

  it('stops for good on a refused key', async () => {
    let shutdown = '';
    const { d } = make([{ status: 401, body: { error: 'invalid_api_key' } }], { onShutdown: (code) => (shutdown = code) });
    d.events.push('event', { name: 'a' });
    d.errors.push('error', { event_id: 'x' });
    await d.flush();
    expect(shutdown).toBe('invalid_api_key');
    expect(d.isStopped).toBe(true);
    expect(d.pending).toBe(0);
  });

  it('turns compression off after the server cannot inflate a body', async () => {
    const { d, sent } = make([{ status: 400, body: { message: 'Invalid gzip in request body' } }]);
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(sent.map((s) => s.gzip)).toEqual([true, false]);
    d.events.push('event', { name: 'b' });
    await d.flush();
    expect(sent[2]!.gzip).toBe(false);
  });

  it('gives up on a batch after the network budget and counts it', async () => {
    const { d, now, lines } = make([new Error('Failed to fetch'), new Error('Failed to fetch'), new Error('Failed to fetch')]);
    d.events.push('event', { name: 'a' });
    for (let i = 0; i < 3; i += 1) {
      await d.flush();
      now.t += 60 * 60_000;
    }
    expect(d.events.length).toBe(0);
    expect(d.reports.snapshot()!.body.discarded).toEqual([{ reason: 'send_error', category: 'event', quantity: 1 }]);
    expect(lines.some((l) => l.includes('no answer'))).toBe(true);
  });

  it('surfaces what the 202 body says was not kept', async () => {
    const { d, lines } = make([{ status: 202, body: { received: 1, rejected: 1, errors: [{ index: 0, code: 'missing_name' }] } }]);
    d.events.push('event', { name: '' });
    await d.flush();
    expect(lines.some((l) => l.includes('rejected 1 item'))).toBe(true);
  });

  it('serialises overlapping flushes', async () => {
    const { d, sent } = make([]);
    d.events.push('event', { name: 'a' });
    const first = d.flush();
    d.events.push('event', { name: 'b' });
    const second = d.flush();
    await Promise.all([first, second]);
    expect(sent.map((s) => s.out.count)).toEqual([1, 1]);
  });

  it('warns once about a monthly cap and holds for hours', async () => {
    let billing = '';
    const { d } = make([{ status: 429, body: { error: 'monthly_cap_exceeded' } }], { onBilling: (c) => (billing = c) });
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(billing).toBe('monthly_cap_exceeded');
    expect(d.nextRetryIn()).toBe(21_600_000);
  });
  it('treats any 2xx as an acceptance', async () => {
    const { d, sent } = make([{ status: 200, body: null }]);
    d.events.push('event', { name: 'a' });
    expect(await d.flush()).toBe(true);
    expect(await d.flush()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(d.pending).toBe(0);
  });

  it('never follows a redirect: stops, and a later flush is false without a request', async () => {
    let shutdown = '';
    const { d, sent, lines } = make([{ status: 307, body: null }], { onShutdown: (code) => (shutdown = code) });
    d.events.push('event', { name: 'a' });
    expect(await d.flush()).toBe(false);
    expect(shutdown).toBe('redirect');
    expect(lines.some((l) => l.includes('redirect'))).toBe(true);
    d.events.push('event', { name: 'b' });
    expect(await d.flush()).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('keeps what is queued after a redirect, for when the host is fixed, but discards after a refused key', async () => {
    const redirected = make([{ status: 308, body: null }]);
    redirected.d.events.push('event', { name: 'kept' });
    expect(await redirected.d.flush()).toBe(false);
    expect(redirected.d.pending).toBe(1);

    const refused = make([{ status: 403, body: { error: 'write_scope_required' } }]);
    refused.d.events.push('event', { name: 'gone' });
    expect(await refused.d.flush()).toBe(false);
    expect(refused.d.pending).toBe(0);
  });

  it('reports a refused batch as a failed flush and keeps the client report for the next request', async () => {
    const { d, sent } = make([{ status: 400, body: { error: 'invalid_payload' } }]);
    d.reports.record('sample_rate', 'event', 2);
    d.events.push('event', { name: 'a' });
    expect(await d.flush()).toBe(false);
    expect(d.pending).toBe(0);
    const report = d.reports.snapshot()!.body.discarded;
    expect(report).toContainEqual({ reason: 'sample_rate', category: 'event', quantity: 2 });
    expect(report).toContainEqual({ reason: 'invalid', category: 'event', quantity: 1 });
    d.events.push('event', { name: 'b' });
    expect(await d.flush()).toBe(true);
    expect((JSON.parse(sent[1]!.out.body) as Record<string, unknown>)['client_report']).toBeDefined();
    expect(d.reports.isEmpty).toBe(true);
  });

  it('counts a per-record rejection inside a 202 as not delivered', async () => {
    const { d } = make([{ status: 202, body: { received: 1, rejected: 1, errors: [{ index: 1, code: 'missing_name' }] } }]);
    d.events.push('identify', { user_id: 'u' });
    d.events.push('event', { name: 'kept' });
    d.events.push('event', { name: '' });
    expect(await d.flush()).toBe(false);
    expect(d.pending).toBe(0);
    expect(d.reports.snapshot()!.body.discarded).toEqual([{ reason: 'invalid', category: 'event', quantity: 1 }]);
  });

  it('answers false again, without sending, while the batch is held', async () => {
    const { d, sent } = make([{ status: 503, body: { error: 'storage_unavailable' }, retryAfter: 10 }]);
    d.events.push('event', { name: 'a' });
    expect(await d.flush()).toBe(false);
    expect(await d.flush()).toBe(false);
    expect(sent).toHaveLength(1);
    expect(d.pending).toBe(1);
  });

  it('refuses an item that cannot be serialised and keeps its neighbours', async () => {
    const { d, sent } = make([]);
    const cyclic: Record<string, unknown> = { name: 'cycle' };
    cyclic['self'] = cyclic;
    expect(d.events.push('event', { name: 'good' })).toBe(true);
    expect(d.events.push('event', { name: 'bad', n: 10n })).toBe(false);
    expect(d.events.push('event', cyclic)).toBe(false);
    expect(d.events.push('event', Promise.resolve({ name: 'async hook' }))).toBe(false);
    expect(await d.flush()).toBe(true);
    expect((JSON.parse(sent[0]!.out.body) as { batch: unknown[] }).batch).toEqual([{ name: 'good' }]);
  });

  it('keeps its own copy: mutating a tracked object afterwards changes nothing', async () => {
    const { d, sent } = make([]);
    const props = { name: 'a', plan: 'free' };
    d.events.push('event', props);
    props.plan = 'pro';
    await d.flush();
    expect((JSON.parse(sent[0]!.out.body) as { batch: Array<Record<string, unknown>> }).batch[0]!['plan']).toBe('free');
  });

  it('uses Retry-After when the category header has no seconds', async () => {
    const { d, now } = make([{ status: 429, body: { error: 'rate_limited' }, retryAfter: 30, rateLimitCategories: ':event' }]);
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(d.nextRetryIn()).toBe(30_000);
    now.t = 31_000;
    expect(await d.flush()).toBe(true);
  });

  it('caps a monthly hold at six hours but honours a nearer reset', async () => {
    const far = make([{ status: 429, body: { error: 'monthly_cap_exceeded' }, retryAfter: 1_209_600 }]);
    far.d.events.push('event', { name: 'a' });
    await far.d.flush();
    expect(far.d.nextRetryIn()).toBe(21_600_000);

    const near = make([{ status: 429, body: { error: 'monthly_cap_exceeded' }, retryAfter: 2_400 }]);
    near.d.events.push('event', { name: 'a' });
    await near.d.flush();
    expect(near.d.nextRetryIn()).toBe(2_400_000);
  });

  it('schedules the next attempt for the earliest queue, not the longest hold', async () => {
    const { d } = make([
      { status: 503, body: { error: 'storage_unavailable' }, retryAfter: 10 },
      { status: 429, body: { error: 'monthly_cap_exceeded' } },
    ]);
    d.errors.push('error', { event_id: 'x' });
    d.events.push('event', { name: 'a' });
    await d.flush();
    expect(d.nextRetryIn()).toBe(10_000);
  });

  it('keeps a batch through a long storage outage instead of retrying every ten seconds', async () => {
    const script = Array.from({ length: 20 }, () => ({ status: 503, body: { error: 'storage_unavailable' }, retryAfter: 10 }));
    const { d, now, sent } = make(script);
    d.events.push('event', { name: 'a' });
    let waited = 0;
    while (d.pending > 0) {
      await d.flush();
      const wait = d.nextRetryIn();
      waited += wait;
      now.t += wait;
    }
    // Ten fixed ten-second retries would have given up after a minute and a half.
    expect(sent).toHaveLength(10);
    expect(waited).toBeGreaterThan(20 * 60_000);
    expect(d.reports.snapshot()!.body.discarded).toEqual([{ reason: 'send_error', category: 'event', quantity: 1 }]);
  });

  it('does not spend the retry budget while offline', async () => {
    let online = false;
    const failures = Array.from({ length: 8 }, () => new Error('Failed to fetch'));
    const { d, now } = make(failures, { isOnline: () => online });
    d.events.push('event', { name: 'a' });
    for (let i = 0; i < 6; i += 1) {
      await d.flush();
      now.t += 60 * 60_000;
    }
    expect(d.pending).toBe(1);
    online = true;
    for (let i = 0; i < 2; i += 1) {
      await d.flush();
      now.t += 60 * 60_000;
    }
    expect(d.pending).toBe(1);
  });

  it('gives up waiting for a transport that never answers', async () => {
    const { d } = make([], { transport: { send: () => new Promise(() => {}) }, sendTimeoutMs: 20, now: Date.now });
    d.events.push('event', { name: 'a' });
    expect(await d.flush()).toBe(false);
    expect(d.pending).toBe(1);
  });

  it('answers only for what was queued when it started, so a capture loop cannot keep it running', async () => {
    let d!: Dispatcher;
    let sends = 0;
    const transport = {
      async send(out: Outbound): Promise<Delivery> {
        sends += 1;
        d.events.push('event', { name: `during ${sends}` });

        return { status: 202, body: { received: out.count, rejected: 0, errors: [] } };
      },
    };
    d = new Dispatcher({ transport, logger: new Logger(() => {}, false), maxQueueSize: 100, maxPendingErrors: 50, gzip: false });
    d.events.push('event', { name: 'before' });
    expect(await d.flush()).toBe(true);
    expect(sends).toBe(1);
    expect(d.pending).toBe(1);
  });

  it('bounds what is waiting, never a chunk that is in flight', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sending = new Promise<void>((resolve) => (started = resolve));
    const transport = {
      async send(out: Outbound): Promise<Delivery> {
        started();
        await gate;

        return { status: 202, body: { received: out.count, rejected: 0, errors: [] } };
      },
    };
    const d = new Dispatcher({ transport, logger: new Logger(() => {}, false), maxQueueSize: 2, maxPendingErrors: 50, gzip: false });
    d.events.push('event', { name: 'a' });
    d.events.push('event', { name: 'b' });
    const flushing = d.flush();
    await sending;
    // a and b are in flight; c and d fit beside them, e pushes out the oldest waiting record.
    for (const name of ['c', 'd', 'e']) d.events.push('event', { name });
    release();
    expect(await flushing).toBe(true);
    expect(d.events.peek().map((e) => e.item['name'])).toEqual(['d', 'e']);
    expect(d.reports.snapshot()!.body.discarded).toEqual([{ reason: 'queue_overflow', category: 'event', quantity: 1 }]);
  });

  it('delivers pending drop counts on an explicit flush with nothing queued', async () => {
    const { d, sent } = make([]);
    expect(await d.flush()).toBe(true);
    expect(sent).toHaveLength(0);
    d.reports.record('deduplicated', 'error', 3);
    expect(await d.flush()).toBe(true);
    expect(JSON.parse(sent[0]!.out.body)).toEqual({ batch: [], client_report: { discarded: [{ reason: 'deduplicated', category: 'error', quantity: 3 }] } });
    expect(d.reports.isEmpty).toBe(true);
  });

  it('puts the client report on only the first unload request', () => {
    const { d } = make([]);
    d.reports.record('ratelimit', 'error');
    d.errors.push('error', { event_id: 'x' });
    d.events.push('event', { name: 'a' });
    const bodies = d.buildAll().map(({ out }) => JSON.parse(out.body) as Record<string, unknown>);
    expect(bodies.map((b) => b['client_report'] !== undefined)).toEqual([true, false]);
  });
});
