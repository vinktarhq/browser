// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installHarness, tick, type Harness } from './harness.js';

/**
 * `spec/fixtures/hostile.json`: the page is never broken by the SDK, whatever it is handed.
 *
 * Every case runs twice, against a client and against the module-level functions, and asserts the
 * same things: each step returned, nothing was thrown, and nothing reached the window's `error`
 * or `unhandledrejection` before the client had closed. `host` entries compare a function the SDK
 * wrapped with the same function called directly. A case or a step that does not apply to a page
 * is skipped by name, and the last test checks those names, so nothing is skipped without this
 * file saying so.
 */
type Facade = typeof import('../src/index.js');
type Client = InstanceType<Facade['Vinktar']>;

interface Step {
  do: string;
  args?: unknown[];
  steps?: Step[];
  capability?: string;
  withinMs?: number;
  returns?: unknown;
}

interface Case {
  name: string;
  capability: 'common' | 'backend' | 'browser';
  options?: Record<string, unknown> | string;
  steps: Step[];
  host?: string[];
  expect?: {
    sent?: Array<{ endpoint: string; identify?: Record<string, unknown>; item?: Record<string, unknown> }>;
    requests?: Record<string, number>;
    logged?: { level: string; count: number };
  };
}

// A path, not a URL: under happy-dom the global URL is the DOM's, which node:fs does not accept.
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../spec/fixtures/hostile.json');
const { cases } = JSON.parse(readFileSync(fixture, 'utf8')) as { cases: Case[] };

const KEY = 'vnk_pk_hostile_0001';
const HOST_URL = 'https://app.test/orders';
const SURFACES = ['client', 'facade'] as const;
type Surface = (typeof SURFACES)[number];

// Hostile values --------------------------------------------------------------------------------

function thrower(): never {
  throw new Error('hostile value was read');
}

/** Each kind as JavaScript has it. A kind with two natural renderings runs the case once per rendering. */
const KINDS: Record<string, Array<() => unknown>> = {
  cycle: [
    () => {
      const root: Record<string, unknown> = { list: [] as unknown[], inner: { deeper: {} as Record<string, unknown> } };
      (root['inner'] as { deeper: Record<string, unknown> }).deeper['root'] = root;
      (root['list'] as unknown[]).push([root]);

      return root;
    },
  ],
  throwing_accessor: [
    () => Object.defineProperties({}, { value: { enumerable: true, get: thrower }, toJSON: { enumerable: false, get: thrower } }),
    () =>
      new Proxy(
        {},
        { get: thrower, has: thrower, ownKeys: thrower, getOwnPropertyDescriptor: thrower, getPrototypeOf: thrower, set: thrower, defineProperty: thrower },
      ),
  ],
  self_replicating: [
    () => {
      const make = (): Record<string, unknown> => ({ toJSON: () => make() });

      return make();
    },
  ],
  no_json_form: [() => ({ big: 10n, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, sym: Symbol('s'), fn: () => 1 })],
  deep: [
    () => {
      let value: Record<string, unknown> = {};
      for (let i = 0; i < 20_000; i += 1) value = { child: value };

      return value;
    },
  ],
  huge: [() => 'x'.repeat(5 * 1024 * 1024)],
  bad_text: [() => 'lone \uD800 surrogate'],
  null: [() => null, () => undefined],
  integer: [() => 42],
  object: [() => ({})],
  list_of_null: [() => [null]],
};

function kindsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const kind = /^hostile\((\w+)\)$/.exec(value)?.[1];
    if (kind !== undefined) found.add(kind);
  } else if (Array.isArray(value)) for (const item of value) kindsIn(item, found);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) kindsIn(item, found);

  return found;
}

function variantsOf(c: Case): number {
  return Math.max(1, ...[...kindsIn([c.options, c.steps])].map((kind) => KINDS[kind]!.length));
}

