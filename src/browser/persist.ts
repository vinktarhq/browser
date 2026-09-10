import { TIMESTAMP_PAST_MS } from '../core/limits.js';
import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import type { Entry } from '../core/queue.js';
import type { Category } from '../core/reports.js';
import { uuidv7 } from '../core/ids.js';
import type { Store } from './storage.js';

/**
 * The queue on disk, so a navigation or a crash between capture and send loses nothing.
 *
 * One slot per TAB (the tab id lives in sessionStorage, which a reload keeps and a duplicated tab
 * copies, so a duplicate mints its own), written on every change with a short throttle and
 * synchronously on unload. On startup a tab adopts its own slot, plus any other tab's slot that
 * has not been touched for a minute: that tab is gone, and its events would otherwise wait
 * forever. The worst case is a duplicate send of an adopted batch, which `event_id` dedupes on
 * the server.
 *
 * Nothing is deleted from a slot when it goes out on the unload path, because a beacon never
 * reports success. If the page comes back, the batch is sent again and deduped; if it does not,
 * the next tab adopts it.
 */
interface Slot {
  readonly t: number;
  readonly e: Entry[];
  readonly x: Entry[];
}

const ORPHAN_AFTER_MS = 60_000;
const WRITE_THROTTLE_MS = 1_000;
const MAX_QUEUE_AGE_MS = TIMESTAMP_PAST_MS - 86_400_000;

export class QueuePersistence {
  private readonly key: string;
  private readonly prefix: string;
  private lastWrite = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: Store,
    tabStore: Store,
    namespace: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly cancel: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {
    let tab = tabStore.get('vk_tab');
    if (tab === null || tab === '') {
      tab = uuidv7(this.now()).slice(-12);
      tabStore.set('vk_tab', tab);
    }
    this.prefix = `${namespace}_q_`;
    this.key = `${this.prefix}${tab}`;
  }

  /** Everything this tab may send: its own slot and any abandoned ones. */
  restore(): { events: Entry[]; errors: Entry[] } {
    const events: Entry[] = [];
    const errors: Entry[] = [];
    const now = this.now();
    const floor = now - MAX_QUEUE_AGE_MS;

    for (const key of this.store.keys(this.prefix)) {
      const slot = parseJson(this.store.get(key)) as Partial<Slot> | undefined;
      if (typeof slot !== 'object' || slot === null) {
        this.store.remove(key);
        continue;
      }
      const own = key === this.key;
      if (!own && Math.abs(now - (slot.t ?? 0)) < ORPHAN_AFTER_MS) continue; // still someone's

      for (const entry of valid(slot.e, floor)) events.push(entry);
      for (const entry of valid(slot.x, floor)) errors.push(entry);
      if (!own) this.store.remove(key);
    }

    if (events.length + errors.length > 0) this.logger.debug('restored queued items', { events: events.length, errors: errors.length });

    return { events, errors };
  }

  save(events: readonly Entry[], errors: readonly Entry[], immediate = false): void {
    if (immediate) {
      this.write(events, errors);

      return;
    }
    const since = this.now() - this.lastWrite;
    if (since >= WRITE_THROTTLE_MS) {
      this.write(events, errors);
    } else if (this.timer === null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.write(events, errors);
      }, WRITE_THROTTLE_MS - since);
    }
  }

  clear(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.store.remove(this.key);
  }

  private write(events: readonly Entry[], errors: readonly Entry[]): void {
    this.lastWrite = this.now();
    if (events.length + errors.length === 0) {
      this.store.remove(this.key);

      return;
    }
    const slot: Slot = { t: this.lastWrite, e: events.slice(), x: errors.slice() };
    this.store.set(this.key, JSON.stringify(slot));
  }
}

function valid(list: unknown, floor: number): Entry[] {
  if (!Array.isArray(list)) return [];
  const out: Entry[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<Entry>;
    const category = entry.category;
    if (category !== 'event' && category !== 'identify' && category !== 'error') continue;
    if (typeof entry.item !== 'object' || entry.item === null) continue;
    const ts = Date.parse(String((entry.item as Record<string, unknown>)['timestamp'] ?? ''));
    // Older than the server's window is dead weight; it would only be rejected.
    if (Number.isFinite(ts) && ts < floor) continue;
    out.push({ category: category as Category, item: entry.item as Record<string, unknown> });
  }

  return out;
}
