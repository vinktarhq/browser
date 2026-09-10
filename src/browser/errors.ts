import { errorCoercer, isErrorLike, type Coercer } from '../core/exception.js';
import { isExtensionFile } from '../core/filters.js';
import { parseStack, type Frame } from '../core/stack.js';
import type { Instrumentation } from './instrument.js';
import { natives } from './natives.js';

/**
 * Where uncaught errors come from, and the shapes the browser hands them over in.
 *
 * Handlers go on with `addEventListener`, never by assigning `window.onerror`: assigning
 * clobbers whatever the application or another library installed, and a second SDK on the page
 * would clobber this one. `Error.stackTraceLimit` is raised from V8's default of ten, which
 * truncates any React or framework stack before it reaches application code.
 */
export type GlobalMechanism = 'onerror' | 'onunhandledrejection';

export interface GlobalError {
  readonly value: unknown;
  readonly mechanism: GlobalMechanism;
  /** Present when the browser gave a location but no Error object (cross-origin scripts). */
  readonly location?: { file: string; line: number; col: number };
}

export function installGlobalHandlers(instrumentation: Instrumentation, onError: (error: GlobalError) => void): void {
  const win = natives.window;
  if (win === undefined) return;

  const ErrorCtor = win.Error as ErrorConstructor & { stackTraceLimit?: number };
  if (typeof ErrorCtor.stackTraceLimit === 'number' && ErrorCtor.stackTraceLimit < 50) {
    const previous = ErrorCtor.stackTraceLimit;
    ErrorCtor.stackTraceLimit = 50;
    instrumentation.onTeardown(() => {
      ErrorCtor.stackTraceLimit = previous;
    });
  }

  instrumentation.listen(win, 'error', (event) => {
    // Resource load failures are plain Events dispatched at the element and do not bubble; an
    // uncaught exception is an ErrorEvent at the window. Only the second is an error.
    if (!isErrorEvent(event)) return;
    const value = event.error ?? event.message;
    const location = event.filename ? { file: event.filename, line: event.lineno || 0, col: event.colno || 0 } : undefined;
    onError({ value, mechanism: 'onerror', ...(location !== undefined && !isErrorLike(event.error) ? { location } : {}) });
  });

  instrumentation.listen(win, 'unhandledrejection', (event) => {
    onError({ value: rejectionReason(event), mechanism: 'onunhandledrejection' });
  });
}

function isErrorEvent(event: Event): event is ErrorEvent {
  return typeof (event as ErrorEvent).message === 'string' && (event.target === natives.window || 'error' in event);
}

/**
 * A `PromiseRejectionEvent` keeps the reason on `.reason`. Some extensions re-dispatch it as a
 * CustomEvent, which moves `reason` under `.detail`; that shape is common enough to read.
 */
function rejectionReason(event: Event): unknown {
  if ('reason' in event) return (event as PromiseRejectionEvent).reason;
  const detail = (event as CustomEvent<{ reason?: unknown }>).detail;
  if (typeof detail === 'object' && detail !== null && 'reason' in detail) return detail.reason;

  return event;
}

// Coercers for the shapes only a browser produces ---------------------------------------------

/** An `ErrorEvent` carries the real Error on `.error`; without one, its message is all there is. */
const errorEventCoercer: Coercer = (value, options) => {
  if (typeof ErrorEvent === 'undefined' || !(value instanceof ErrorEvent)) return null;
  if (isErrorLike(value.error)) return errorCoercer(value.error, options);

  return { type: options.fallbackType ?? 'Error', value: value.message || 'Unknown error', stack: [] };
};

/** `DOMException` is an Error in every current browser, but its `.stack` is often empty. */
const domExceptionCoercer: Coercer = (value, options) => {
  if (typeof DOMException === 'undefined' || !(value instanceof DOMException)) return null;
  const parsed = errorCoercer(value, options);
  if (parsed === null) return null;

  return { ...parsed, type: value.name || 'DOMException' };
};

/** A rejection event handed straight to `captureException`. */
const promiseRejectionEventCoercer: Coercer = (value, options) => {
  if (typeof PromiseRejectionEvent === 'undefined' || !(value instanceof PromiseRejectionEvent)) return null;
  const reason = value.reason as unknown;
  if (isErrorLike(reason)) return errorCoercer(reason, options);

  return null; // let the core describe the primitive/object reason
};

export const DOM_COERCERS: readonly Coercer[] = [domExceptionCoercer, errorEventCoercer, promiseRejectionEventCoercer];

/** Unwrap the event shapes so the cause chain and the primitive coercers see the payload. */
export function unwrapBrowserValue(value: unknown): unknown {
  if (typeof PromiseRejectionEvent !== 'undefined' && value instanceof PromiseRejectionEvent) return value.reason;
  if (typeof ErrorEvent !== 'undefined' && value instanceof ErrorEvent && isErrorLike(value.error)) return value.error;

  return value;
}

// Extension noise -------------------------------------------------------------------------------

/** Globals injected by in-app browsers; a frame named after one is not application code. */
const INJECTED_GLOBALS = /^(?:__firefox__|__gCrWeb|__ybro|__yandex)/;

/** An error that came entirely from an extension or an injected browser shim. */
export function isExtensionError(frames: readonly Frame[]): boolean {
  if (frames.length === 0) return false;

  return frames.every((frame) => isExtensionFile(frame.file) || INJECTED_GLOBALS.test(frame.function ?? ''));
}

// Debug ids -----------------------------------------------------------------------------------

/**
 * The debug-id registry a bundler plugin fills at chunk load: `globalThis._vinktarDebugIds` maps a
 * `new Error().stack` captured inside the chunk to that chunk's id. The key is a stack rather
 * than a filename so the URL in it is exactly the URL a real error frame will carry, as the
 * browser resolved it. Parsing the key with the same parser used on real errors is what makes the
 * two sides agree. Rebuilt only when the number of registered chunks changes.
 */
const REGISTRY_GLOBAL = '_vinktarDebugIds';

let cache: Map<string, string> | null = null;
let cachedCount = -1;

export function debugIdFor(file: string): string | undefined {
  const registry = (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL] as Record<string, unknown> | undefined;
  if (typeof registry !== 'object' || registry === null) return undefined;

  const keys = Object.keys(registry);
  if (cache === null || keys.length !== cachedCount) {
    cache = new Map();
    for (const key of keys) {
      const id = registry[key];
      if (typeof id !== 'string' || id === '' || id.length > 64) continue;
      // Crash-last: the LAST frame is where the stack was created, inside the registering chunk.
      const frames = parseStack(key);
      const registered = frames[frames.length - 1]?.file;
      if (registered !== undefined && registered !== '') {
        cache.set(registered, id);
        cache.set(basename(registered), id);
      }
    }
    cachedCount = keys.length;
  }

  return cache.get(file) ?? cache.get(basename(file));
}

export function stampDebugIds(frames: Frame[]): void {
  for (const frame of frames) {
    const id = debugIdFor(frame.file);
    if (id !== undefined) frame.debug_id = id;
  }
}

function basename(file: string): string {
  const clean = file.split('?')[0]?.split('#')[0] ?? file;

  return clean.slice(clean.lastIndexOf('/') + 1);
}