function materialise(value: unknown, variant: number): unknown {
  if (typeof value === 'string') {
    const kind = /^hostile\((\w+)\)$/.exec(value)?.[1];
    if (kind !== undefined) {
      const renderings = KINDS[kind];
      if (renderings === undefined) throw new Error(`hostile.json names a kind this test does not render: ${kind}`);

      return renderings[variant % renderings.length]!();
    }
    const error = /^error\((.*)\)$/.exec(value);
    if (error) return new Error(error[1]);
    if (value === 'rejected(handled)') {
      const rejected = Promise.reject(new Error('the caller handled this'));
      rejected.catch(() => {});

      return rejected;
    }

    return value;
  }
  if (Array.isArray(value)) return value.map((item) => materialise(item, variant));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialise(item, variant)]));

  return value;
}

// The rig ---------------------------------------------------------------------------------------

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

interface Rig {
  readonly harness: Harness;
  readonly logs: Array<{ level: string; message: string }>;
  readonly failures: string[];
  readonly unhandled: string[];
  /** How the network behaves for the SDK's own sends. */
  transport: 'answers' | 'throws' | 'hangs';
  /** True while the test itself is dispatching error events at the window. */
  staged: boolean;
  /** What the page's own functions are before the SDK wraps them. */
  readonly host: { fetch: Spy; open: Spy; send: Spy; log: Spy; pushState: Spy };
}

const executed = new Set<string>();
const skippedCases = new Map<string, string>();
const skippedSteps = new Set<string>();

let rig: Rig;
let sdk: Facade;
let client: Client | null = null;
let restoreGlobals: Array<() => void> = [];

function printable(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  } catch {
    return 'a value that cannot be printed';
  }
}

const onRejection = (reason: unknown): void => void rig.unhandled.push(`unhandledRejection: ${printable(reason)}`);
const onException = (error: unknown): void => void rig.unhandled.push(`uncaughtException: ${printable(error)}`);
const onWindowError = (event: Event): void => {
  if (!rig.staged) rig.unhandled.push(`window ${event.type}: ${printable((event as ErrorEvent).error ?? (event as PromiseRejectionEvent).reason ?? (event as ErrorEvent).message)}`);
};

/** Replace `owner[name]` for one test. */
function swap(owner: object, name: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(owner, name);
  Object.defineProperty(owner, name, { value, writable: true, configurable: true, enumerable: own?.enumerable ?? true });
  restoreGlobals.push(() => {
    if (own !== undefined) Object.defineProperty(owner, name, own);
    else delete (owner as Record<string, unknown>)[name];
  });
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  restoreGlobals = [];

  const domFetch = globalThis.fetch;
  const harness = installHarness();
  const ingest = globalThis.fetch as unknown as Callable;
  const response = new Response('{}', { status: 200 });
  // Ingest is the harness. The page's own URL answers. Anything else is whatever the platform does with it.
  const hostFetch = vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
    if (typeof input === 'string' && input.includes('/v1/')) {
      if (rig.transport === 'throws') throw new Error('the network layer threw');
      if (rig.transport === 'hangs') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));

      return ingest(input, init);
    }

    return input === HOST_URL ? Promise.resolve(response) : domFetch(input as never, init as never);
  });
  vi.stubGlobal('fetch', hostFetch);

  const realOpen = XMLHttpRequest.prototype.open as unknown as Callable;
  const host = {
    fetch: hostFetch,
    open: vi.fn(function (this: unknown, ...args: unknown[]) {
      return realOpen.apply(this, args);
    }),
    send: vi.fn(() => undefined),
    log: vi.fn(() => undefined),
    pushState: vi.fn(() => undefined),
  };
  swap(XMLHttpRequest.prototype, 'open', host.open);
  swap(XMLHttpRequest.prototype, 'send', host.send);
  swap(console, 'log', host.log);
  swap(history, 'pushState', host.pushState);

  rig = { harness, logs: [], failures: [], unhandled: [], transport: 'answers', staged: false, host };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onWindowError);
  sdk = await import('../src/index.js');
});

afterEach(async () => {
  await sdk.close();
  await client?.close();
  client = null;
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
  window.removeEventListener('error', onWindowError);
  window.removeEventListener('unhandledrejection', onWindowError);
  for (const restore of restoreGlobals.splice(0).reverse()) restore();
  vi.unstubAllGlobals();
});

