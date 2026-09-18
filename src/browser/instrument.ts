/**
 * Patches that can be undone, and that never stack on themselves.
 *
 * Every patch is tagged with the identity of the instance that installed it, so the same client
 * asked to patch twice (hot reload, a framework that mounts twice) leaves its own wrapper alone,
 * while a second, unrelated instance on the page (a CDN tag next to an npm bundle) wraps on top
 * and sees the same calls. Teardown restores in reverse order, and only when nobody has patched
 * on top since, so a wrapper installed by another library is never stranded.
 *
 * A global that cannot be replaced (a frozen `console`, a read-only `fetch` in a hardened page) is
 * left as it is and `onRefused` is told; the patches made before it keep working. Every listener
 * registered here runs inside a `try`, because what a listener throws surfaces in the page, as an
 * `error` event or out of the `dispatchEvent` call that fired it.
 */
const TAG = '__vinktar_patched__';

let instances = 0;

export type Restore = () => void;

export class Instrumentation {
  private readonly restores: Restore[] = [];
  private readonly id = (instances += 1);
  private torndown = false;

  /** @param onRefused told the name of each global that could not be patched. */
  constructor(private readonly onRefused: (what: string) => void = () => {}) {}

  /** Replace `owner[name]` with `wrap(original)`, unless it is already ours. `label` is how a refusal names it. */
  patch<T extends object, K extends keyof T & string>(owner: T, name: K, wrap: (original: T[K]) => T[K], label: string = name): void {
    if (this.torndown) return;
    let original: T[K];
    let replacement: T[K];
    try {
      original = owner[name];
      if (typeof original !== 'function' || (original as unknown as Record<string, unknown>)[TAG] === this.id) return;
      replacement = wrap(original);
    } catch {
      return;
    }
    try {
      Object.defineProperty(replacement as object, TAG, { value: this.id, enumerable: false });
    } catch {
      // A frozen function cannot be tagged; it still works, it just cannot be recognised twice.
    }
    try {
      owner[name] = replacement;
    } catch {
      this.onRefused(label);

      return;
    }
    this.restores.push(() => {
      // Only if nobody patched on top of us since: restoring under a later wrapper would strand it.
      if (owner[name] === replacement) owner[name] = original;
    });
  }

  listen<K extends keyof WindowEventMap>(
    target: Window | Document,
    type: K | string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    if (this.torndown) return;
    const guarded = (event: Event): void => {
      try {
        handler(event);
      } catch {
        // Whatever the SDK wanted from this event is lost. The page's own listeners are not.
      }
    };
    try {
      target.addEventListener(type, guarded, options);
      this.restores.push(() => target.removeEventListener(type, guarded, options));
    } catch {
      // A target without addEventListener (some webviews' opener) is simply not observed.
    }
  }

  /** Any other undo, registered so teardown runs it. */
  onTeardown(restore: Restore): void {
    if (this.torndown) return;
    this.restores.push(restore);
  }

  teardown(): void {
    this.torndown = true;
    while (this.restores.length > 0) {
      const restore = this.restores.pop();
      try {
        restore?.();
      } catch {
        // Keep restoring the rest.
      }
    }
  }
}
