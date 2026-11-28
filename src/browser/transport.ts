import { byteLength } from '../core/bytes.js';
import { parseRetryAfter } from '../core/decide.js';
import type { Delivery, Outbound, SendOptions, Transport } from '../core/dispatcher.js';
import type { Logger } from '../core/logger.js';
import { parseJson } from '../core/normalize.js';
import { markOwn } from '../core/own.js';
import { natives } from './natives.js';

/**
 * HTTP for the browser, with the constraints that shape it:
 *
 * **Only three request headers exist**: `Content-Type`, `Content-Encoding` and `X-Vinktar-Key`.
 * Anything else fails the CORS preflight, the failure is cached for a day, and every send on the
 * page dies with it. SDK identity rides inside the body, in `context.$lib`.
 *
 * **An uncompressed body is sent CORS-simple**: `text/plain`, no custom header, the key in the
 * query string, so the first pageview needs no preflight. The server parses JSON regardless of
 * the declared type and reads the key from `_k`. `Content-Encoding` is never safelisted, so a
 * compressed body keeps the header form and pays for the preflight.
 *
 * **Redirects are never followed.** `fetch` follows them by default and sends the body and the
 * write key to wherever `Location` points. An ingest host that redirects is misconfigured, and the
 * dispatcher stops on the 3xx this reports.
 *
 * **One deadline per request covers all of it**: compression, the request, and reading the body.
 * A response that sends its headers and then stalls is a timeout, not a success.
 *
 * **Everything sent while the page goes away is CORS-simple**: `text/plain`, no custom header, the
 * key in the query string. A request that needs a preflight does not survive unload everywhere
 * (WebKit drops it), and a beacon cannot carry headers at all. The server parses JSON regardless
 * of the declared type and reads the key from `_k`, so nothing is lost.
 *
 * **`fetch(..., { keepalive })` has a shared 64 KiB in-flight budget** per page; over it, the
 * request is refused outright. So keepalive is used only for bodies under ~51 KiB with fewer than
 * fifteen in flight.
 *
 * **Third-party code patches `fetch`**, sometimes to throw synchronously. The SDK holds the
 * reference `natives.ts` took when it loaded and still wraps the call. That reference is only as
 * pristine as the page was at that moment: a wrapper installed earlier is the one the SDK sends
 * through, and if it derives a promise it never handles, a failed send becomes an unhandled
 * rejection there. Every error made or caught here is therefore marked (`core/own.ts`), and the
 * global handlers do not report a marked one as the application's.
 */
export interface BrowserTransportOptions {
  readonly host: string;
  readonly writeKey: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly useBeacon: boolean;
}

/** What an unload send came to. `sent` will still call back with its answer; `beacon` never can. */
export type UnloadResult = 'sent' | 'beacon' | 'too_large' | 'refused';

export const GZIP_THRESHOLD_BYTES = 1024;
export const KEEPALIVE_BODY_LIMIT = Math.floor(64 * 1024 * 0.8);
export const KEEPALIVE_MAX_INFLIGHT = 15;
export const BEACON_SPLIT_FLOOR_BYTES = 16 * 1024;

const NETWORK_ERROR = /Failed to fetch|NetworkError|Load failed|network error/i;
const TIMED_OUT = 'vinktar: request timed out';

export class BrowserTransport implements Transport {
  private inFlight = 0;
  private gzipBroken = false;

  constructor(private readonly options: BrowserTransportOptions) {}

  get canCompress(): boolean {
    return natives.CompressionStream !== undefined && !this.gzipBroken;
  }