/** Every global the SDK patches or writes to, made read-only in a way the test can undo. */
function freezeGlobals(): void {
  const readOnly = (owner: object, name: string): void => {
    const value = (owner as Record<string, unknown>)[name];
    const own = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, { value, writable: false, configurable: true, enumerable: own?.enumerable ?? true });
    restoreGlobals.push(() => {
      if (own !== undefined) Object.defineProperty(owner, name, own);
      else delete (owner as Record<string, unknown>)[name];
    });
  };
  for (const level of ['debug', 'info', 'log', 'warn', 'error']) readOnly(console, level);
  readOnly(globalThis, 'fetch');
  readOnly(XMLHttpRequest.prototype, 'open');
  readOnly(XMLHttpRequest.prototype, 'send');
  readOnly(history, 'pushState');
  readOnly(history, 'replaceState');
  readOnly(Error, 'stackTraceLimit');
}

function optionsFor(c: Case, variant: number): unknown {
  if (typeof c.options === 'string') return materialise(c.options, variant);
  const { $runtime: runtime, hooks, logger, onError, transport, writeKey, ...rest } = c.options ?? {};
  const throws = (): never => {
    throw new Error('the callback threw');
  };
  rig.transport = transport === 'throws' ? 'throws' : runtime === 'unreachableHost' ? 'hangs' : 'answers';

  return {
    logger: logger === 'throws' ? throws : (level: string, message: string) => void rig.logs.push({ level, message }),
    // happy-dom reports `navigator.webdriver`, so the bot filter would (correctly) drop every analytics event.
    filterBots: false,
    autoPageviews: false,
    flushIntervalMs: 60_000,
    ...(writeKey === null ? {} : { writeKey: typeof writeKey === 'string' ? writeKey : KEY }),
    ...(hooks === 'allThrow' ? { beforeSend: throws, beforeTrack: throws, beforeBreadcrumb: throws } : {}),
    ...(onError === 'throws' ? { onError: throws } : {}),
    ...(runtime === 'unreachableHost' ? { requestTimeoutMs: 1_000, shutdownTimeout: 100 } : {}),
    ...(materialise(rest, variant) as Record<string, unknown>),
  };
}

// Steps -----------------------------------------------------------------------------------------

function applies(capability: string | undefined): boolean {
  return capability === undefined || capability === 'common' || capability === 'browser' || capability === 'js';
}

/** The function a step names: the module-level one where the facade is under test and has it. */
function lookup(surface: Surface, name: string): Callable | undefined {
  const exported = (sdk as unknown as Record<string, unknown>)[name];
  if (surface === 'facade' && typeof exported === 'function') return exported as Callable;
  const method = (client as unknown as Record<string, unknown> | null)?.[name];

  return typeof method === 'function' ? (method as Callable).bind(client) : undefined;
}

/** `setContext` takes one object here; the fixture's key and value become that object. */
function argsFor(step: Step, variant: number): unknown[] {
  const args = (step.args ?? []).map((value) => materialise(value, variant));
  if (step.do === 'setContext' && typeof args[0] === 'string') return [{ [args[0]]: args[1] }];

  return args;
}

async function attempt(label: string, step: Step, call: () => unknown): Promise<void> {
  const started = Date.now();
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    rig.failures.push(`${label} threw ${printable(error)}`);

    return;
  }
  const blocked = Date.now() - started;
  if (step.withinMs !== undefined && blocked > step.withinMs) rig.failures.push(`${label} blocked for ${blocked} ms, over ${step.withinMs}`);
  if (result instanceof Promise) {
    try {
      result = await result;
    } catch (error) {
      rig.failures.push(`${label} rejected with ${printable(error)}`);

      return;
    }
  }
  if ('returns' in step) expect(result, `${label} returns`).toEqual(step.returns);
  // The argument stood in for the callback: there is nothing to run, and nothing to return.
  if (step.do === 'withScope' && step.args !== undefined) expect(result, `${label} returns`).toBeUndefined();
}

