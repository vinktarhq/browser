import { Vinktar } from './client.js';
import type { Breadcrumb, Props, Traits } from './types.js';
import type { CaptureContext, IdentifyOptions, Scope, User } from './types.js';
import type { VinktarOptions } from './options.js';
import { natives } from './browser/natives.js';

/**
 * The module-level facade: one default client, and a function per method that forwards to it.
 *
 * Calls made before `init()` are buffered (bounded, oldest dropped with a warning) and replayed
 * once it runs, so a `track()` fired from an early script or an `identify()` in a layout is not
 * lost to load order. A second `init()` warns and returns the first client; two clients on one
 * page would each patch the same globals.
 */
export { Vinktar } from './client.js';
export { VERSION, LIB } from './version.js';
export type { VinktarOptions } from './options.js';
export type {
  Breadcrumb, CaptureContext, CrumbHook, EventHook, Frame, IdentifyOptions, Integration, IntegrationHost, Level, LogLevel,
  LogSink, Props, Scope, Traits, User, WireException,
} from './types.js';

let client: Vinktar | null = null;

const MAX_PENDING = 100;
type Pending = [method: string, args: unknown[]];
const pending: Pending[] = [];

export function init(options: VinktarOptions = {}): Vinktar {
  if (client !== null) {
    natives.console.warn('[vinktar] init() was called twice; the first client is kept');

    return client;
  }
  client = new Vinktar(options);
  for (const [method, args] of pending.splice(0)) {
    (client as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args);
  }

  return client;
}

export function getClient(): Vinktar | null {
  return client;
}

function call<T>(method: keyof Vinktar, args: unknown[], fallback: T): T {
  if (client !== null) return (client[method] as (...a: unknown[]) => T)(...args);
  if (pending.length >= MAX_PENDING) {
    pending.shift();
    natives.console.warn('[vinktar] more than 100 calls before init(); the oldest was dropped');
  }
  pending.push([method, args]);

  return fallback;
}

export function track(name: string, properties?: Props): void {
  call('track', [name, properties], undefined);
}

export function page(name?: string, properties?: Props): void {
  call('page', [name, properties], undefined);
}

export function identify(userId: string, traits?: Traits, traitsOnce?: Traits, options?: IdentifyOptions): void {
  call('identify', [userId, traits, traitsOnce, options], undefined);
}

export function setTraits(traits: Traits, traitsOnce?: Traits): void {
  call('setTraits', [traits, traitsOnce], undefined);
}

export function setTraitsOnce(traits: Traits): void {
  call('setTraitsOnce', [traits], undefined);
}

export function unsetTraits(keys: string[]): void {
  call('unsetTraits', [keys], undefined);
}

export function setUser(user: User | null): void {
  call('setUser', [user], undefined);
}

export function reset(): void {
  call('reset', [], undefined);
}

export function register(properties: Props): void {
  call('register', [properties], undefined);
}

export function registerOnce(properties: Props): void {
  call('registerOnce', [properties], undefined);
}

export function unregister(key: string): void {
  call('unregister', [key], undefined);
}

export function captureException(error: unknown, hint?: CaptureContext): string {
  return call('captureException', [error, hint], '');
}

export function captureMessage(message: string, hint?: CaptureContext): string {
  return call('captureMessage', [message, hint], '');
}

export function addBreadcrumb(crumb: Partial<Breadcrumb>): void {
  call('addBreadcrumb', [crumb], undefined);
}

export function setTag(key: string, value: string): void {
  call('setTag', [key, value], undefined);
}

export function setTags(tags: Record<string, string>): void {
  call('setTags', [tags], undefined);
}

export function setContext(context: Props | null): void {
  call('setContext', [context], undefined);
}

export function withScope<T>(work: (scope: Scope) => T): T | undefined {
  if (client !== null) return client.withScope(work);
  // Without a client there is no scope to fork; the work still runs.
  const noop: Scope = { setTag: () => {}, setTags: () => {}, setContext: () => {} };

  return work(noop);
}

export function scope(): Scope | null {
  return client?.scope() ?? null;
}

export function optOut(): void {
  call('optOut', [], undefined);
}

export function optIn(): void {
  call('optIn', [], undefined);
}

export function hasOptedOut(): boolean {
  return client?.hasOptedOut() ?? false;
}

export function flush(): Promise<boolean> {
  return client?.flush() ?? Promise.resolve(true);
}

export function close(): Promise<void> {
  const current = client;
  client = null;

  return current?.close() ?? Promise.resolve();
}

export function getDeviceId(): string {
  return client?.getDeviceId() ?? '';
}

export function getSessionId(): string {
  return client?.getSessionId() ?? '';
}

export function getUserId(): string | null {
  return client?.getUserId() ?? null;
}
