// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installHarness, tick, type Harness } from './harness.js';

/**
 * The behaviour scenarios in `spec/fixtures/scenarios.json`, run against the public API with a
 * scripted ingest. Only what reaches the wire is asserted. Scenarios for server runtimes (scopes
 * per request, per-call identity, several clients) do not apply to a page and are skipped.
 */
type Facade = typeof import('../src/index.js');
type Client = InstanceType<Facade['Vinktar']>;

interface Step {
  do: string;
  args?: unknown[];
  client?: string;
  steps?: Step[];
  returns?: unknown;
  throws?: string;
  await?: boolean;
}

interface Match {
  endpoint: string;
  item?: Record<string, unknown>;
  identify?: Record<string, unknown>;
  maxTopLevelKeys?: { of: string[]; max: number };
  capture?: Record<string, string>;
  differs?: Record<string, string>;
}

interface Scenario {
  name: string;
  capability: 'common' | 'backend' | 'browser';
  clients?: string[];
  options?: Record<string, unknown>;
  respond?: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>;
  steps: Step[];
  expect?: {
    sent?: Match[];
    notSent?: Match[];
    requests?: Record<string, number>;
    errorCount?: Record<string, number>;
    report?: Array<{ reason: string; category: string; quantity: number }>;
  };
}

interface WireItem {
  readonly endpoint: string;
  readonly kind: 'item' | 'identify';
  readonly value: Record<string, unknown>;
}

// A path, not a URL: under happy-dom the global URL is the DOM's, which node:fs does not accept.
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../spec/fixtures/scenarios.json');
const { scenarios } = JSON.parse(readFileSync(fixture, 'utf8')) as { scenarios: Scenario[] };
const KEY = 'vnk_pk_scenario_0001';

let harness: Harness;
let sdk: Facade;
const open: Client[] = [];

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  harness = installHarness();
  sdk = await import('../src/index.js');
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  vi.unstubAllGlobals();
});

function arg(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const error = /^error\((.*)\)$/.exec(value);
  if (error) return new Error(error[1]);
  const props = /^props\((\d+)\)$/.exec(value);
  if (props) return Object.fromEntries(Array.from({ length: Number(props[1]) }, (_, i) => [`p${i}`, 'v']));
  const big = /^bigint\((\d+)\)$/.exec(value);
  if (big) return BigInt(big[1]!);

  return value;
}

function clientOptions(scenario: Scenario): Record<string, unknown> {
  const { hooks, ...rest } = scenario.options ?? {};
  const options: Record<string, unknown> = { writeKey: KEY, filterBots: false, autoPageviews: false, flushIntervalMs: 60_000, logger: () => {}, ...rest };
  if (hooks === 'poisonProperty') {
    options['beforeTrack'] = (event: Record<string, unknown>) => (event['name'] === 'poison' ? { ...event, poison: 10n } : event);
  }

  return options;
}

function invoke(client: Client, step: Step): unknown {
  if (step.do === 'withScope') return client.withScope(() => runInScope(client, step.steps ?? []));
  const method = (client as unknown as Record<string, unknown>)[step.do];
  if (typeof method !== 'function') throw new Error(`scenario step "${step.do}" has no browser equivalent`);

  return (method as (...args: unknown[]) => unknown).apply(client, (step.args ?? []).map(arg));
}

/** A browser scope is synchronous, so its steps are too. */
function runInScope(client: Client, steps: Step[]): unknown {
  for (const step of steps) {
    if (step.do === 'value') return step.args?.[0];
    if (step.do === 'throw') throw new Error(String(step.args?.[0]));
    invoke(client, step);
  }

  return undefined;
}

async function run(client: Client, steps: Step[]): Promise<void> {
  let closing: Promise<unknown> | undefined;

  for (const step of steps) {
    if (step.do === 'awaitClose') {
      const result = await closing;
      if ('returns' in step) expect(result, `${step.do} returns`).toEqual(step.returns);
      continue;
    }

    let result: unknown;
    let threw: unknown;
    try {
      result = invoke(client, step);
      if (step.do === 'close') closing = result as Promise<unknown>;
      if (step.await !== false && result instanceof Promise) result = await result;
    } catch (error) {
      threw = error;
    }

    if (step.throws !== undefined) expect((threw as Error | undefined)?.message, `${step.do} throws`).toBe(step.throws);
    else if (threw !== undefined) throw threw;
    if ('returns' in step && step.await !== false) expect(result, `${step.do} returns`).toEqual(step.returns);
  }
}