async function runSteps(surface: Surface, steps: Step[], variant: number, on?: { name: string; target: Record<string, unknown> }): Promise<void> {
  for (const step of steps) {
    if (!applies(step.capability)) continue;
    const label = `${on?.name ?? surface}.${step.do}()`;

    if (step.do === 'scope') {
      let handed: unknown;
      await attempt(label, step, () => (handed = lookup(surface, 'scope')!()));
      if (typeof handed === 'object' && handed !== null) await runSteps(surface, step.steps ?? [], variant, { name: 'scope', target: handed as Record<string, unknown> });
      continue;
    }
    if (step.do === 'withScope' && step.steps !== undefined) {
      const nested = step.steps;
      await attempt(label, step, () => lookup(surface, 'withScope')!(() => runSteps(surface, nested, variant)));
      continue;
    }

    const found = on !== undefined ? on.target[step.do] : lookup(surface, step.do);
    if (typeof found !== 'function') {
      skippedSteps.add(`${on?.name ?? 'client'}.${step.do}`);
      continue;
    }
    const fn = on !== undefined ? (found as Callable).bind(on.target) : (found as Callable);
    await attempt(label, step, () => fn(...argsFor(step, variant)));
  }
}

// Host functions ----------------------------------------------------------------------------------

interface Outcome {
  how: 'returned' | 'threw' | 'resolved' | 'rejected';
  value: unknown;
}

async function outcome(call: () => unknown): Promise<Outcome> {
  let value: unknown;
  try {
    value = call();
  } catch (error) {
    return { how: 'threw', value: error };
  }
  if (!(value instanceof Promise)) return { how: 'returned', value };

  return value.then(
    (resolved): Outcome => ({ how: 'resolved', value: resolved }),
    (error: unknown): Outcome => ({ how: 'rejected', value: error }),
  );
}

/** The wrapped call against the same call on the original: same way out, same value, original called once. */
async function same(label: string, original: ReturnType<typeof vi.fn>, wrapped: Callable, thisArg: unknown, args: unknown[]): Promise<void> {
  const expected = await outcome(() => (original as unknown as Callable).apply(thisArg, args));
  original.mockClear();
  const actual = await outcome(() => wrapped.apply(thisArg, args));
  expect(actual.how, `${label}: how it ended`).toBe(expected.how);
  if (expected.value instanceof Error) {
    expect((actual.value as Error).constructor, `${label}: error type`).toBe(expected.value.constructor);
    expect((actual.value as Error).message, `${label}: error message`).toBe(expected.value.message);
  } else expect(actual.value, `${label}: value`).toBe(expected.value);
  expect(original.mock.calls, `${label}: the original was called once, with what the caller passed`).toHaveLength(1);
  expect(original.mock.calls[0], `${label}: argument count`).toHaveLength(args.length);
  args.forEach((arg, index) => expect(original.mock.calls[0]![index], `${label}: argument ${index}`).toBe(arg));
  expect(original.mock.contexts[0], `${label}: this`).toBe(thisArg);
}


function accessor(variant: number): unknown {
  return KINDS['throwing_accessor']![variant % 2]!();
}