  async send(out: Outbound, { gzip }: SendOptions): Promise<Delivery> {
    const fetch = natives.fetch;
    if (fetch === undefined) return { status: 0, body: null };

    const controller = natives.AbortController !== undefined ? new natives.AbortController() : undefined;
    let timedOut = false;
    const timeout = new Error(TIMED_OUT);
    markOwn(timeout);
    let expire: () => void = () => {};
    // Raced against every await below, so a step that ignores the abort signal still ends on time.
    const deadline = new Promise<never>((_, reject) => {
      expire = () => reject(timeout);
    });
    deadline.catch(() => {});
    // Detected by flag, not by comparing the rejection against the abort reason: not every browser
    // propagates the reason, and an explicit reason at least keeps "signal is aborted without
    // reason" out of the customer's console.
    const timer = natives.setTimeout(() => {
      timedOut = true;
      controller?.abort(timeout);
      expire();
    }, this.options.timeoutMs);

    try {
      let headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      let url = this.simpleUrl(out.endpoint);
      let body: BodyInit = out.body;
      let bytes = byteLength(out.body);

      if (gzip && this.canCompress && bytes >= GZIP_THRESHOLD_BYTES) {
        const compressed = await Promise.race([this.compress(out.body), deadline]);
        if (compressed !== null) {
          body = compressed as BodyInit;
          bytes = compressed.byteLength;
          headers = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Vinktar-Key': this.options.writeKey };
          url = `${this.options.host}${out.endpoint}`;
        }
      }

      const keepalive = bytes <= KEEPALIVE_BODY_LIMIT && this.inFlight < KEEPALIVE_MAX_INFLIGHT;
      this.inFlight += 1;
      let response: Response;
      try {
        response = await Promise.race([
          fetch(url, {
            method: 'POST',
            headers,
            body,
            keepalive,
            credentials: 'omit',
            mode: 'cors',
            redirect: 'manual',
            referrerPolicy: 'strict-origin-when-cross-origin',
            ...(controller !== undefined ? { signal: controller.signal } : {}),
          }),
          deadline,
        ]);
      } finally {
        this.inFlight -= 1;
      }

      // A cross-origin redirect under `manual` is an opaque response with status 0. Report it as
      // what it is, so it is not retried as a network failure.
      if (response.type === 'opaqueredirect') return { status: 307, body: null };

      let text = '';
      try {
        text = await Promise.race([response.text(), deadline]);
      } catch (error) {
        if (timedOut) throw error;
        // An empty or unreadable body is decided on status alone.
      }

      return {
        status: response.status,
        body: parseJson(text) ?? null,
        retryAfter: parseRetryAfter(header(response, 'Retry-After')),
        rateLimitCategories: header(response, 'X-RateLimit-Categories') ?? '',
      };
    } catch (error) {
      markOwn(error);
      const message = error instanceof Error ? error.message : String(error);
      // Ad blockers, offline devices and CORS failures all surface as one generic TypeError with a
      // browser-specific message. Logged at debug, not warn: a transport failure of the SDK's own
      // must never become an error the SDK then reports.
      this.options.logger.debug(timedOut ? 'request timed out' : NETWORK_ERROR.test(message) ? 'network error' : 'request failed', { message });

      return { status: 0, body: null };
    } finally {
      natives.clearTimeout(timer);
    }
  }

  private simpleUrl(endpoint: string): string {
    return `${this.options.host}${endpoint}?_k=${encodeURIComponent(this.options.writeKey)}`;
  }

  /**
   * One attempt, synchronous, for a tab going hidden and for `pagehide`.
   *
   * A beacon first: a hidden tab may never run again (mobile browsers kill it, a closed tab fires
   * nothing after this), and a beacon is what every engine delivers most reliably while a page goes
   * away. A keepalive request is the fallback, and `onAnswer` is told whether it got a 2xx. A refusal at
   * a body over the split floor means the payload is too big; under it, the page's quota is
   * exhausted and halving will not help.
   */
  sendOnUnload(out: Outbound, onAnswer?: (accepted: boolean) => void): UnloadResult {
    const size = byteLength(out.body);
    const url = this.simpleUrl(out.endpoint);

    if (this.beacon(url, out.body)) return 'beacon';

    if (natives.fetch !== undefined && size <= KEEPALIVE_BODY_LIMIT && this.inFlight < KEEPALIVE_MAX_INFLIGHT) {
      try {
        void natives
          .fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: out.body,
            keepalive: true,
            credentials: 'omit',
            mode: 'cors',
            redirect: 'manual',
          })
          .then(
            (response) => onAnswer?.(response.status >= 200 && response.status < 300),
            (error: unknown) => {
              markOwn(error);
              onAnswer?.(false);
            },
          );

        return 'sent';
      } catch {
        // Fall through to the beacon.
      }
    }

    if (!this.options.useBeacon || natives.sendBeacon === undefined || natives.Blob === undefined) {
      return size > KEEPALIVE_BODY_LIMIT ? 'too_large' : 'refused';
    }

    return size > BEACON_SPLIT_FLOOR_BYTES ? 'too_large' : 'refused';
  }

  private beacon(url: string, body: string): boolean {
    if (!this.options.useBeacon || natives.sendBeacon === undefined || natives.Blob === undefined) return false;
    try {
      return natives.sendBeacon(url, new natives.Blob([body], { type: 'text/plain' }));
    } catch {
      // A beacon that throws is a beacon that was refused.
      return false;
    }
  }

  private async compress(text: string): Promise<Uint8Array | null> {
    try {
      const stream = new Blob([text]).stream().pipeThrough(new natives.CompressionStream!('gzip'));
      const buffer = await new Response(stream).arrayBuffer();

      return new Uint8Array(buffer);
    } catch (error) {
      markOwn(error);
      // Latched: a runtime whose CompressionStream is broken is broken for the rest of the page,
      // and every request would otherwise pay to find that out again.
      this.gzipBroken = true;
      this.options.logger.debug('compression unavailable; sending uncompressed', { error: String(error) });

      return null;
    }
  }
}

function header(response: Response, name: string): string | null {
  try {
    return response.headers.get(name);
  } catch {
    return null;
  }
}