function wire(): { items: WireItem[]; reports: Array<Record<string, unknown>> } {
  const items: WireItem[] = [];
  const reports: Array<Record<string, unknown>> = [];

  for (const request of harness.requests) {
    const endpoint = new URL(request.url).pathname;
    const body = request.body as Record<string, unknown>;
    const list = (key: string): Array<Record<string, unknown>> => (Array.isArray(body[key]) ? (body[key] as Array<Record<string, unknown>>) : []);
    if (endpoint === '/v1/batch') {
      for (const value of list('batch')) items.push({ endpoint, kind: 'item', value });
      for (const value of list('identify')) items.push({ endpoint, kind: 'identify', value });
    }
    if (endpoint === '/v1/errors') for (const value of list('errors')) items.push({ endpoint, kind: 'item', value });
    const discarded = (body['client_report'] as { discarded?: unknown } | undefined)?.discarded;
    if (Array.isArray(discarded)) reports.push(...(discarded as Array<Record<string, unknown>>));
  }

  return { items, reports };
}

/** Partial deep match. `null` means absent or empty; arrays match element-wise from the start. */
function matches(expected: unknown, actual: unknown): boolean {
  if (expected === null) {
    return actual === undefined || actual === null || actual === '' || (typeof actual === 'object' && Object.keys(actual).length === 0);
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((value, index) => matches(value, actual[index]));
  if (typeof expected === 'object') {
    const record = typeof actual === 'object' && actual !== null ? (actual as Record<string, unknown>) : undefined;
    // `{ account: null }` also holds when the whole object is absent.
    if (record === undefined) return Object.values(expected).every((value) => value === null);

    return Object.entries(expected).every(([key, value]) => matches(value, record[key]));
  }

  return expected === actual;
}

describe('fixtures/scenarios.json', () => {
  const applicable = scenarios.filter((s) => s.capability !== 'backend' && (s.clients?.length ?? 1) <= 1);

  for (const scenario of applicable) {
    it(scenario.name, async () => {
      for (const response of scenario.respond ?? []) harness.respond(response.status, response.body ?? null, response.headers ?? {});
      const client = new sdk.Vinktar(clientOptions(scenario) as never);
      open.push(client);

      await run(client, scenario.steps);
      // Sends started by captures (errors and identify go at once) finish before anything is read.
      await tick(10);

      const expectations = scenario.expect ?? {};
      const { items, reports } = wire();
      const remembered: Record<string, unknown> = {};
      const find = (match: Match): WireItem | undefined =>
        items.find((item) => {
          if (item.endpoint !== match.endpoint) return false;
          if (match.identify !== undefined ? item.kind !== 'identify' || !matches(match.identify, item.value) : item.kind !== 'item' || !matches(match.item ?? {}, item.value)) return false;
          if (match.maxTopLevelKeys !== undefined) {
            const keys = new Set(match.maxTopLevelKeys.of.flatMap((field) => Object.keys((item.value[field] as object | undefined) ?? {})));
            if (keys.size > match.maxTopLevelKeys.max) return false;
          }
          if (match.differs !== undefined) {
            for (const [field, label] of Object.entries(match.differs)) {
              if (item.value[field] === undefined || item.value[field] === remembered[label]) return false;
            }
          }

          return true;
        });

      for (const match of expectations.sent ?? []) {
        const hit = find(match);
        expect(hit, `sent ${JSON.stringify(match)}`).toBeDefined();
        for (const [field, label] of Object.entries(match.capture ?? {})) remembered[label] = hit?.value[field];
      }
      for (const match of expectations.notSent ?? []) expect(find(match), `not sent ${JSON.stringify(match)}`).toBeUndefined();
      // Requests carrying records; one that only delivers the client report is not a resend.
      const carrying = harness.requests.filter((r) => ['batch', 'identify', 'errors'].some((key) => Array.isArray(r.body[key]) && (r.body[key] as unknown[]).length > 0));
      for (const [endpoint, count] of Object.entries(expectations.requests ?? {})) {
        expect(carrying.filter((r) => new URL(r.url).pathname === endpoint), `requests to ${endpoint}`).toHaveLength(count);
      }
      for (const [message, count] of Object.entries(expectations.errorCount ?? {})) {
        const sent = items.filter((i) => i.endpoint === '/v1/errors' && (i.value['exceptions'] as Array<{ value?: string }> | undefined)?.[0]?.value === message);
        expect(sent, `occurrences of "${message}"`).toHaveLength(count);
      }
      for (const entry of expectations.report ?? []) {
        expect(reports, `client report ${JSON.stringify(entry)}`).toContainEqual(entry);
      }
    });
  }
});