async function checkHost(entry: string, variant: number, listeners: { error: Spy; rejection: Spy; onerror: Spy }): Promise<void> {
  const proto = XMLHttpRequest.prototype as unknown as Record<string, Callable>;
  if (entry === 'fetch') {
    await same('fetch', rig.host.fetch, globalThis.fetch as unknown as Callable, undefined, [HOST_URL, { method: 'POST', body: 'a=1' }]);
    await same('fetch(url)', rig.host.fetch, globalThis.fetch as unknown as Callable, undefined, [HOST_URL]);
  } else if (entry === 'fetch(invalid)') {
    const invalid: unknown[][] = [[undefined], [null], [], [HOST_URL, { method: 5 }], [HOST_URL, { headers: 5 }], [42], [accessor(variant)], [HOST_URL, accessor(1)]];
    for (const [index, args] of invalid.entries()) await same(`fetch(invalid ${index})`, rig.host.fetch, globalThis.fetch as unknown as Callable, undefined, args);
  } else if (entry === 'xhr') {
    const xhr = new XMLHttpRequest();
    await same('xhr.open', rig.host.open, proto['open']!, xhr, ['GET', HOST_URL]);
    await same('xhr.send', rig.host.send, proto['send']!, xhr, ['a=1']);
    await same('xhr.open(URL)', rig.host.open, proto['open']!, new XMLHttpRequest(), ['POST', new URL(HOST_URL), true]);
  } else if (entry === 'xhr(invalid)') {
    const invalid: unknown[][] = [['GET', undefined], ['GET', null], [undefined, undefined], [], ['GET', 42], [accessor(1), HOST_URL], ['GET', accessor(variant)]];
    for (const [index, args] of invalid.entries()) await same(`xhr.open(invalid ${index})`, rig.host.open, proto['open']!, new XMLHttpRequest(), args);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', HOST_URL);
    await same('xhr.send(invalid)', rig.host.send, proto['send']!, xhr, [accessor(1)]);
    await same('xhr.send() before open()', rig.host.send, proto['send']!, new XMLHttpRequest(), []);
  } else if (entry === 'console') {
    rig.host.log.mockImplementation(() => 'what the host console returns');
    await same('console.log', rig.host.log, console.log as Callable, console, ['checkout', KINDS['cycle']![0]!(), accessor(variant)]);
    rig.host.log.mockImplementation(() => {
      throw new Error('the host console threw');
    });
    await same('console.log that throws', rig.host.log, console.log as Callable, console, ['again']);
    rig.host.log.mockImplementation(() => undefined);
  } else if (entry === 'history') {
    const pushState = history.pushState as unknown as Callable;
    await same('history.pushState', rig.host.pushState, pushState, history, [{ step: 1 }, '', '/next']);
    await same('history.pushState(invalid)', rig.host.pushState, pushState, history, [accessor(1), accessor(1), accessor(1)]);
    rig.host.pushState.mockImplementation(() => {
      throw new Error('the host history threw');
    });
    await same('history.pushState that throws', rig.host.pushState, pushState, history, [{}, '', '/again']);
    rig.host.pushState.mockImplementation(() => undefined);
  } else if (entry === 'errorHandler(levels)') {
    // The page listens for errors and, separately, for rejections. Each hears its own kind once,
    // as it would without the SDK, and never the other's; `window.onerror` is still the page's.
    rig.staged = true;
    const failure = new Error('the page failed');
    window.dispatchEvent(new ErrorEvent('error', { error: failure, message: failure.message }));
    expect(listeners.error.mock.calls, 'error listener').toHaveLength(1);
    expect(listeners.rejection.mock.calls, 'a page error does not reach the rejection listener').toHaveLength(0);
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('the page rejected') }));
    expect(listeners.rejection.mock.calls, 'rejection listener').toHaveLength(1);
    expect(listeners.error.mock.calls, 'a rejection does not reach the error listener').toHaveLength(1);
    expect(window.onerror, 'window.onerror').toBe(listeners.onerror);
    rig.staged = false;
    await tick(10);
  } else throw new Error(`hostile.json names a host check this test does not run: ${entry}`);
}

// The cases ---------------------------------------------------------------------------------------

