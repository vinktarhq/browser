// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installHarness, tick, type Harness } from './harness.js';

let harness: Harness;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  harness = installHarness();
});

afterEach(async () => {
  const w = window as Window & { vinktar?: { close?: () => Promise<void> } };
  await w.vinktar?.close?.();
  delete w.vinktar;
  vi.unstubAllGlobals();
});

describe('the CDN entry', () => {
  it('drains the stub queue in order and inits from the script tag', async () => {
    const script = document.createElement('script');
    script.setAttribute('data-key', 'vnk_pk_cdn');
    script.setAttribute('data-auto-pageviews', 'false');
    script.setAttribute('data-debug', '');
    script.setAttribute('data-filter-bots', 'false');
    document.head.appendChild(script);
    (window as Window & { vinktar?: unknown }).vinktar = { q: [['track', 'queued', { n: 1 }]], __sv: 1 };

    await import('../src/global.js');
    const api = (window as Window & { vinktar?: { flush(): Promise<boolean>; track(n: string): void } }).vinktar!;
    api.track('after');
    await api.flush();
    expect(harness.batches().map((e) => e['name'])).toEqual(['queued', 'after']);
    expect(String(api)).toMatch(/^vinktar\//);
  });

  it('reads typed options from data attributes', async () => {
    const { optionsFromAttributes } = await import('../src/global.js');
    const script = document.createElement('script');
    script.setAttribute('data-key', 'vnk_pk_x');
    script.setAttribute('data-host', 'https://in.example.com');
    script.setAttribute('data-sample-rate', '0.5');
    script.setAttribute('data-errors', 'false');
    script.setAttribute('data-autocapture', 'true');
    expect(optionsFromAttributes(script)).toEqual({ writeKey: 'vnk_pk_x', host: 'https://in.example.com', sampleRate: 0.5, errors: false, autocapture: true });
    await tick();
  });
});
