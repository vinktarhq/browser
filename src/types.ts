import type { Breadcrumb } from './core/breadcrumbs.js';
import type { Level } from './core/limits.js';
import type { Props } from './core/normalize.js';
import type { Traits } from './core/traits.js';

export type { Breadcrumb, Level, Props, Traits };
export type { Frame } from './core/stack.js';
export type { WireException } from './core/exception.js';
export type { LogLevel, LogSink } from './core/logger.js';

/** Extra detail for one `captureException` / `captureMessage` call. */
export interface CaptureContext {
  readonly level?: Level;
  readonly tags?: Record<string, string>;
  readonly context?: Props;
  /** Group this occurrence under these parts instead of the server's fingerprint. Never per-occurrence. */
  readonly fingerprint?: readonly string[];
  /** `false` for an error the application did not catch. Defaults to `true` for manual captures. */
  readonly handled?: boolean;
}

export interface IdentifyOptions {
  /** Trait keys to remove. */
  readonly unset?: readonly string[];
  /** Ignored in the browser, which mints and persists the device id itself. A warning says so. */
  readonly deviceId?: string;
}

/** What `setUser` accepts: an id plus any traits. */
export type User = { id: string } & Record<string, unknown>;

/** The mutable part of the client's state a caller can annotate. */
export interface Scope {
  setTag(key: string, value: string): void;
  setTags(tags: Record<string, string>): void;
  /** Merge into the error context; `null` clears it. */
  setContext(context: Props | null): void;
}

/** What an integration is given. Enough to emit events and errors; nothing to reconfigure. */
export interface IntegrationHost {
  track(name: string, properties?: Props): void;
  captureException(error: unknown, hint?: CaptureContext): string;
  addBreadcrumb(crumb: Partial<Breadcrumb>): void;
  readonly logger: { warn(message: string): void; debug(message: string): void };
}

/** An opt-in capability. `setup` returns its teardown. */
export interface Integration {
  readonly name: string;
  setup(host: IntegrationHost): (() => void) | void;
}

/** Event hooks receive the wire event; return it (rewritten or not) or `null` to drop it. */
export type EventHook = (event: Record<string, unknown>) => Record<string, unknown> | null | undefined;
export type CrumbHook = (crumb: Breadcrumb) => Breadcrumb | null | undefined;