describe('fixtures/hostile.json', () => {
  for (const c of cases) {
    if (c.capability === 'backend') {
      skippedCases.set(c.name, 'server only');
      it.skip(`${c.name} (server only)`, () => {});
      continue;
    }

    for (const surface of SURFACES) {
      for (let variant = 0; variant < variantsOf(c); variant += 1) {
        it(`${c.name} [${surface}${variantsOf(c) > 1 ? `, rendering ${variant + 1}` : ''}]`, async () => {
          const runtime = typeof c.options === 'object' ? c.options['$runtime'] : undefined;
          if (runtime === 'frozenGlobals') freezeGlobals();

          const listeners = { error: vi.fn(), rejection: vi.fn(), onerror: vi.fn() };
          if ((c.host ?? []).includes('errorHandler(levels)')) {
            window.addEventListener('error', listeners.error);
            window.addEventListener('unhandledrejection', listeners.rejection);
            swap(window, 'onerror', listeners.onerror);
            restoreGlobals.push(() => {
              window.removeEventListener('error', listeners.error);
              window.removeEventListener('unhandledrejection', listeners.rejection);
            });
          }

          const options = optionsFor(c, variant);
          try {
            client = surface === 'facade' ? sdk.init(options as never) : new sdk.Vinktar(options as never);
          } catch (error) {
            rig.failures.push(`init threw ${printable(error)}`);
          }
          expect(rig.failures).toEqual([]);

          await runSteps(surface, c.steps, variant);
          for (const entry of c.host ?? []) await checkHost(entry, variant, listeners);
          if (runtime === 'frozenGlobals') {
            const said = rig.logs.filter((line) => /cannot be patched/.test(line.message)).map((line) => line.message);
            for (const name of ['fetch', 'console.log', 'XMLHttpRequest', 'history.pushState']) expect(said.some((line) => line.includes(name)), `${name} was skipped out loud`).toBe(true);
          }

          const closed = await outcome(() => (surface === 'facade' ? sdk.close() : client!.close()));
          expect(closed.how, 'close()').toBe('resolved');
          // Sends started by captures finish, and a rejection nobody handled is reported, after the microtasks drain.
          await tick(20);

          expect(rig.failures).toEqual([]);
          expect(rig.unhandled).toEqual([]);

          const carrying = rig.harness.requests.filter((r) => ['batch', 'identify', 'errors'].some((key) => Array.isArray(r.body[key]) && (r.body[key] as unknown[]).length > 0));
          for (const [endpoint, count] of Object.entries(c.expect?.requests ?? {})) {
            expect(carrying.filter((r) => new URL(r.url).pathname === endpoint), `requests to ${endpoint}`).toHaveLength(count);
          }
          for (const match of c.expect?.sent ?? []) {
            const key = match.identify !== undefined ? 'identify' : match.endpoint === '/v1/errors' ? 'errors' : 'batch';
            const list = rig.harness.requests.filter((r) => new URL(r.url).pathname === match.endpoint).flatMap((r) => (r.body[key] as unknown[] | undefined) ?? []);
            expect(list, `sent ${JSON.stringify(match)}`).toContainEqual(expect.objectContaining(match.identify ?? match.item ?? {}));
          }
          if (c.expect?.logged !== undefined) {
            expect(rig.logs.filter((line) => line.level === c.expect!.logged!.level), `lines at ${c.expect.logged.level}`).toHaveLength(c.expect.logged.count);
          }
          executed.add(c.name);
        });
      }
    }
  }

  afterAll(() => {
    expect(cases).toHaveLength(28);
    expect(executed.size, 'cases that ran').toBe(25);
    expect([...skippedCases.keys()]).toEqual([
      'hostile data held in scope does not break a unit of work',
      'headers with empty and non-string values',
      'a promise handed to the SDK that rejects, already handled by the caller',
    ]);
    // A page's scope sets tags and context. It has no user or properties of its own to set.
    expect([...skippedSteps].sort()).toEqual(['scope.addBreadcrumb', 'scope.register', 'scope.registerOnce', 'scope.setUser']);
  });
});

// What the fixture cannot say in JSON ---------------------------------------------------------------

