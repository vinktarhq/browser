/**
 * Patches that can be undone, and that never stack on themselves.
 *
 * Every patch is tagged with the identity of the instance that installed it, so the same client
 * asked to patch twice (hot reload, a framework that mounts twice) leaves its own wrapper alone,
 * while a second, unrelated instance on the page (a CDN tag next to an npm bundle) wraps on top
 * and sees the same calls. Teardown restores in reverse order, and only when nobody has patched
 * on top since, so a wrapper installed by another library is never stranded.
 */
const TAG = '__vinktar_patched__';

let instances = 0;

export type Restore = () => void;

export class Instrumentation {
  private readonly restores: Restore[] = [];
  private readonly id = (instances += 1);
  private torndown = false;

  /** Replace `owner[name]` with `wrap(original)`, unless it is already ours. */
  patch<T extends object, K extends keyof T & string>(owner: T, name: K, wrap: (original: T[K]) => T[K]): void {
    if (this.torndown) return;
    const original = owner[name];
    if (typeof original !== 'function' || (original as unknown as Record<string, unknown>)[TAG] === this.id) return;

    let replacement: T[K];
    try {
      replacement = wrap(original);
    } catch {
      return;
    }
    try {
      Object.defineProperty(replacement as object, TAG, { value: this.id, enumerable: false });
    } catch {
      // A frozen function cannot be tagged; it still works, it just cannot be recognised twice.
    }
    owner[name] = replacement;
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
    try {
      target.addEventListener(type, handler, options);
      this.restores.push(() => target.removeEventListener(type, handler, options));
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
