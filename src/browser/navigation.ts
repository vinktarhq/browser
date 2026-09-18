import type { Instrumentation } from './instrument.js';
import { natives } from './natives.js';

/**
 * One patch of the History API, fanned out to whoever wants to know the URL changed: pageviews and
 * navigation breadcrumbs, and integrations after them.
 *
 * `pushState` and `replaceState` are wrapped (there is no event for them); `popstate` and
 * `hashchange` are listened to. Whether a change *counts* is the subscriber's decision, because a
 * framework can call `replaceState` a dozen times per route transition with only the search or
 * the hash moving, and what a pageview means differs per application.
 */
export type NavigationType = 'pushState' | 'replaceState' | 'popstate' | 'hashchange';

export interface NavigationChange {
  readonly from: string;
  readonly to: string;
  readonly type: NavigationType;
}

export type NavigationListener = (change: NavigationChange) => void;

export class Navigation {
  private readonly listeners = new Set<NavigationListener>();
  private installed = false;
  private last = '';

  constructor(private readonly instrumentation: Instrumentation) {}

  subscribe(listener: NavigationListener): () => void {
    this.listeners.add(listener);
    this.install();

    return () => this.listeners.delete(listener);
  }

  private install(): void {
    if (this.installed) return;
    const win = natives.window;
    if (win === undefined || typeof win.history !== 'object') return;
    this.installed = true;
    this.last = win.location.href;

    const emit = (type: NavigationType): void => {
      const to = win.location.href;
      if (to === this.last) return;
      const change: NavigationChange = { from: this.last, to, type };
      this.last = to;
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch {
          // One subscriber's failure is not another's.
        }
      }
    };

    for (const method of ['pushState', 'replaceState'] as const) {
      this.instrumentation.patch(
        win.history,
        method,
        (original) => {
          return function patched(this: History, ...args: Parameters<History['pushState']>) {
            const result = original.apply(this, args);
            try {
              emit(method);
            } catch {
              // The navigation happened. Only the SDK's notice of it is lost.
            }

            return result;
          } as History['pushState'];
        },
        `history.${method}`,
      );
    }
    this.instrumentation.listen(win, 'popstate', () => emit('popstate'));
    this.instrumentation.listen(win, 'hashchange', () => emit('hashchange'));
  }
}

/** The part of a URL that decides whether a navigation is a new page. */
export function locationKey(href: string, parts: { path: boolean; search: boolean; hash: boolean }): string {
  try {
    const url = new URL(href);

    return `${parts.path ? url.pathname : ''}|${parts.search ? url.search : ''}|${parts.hash ? url.hash : ''}`;
  } catch {
    return href;
  }
}