describe('the same rule, where only a page can break it', () => {
  const BASE = { writeKey: KEY, filterBots: false, autoPageviews: false, flushIntervalMs: 60_000 };
  const make = (options: Record<string, unknown> = {}): Client => {
    client = new sdk.Vinktar({ ...BASE, logger: (level: string, message: string) => void rig.logs.push({ level, message }), ...options } as never);

    return client;
  };

  it('replays calls made before init(), whatever they were given', () => {
    const proxy = accessor(1);
    expect(() => {
      sdk.page(proxy as never, proxy as never);
      sdk.page('pricing', 42 as never);
      sdk.track(proxy as never, proxy as never);
      sdk.withScope(proxy as never);
      sdk.init({ ...BASE, logger: (level: string, message: string) => void rig.logs.push({ level, message }) } as never);
    }).not.toThrow();
    expect(rig.logs.filter((line) => line.level === 'error').map((line) => line.message)).toEqual(['[vinktar] internal failure']);
  });

  it('keeps the patches it could make when one global refuses', async () => {
    const own = Object.getOwnPropertyDescriptor(globalThis, 'fetch')!;
    Object.defineProperty(globalThis, 'fetch', { ...own, writable: false });
    restoreGlobals.push(() => Object.defineProperty(globalThis, 'fetch', own));
    make();
    expect(rig.logs.filter((line) => /cannot be patched/.test(line.message)).map((line) => line.message)).toEqual([expect.stringContaining('fetch')]);
    console.log('still a breadcrumb');
    client!.captureException(new Error('after a refused patch'));
    await client!.flush();
    const [error] = rig.harness.errors();
    expect(error?.['breadcrumbs']).toContainEqual(expect.objectContaining({ category: 'console', message: 'still a breadcrumb' }));
  });

  it('captures a form whose controls shadow its own properties and whose action is not a URL', async () => {
    make({ autocapture: true });
    const form = document.createElement('form');
    form.setAttribute('action', 'http://[not a url');
    form.setAttribute('name', 'checkout');
    const control = document.createElement('input');
    // What `<input name="id">` does to its form. happy-dom does not do it by itself.
    for (const name of ['id', 'name', 'action']) Object.defineProperty(form, name, { value: control, configurable: true });
    const label = document.createElement('span');
    form.append(label);
    document.body.append(form);

    expect(() => {
      label.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    }).not.toThrow();
    await client!.flush();
    form.remove();

    const submit = rig.harness.batches().find((event) => (event['payload'] as Record<string, unknown>)['$event_type'] === 'submit');
    expect(submit?.['payload']).toMatchObject({ $form_name: 'checkout', $form_action: 'http://[not a url' });
    expect(rig.harness.batches().some((event) => (event['payload'] as Record<string, unknown>)['$event_type'] === 'click')).toBe(true);
    expect(rig.unhandled).toEqual([]);

    // `<input name="getAttribute">` is the same trick. happy-dom cannot dispatch at such an element
    // (it calls the method itself), so the reading is checked without an event.
    const { attribute } = await import('../src/browser/crumbs.js');
    const shadowed = document.createElement('button');
    shadowed.setAttribute('name', 'pay');
    Object.defineProperty(shadowed, 'getAttribute', { value: control });
    expect(attribute(shadowed, 'name')).toBe('pay');
  });

  it('hands back whatever an earlier fetch wrapper returns, promise or not', async () => {
    make();
    for (const returned of [undefined, 42, { then: 'not a function' }, Promise.resolve('not a Response'), Promise.resolve(Object.defineProperty({}, 'status', { get: thrower }))]) {
      rig.host.fetch.mockImplementationOnce(() => returned);
      const result = (globalThis.fetch as unknown as Callable)(HOST_URL);
      expect(result instanceof Promise ? await result : result).toBe(returned instanceof Promise ? await returned : returned);
    }
    expect(rig.unhandled).toEqual([]);
  });

  it('measures and truncates strings where there is no TextEncoder', async () => {
    vi.resetModules();
    vi.stubGlobal('TextEncoder', undefined);
    const bytes = await import('../src/core/bytes.js');
    expect(bytes.byteLength('aé€\u{1F600}\uD800')).toBe(1 + 2 + 3 + 4 + 3);
    expect(bytes.truncateToBytes('€€\u{1F600}', 7)).toBe('€€');
    expect([...bytes.encodeUtf8('aé€\u{1F600}\uD800')]).toEqual([...new (await import('node:util')).TextEncoder().encode('aé€\u{1F600}\uD800')]);
  });
});
